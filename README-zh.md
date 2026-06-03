# desktop-proxy

> 通用 Electron 应用注入框架，用于请求拦截与 UI 定制。

> English version: [README.md](./README.md)

`desktop-proxy` 会给本地安装的 Electron 应用打补丁，使其启动时先加载一个小型 runtime。
该 runtime 位于应用包**之外**，负责发现本地插件并把它们注入到主进程与渲染进程——
让你在**无需重新打包目标应用**的前提下拦截网络流量、修改 UI、添加设置页。

它是 [Codex++](./third-project/codex-plusplus) 思路（原本仅针对 Codex）的泛化版本，
适用于任意 Electron 应用（Codex、Cursor、Windsurf，或任何你用 `--app` 指定的应用）。

> ⚠️ 非官方工具。它会修改磁盘上的应用包并在其中运行本地代码。
> 只安装你信任来源的插件，使用风险自负。

---

## 目录

- [工作原理](#工作原理)
- [仓库结构](#仓库结构)
- [环境要求](#环境要求)
- [从源码构建](#从源码构建)
- [CLI 用法](#cli-用法)
- [文件位置](#文件位置)
- [编写插件](#编写插件)
- [Plugin API](#plugin-api)
- [安全与恢复](#安全与恢复)
- [日志](#日志)
- [隐身模式](#隐身模式)
- [平台支持](#平台支持)
- [开发说明](#开发说明)

---

## 工作原理

### 安装流程（`desktop-proxy install`）

1. **定位**目标 `.app` 包（内置已知应用，或 `--app` 指定）。
2. **备份**原始的 `app.asar`、`app.asar.unpacked` 和 `Electron Framework`。
3. **给 `app.asar` 打补丁**：把 `package.json#main` 改写为一个极小的 loader 桩
   （`desktop-proxy-loader.cjs`），并把原始入口记录在 `__desktop_proxy.originalMain`。
4. **恢复完整性校验**：重算 asar header 的 SHA-256 写回 `Info.plist` →
   `ElectronAsarIntegrity`，再把 Electron fuse `EnableEmbeddedAsarIntegrityValidation`
   翻为 `off`。
5. **重新签名**（macOS，使用本地自签名身份）并清除 quarantine 属性。
6. **部署** runtime 和一个默认插件到用户数据目录。

### 运行流程（每次启动）

```
应用启动
  └─ desktop-proxy-loader.cjs            (位于 app.asar 内)
       └─ require(<userRoot>/runtime/main.js)   ← 主进程
            ├─ hook session.setPreloads → 注入 preload.js
            ├─ 注册 IPC 桥
            └─ 加载主进程作用域插件
       └─ require(originalMain)           ← 目标应用正常启动

渲染窗口创建
  └─ preload.js 在页面 JS 之前运行
       ├─ 安装 React DevTools 全局 hook（用于访问 fiber）
       ├─ hook window.fetch / XMLHttpRequest（网络拦截）
       ├─ 安装设置面板（隔离的 Shadow-DOM 浮层）
       └─ DOMContentLoaded 后 → 插件宿主加载渲染进程作用域插件
```

由于渲染进程运行在沙盒中，插件源码会通过 IPC 从主进程获取，并在 preload 上下文里用
`new Function(...)` 执行。

---

## 仓库结构

这是一个 [pnpm](https://pnpm.io) workspace monorepo。

| 包 | 名称 | 职责 |
|---|---|---|
| `packages/loader` | `@desktop-proxy/loader` | 复制进目标 `app.asar` 的极小 `loader.cjs` 桩。先启动 runtime，再移交原始入口。 |
| `packages/runtime` | `@desktop-proxy/runtime` | 主进程 runtime。hook Electron session、管理插件、暴露 IPC 桥、监听插件热重载。 |
| `packages/preload` | `@desktop-proxy/preload` | 渲染进程 preload。React hook + 网络拦截器 + 插件宿主。 |
| `packages/plugin-sdk` | `@desktop-proxy/plugin-sdk` | 给插件作者的 TypeScript 类型与 `validateManifest()`。 |
| `packages/installer` | `@desktop-proxy/installer` | `desktop-proxy` CLI：asar 打补丁、fuse 翻转、代码签名、install/uninstall/status/repair。 |
| `packages/plugins/request-interceptor` | — | 内置示例插件，捕获 AI 服务的请求/响应。 |

`third-project/` 包含 vendored 的参考项目（[codex-plusplus](./third-project/codex-plusplus)
与 [v8_killer](./third-project/v8_killer)），已排除在版本控制之外。

---

## 环境要求

- **Node.js** ≥ 18（基于 Node 22 开发）
- **pnpm** ≥ 10
- 完整安装路径需要 **macOS**（`codesign`、`plutil`、`security`、`openssl`）。
  其它平台可以构建并运行各包，但安装器以 macOS 为主。

---

## 从源码构建

```bash
pnpm install
pnpm build
```

也可以单独构建某个包：

```bash
pnpm build:loader
pnpm build:runtime
pnpm build:preload
pnpm build:installer
pnpm build:plugin-sdk
```

其它 workspace 脚本：

```bash
pnpm typecheck   # 对所有包执行 tsc --noEmit
pnpm test        # 运行 Vitest 测试套件
pnpm test:watch  # Vitest 监听模式
pnpm dev         # 对所有包执行 tsc --watch
pnpm clean       # 删除每个包的 dist/
```

> 注意：`electron` 仅作为 `runtime`/`preload` 的**开发依赖**用于类型定义——
> 已跳过 Electron 二进制的下载。

---

## CLI 用法

构建后，CLI 入口为 `packages/installer/dist/cli.js`。

```bash
node packages/installer/dist/cli.js <command> [options]
```

| 命令 | 说明 |
|---|---|
| `install` | 给 Electron 应用打补丁并部署 runtime。 |
| `uninstall` | 从备份恢复原始应用。 |
| `status` | 显示安装状态、asar 哈希、fuse 状态。 |
| `repair` | 目标应用更新后重新打补丁。 |
| `safe-mode [on\|off]` | 禁用所有插件运行应用（不带参数则切换）。 |
| `logs [--follow] [--lines N]` | 打印（或实时跟随）runtime 日志。 |
| `doctor [--json]` | 诊断安装状态（健康检查）。 |
| `plugin list [--json]` | 列出已装插件及启用状态。 |
| `plugin enable\|disable <id>` | 启用/禁用插件（app 运行时即时生效）。 |
| `plugin check-updates [--json]` | 检查各插件 `githubRepo` 是否有新版本。 |
| `config get [key] [--json]` | 打印配置（或单个键）。 |
| `config set <key> <value>` | 设置配置键（`logLevel`/`stealth`/`safeMode`/`autoUpdate`/`enforcePermissions`/`maxResponseBodyBytes`/`cdpNetwork`/`cdpIntercept`/`cdpStreamTransform`/`cdpWsTransform`/`captureTraffic`）。 |
| `watch install\|uninstall\|status` | app 更新后自动重打补丁（macOS）。 |
| `create-plugin <dir>` | 脚手架生成新插件（`--id`/`--name`/`--scope`）。 |
| `validate-plugin <dir> [--json]` | 校验插件的 manifest 与入口文件。 |

**选项**（用于 `install` / `repair`）：

| 选项 | 作用 |
|---|---|
| `--app <path>` | `.app` 包路径（省略则自动探测）。 |
| `--no-fuse` | 跳过 Electron fuse 翻转。 |
| `--no-resign` | 跳过 macOS 重新签名。 |
| `--follow, -f` | 跟随日志输出（logs 命令）。 |
| `--lines <n>` | 打印行数（logs 命令，默认 200）。 |
| `--json` | 机器可读输出（`doctor` / `plugin list` / `config get`）。 |
| `--quiet` | 抑制进度输出。 |
| `--verbose` | 显示详细输出。 |

> 读取类命令支持 `--json`，便于其它工具或 AI 程序化驱动
> （如 `doctor --json`、`plugin list --json`、`config get logLevel --json`）。

**示例**

```bash
# 自动探测已知应用（Codex / Cursor / Windsurf）
node packages/installer/dist/cli.js install

# 指定具体的应用包
node packages/installer/dist/cli.js install --app /Applications/Cursor.app

# 查看当前状态
node packages/installer/dist/cli.js status

# 临时禁用插件，再恢复
node packages/installer/dist/cli.js safe-mode on
node packages/installer/dist/cli.js safe-mode off

# 恢复原始应用
node packages/installer/dist/cli.js uninstall
```

> 由于 macOS 的 App Management 保护，修改 `/Applications` 下的应用可能需要提升权限，
> 或在「系统设置」里给终端授予**完全磁盘访问权限**。

---

## 文件位置

所有用户可编辑的内容都放在 `~/.desktop-proxy/`：

| 项目 | 位置 |
|---|---|
| Loader 补丁 | 目标 `app.asar` 内 |
| Runtime | `~/.desktop-proxy/runtime/` |
| 插件 | `~/.desktop-proxy/plugins/` |
| 每插件键值（`api.storage`） | `~/.desktop-proxy/plugin-<id>.json` |
| 每插件文件（`api.fs` 沙盒） | `~/.desktop-proxy/plugin-data/<id>/` |
| 配置 | `~/.desktop-proxy/config.json` |
| 安装状态 | `~/.desktop-proxy/state.json` |
| 日志 | `~/.desktop-proxy/log/`（`main.log`、`loader.log`） |
| 备份 | `~/.desktop-proxy/backup/` |
| 安全模式标志 | `~/.desktop-proxy/safe-mode` |

---

## 编写插件

插件是 `~/.desktop-proxy/plugins/` 下的一个文件夹，含 manifest 与入口文件：

```
my-plugin/
  manifest.json
  index.js
```

用 CLI 脚手架生成并校验：

```bash
node packages/installer/dist/cli.js create-plugin ./my-plugin --name "My Plugin"
node packages/installer/dist/cli.js validate-plugin ./my-plugin
```

**`manifest.json`**

```json
{
  "id": "com.you.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "Adds a settings page and logs requests.",
  "author": "you",
  "main": "index.js",
  "scope": "renderer"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 唯一的反向域名标识符。 |
| `name` | 是 | 可读名称。 |
| `version` | 是 | 语义化版本。 |
| `main` | 是 | 相对插件根目录的入口文件。 |
| `scope` | 是 | `"main"`、`"renderer"` 或 `"both"`。 |
| `description` | 否 | 简短描述。 |
| `author` | 否 | 作者名。 |
| `iconUrl` | 否 | `data:` 或 `https:` 图标 URL。 |
| `githubRepo` | 否 | 用于更新检查的 `owner/repo`。 |
| `minDesktopProxyVersion` | 否 | 所需的最低框架版本（不兼容的插件会被跳过）。 |
| `permissions` | 否 | 使用的能力：`cdp`（始终必需）、`fs` / `network`（见下）。 |

> **权限**：`api.cdp` 始终需要 `cdp` 权限。`api.fs` 与 `api.network` 默认开放，但未声明
> 就使用会打一次警告；设 `enforcePermissions`（`config set enforcePermissions true`）
> 可改为「未声明即拒绝」。

**`index.js`**（CommonJS 模块形态）

```js
module.exports = {
  start(api) {
    api.log.info("plugin started");

    // 在渲染进程拦截网络请求
    api.network.onRequest((req) => {
      api.log.info(`${req.method} ${req.url}`);
      // 返回修改后的请求可改 url/method；不返回则放行
    });

    // 添加一个设置页
    api.settings.registerPage({
      id: "main",
      title: api.manifest.name,
      render(root) {
        root.textContent = "Hello from my plugin.";
      },
    });
  },
  stop() {
    // 可选清理
  },
};
```

插件支持**热重载**：runtime 监听插件目录，文件变化时重新运行渲染进程插件。

---

## Plugin API

`start(api)` 会收到一个 `PluginAPI` 对象（完整类型见
[`packages/plugin-sdk/src/index.ts`](./packages/plugin-sdk/src/index.ts)）：

| 命名空间 | 说明 |
|---|---|
| `api.manifest` | 插件解析后的 manifest。 |
| `api.process` | `"main"` 或 `"renderer"`。 |
| `api.log` | 分级日志（`debug`/`info`/`warn`/`error`）转发到 `main.log`，并提供 `isEnabled(level)` 以保护昂贵日志。 |
| `api.storage` | 持久化键值存储（渲染进程用 `localStorage`，主进程用 JSON 文件）。 |
| `api.settings` | `registerSection` / `registerPage`，渲染到框架的浮层面板。 |
| `api.react` | `getFiber` / `findOwnerByName` / `waitForElement`（渲染进程）。 |
| `api.ipc` | 主进程与渲染进程间带命名空间的 `on` / `send` / `invoke`。 |
| `api.network` | `onRequest` / `onResponse` 观察钩子；`intercept(handler, filter?)` 请求控制（`continue 改写` / `fulfill mock` / `fail 拦阻`）；`interceptResponse(handler, filter?)` 改写真实响应；`transformStream(filter, fn, opts?)` **流式安全地改写流式响应**。观察为流式安全、按 `maxResponseBodyBytes` 截断、二进制跳过、带 `source` 标签。主作用域插件还能看到 `webRequest` 看不到的主进程 Node 流量——`http`/`https`、全局 `fetch`（undici）、`http2`；开启 `cdpNetwork` 后经 CDP 看到所有渲染层请求。`intercept`/`interceptResponse` 在开启 `cdpIntercept` 后经 CDP Fetch 执行——**仅被 `interceptResponse` 命中的 URL 会被缓冲改写**，其余保持流式。主作用域与渲染作用域插件都可注册：渲染端处理器在其渲染进程运行，主进程把每次暂停经 IPC 转给它（先问主作用域）。`transformStream`（开启 `cdpStreamTransform`）注入主世界包裹器，把命中响应体接到 `TransformStream`，逐块或逐 SSE 事件执行你的 `fn`——返回替换内容、`null` 丢弃、`undefined` 透传；`opts.emit`/`opts.onEmit` 把观察数据回流主进程。`onWebSocket(handler)` 经 CDP 被动观察 WebSocket 生命周期/帧（open/sent/received/close/error，开启 `cdpNetwork`）。`transformWebSocket(filter, fn, opts?)`（开启 `cdpWsTransform`）在主世界**双向**改写 WS 文本帧（按 `ctx.direction` 区分 `"send"`/`"receive"`）——返回替换内容、`null` 丢弃、`undefined` 透传（二进制帧不动）。 |
| `api.fs` | 限定在插件数据目录内的沙盒文件 I/O：`read` / `write` / `exists` / `list` / `delete` / `mkdir` / `stat`（utf8 或 base64）。 |
| `api.cdp` | Chrome DevTools Protocol：`attach`/`send`/`on`/`evaluate`，外加 `onResponse`/`onRequestPaused` 便捷封装。渲染进程指向自身 webContents；主进程指向聚焦窗口。需要 `"cdp"` 权限。 |
| `api.ui` | DOM 辅助：`injectCSS()`（返回移除函数）与 `toast()`（宿主隔离的通知）。 |
| `api.app` | `getInfo()` 与 `getWindows()`。 |

### 示例：内置的 request interceptor

[`packages/plugins/request-interceptor`](./packages/plugins/request-interceptor)
会识别对 OpenAI、Anthropic、Google AI、DeepSeek、Codex 等端点的调用，捕获（并脱敏）
API token 与请求/响应体，并提供一个设置页用于查看。它在 `install` 时自动部署。

### 设置浮层（Settings overlay）

通过 `api.settings.*` 注册的页面与分区，都渲染在一个**框架自有的浮层面板**里，
而不是 hook 宿主应用自己的设置 UI。该面板位于隔离的 Shadow DOM 中，因此不受宿主应用的
标记与 CSS 影响（也不会影响它们）——从而能在任意 Electron 应用上统一工作。
用右下角的浮动 **DP** 按钮或 **Cmd/Ctrl+Shift+\\** 热键打开；按 **Esc** 关闭。

### CDP 访问

声明了 `"permissions": ["cdp"]` 的插件会获得 `api.cdp`——一个面向其**自身**渲染进程的
轻量 Chrome DevTools Protocol 客户端，底层使用 Electron 进程内的
`webContents.debugger`——**不会开启任何远程调试端口**。在使用某个 CDP domain 的事件前
需要先启用它：

```js
await api.cdp.attach();
await api.cdp.send("Network.enable");
api.cdp.on("Network.responseReceived", (p) => api.log.info("response", p));
const title = await api.cdp.evaluate("document.title"); // 在页面主世界执行
```

便捷封装包装了 Network 与 Fetch domain：

```js
await api.cdp.attach();

// 观察响应，并按需懒加载响应体
await api.cdp.onResponse(async (res) => {
  if (res.url.includes("/api/")) {
    const { body } = await res.getBody();
    api.log.info(res.status, res.url, body.slice(0, 200));
  }
});

// 拦截并改写/拦阻请求
await api.cdp.onRequestPaused((req, ctl) => {
  if (req.url.endsWith("/blocked")) return ctl.fail("BlockedByClient");
  ctl.continue();
});
```

CDP 能力很强（可完整查看/控制页面），因此用 manifest 权限门控。渲染进程的 `api.cdp`
限定在插件自身的 webContents；对**主进程插件**则指向聚焦窗口（或第一个可用窗口）。
如果该窗口已打开 DevTools，`attach()` 会失败。

### 管理框架

框架有两种驱动方式，背后都是同一个 `~/.desktop-proxy/config.json`：

- **应用内管理页**：浮层里内置的「desktop-proxy」页（与插件页并列），可开关插件、
  切 safe-mode、调日志等级、切 stealth。
- **应用内「Network」页**：内置流量查看器（开启 `captureTraffic`），列出最近的
  请求/响应/WebSocket 帧（覆盖所有抓取来源），一键 **HAR 导出**。
- **CLI**：`plugin enable/disable`、`config get/set`、`doctor`（适合脚本/AI，带 `--json`）。

runtime 会**监听 `config.json`** 并即时生效：日志等级立即更新；插件启停或 safe-mode
变更会重载渲染层插件。（stealth 变更需重启，因为 hook 在 preload 阶段就已安装。）

---

## 安全与恢复

- **安全模式** — `safe-mode on`（或创建 `~/.desktop-proxy/safe-mode`）会在下次启动时
  禁用所有插件并跳过 preload 注册。
- **每插件开关** — 存在 `config.json` 的 `plugins.<id>.enabled`。
- **备份** — 打补丁前原始文件会被复制到 `~/.desktop-proxy/backup/`；`uninstall` 会还原。
- **修复（repair）** — 目标应用自动更新（通常会抹掉补丁）后重新打补丁；
  `repair --if-needed` 仅在补丁缺失时才动作。
- **自动修复 watcher** — `watch install` 注册一个 macOS LaunchAgent（launchd
  `WatchPaths`），当 app 的 `app.asar` 变化时运行 `repair --if-needed`，自动修复更新。
- **日志限大小** — 日志文件按 10 MB 滚动上限裁剪。

---

## 日志

框架与插件日志写入 `~/.desktop-proxy/log/main.log`（限大小 10 MB）；`loader.log` 覆盖
最早的启动阶段。渲染进程/插件日志通过 IPC 转发到主进程。

用 CLI 查看：

```bash
node packages/installer/dist/cli.js logs            # 最后 200 行
node packages/installer/dist/cli.js logs --follow   # 实时跟随
node packages/installer/dist/cli.js logs --lines 50
```

通过 `config.json` 或环境变量设置最低等级（环境变量优先）：

```json
{ "logLevel": "debug" }
```

```bash
DESKTOP_PROXY_LOG_LEVEL=debug   # debug | info | warn | error | silent
```

等级顺序为 `debug < info < warn < error < silent`（默认 `info`）。插件可用
`api.log.isEnabled("debug")` 来保护昂贵的日志构造；该等级会同步给渲染进程，
因此被抑制的消息不会经 IPC 发送。

---

## 隐身模式

默认情况下框架会留下容易被检测的痕迹（可见的启动按钮、具名全局变量、被 JS 改写的
`fetch`/`XHR`）。对于会主动检测注入的目标应用，可在 `~/.desktop-proxy/config.json`
开启隐身：

```json
{ "stealth": true }
```

开启后：

- 被改写的 `fetch` / `XMLHttpRequest` 在 `fn.toString()` 下返回原生源码字符串
  （最常见的检测点）；
- 框架的标记全局变量（`window.__desktop_proxy__`、overlay 句柄）不再暴露——
  内部状态保存在闭包中；
- 设置浮层使用 **closed** shadow root、不带可识别属性，且隐藏启动按钮
  （只能用 **Cmd/Ctrl+Shift+\\** 打开）。

隐身**不会**改变以下内容，以及原因：

- 渲染↔主进程的 IPC 通道本就对页面脚本不可见——它们位于隔离的 preload 世界，
  因此不是页面检测的入口。
- `__REACT_DEVTOOLS_GLOBAL_HOOK__` 保留，因为它与真实的 React DevTools 无法区分。

隐身模式下，IPC 通道名也会**按会话随机化**（如 `dp-a1b2c3:list-plugins`，而非
`desktop-proxy:list-plugins`），使宿主应用自身的主进程无法用已知名字枚举 handler。
只有 `desktop-proxy:config-sync` 这个引导通道保持固定名（preload 用它来获知随机前缀）。
注意：渲染层 `api.storage` 仍使用可见的 `localStorage` key——需要隐藏的持久化请用 `api.fs`。

插件不受随机化影响：`api.ipc.*` 接收逻辑通道名，框架会在主/渲染两端用同一前缀一致地包装。
若插件绕过 `api.ipc`、直接用硬编码的 `ipcRenderer` 通道名，则在随机化下会失配——请始终用 `api.ipc`。

---

## 平台支持

| 平台 | 状态 |
|---|---|
| macOS | 主要目标。完整安装路径：asar 打补丁、完整性哈希、fuse 翻转、`codesign` 重签名。 |
| Windows | 部分支持。已有应用定位/打补丁逻辑，但签名/完整性步骤是 macOS 专属。 |
| Linux | 安装器暂未实现。 |

另一种「不改文件」的注入思路（通过 `LD_PRELOAD` hook V8 编译器），见 vendored 的
[v8_killer](./third-project/v8_killer) 参考项目。

---

## 开发说明

- `installer` 是 **ESM** 包（`"type": "module"`）；使用 `import.meta.url` 与仅 ESM 的
  `@electron/asar` v4。
- `runtime` 与 `preload` 在运行时从目标应用解析 Electron；`electron` 依赖**仅用于类型**。
- `plugin-sdk` 带 DOM 类型（设置渲染用到 `HTMLElement`），且刻意不含 Node 类型。

### 健壮性

- 插件通过 `api.*`（ipc/network/cdp/settings/ui）获得的订阅按插件登记，热重载时**自动注销**，
  即便插件 `stop()` 没退订也不会累积。
- 渲染层 fetch hook 在关键路径外读响应体，**流式/SSE 不被缓冲**；响应体有上限、二进制类型跳过。
- 主进程 `webRequest` handler 有 3s 超时，超时后请求**原样放行**（避免某 handler 卡死全部流量）。
- preload 注册在 Electron ≥ 35 用 `session.registerPreloadScript`，旧版本回退 `setPreloads`。

### 测试

一套 [Vitest](https://vitest.dev) 测试（`pnpm test`）覆盖了不依赖宿主环境的纯逻辑
（也是最难肉眼检查、最易出错的部分）：

- `plugin-sdk`：`validateManifest`、`isLevelEnabled`，以及 `createCDP` 的封装接线
  （用 mock core 测 Network/Fetch/evaluate）。
- `runtime`：分级 `logger`（过滤、`setLevel`、命名空间、限大小）与 `fs-sandbox` 的
  路径限定 + 读写往返。
- `installer`：`fuses` 针对合成的 Electron 二进制缓冲区做读/写测试。

测试位于各包的 `test/` 目录（已排除在 `tsc` 构建之外）。依赖 Electron/DOM 的代码
（session、`webContents.debugger`、overlay）未做单测。GitHub Actions 工作流
（`.github/workflows/ci.yml`）会在每次 push 和 PR 上跑 build + typecheck + test。

### 状态 / 已知缺口

- 主进程 `api.network` 由默认 session 上共享的 `onBeforeSendHeaders` /
  `onCompleted` hub 支撑：handler 可读取并修改请求头，且拥有真实的、可独立取消的订阅。
  限制：响应体不可得（Electron `webRequest` 不暴露），且主进程不捕获请求体——
  请用渲染进程作用域插件来观察请求体。

---

## 许可证

当前未包含 license 文件。分发前请先添加。
