# Canvas Study Assistant MCP - 使用演示

## 配置步骤

### 1. 找到你的 Canvas Manager 数据路径

打开 Canvas Manager 应用,点击右上角"⚙ 设置",在底部会显示数据保存路径,例如:
- Windows: `C:\Users\你的用户名\AppData\Roaming\canvas-manager\data`
- macOS: `/Users/你的用户名/Library/Application Support/canvas-manager/data`

### 2. 配置 MCP Server

**在 ZCode 中配置:**

1. 打开 ZCode 设置文件
2. Windows 路径: `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\cline_mcp_settings.json`
3. macOS/Linux 路径: `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`

添加配置:

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

**在 Claude Desktop 中配置:**

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) 或
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "canvas-study-assistant": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": {
        "CANVAS_DATA_DIR": "/Users/你的用户名/Library/Application Support/canvas-manager/data"
      }
    }
  }
}
```

### 3. 重启 IDE/Claude Desktop

配置保存后,重启 ZCode 或 Claude Desktop,MCP Server 会自动连接。

## 对话示例

### 场景 1: 早上起床,检查今天的任务

```
👤 你: 早上好,今天有什么作业要交吗?

🤖 AI: [调用 check_deadline_today]
     ✅ 今天没有作业截止,可以安心安排其他学习任务!

👤 你: 那这周呢?

🤖 AI: [读取 canvas://assignments/pending]
     本周有 5 项待交作业:

     1. [COMP3711] Assignment 3 - Dynamic Programming
        截止: 2024-09-25 23:59 (还剩 2 天)
        分值: 100 分

     2. [MATH2411] Homework 5 - Linear Algebra
        截止: 2024-09-26 18:00 (还剩 3 天)
        分值: 50 分

     3. [PHYS1112] Lab Report 4
        截止: 2024-09-27 23:59 (还剩 4 天)
        分值: 20 分

     建议优先完成 COMP3711 的作业,分值最高且难度较大。
```

### 场景 2: 准备做作业,理解任务要求

```
👤 你: 帮我看看 COMP3711 Assignment 3 具体要做什么

🤖 AI: [调用 get_assignment_detail with courseId=12345, assignmentId=67890]

     课程: COMP3711 - Design and Analysis of Algorithms
     标题: Assignment 3 - Dynamic Programming
     截止: 2024-09-25 23:59
     分值: 100

     说明:
     This assignment focuses on dynamic programming techniques.

     Problems:
     1. Longest Common Subsequence (30 points)
        - Implement LCS algorithm
        - Time complexity analysis required

     2. Knapsack Problem (40 points)
        - 0/1 knapsack with optimization
        - Space-optimized solution for bonus

     3. Matrix Chain Multiplication (30 points)
        - Find optimal parenthesization
        - Reconstruct solution path

     Submission:
     - Submit both code and report
     - Code should be well-commented
     - Report should include complexity analysis

👤 你: 帮我制定一个完成计划

🤖 AI: 根据作业要求和剩余时间(2天),建议以下计划:

     Day 1 (今天):
     - 上午: 复习动态规划基础概念,理解 LCS 算法原理
     - 下午: 完成 Problem 1 的代码实现和测试
     - 晚上: 完成 Problem 2 的基础实现

     Day 2 (明天):
     - 上午: 优化 Problem 2,尝试空间优化版本(bonus)
     - 下午: 完成 Problem 3
     - 晚上: 整理报告,撰写复杂度分析,最终检查

     Tips:
     - 每个问题完成后立即写好注释和复杂度分析
     - 预留至少 2 小时用于报告撰写和整体检查
     - 建议 23:00 前提交,避免最后时刻网络问题
```

### 场景 3: 搜索特定主题的作业

```
👤 你: 搜索所有关于"期末"或"final"的作业

🤖 AI: [调用 search_assignments with keyword="final"]

     找到 3 项匹配的作业:

     1. [COMP3711] Final Project Proposal
        状态: pending | 截止: 2024-11-15 23:59

     2. [MATH2411] Final Exam Review Problems
        状态: pending | 截止: 2024-12-05 18:00

     3. [PHYS1112] Final Lab Report
        状态: done | 截止: 2024-11-30 23:59

     其中 PHYS1112 的 Final Lab Report 已提交。
```

### 场景 4: 课程概览

```
👤 你: 给我看看 COMP3711 这门课的整体情况

🤖 AI: [调用 get_course_summary with courseId=12345]

     课程: COMP3711 - Design and Analysis of Algorithms

     作业统计:
     - 总数: 8
     - 待交: 2
     - 过期: 0
     - 已交: 6

     完成进度: 75% (6/8)

     最近公告 (3):
     - Assignment 4 Released
       2024-09-20
     - Midterm Exam Schedule Announced
       2024-09-18
     - Office Hour Time Change
       2024-09-15

     建议: 保持良好的完成节奏,继续努力!
```

### 场景 5: 设置定时提醒

```
👤 你: 每天早上 8 点帮我检查今天是否有作业截止,如果有就提醒我

🤖 AI: 好的,我为你创建一个每日提醒任务:

     [调用 CronCreate with cron="0 8 * * *"]

     ✅ 已创建定时任务"每日作业截止检查"

     执行时间: 每天 08:00
     任务内容: 检查当天截止的作业并发送提醒

     如果当天有作业截止,你会在早上 8 点收到通知。
```

## 高级用法

### 结合 AI 辅助学习

```
👤 你: 我对 COMP3711 的 Assignment 3 的 Matrix Chain Multiplication 不太理解,
     能帮我讲解一下吗?

🤖 AI: [读取作业详情] 好的,让我为你讲解 Matrix Chain Multiplication 问题...

     (AI 会结合作业具体要求,给出详细的讲解、示例代码和解题思路)
```

### 批量查询

```
👤 你: 帮我列出所有课程中过期未交的作业

🤖 AI: [读取 canvas://assignments/overdue]

     ⚠️ 发现 1 项过期未交作业:

     - [MATH2411] Homework 4
       截止: 2024-09-15 18:00 (已过期 8 天)
       分值: 50

     建议尽快联系老师说明情况,争取补交机会。
```

## 故障排查

### 问题 1: AI 说"无法访问 Canvas 数据"

**原因:** 数据路径配置错误或 Canvas Manager 未同步数据

**解决:**
1. 打开 Canvas Manager,点击"⟳ 同步"
2. 检查 `CANVAS_DATA_DIR` 路径是否正确
3. 确认该路径下有 `courses.json` 文件

### 问题 2: 配置后没有效果

**原因:** MCP Server 未正确连接

**解决:**
1. 重启 IDE/Claude Desktop
2. 查看 ZCode 输出面板的 MCP 日志
3. 手动测试: `node mcp-server/dist/index.js` 应输出 "Canvas Study Assistant MCP Server running on stdio"

### 问题 3: 数据不是最新的

**原因:** MCP Server 读取的是本地缓存

**解决:**
在 Canvas Manager 里点击"⟳ 同步",数据会自动更新,下次 AI 查询时会读取新数据。

## 隐私说明

- MCP Server 只读取本地数据,不会连接任何外部服务
- 所有数据都保存在你自己的电脑上
- AI 对话内容会发送到 AI 服务商(Anthropic/OpenAI),但不会包含你的 Canvas 登录凭证
- 如果不想使用此功能,删除 MCP 配置即可完全禁用
