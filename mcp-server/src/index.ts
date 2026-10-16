#!/usr/bin/env node
import { activeDataDir, canvasOrigin } from './schoolContext.js';
import { calendarDay, formatDeadline } from './time.js';
import { getAssignmentFull, listAssignments, type AssignmentFilter } from './localFeatures.js';
import { readChanges, setBaseline } from './changes.js';
import { triggerAppSync } from './syncClient.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 数据路径:优先用环境变量,否则根据平台选默认路径
function getDataDir(): string {
  if (process.env.CANVAS_DATA_DIR) {
    return process.env.CANVAS_DATA_DIR;
  }
  const platform = process.platform;
  if (platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'canvas-manager', 'data');
  } else if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'canvas-manager', 'data');
  } else {
    return join(homedir(), '.config', 'canvas-manager', 'data');
  }
}

const DATA_ROOT = getDataDir();
function currentDataDir() { return activeDataDir(DATA_ROOT); }

function syncStatus(dataDir = currentDataDir()) {
  const manifestPath = join(dataDir, 'sync_manifest.json');
  const coursesPath = join(dataDir, 'courses.json');
  let syncedAt: string | null = null;
  let source = 'none';
  let courseCount: number | null = null;
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (typeof manifest.syncedAt === 'string' && !Number.isNaN(Date.parse(manifest.syncedAt))) {
        syncedAt = manifest.syncedAt;
        courseCount = Number.isInteger(manifest.courseCount) ? manifest.courseCount : null;
        source = 'completed-sync manifest';
      }
    } catch { /* 保留旧缓存时间作参考 */ }
  }
  if (!syncedAt && existsSync(coursesPath)) {
    syncedAt = statSync(coursesPath).mtime.toISOString();
    source = 'legacy file timestamp; completion unconfirmed';
  }
  const ageMinutes = syncedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(syncedAt)) / 60000)) : null;
  const updating = existsSync(manifestPath) && existsSync(coursesPath) &&
    statSync(coursesPath).mtimeMs > statSync(manifestPath).mtimeMs;
  return { dataDir, syncedAt, ageMinutes, stale: ageMinutes === null || ageMinutes > 60,
    source, courseCount, updating, timeZone: process.env.CANVAS_TIME_ZONE || 'Asia/Shanghai' };
}

interface Course {
  id: number;
  code: string;
  name: string;
}

interface Assignment {
  id: number;
  name: string;
  description: string | null;
  due_at: string | null;
  points: number | null;
  published: boolean;
  sub?: {
    state: string;
    submitted_at?: string;
    score?: number;
  };
}

interface Announcement {
  id: number;
  title: string;
  message: string | null;
  posted_at: string | null;
  url: string;
}

interface FileItem {
  id: number;
  filename: string;
  size: number;
  url: string;
  type?: string;
}

// 读取本地数据
function readLocalData(dataDir = currentDataDir()) {
  try {
    const coursesPath = join(dataDir, 'courses.json');
    if (!existsSync(coursesPath)) {
      return { courses: [] as Course[], byCourse: {} as Record<number, Assignment[]>, filesBy: {} as Record<number, { files: FileItem[]; links: any[] }>, annBy: {} as Record<number, Announcement[]>, canvasOrigin: canvasOrigin(dataDir) };
    }
    if (syncStatus(dataDir).updating) throw new Error('桌面应用正在写入新课程数据，请稍后再查询。');

    const courses: Course[] = JSON.parse(readFileSync(coursesPath, 'utf-8'));
    const byCourse: Record<number, Assignment[]> = {};
    const filesBy: Record<number, { files: FileItem[]; links: any[] }> = {};
    const annBy: Record<number, Announcement[]> = {};

    for (const course of courses) {
      const assignPath = join(dataDir, `course_${course.id}_assignments.json`);
      const filesPath = join(dataDir, `course_${course.id}_files.json`);
      const annPath = join(dataDir, `course_${course.id}_announcements.json`);

      if (existsSync(assignPath)) {
        byCourse[course.id] = JSON.parse(readFileSync(assignPath, 'utf-8'));
      }
      if (existsSync(filesPath)) {
        filesBy[course.id] = JSON.parse(readFileSync(filesPath, 'utf-8'));
      }
      if (existsSync(annPath)) {
        const ann = JSON.parse(readFileSync(annPath, 'utf-8'));
        annBy[course.id] = Array.isArray(ann) ? ann : (ann.announcements || []);
      }
    }

    return { courses, byCourse, filesBy, annBy, canvasOrigin: canvasOrigin(dataDir) };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `读取数据失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// 分析作业状态
function classifyAssignment(a: Assignment): 'pending' | 'overdue' | 'done' {
  const sub = a.sub;
  if (sub && (sub.state === 'graded' || sub.state === 'submitted' || sub.submitted_at)) {
    return 'done';
  }
  if (!a.due_at) return 'pending';
  const due = new Date(a.due_at);
  return due < new Date() ? 'overdue' : 'pending';
}

// 格式化倒计时
function formatCountdown(due: Date): string {
  const now = new Date();
  const diff = due.getTime() - now.getTime();
  if (diff < 0) return '已过期';
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return `还剩 ${days} 天`;
  if (hours > 0) return `还剩 ${hours} 小时`;
  return `还剩 ${Math.floor(diff / 60000)} 分钟`;
}

// MCP Server
const server = new Server(
  {
    name: 'canvas-study-assistant',
    version: '0.1.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// 资源列表
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const { courses } = readLocalData();

  return {
    resources: [
      {
        uri: 'canvas://courses',
        name: '课程列表',
        description: '所有已同步的 Canvas 课程',
        mimeType: 'application/json',
      },
      {
        uri: 'canvas://assignments/pending',
        name: '待交作业',
        description: '所有未提交且未过期的作业',
        mimeType: 'application/json',
      },
      {
        uri: 'canvas://assignments/overdue',
        name: '过期未交作业',
        description: '已过截止时间但未提交的作业',
        mimeType: 'application/json',
      },
      {
        uri: 'canvas://announcements/recent',
        name: '最新公告',
        description: '最近 7 天的课程公告',
        mimeType: 'application/json',
      },
      ...courses.map(c => ({
        uri: `canvas://course/${c.id}/assignments`,
        name: `${c.code} - 作业列表`,
        description: `课程 ${c.name} 的全部作业`,
        mimeType: 'application/json',
      })),
    ],
  };
});

