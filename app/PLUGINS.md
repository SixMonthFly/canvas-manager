# Canvas 4.0 插件结构

4.0.0 将原有 AI 助手从主程序中独立为随包插件。首次启动已安装但默认不启用；用户在“设置 → 插件”勾选后，可以使用作业解读、作业方案、公告摘要、课程结构分析和模型配置。取消勾选停用插件；“卸载”会移除用户目录中的运行文件，并在重启后保持未安装。之后可从安装包中的副本重新安装，完成后默认关闭。旧版 AI 配置与报告保留，不会因为升级、停用或卸载而删除，也不会依据旧配置自动启用插件。

皮肤使用同一个安装与卸载宿主。首次仅安装 HKUST，Claude、ChatGPT 和深色皮肤按需安装；外观选择只列出已安装的皮肤。外观插件提供 CSS、字体和主题描述，只在渲染器注册资源，不激活主进程方法。卸载当前皮肤时回到已安装的 HKUST，或底座的基础外观。底座即使没有任何皮肤也能使用。

设置页统一使用“保存”提交外观、诊断选项及已启用插件的配置；取消放弃配置草稿。AI 插件通过通用、可撤销的设置保存回调参与，不提供自己的保存按钮。插件安装、卸载与启停是即时操作，不随取消回退。测试 AI 连接与能力探测仅使用草稿，不能将未保存的配置写入文件。

## 组成与边界

### Mac 原生系统小组件（2026-10-02）

用户明确要求 macOS 桌面原生小组件后，新增 `native-assignments`，名称为“Mac 系统小组件”。它是可安装、卸载和启停的数据提供插件，首次安装但默认关闭。启用后将当前课程的待交作业摘要导出到用户目录 `~/Library/Application Support/canvas-manager/widget-data/snapshot.json`，同步成功后更新并请求 WidgetKit 重载。只含课程代码、作业标题、ID、截止时间和同步时间，不包含作业正文、附件、AI 配置或登录会话。

`native/macos-widget/` 是 SwiftUI / WidgetKit 原生扩展，随 Mac 完整应用包部署到 `Contents/PlugIns/CanvasAssignmentsWidget.appex`，提供小、中、大三种尺寸。用户通过桌面右键“编辑小组件”添加，而非应用窗口。小尺寸展示前两项，中尺寸展示前两项并支持点击具体作业，大尺寸展示前六项；额外作业显示数量并引导打开应用。原生时间线根据缓存重新计算滚动 168 小时范围，因此客户端退出后仍可显示最近同步内容；刷新时机最终由 macOS 决定。

发布器保留全部待交作业摘要，让原生时间线在应用退出后仍可纳入随后进入七天范围的截止项。停用或卸载发布器时写入禁用且清空的摘要；完全退出客户端保留上次摘要。宿主的 `dispose({ reason })` 新增 `shutdown` 与 `deactivate` 区分，原有插件可以忽略此参数。卸载只删除用户目录中的发布器代码，不会修改已签名 `.app` 内的原生扩展；已添加到桌面的系统小组件由用户通过系统菜单移除，不能称为应用内独立卸载原生扩展。

`core/native-widget-service.cjs` 注入原子摘要发布与原生刷新能力。`CanvasWidgetBridge` 随应用放在 `Contents/MacOS/`，由底座调用 WidgetCenter。作业链接使用固定 `canvas-manager://assignment/<courseId>/<assignmentId>` 协议；严格验证数字 ID，等待主渲染器准备完毕后定位已有课程与作业，不接受代码路径或任意文件 URL。

当前本机开发包为 ad-hoc 签名。原生扩展开启 App Sandbox，仅通过只读路径授权读取上述单个摘要文件；未给扩展课程目录、登录会话或 AI 数据访问权限。该本地方案并非已验证的 App Store 发布方案；未来正式签名与 App Groups 共享方式需要另行配置验证。原生扩展、辅助程序及 URL 协议属于完整 Mac 安装包内容，本轮没有实现小包更新或外部插件下载。Windows 打包不编译或嵌入此扩展，启用此插件需具备原生 Mac 运行文件。

