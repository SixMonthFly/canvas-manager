import { calendarDay, formatDeadline } from './time.js';

export interface CourseRecord { id: number; code: string; name: string }
export interface AssignmentRecord {
  id: number; name: string; description: string | null; due_at: string | null;
  points: number | null; published: boolean; url?: string;
  attachments?: Array<{ id: number; filename: string; size?: number; content_type?: string; url?: string }>;
  sub?: { state: string; submitted_at?: string; score?: number; late?: boolean };
}
export interface AnnouncementRecord { id: number; title: string; posted_at: string | null; message: string | null; url: string }
export interface LocalData {
  canvasOrigin?: string;
  courses: CourseRecord[];
  byCourse: Record<number, AssignmentRecord[]>;
  annBy: Record<number, AnnouncementRecord[]>;
}
export type AssignmentStatus = 'pending' | 'overdue' | 'done';

export function assignmentStatus(a: AssignmentRecord): AssignmentStatus {
  if (a.sub && (a.sub.state === 'graded' || a.sub.state === 'submitted' || a.sub.submitted_at)) return 'done';
  if (!a.due_at) return 'pending';
  const due = new Date(a.due_at);
  return Number.isNaN(due.getTime()) || due >= new Date() ? 'pending' : 'overdue';
}

export interface AssignmentFilter {
  courseId?: number; courseCode?: string;
  status?: AssignmentStatus | 'all';
  from?: string; to?: string;
  includeUndated?: boolean; limit?: number;
}

function validDay(value: string | undefined): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function listAssignments(data: LocalData, filter: AssignmentFilter = {}) {
  if (!validDay(filter.from) || !validDay(filter.to)) throw new Error('日期请使用 YYYY-MM-DD');
  if (filter.from && filter.to && filter.from > filter.to) throw new Error('开始日期不能晚于结束日期');
  if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 500)) {
    throw new Error('limit 须为 1 到 500 的整数');
  }
  let courses = data.courses;
  if (filter.courseId !== undefined) {
    courses = courses.filter(c => c.id === filter.courseId);
    if (!courses.length) throw new Error(`课程 ID ${filter.courseId} 不存在`);
  }
  if (filter.courseCode) {
    const code = filter.courseCode.trim().toLowerCase();
    courses = courses.filter(c => c.code.toLowerCase().split(' ')[0] === code || c.code.toLowerCase() === code);
    if (!courses.length) throw new Error(`课程代码 ${filter.courseCode} 不存在`);
    if (courses.length > 1) throw new Error(`课程代码 ${filter.courseCode} 对应多个课程，请使用 courseId: ${courses.map(c => c.id).join(', ')}`);
  }
  const status = filter.status || 'pending';
  if (!['pending', 'overdue', 'done', 'all'].includes(status)) throw new Error('无效状态');
  const all = courses.flatMap(course => (data.byCourse[course.id] || [])
    .filter(a => a.published)
    .map(a => ({
      courseId: course.id, courseCode: course.code, assignmentId: a.id, name: a.name,
      status: assignmentStatus(a), dueAt: a.due_at, dueLocal: formatDeadline(a.due_at),
      points: a.points, url: a.url || null,
      hasDescription: Boolean(a.description), attachmentCount: a.attachments?.length || 0,
    })))
    .filter(a => status === 'all' || a.status === status)
    .filter(a => {
      if (!filter.from && !filter.to) return true;
      if (!a.dueAt) return filter.includeUndated === true;
      const day = calendarDay(new Date(a.dueAt));
      return (!filter.from || day >= filter.from) && (!filter.to || day <= filter.to);
    })
    .sort((a, b) => (a.dueAt || '9999').localeCompare(b.dueAt || '9999') ||
      a.courseId - b.courseId || a.assignmentId - b.assignmentId);
  return { total: all.length, items: all.slice(0, filter.limit || 100) };
}

function decodeText(html: string): string {
  return html.replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|ul|ol)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\n{3,}/g, '\n\n').trim();
}

function safeCanvasUrl(raw: string | undefined, origin = 'https://hkust-gz.instructure.com'): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, origin);
    if (u.protocol !== 'https:') return null;
    u.search = ''; u.hash = '';
    return u.href;
  } catch { return null; }
}

function sanitizeDescriptionUrls(html: string, origin: string): string {
  // Signed Canvas attachment URLs may embed access credentials in their query string.
  return html.replace(/\b(href|src|data-src)\s*=\s*(["'])(.*?)\2/gi, (_match, attr, quote, raw) => {
    try {
      const u = new URL(raw, origin);
      if (u.protocol !== 'https:') return `${attr}=${quote}#${quote}`;
      u.search = ''; u.hash = '';
      return `${attr}=${quote}${u.href}${quote}`;
    } catch { return `${attr}=${quote}#${quote}`; }
  });
}

export function getAssignmentFull(data: LocalData, courseId: number, assignmentId: number) {
  const course = data.courses.find(c => c.id === courseId);
  if (!course) throw new Error(`课程 ID ${courseId} 不存在`);
  const a = (data.byCourse[courseId] || []).find(a => a.id === assignmentId);
  if (!a) throw new Error(`作业 ID ${assignmentId} 不存在`);
  const origin = data.canvasOrigin || 'https://hkust-gz.instructure.com';
  const html = sanitizeDescriptionUrls(a.description || '', origin);
  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map(([tag]) => ({
    alt: tag.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] || '',
    url: safeCanvasUrl(tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2]),
  }));
  const links = [...html.matchAll(/<a\b[^>]*>/gi)].map(([tag]) =>
    safeCanvasUrl(tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2])).filter(Boolean);
  return {
    courseId, courseCode: course.code, assignmentId, name: a.name,
    status: assignmentStatus(a), dueAt: a.due_at, dueLocal: formatDeadline(a.due_at),
    points: a.points, canvasUrl: safeCanvasUrl(a.url, origin),
    descriptionText: decodeText(html), descriptionHtml: html,
    images, links,
    attachments: (a.attachments || []).map(att => ({
      id: att.id, filename: att.filename, size: att.size ?? null,
      contentType: att.content_type || null, canvasUrl: `${origin}/courses/${courseId}/files/${att.id}`,
    })),
    submission: a.sub || null,
  };
}