// 读取资源
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const { courses, byCourse, annBy } = readLocalData();

  if (uri === 'canvas://courses') {
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(courses, null, 2),
      }],
    };
  }

  if (uri === 'canvas://assignments/pending') {
    const pending: any[] = [];
    for (const [cid, assignments] of Object.entries(byCourse)) {
      const course = courses.find(c => c.id === Number(cid));
      for (const a of assignments) {
        if (a.published && classifyAssignment(a) === 'pending') {
          pending.push({
            course: course?.code,
            courseId: Number(cid),
            id: a.id,
            name: a.name,
            due_at: a.due_at,
            countdown: a.due_at ? formatCountdown(new Date(a.due_at)) : null,
            points: a.points,
          });
        }
      }
    }
    pending.sort((x, y) => (x.due_at || '9999') < (y.due_at || '9999') ? -1 : 1);

    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(pending, null, 2),
      }],
    };
  }

  if (uri === 'canvas://assignments/overdue') {
    const overdue: any[] = [];
    for (const [cid, assignments] of Object.entries(byCourse)) {
      const course = courses.find(c => c.id === Number(cid));
      for (const a of assignments) {
        if (a.published && classifyAssignment(a) === 'overdue') {
          overdue.push({
            course: course?.code,
            courseId: Number(cid),
            id: a.id,
            name: a.name,
            due_at: a.due_at,
            points: a.points,
          });
        }
      }
    }
    overdue.sort((x, y) => (x.due_at || '') < (y.due_at || '') ? -1 : 1);

    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(overdue, null, 2),
      }],
    };
  }

  if (uri === 'canvas://announcements/recent') {
    const recent: any[] = [];
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

    for (const [cid, announcements] of Object.entries(annBy)) {
      const course = courses.find(c => c.id === Number(cid));
      for (const ann of announcements) {
        const posted = ann.posted_at ? new Date(ann.posted_at) : null;
        if (posted && posted >= sevenDaysAgo) {
          recent.push({
            course: course?.code,
            courseId: cid,
            id: ann.id,
            title: ann.title,
            posted_at: ann.posted_at,
            url: ann.url,
          });
        }
      }
    }
    recent.sort((x, y) => (x.posted_at || '') > (y.posted_at || '') ? -1 : 1);

    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(recent, null, 2),
      }],
    };
  }

  const courseMatch = uri.match(/^canvas:\/\/course\/(\d+)\/assignments$/);
  if (courseMatch) {
    const cid = Number(courseMatch[1]);
    const course = courses.find(c => c.id === cid);
    const assignments = byCourse[cid] || [];

    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          course: course?.code,
          assignments: assignments.map(a => ({
            id: a.id,
            name: a.name,
            due_at: a.due_at,
            status: classifyAssignment(a),
            points: a.points,
          })),
        }, null, 2),
      }],
    };
  }

  throw new McpError(ErrorCode.InvalidRequest, `未知资源: ${uri}`);
});