原生数据验证：`node --test app/tests/native-widget.test.cjs`；Swift 筛选与缓存解码验证：`xcrun swiftc -parse-as-library app/native/macos-widget/WidgetData.swift app/tests/native-widget-data.swift -o output/native-widget/native/data-tests` 后运行该二进制。原生编译：`node app/scripts/build-native-widget.cjs`。electron-builder 的 Mac `afterPack` 会自动编译和嵌入原生文件，随后对完整应用签名；需在 Mac 上打包，未验证 Windows 上的 Mac 交叉构建。

### Mac 七天作业桌面卡片（2026-10-02）

`desktop-assignments` 是独立随包功能插件，首次安装但默认关闭。在“设置 → 插件”启用后出现可拖动的桌面卡片；隐藏后可使用同处的“显示桌面卡片”恢复。仅支持 Mac，是 Electron 辅助窗口，不属于 macOS WidgetKit 系统小组件。应用后台运行时可显示，完全退出后关闭。

卡片使用已同步的数据，展示从当前时刻至未来 168 小时内截止的已发布作业，按截止时间排序。默认隐藏已提交、已评分项，可在卡片内切换“显示已提交”；过期、无截止时间和已移出当前课程列表的缓存作业不参与。点击作业打开主界面详情。同步成功时刷新，每分钟重新计算截止范围，并显示上次同步时间；不发起额外的 Canvas 网络请求。

`plugins/desktop-assignments/` 包含筛选逻辑、后台生命周期、专用受限 preload、卡片界面和设置入口。后台通过注入的 `canvas`、`storage`、`desktop` 服务工作，不导入 Electron。`core/desktop-service.cjs` 提供通用窗口创建，限制调用来自所属窗口的主 frame，阻止导航与新窗口。插件停用、卸载和退出时销毁窗口并撤销监听与计时器。拖动位置、“置顶”和“显示已提交”在卡片操作时即时写入 `desktop_assignments.json`；卸载保留这些偏好和全部课程数据，重新安装仍默认关闭。

验证：`node --test app/tests/desktop-assignments.test.cjs`，`node app/tests/desktop-assignments-electron.cjs`。后者在两个隔离 Electron 进程中使用合成课程验证实际设置、窗口、详情跳转、置顶、空状态、同步刷新、停用、卸载及重启后的偏好保留，不访问真实 Canvas。

本功能未实现外部插件下载或客户端小包更新；测试旧版安装时仍需构建完整 Mac 应用。

### 通用宿主

- `plugins/catalog.json`：可信内置插件清单，声明 ID、版本、插件契约版本、默认启用状态、依赖的服务及前后端入口。
- `core/plugin-manager.cjs`：后台生命周期、服务注入、调用分发、事件隔离与启用状态持久化。核心主进程只接入这个宿主，不导入 AI 实现。
- `core/plugin-install-store.cjs`：校验随包插件的文件、契约与入口，将运行副本安装至 `data/installed-plugins/<id>/<generation>/`，负责安装与卸载的文件事务。新的安装代次具有独立路径，使重新安装不会沿用旧模块缓存。
- `plugins/ai/main.cjs`：模型配置、请求、材料提取与课程分析。通过注入的 `canvas`、`storage`、`diagnostics` 服务访问同步后的数据、下载及诊断能力，不导入 Electron 主程序。
- `plugins/ai/renderer.mjs`、`style.css`：AI 的按钮、输出区、看板与配置。启用时动态加载，并通过通用界面扩展点注册；停用时撤销。
- `plugins/themes/*`：独立的皮肤 CSS、主题描述及可选字体。通过 `ui.registerTheme` 声明主题，不在底座中硬编码可选皮肤的样式。
- `preload.js`：固定通用桥接 `pluginsList`、`pluginSetEnabled`、`pluginInstall`、`pluginUninstall`、`pluginInvoke`、`onPluginEvent`、`onPluginsChanged`。不随每个插件增加专有 IPC API。

主进程插件契约版本目前为 `1`：

```js
module.exports = {
  activate(ctx) {
    const courses = ctx.services.canvas;
    ctx.effect(() => { /* 清理监听、计时器或其他注册 */ });
    return {
      methods: { /* methodName: (...args) => result */ },
      isBusy: () => false,
      dispose: async () => { /* 可选的异步收尾 */ },
    };
  },
};
```

