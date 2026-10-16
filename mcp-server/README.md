# Canvas Study Assistant MCP Server

Model Context Protocol (MCP) 服务器,让 AI Agent 可以访问你的 Canvas 课程数据,实现:

- 📅 **定时查作业**:自动检查今天/本周截止的作业
- ✍️ **作业辅助**:读取作业说明,帮助理解任务要求
- 📊 **学习追踪**:课程概览、已交/待交统计
- 🔍 **智能搜索**:按关键词搜索作业

## 前置要求

1. 已安装并运行过 Canvas Manager 桌面应用,本地数据路径:
   - Windows: `%APPDATA%\canvas-manager\data`
   - macOS: `~/Library/Application Support/canvas-manager/data`
   - Linux: `~/.config/canvas-manager/data`

2. Node.js >= 18

## 安装

```bash
cd mcp-server
npm install
npm run build
```

## 配置 Codex

构建后运行以下命令接入桌面开发版的数据：

```powershell
codex mcp add canvas-study-assistant --env 'CANVAS_DATA_DIR=D:\canvas-manager\data' --env 'CANVAS_TIME_ZONE=Asia/Shanghai' -- 'C:\Program Files\nodejs\node.exe' 'D:\canvas-manager\mcp-server\dist\index.js'
codex mcp get canvas-study-assistant --json
```

按实际位置调整 Node 和项目路径。若使用安装版，将 `CANVAS_DATA_DIR` 改为 `%APPDATA%\canvas-manager\data` 的绝对路径。`sync_courses` 需要对应的桌面应用正在运行；它通过本机带令牌管道调用应用现有同步流程。其余查询只读取本地缓存。MCP 不提交作业。时间显示使用 `CANVAS_TIME_ZONE`，默认 `Asia/Shanghai`，并明确标出时区。

若当前 Codex 任务尚未出现新工具，重启 Codex 后再试。构建及测试：`npm run build`，然后 `node --test tests/time.test.mjs tests/features.test.mjs tests/sync-client.test.mjs tests/mcp-integration.test.mjs`。

新增查询：`get_sync_status` 查看数据时间，`list_assignments` 按课程、状态和北京时间日期筛选，`get_assignment_full` 读取完整说明与附件元数据，`get_sync_changes` 对比上次检查的作业公告，`sync_courses` 触发桌面应用同步。首次变化检查只建立基线；之后的更改会保存在本地的 `data/mcp_changes.json`。

## 配置 ZCode

在 ZCode 配置文件中添加(路径根据平台而定):

**Windows** (`%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "canvas-study-assistant": {
      "command": "node",
      "args": ["D:\\canvas-manager\\mcp-server\\dist\\index.js"],
      "env": {
        "CANVAS_DATA_DIR": "C:\\Users\\你的用户名\\AppData\\Roaming\\canvas-manager\\data"
      }
    }
  }
}
```

**macOS/Linux**:

```json
{
  "mcpServers": {
    "canvas-study-assistant": {
      "command": "node",
      "args": ["/path/to/canvas-manager/mcp-server/dist/index.js"],
      "env": {
        "CANVAS_DATA_DIR": "/Users/你的用户名/Library/Application Support/canvas-manager/data"
      }
    }
  }
}
```

重启 ZCode 后,MCP 服务器会自动连接。

## 可用资源 (Resources)

Agent 可以直接读取这些资源:

- `canvas://courses` - 课程列表
- `canvas://assignments/pending` - 待交作业
- `canvas://assignments/overdue` - 过期未交作业
- `canvas://announcements/recent` - 最近 7 天公告
- `canvas://course/{课程ID}/assignments` - 指定课程的作业列表

## 可用工具 (Tools)

Agent 可以调用这些工具:

### `get_pending_assignments`
获取所有待交作业,按截止时间排序。

### `get_assignment_detail`
获取作业完整信息(说明、附件、截止时间)。

**参数:**
- `courseId`: 课程 ID
- `assignmentId`: 作业 ID

### `check_deadline_today`
检查今天是否有作业截止。

### `get_course_summary`
获取课程概览(作业统计、最近公告)。

**参数:**
- `courseId`: 课程 ID

### `search_assignments`
按关键词搜索作业。

**参数:**
- `keyword`: 搜索关键词

## 使用示例

在 ZCode/Claude Desktop 里直接对话:

```
你: 今天有什么作业要交吗?
AI: [调用 check_deadline_today] 今天有 2 项作业截止:
    - [COMP3711] Assignment 3 - 今晚 23:59
    - [MATH2411] Homework 5 - 今天 18:00

你: 帮我看看 COMP3711 的 Assignment 3 要做什么
AI: [调用 get_assignment_detail] 这个作业要求实现...
```

```
你: 我这周有多少作业要交?
AI: [读取 canvas://assignments/pending] 本周有 5 项作业待交,最近的是...
```

```
你: 搜索所有关于"期末"的作业
AI: [调用 search_assignments with keyword="期末"] 找到 3 项...
```

## 定时提醒(需配合 Cron/任务计划)

可以配合系统 cron 或 ZCode 的 CronCreate 实现每天早上自动检查:

```
你: 每天早上 8 点检查今天是否有作业截止,如果有就提醒我
AI: [调用 CronCreate] 已创建定时任务,每天 8:00 自动执行
```

## 故障排查

### MCP 服务器未连接

1. 检查 ZCode MCP 配置文件路径是否正确
2. 检查 `CANVAS_DATA_DIR` 路径是否存在
3. 查看 ZCode 输出面板的 MCP 日志

### 数据为空

Canvas Manager 桌面应用需要先同步一次数据,点击右上角"⟳ 同步"。

### 路径找不到

如果 Canvas Manager 使用了自定义数据路径,需要在 `env.CANVAS_DATA_DIR` 里指定。

## 开发

```bash
# 监听模式(代码改动自动重新编译)
npm run watch

# 使用 MCP Inspector 调试
npm run inspector
```

## 许可

MIT