// 工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_pending_assignments',
        description: '获取所有待交作业列表(未提交且未过期),按截止时间排序',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_assignment_detail',
        description: '获取指定作业的完整信息(说明、附件、截止时间)',
        inputSchema: {
          type: 'object',
          properties: {
            courseId: { type: 'number', description: '课程 ID' },
            assignmentId: { type: 'number', description: '作业 ID' },
          },
          required: ['courseId', 'assignmentId'],
        },
      },
      {
        name: 'check_deadline_today',
        description: '检查今天是否有作业截止',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_course_summary',
        description: '获取指定课程的概览(作业数、待交数、最近公告)',
        inputSchema: {
          type: 'object',
          properties: {
            courseId: { type: 'number', description: '课程 ID' },
          },
          required: ['courseId'],
        },
      },
      {
        name: 'search_assignments',
        description: '根据关键词搜索作业',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '搜索关键词' },
          },
          required: ['keyword'],
        },
      },
      {
        name: 'get_sync_status',
        description: '查看本地课程数据的最后完成同步时间、数据来源和是否过时',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_assignments',
        description: '按课程、状态和北京时间日期范围筛选作业；返回作业 ID、原页链接和数据时间',
        inputSchema: { type: 'object', properties: {
          courseId: { type: 'number' }, courseCode: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'overdue', 'done', 'all'], default: 'pending' },
          from: { type: 'string', description: '开始日期 YYYY-MM-DD，含当天' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD，含当天' },
          includeUndated: { type: 'boolean', description: '按日期筛选时包含无截止日期作业' },
          limit: { type: 'number', minimum: 1, maximum: 500 },
        } },
      },
      {
        name: 'get_assignment_full',
        description: '读取完整作业说明、保留段落和图片线索，列出附件与提交状态；链接去除查询凭据',
        inputSchema: { type: 'object', properties: {
          courseId: { type: 'number' }, assignmentId: { type: 'number' },
        }, required: ['courseId', 'assignmentId'] },
      },
      {
        name: 'get_sync_changes',
        description: '对比本地课程缓存与上次检查，列出新增、删除和修改的作业公告；首次使用建立基线',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'sync_courses',
        description: '让正在运行的 Canvas 桌面应用同步课程，可能需要用户在弹出的窗口完成学校登录',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
});

