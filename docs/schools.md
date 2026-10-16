# 多校 Canvas 适配


## 首批学校

| 学校 | Canvas 地址 | 公开依据 |
| --- | --- | --- |
| 香港科技大学（广州） | https://hkust-gz.instructure.com | 原有默认学校 |
| 香港科技大学 | https://canvas.ust.hk | [学校课程说明](https://seng.hkust.edu.hk/sites/default/files/IMCE/UG/Course%20Syllabus/Spring_2024-2025/ENTR1001_Spring%202024-25.pdf)，入口重定向至学校 CAS |
| 香港城市大学 | https://canvas.cityu.edu.hk | [学校学习资源](https://www.ds.cityu.edu.hk/en/student-enrichment/academic-advising)，入口重定向至学校认证 |
| 新加坡国立大学 | https://canvas.nus.edu.sg | [学校登录说明](https://nus.atlassian.net/wiki/spaces/canvasstudent/pages/12550496/Log%2Bin%2Bto%2BCanvas) |
| 新加坡社科大学 | https://canvas.suss.edu.sg | [学校资源指南](https://learningservices.suss.edu.sg/assets/pdf/QuickGuideTo5EssentialResources.pdf)，[当前 Canvas 登录入口](https://lmslogin.suss.edu.sg/) |

| 哈佛大学 | https://canvas.harvard.edu | [学校官方资料](https://atg.fas.harvard.edu/canvas-behind-scenes) |
| 牛津大学 | https://canvas.ox.ac.uk | [学校官方资料](https://login.canvas.ox.ac.uk/) |
| 墨尔本大学 | https://canvas.lms.unimelb.edu.au | [学校官方资料](https://study.unimelb.edu.au/study-with-us/online-courses/current-students/online-systems-support/lms) |
| 奥克兰大学 | https://canvas.auckland.ac.nz | [学校官方资料](https://teachwell.auckland.ac.nz/canvas/canvas-baseline-practices-2/2-orientation-to-course/) |
| 金山大学 | https://ulwazi.wits.ac.za | [学校官方资料](https://www.wits.ac.za/ulwazi/) |
| 智利天主教大学 | https://cursos.canvas.uc.cl | [学校官方资料](https://cddoc.uc.cl/servicios/canvas/) |

新增预设覆盖北美洲、欧洲、大洋洲、非洲及南美洲。学校官方入口已核实，但不代表真实账号同步、MFA 或 API 权限已验收。

只收录已核实的 Canvas 部署，不代表覆盖当地全部高校或各校所有课程。SUSS 同时出现 Learnova 服务，当前预设只处理其 Canvas 课程。其他 LMS 需要独立适配器。

## 使用

设置 → 常规 → 学校，选择后点击保存，应用会自动重启，再点击同步完成学校认证。取消不会保存学校草稿。窗口标题和设置页显示当前学校；登录成功以 Canvas 用户 API 返回有效用户为准，不把同域登录页视为已认证。

## 数据与配置

- 原港科广 `data/`、`persist:canvas` 会话、插件配置、AI 报告和外观设置保留原位置。
- 其他学校使用 `data/schools/<schoolId>/` 和独立 Electron 登录分区；插件安装状态、AI 配置、报告、下载及提醒随学校隔离。新学校默认不安装任何皮肤，使用基础外观；AI 默认关闭，已安装皮肤保留。
- 当前版本按学校隔离，不提供同一学校多账号切换功能。
- `data/school.json` 保存待启用选择。`data/active-school.json` 记录客户端已经启用的学校，只有重启才切换。各数据目录的 `school-context.json` 保存链接使用的 Canvas origin。
- MCP 跟随已经启用的学校，切校后不需要重启 MCP。更新过 MCP 源码后仍须单独构建、重启服务一次，不能将客户端更新当作 MCP 已更新。
- `CANVAS_DATA_DIR` 可指向根 `data/`（跟随当前学校），也可指向某学校的具体目录（固定查询该目录）。Python CLI 也遵循此规则；默认仍读仓库 `data/`。
- Python 直连模式在其他学校不复用旧 `.token`，需提供 `CANVAS_TOKEN` 或对应学校数据目录的 `.token`，并明确指定课程 ID。
- 切校时清空可用的原生小组件旧快照，新学校启用插件后重新发布。Unix 同步通道在数据路径过长时使用基于完整路径哈希的短 socket，继续使用本地令牌校验和 0600 权限。

## 验证与边界

自动化覆盖：十一校配置与登录会话选择、同域登录页检查、恶意域名拒绝、图片链接、MCP 链接与学校切换、长路径同步 socket。真实 Electron 测试使用隔离的合成数据，覆盖设置取消、保存后当前学校不变、重启切至 NUS、切回港科广后恢复原课程。它们不访问真实学校账号。

待逐校验证：SSO/MFA 是否允许 Electron 登录、学生角色 API 权限、课程分页、公告、附件和图片、会话过期与重登。测试通过不代表这些远端条件已通过。