`ctx.services` 仅提供清单 `requires` 所声明的服务。`ctx.emit(event, data)` 发布插件所属事件，停用及再次启用后，旧实例的事件不会流入新实例。`ctx.effect(disposer)` 收集清理函数，卸载时按逆序执行；激活失败也清理已经注册的行为。清理注册并不能自动撤销文件写入或网络操作，插件必须自行处理任务取消和异步结果失效。

安装和启用状态写入应用数据目录的 `plugins.json`（打包版本位于用户目录，开发模式位于仓库 `data/`），使用临时文件和原子替换。安装状态与启用状态分别记录。旧 schema 1 的启用偏好迁移至 schema 2；旧用户启用过的插件继续启用，新用户保持默认关闭。状态文件存在但损坏时，不会自动安装或执行插件，用户可在设置中重新安装。

清单的 `defaultInstalled` 控制新插件是否随初次启动安装，显式未安装记录优先于后续清单默认值。`kind: "theme"` 表示仅提供外观的插件，安装后由渲染器注册主题，不接受后台启用请求；功能插件保留原有安装与启用分离的行为。

插件文件先写入临时目录并校验，再切换至独立安装目录；未安装的插件不能启用或调用。启用失败不保存为成功；保存失败回退刚创建的实例。后台调用进行中时拒绝停用或卸载，用户可等待完成或取消课程分析。卸载只处理插件代码，不触碰 `ai_config.json`、`analysis_*.json`、课程、课件或会话。退出时阻止新调用和事件，并要求插件中止请求。插件安装与启用偏好在下次启动恢复。

## 这次借鉴 skill 的范围

参考了桌面 `everything-is-a-plugin/SKILL.md` 中的能力契约、依赖注入和可逆注册建议。项目目前保留 CommonJS 主进程和原生 JavaScript 界面，以显式服务对象和小型宿主管理已存在的插件边界，没有引入 DI 框架、monorepo 或为每个单实现功能建立三套包。

该 skill 的部分说法不能当成普遍规则：组合入口可以导入具体实现；接口或普通对象也能声明契约，不必强制使用抽象类；可逆注册不代表所有任务都能安全热重载。文中 DeepSeek Harness 的来源、星数与实现描述未作核实，本项目不以这些描述作为设计依据。

## 扩展与更新

现阶段安装来源只接受应用包中的可信清单，文件 SHA-256 以该清单为准；用户偏好文件只能选择已有 ID，不能提供代码路径。`.app` 内的源副本保持不变，运行副本可以卸载，因此重新安装不需要联网。主进程插件具有 Node.js 权限，服务注入不构成安全沙箱。

开发时修改插件文件后运行 `npm run plugins:prepare` 更新清单；`npm run plugins:check` 校验内容，启动与打包会拒绝过期的清单。直接运行 electron-builder 和交叉打包脚本也会执行打包前检查。

未来可把底座和插件分开发布至 GitHub。届时仍需实现可信发布者签名、在线清单与下载、独立版本兼容、更新和回退。当前没有 GitHub 插件下载、外部插件商店或任意本地代码安装入口；本地哈希校验不能替代未来远程包的来源认证。

插件启停与客户端小包更新是两个不同机制。4.0.0 此次实现插件拆分，没有实现固定更新启动器、签名清单、代码包原子切换和失败回退，不能宣称已经支持热更新。独立 MCP 服务继续使用已有实现，官网 MCP 介绍保留。

验证：`node --test app/tests/plugin-manager.test.cjs app/tests/plugin-install.test.cjs app/tests/ai-plugin.test.cjs`；真实渲染器交互验证运行 `app/tests/interaction-electron.cjs`。`node app/tests/plugin-install-electron.cjs` 使用两个独立 Electron 进程验证物理卸载、重启、重新安装及配置与报告保留；可用 `CANVAS_TEST_APP_ROOT` 指向最终 ASAR。全部测试使用合成课程与模拟模型接口，不访问 Canvas 或真实 AI 服务。