// 工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'get_sync_status') {
    return { content: [{ type: 'text', text: JSON.stringify(syncStatus(), null, 2) }] };
  }

  if (name === 'list_assignments') {
    try {
      const data = readLocalData();
      const filtered = listAssignments(data, (args || {}) as AssignmentFilter);
      return { content: [{ type: 'text', text: JSON.stringify({ sync: syncStatus(), ...filtered }, null, 2) }] };
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
    }
  }

  if (name === 'get_assignment_full') {
    const { courseId, assignmentId } = (args || {}) as { courseId: number; assignmentId: number };
    try {
      const data = readLocalData();
      return { content: [{ type: 'text', text: JSON.stringify({ sync: syncStatus(),
        assignment: getAssignmentFull(data, courseId, assignmentId) }, null, 2) }] };
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
    }
  }

  if (name === 'get_sync_changes') {
    const data = readLocalData();
    const sync = syncStatus();
    return { content: [{ type: 'text', text: JSON.stringify({ sync, ...readChanges(currentDataDir(), data, sync.syncedAt) }, null, 2) }] };
  }

  if (name === 'sync_courses') {
    const dataDir = currentDataDir();
    const before = readLocalData(dataDir);
    setBaseline(dataDir, before, syncStatus(dataDir).syncedAt);
    try {
      const result = await triggerAppSync(dataDir);
      if (currentDataDir() !== dataDir) throw new Error('同步期间学校已切换，请重新查询');
      const after = readLocalData(dataDir);
      const changes = readChanges(dataDir, after, syncStatus(dataDir).syncedAt);
      return { content: [{ type: 'text', text: JSON.stringify({ sync: syncStatus(),
        courseCount: result.courseCount, progress: result.progress, changes: changes.changes }, null, 2) }] };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : String(error));
    }
  }

  if (name === 'get_pending_assignments') {
    const { courses, byCourse } = readLocalData();
    const pending: any[] = [];

    for (const [cid, assignments] of Object.entries(byCourse)) {
      const course = courses.find(c => c.id === Number(cid));
      for (const a of assignments) {
        if (a.published && classifyAssignment(a) === 'pending') {
          pending.push({
            course: course?.code,
            courseId: Number(cid),
            id: a.id,
            name: a.name,
            due_at: a.due_at,
            countdown: a.due_at ? formatCountdown(new Date(a.due_at)) : null,
            points: a.points,
          });
        }
      }
    }
    pending.sort((x, y) => (x.due_at || '9999') < (y.due_at || '9999') ? -1 : 1);

    return {
      content: [{
        type: 'text',
        text: `找到 ${pending.length} 项待交作业:\n\n${pending.map(p =>
          `- [${p.course}] ${p.name}\n  截止: ${formatDeadline(p.due_at)} (${p.countdown || '-'})\n  分值: ${p.points || '-'}`
        ).join('\n\n')}`,
      }],
    };
  }

  if (name === 'get_assignment_detail') {
    const { courseId, assignmentId } = args as { courseId: number; assignmentId: number };
    const { courses, byCourse } = readLocalData();
    const assignments = byCourse[courseId];
    if (!assignments) {
      throw new McpError(ErrorCode.InvalidRequest, `课程 ${courseId} 不存在`);
    }

    const assignment = assignments.find(a => a.id === assignmentId);
    if (!assignment) {
      throw new McpError(ErrorCode.InvalidRequest, `作业 ${assignmentId} 不存在`);
    }

    const course = courses.find(c => c.id === courseId);
    const stripHtml = (html: string | null) => {
      if (!html) return '';
      return html.replace(/<[^>]*>/g, '').replace(/\n{3,}/g, '\n\n').trim();
    };

    return {
      content: [{
        type: 'text',
        text: `课程: ${course?.code}\n标题: ${assignment.name}\n截止: ${formatDeadline(assignment.due_at)}\n分值: ${assignment.points || '-'}\n\n说明:\n${stripHtml(assignment.description) || '(无说明)'}`,
      }],
    };
  }

  if (name === 'check_deadline_today') {
    const { courses, byCourse } = readLocalData();
    const today = new Date();
    const todayStr = calendarDay(today);
    const todayAssignments: any[] = [];

    for (const [cid, assignments] of Object.entries(byCourse)) {
      const course = courses.find(c => c.id === Number(cid));
      for (const a of assignments) {
        if (a.published && a.due_at && calendarDay(new Date(a.due_at)) === todayStr && classifyAssignment(a) === 'pending') {
          todayAssignments.push({
            course: course?.code,
            name: a.name,
            due_at: a.due_at,
          });
        }
      }
    }

    if (todayAssignments.length === 0) {
      return { content: [{ type: 'text', text: '✅ 今天没有作业截止' }] };
    }

    return {
      content: [{
        type: 'text',
        text: `⚠️ 今天有 ${todayAssignments.length} 项作业截止:\n\n${todayAssignments.map(t =>
          `- [${t.course}] ${t.name}\n  ${formatDeadline(t.due_at)}`
        ).join('\n\n')}`,
      }],
    };
  }

  if (name === 'get_course_summary') {
    const { courseId } = args as { courseId: number };
    const { courses, byCourse, annBy } = readLocalData();
    const course = courses.find(c => c.id === courseId);
    if (!course) {
      throw new McpError(ErrorCode.InvalidRequest, `课程 ${courseId} 不存在`);
    }

    const assignments = byCourse[courseId] || [];
    const published = assignments.filter(a => a.published);
    const pending = published.filter(a => classifyAssignment(a) === 'pending').length;
    const overdue = published.filter(a => classifyAssignment(a) === 'overdue').length;
    const done = published.filter(a => classifyAssignment(a) === 'done').length;

    const announcements = annBy[courseId] || [];
    const recentAnn = announcements
      .filter(a => a.posted_at && new Date(a.posted_at) > new Date(Date.now() - 7 * 86400000))
      .sort((x, y) => (x.posted_at || '') > (y.posted_at || '') ? -1 : 1)
      .slice(0, 3);

    return {
      content: [{
        type: 'text',
        text: `课程: ${course.code} - ${course.name}\n\n作业统计:\n- 总数: ${published.length}\n- 待交: ${pending}\n- 过期: ${overdue}\n- 已交: ${done}\n\n最近公告 (${recentAnn.length}):\n${recentAnn.map(a => `- ${a.title}\n  ${a.posted_at?.slice(0, 10)}`).join('\n')}`,
      }],
    };
  }

  if (name === 'search_assignments') {
    const { keyword } = args as { keyword: string };
    const { courses, byCourse } = readLocalData();
    const results: any[] = [];

    for (const [cid, assignments] of Object.entries(byCourse)) {
      const course = courses.find(c => c.id === Number(cid));
      for (const a of assignments) {
        if (a.name.toLowerCase().includes(keyword.toLowerCase()) ||
            (a.description && a.description.toLowerCase().includes(keyword.toLowerCase()))) {
          results.push({
            course: course?.code,
            id: a.id,
            name: a.name,
            status: classifyAssignment(a),
            due_at: a.due_at,
          });
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: `找到 ${results.length} 项匹配的作业:\n\n${results.map(r =>
          `- [${r.course}] ${r.name}\n  状态: ${r.status} | 截止: ${formatDeadline(r.due_at)}`
        ).join('\n\n')}`,
      }],
    };
  }

  throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${name}`);
});

// 启动
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Canvas Study Assistant MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
