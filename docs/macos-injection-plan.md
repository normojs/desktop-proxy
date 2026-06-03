# macOS 注入后端方案：DYLD + V8-hook（installer 第二注入向量）

## 0. 背景与目标

当前 installer 走 **asar 补丁**：改 `app.asar` 的 `package.json#main` → loader，更新 `Info.plist` 的
`ElectronAsarIntegrity` 哈希，翻转 `EnableEmbeddedAsarIntegrityValidation` fuse，重签名。
它对 Codex / Cursor / Windsurf 这类 app 有效，但前提是**能重算 asar 完整性哈希并重签名**。

本方案新增**第二注入后端**：**不改 app.asar**，而是把一个**原生 V8-hook dylib** 加载进 Electron
主进程，由它在 V8 编译"主入口脚本"时 `insert-before` 一段 bootstrap（设 env + `require(runtime)`），
之后 runtime 一切照旧（webRequest / Node patch / CDP）。复用现有 `codesign.ts` 重签名流水线。

适用场景：asar 完整性无法重算/不想动 app 资源、或希望"零改 JS 资源"的注入。

> 关键事实：网络拦截能力（webRequest / Node http/https/fetch/http2 / CDP）都在**主进程**，
> 只要 runtime 跑起来就生效，**与注入向量无关**。本方案只解决"如何让 runtime 在硬化 app 里跑起来"。

## 1. 为什么 macOS 需要额外动作（不是代码 bug）

目标 IDE 普遍是 **hardened runtime + library validation + 公证**。直接 dylib 注入会被挡：

| 机制 | 后果 | 对策 |
|---|---|---|
| hardened runtime 剥离 `DYLD_*` | `DYLD_INSERT_LIBRARIES` 被忽略 | 重签名加 `com.apple.security.cs.allow-dyld-environment-variables`（或改用 LC_LOAD_DYLIB） |
| library validation | 拒绝加载非同 Team ID 的 dylib | 重签名加 `com.apple.security.cs.disable-library-validation` |
| W^X / 代码页保护 | Frida inline hook 改代码页被拒 | 重签名加 `com.apple.security.cs.allow-unsigned-executable-memory`（兜底 `disable-executable-page-protection`） |
| 多进程 | Helper（Renderer/GPU/Plugin）也会加载 | 深度重签所有 `*.app`/Framework；dylib 在无 V8 符号的进程里安全 no-op |
| universal | arch 不匹配则加载失败 | dylib 构建 `arm64` + `x86_64` 后 `lipo` 合并 |

**结论**：唯一绕不过的是**给目标重签名 + 加 entitlements**——这正是 installer 已有的能力，复用即可。
代价：**削弱目标 app 安全性 + 破坏公证，仅限本地自用**。

## 2. 两种 dylib 加载向量（择一；均需重签名 + entitlements）

### 向量 A：LC_LOAD_DYLIB 注入（持久、透明，**推荐**）
往主可执行（macOS 下是 `Electron Framework.framework` 内的二进制，或 `MacOS/<App>`）的 Mach-O
头插入一条 `LC_LOAD_DYLIB` 加载命令指向我们的 dylib → **正常双击启动即加载**，无需包装器。
- 实现：Mach-O load-command 插入（`insert_dylib`/`optool` 同类技术；universal 需对每个 slice 处理）。
- 之后必须重签名（插入改了二进制）。
- 优点：透明、持久。缺点：要稳健编辑 Mach-O（universal + 重签）。

### 向量 B：DYLD_INSERT_LIBRARIES（启动期，shim 包装）
把真实 `MacOS/<App>` 重命名为 `<App>.real`，放一个 shim 作为 bundle 可执行：设
`DYLD_INSERT_LIBRARIES=<dylib>` + `V8_KILLER_CONFIG_FILE_PATH=<config>` 后 `exec <App>.real`。
- 优点：不编辑 Mach-O。缺点：shim 在硬化运行时下较脆（脚本 shim 可能不被作为 bundle 可执行接受，
  更稳要小型编译 shim）；仍需 `allow-dyld-environment-variables` + 重签。

> 推荐 **A（LC_LOAD_DYLIB）** 作为默认（透明持久），B 作为回退/调试。两者都靠 §1 的 entitlements。

## 3. V8-hook dylib

复用 `third-project/v8_killer`（Frida-Gum hook `v8::ScriptCompiler::CompileFunctionInternal`，
按脚本名匹配 + `insert-before`/`replace` 改源码后回写 `_source_string`）。核心**已含 macOS 分支**
（Itanium 符号、`.dylib`、DYLD 路径），机制层面 mac 已通。

**已发现的构建风险（必须先解决）**：当前固定的 `frida-gum 0.16.7` 与 `frida-gum-sys` 存在
bindgen 类型错配（aarch64 下 `_GumArgument__bindgen_ty_1` 缺失），**开箱即编不过**。需：
- 锁定一组互相兼容的 `frida-gum` / `frida-gum-sys` 版本（升/降到匹配版本），或
- 换用其它 inline-hook 方案（如 `dobby`/自写 trampoline），或
- 用 RVA identifier 兜底（配置里给模块名 + 偏移），减少对符号导出的依赖。

dylib 的唯一职责：命中主进程入口脚本时 `insert-before` 我们的 **bootstrap**。

### bootstrap（注入进入口的 JS）
必须在 runtime `require` 之前设好 env（runtime 启动即 `requireEnv` 读取）：
```js
(function(){
  try {
    if (process.type && process.type !== "browser") return; // 仅主进程
    if (globalThis.__desktopProxyBooted) return; globalThis.__desktopProxyBooted = true;
    process.env.DESKTOP_PROXY_USER_ROOT = process.env.DESKTOP_PROXY_USER_ROOT || "<userRoot>";
    process.env.DESKTOP_PROXY_RUNTIME  = process.env.DESKTOP_PROXY_RUNTIME  || "<runtimeDir>";
    require("<runtimeEntry>");
  } catch (e) { try { console.error("[desktop-proxy] bootstrap failed:", e); } catch (_) {} }
})();
```
（注入只在 `resource-name` 命中入口脚本时发生，避免对每个脚本注入。）

## 4. installer 集成

- CLI：`desktop-proxy install --backend <asar|dyld>`（默认 `asar`；`dyld` 启用本方案）。
- 流程（`dyld`）：
  1. 定位 app（复用 `locateApp`）。备份（`backupOnce`）。
  2. 暂存 dylib（universal）+ 写 V8-hook TOML 配置 + 写 bootstrap（到 `~/.desktop-proxy/`）。
  3. 选向量 A：插入 `LC_LOAD_DYLIB`；或向量 B：装 shim。
  4. **重签名（带 entitlements）**：深度签 `.app` + `Electron Framework.framework` + 所有 Helper（复用并扩展 `codesign.ts`）。
  5. `clearQuarantine`。写 `state.json`（记录 backend、备份、entitlements）。
- 卸载/更新：app 更新会还原二进制 → 复用现有 watcher（macOS LaunchAgent）重打。
- `doctor`：检测 backend、签名状态、dylib 是否存在、entitlements 是否生效。

## 5. 安全与可逆性

- 明确告知：**关闭 library validation + 允许未签名可执行内存 = 降低该 app 安全性**，且破坏公证；仅本地自用。
- 一切可逆：备份原始二进制/bundle；`uninstall` 还原 + 去 entitlements 重签（或恢复备份）。
- dylib 在非主进程/无 V8 的 Helper 里 no-op，降低副作用。

## 6. 测试策略（不要拿真实 IDE 试错）

1. **纯逻辑单测（已随本方案落地）**：entitlements plist、V8-hook TOML、bootstrap、注入计划（`planMacosInjection`）生成。
2. **原生构建**：先修复 frida 版本错配，`cargo build` 出 universal dylib（CI 可选）。
3. **端到端（手动）**：先用 **vanilla / throwaway Electron**（非硬化）验证 dylib 加载 + bootstrap + runtime 起来；
   再在一个**可丢弃的硬化测试 app**（自签 hardened runtime 的最小 Electron）验证重签 + entitlements + 注入；
   最后才考虑真实 IDE（务必先备份）。
4. 复用 `scripts/smoke/main.js` 的断言思路验证拦截在注入后仍生效。

## 7. 现状与后续

- ✅ 已落地：设计文档；`codesign.ts` 增加 `signAppBundleWithEntitlements`；`macos-inject.ts` 纯函数
  （entitlements/TOML/bootstrap/plan）+ 单测。
- ✅ 已落地：**`InjectionBackend` 抽象 + 统一流水线**（`src/backends/{types,asar,index}.ts`）。asar 逻辑
  收进 `AsarBackend`（backup+patch+integrity+fuse / isApplied / revert）；`install`/`uninstall`/`status`/`doctor`
  改为按 `state.backend` 分发（`doctor` 用 `backend.isApplied` 报告 `injected`），重签/quarantine/staging/state
  为共享步骤；CLI `install --backend <asar|dyld>`；`dyld` 为占位后端（`supported()=false`），为未来 fallback 留口。+ 后端注册表单测。
- ✅ 已落地（渲染层补充路径，§9.2/§9.6）：`src/proxy-config.ts`（纯函数：settings.json/argv.json 代理补丁、
  JSONC 解析/合并/删键、VS Code 衍生 app 路径解析、CA env 提示）+ CLI `proxy <on|off|status>`。**仅渲染/扩展宿主**，
  AI/主进程流量仍需注入；+ 单测。
- ⏳ 待办（需联机/真机）：修复 frida 构建并产出 universal dylib；实现向量 A 的 Mach-O `LC_LOAD_DYLIB`
  插入（或向量 B 的 shim）；CLI `--backend dyld` 接线 + `uninstall`/`doctor` 适配；throwaway Electron 实测。

## 8. 风险审视、与现有后端融合、易忽略点

### 8.1 方案自身的硬伤
- **frida 依赖很重且当前编不过**：`frida-gum 0.16.7` 与 `gum-sys` bindgen 错配；即便修好，frida 体积大、构建期联网下载 devkit、ABI 绑定 frida 发布节奏。可考虑 Dobby/自写 trampoline，或把 V8-hook 设为**可选**能力。
- **V8 符号随版本漂移**：`CompileFunctionInternal`/`CompileFunction` 的 mangled 名随 V8/Electron 变（v8_killer 已带"新版回退"）。Electron 更新频繁 → hook 可能**静默失效**。需多符号 + pattern 扫描 + RVA 兜底，仍是长期维护负担。
- **字节码/快照主入口（关键可行性）**：若目标 app 的主进程入口是 **V8 snapshot / 字节码缓存**（`v8-compile-cache`/`bytenode`/`--snapshot`），源码根本不经过 `CompileFunctionInternal` → hook 永不触发 → **注入静默失败**。**必须先实测 Cursor/Codex/Windsurf 主包是否字节码缓存**；若是，则需检测并**回退 asar**。
- **入口脚本匹配脆弱**：按 `resource-name` 关键字匹配入口，不同打包器（esbuild/webpack/单 bundle/多 chunk）差异大，过宽会注入过多脚本、过窄会漏。
- **Mach-O LC_LOAD_DYLIB 编辑风险**：fat 二进制需逐 slice 处理、重算偏移；插入 load command 会让 `LC_CODE_SIGNATURE` 失效（必须重签）；头部可能没有 padding 容纳新命令。**应用成熟工具（insert_dylib/optool），别手搓**。
- **shim 向量更糟**：`DYLD_INSERT_LIBRARIES` 会**波及所有子进程**（app 衍生的 git/node/rg 等），dylib 虽 no-op 但仍被加载；脚本 shim 在硬化运行时下不被可靠地当作 bundle 可执行。→ **强烈优先 LC_LOAD_DYLIB**（只影响 framework 使用者）。
- **重签名的连锁反应（重要，且 asar 后端同样有）**：换签名身份会**重置该 app 的 TCC 权限**（屏幕录制/麦克风/全盘）、**使 keychain ACL 失效**、**让绑定原 Team-ID 的 entitlement（app groups/iCloud/推送）失效**，且部分 app 会**自校验签名**而拒启。这是"任何重签"的共性限制，dyld 不比 asar 更糟，但要明确告知用户。
- **静默失败难诊断**：失败时 app 只是没加载 runtime。需 dylib 自带日志 + `doctor` 校验"runtime 是否真的 boot"。
- **自动更新后被还原**：二进制重打 + 重签比 asar 重补**更重更易碎**，需原子化 + 可靠备份/回滚。
- **安全面**：关 library validation = 给主力 IDE 开注入后门，**必须 opt-in + 明确警告，默认 asar**。

### 8.2 关键反问：macOS 上真的需要它吗？
asar 后端在 mac **已经可用**（它也重签）。dyld 的唯一好处是"不动 app.asar"，代价却是**同样重签 + 更多风险**（二进制编辑、frida、符号漂移、字节码缓存失败）。→ **mac 上 asar 更简单更稳**。
dyld/V8-hook 的**真正价值在 Linux/Windows**（v8_killer 不需重签、零改文件过完整性）+ mac 上"asar 不可补"的边缘场景（完整性算不出 / 入口被快照）。
**建议重排优先级**：asar 仍为各平台默认；dyld/V8-hook 主攻 **Linux/Win**，mac 仅作**回退**。即"跨平台扩展"价值 > "mac 平价"。

### 8.3 与现有后端融合（避免双份维护）——核心
抽象一个后端接口，把"注入方式"做成可插拔，其余全部共享：
```ts
interface InjectionBackend {
  name: "asar" | "dyld";
  supported(install): boolean;                 // dyld 仅 darwin/可注入；asar 需可补 asar
  apply(install, ctx): { entitlements: string[] }; // 执行注入，返回重签所需 entitlements
  revert(install, state): void;                // uninstall
  verify(install, state): DiagResult;          // doctor
}
```
- **统一 install 流水线**：stage 共享文件（runtime/preload/plugins）→ 选后端 → `backend.apply` → **共享重签（按后端返回的 entitlements）** → `clearQuarantine` → 写 `state.json(含 backend)`。
- **uninstall/doctor/watcher 按 `state.backend` 分发**，**一套管线**而非两套。
- **统一 bootstrap**：dyld 的 bootstrap 直接 `require` 与 asar **同一份** `loader.cjs`/`boot.js`，引导逻辑只维护一处（现 `buildBootstrap` 应改为"require 共享 loader"而非内联重复）。
- 备份、codesign、quarantine、state、watcher（LaunchAgent）、doctor 全部共享；两后端只各写一个小 `apply/revert/verify`。
- **不把 v8_killer 的 Rust 源进树**：dylib 作**预构建二进制资产**（单独 CI 产 universal）或 git submodule，避免在本仓维护 frida 构建。

### 8.4 entitlement 收敛（按向量给最小集）
- LC_LOAD_DYLIB **不需要** `allow-dyld-environment-variables`（那是 shim 才要）。
- 尽量只 `disable-library-validation` +（`allow-unsigned-executable-memory` 或 `allow-jit`）；**慎用 `disable-executable-page-protection`**（过度削弱）。
- 按 vector 产出最小 entitlements，减少安全损失（当前 `MACOS_INJECT_ENTITLEMENTS` 是全集，应拆分）。
- dylib 自身也要（至少 ad-hoc）签名，否则即使关了 library validation，硬化运行时可能仍拒载未签名 dylib。

### 8.5 仍需确认/实测
1. **三个目标 IDE 的主进程入口是否字节码缓存**（决定 V8-source-hook 在 mac 是否根本可行）。
2. frida 版本锁定或替代方案选型。
3. 造一个**自签 hardened-runtime 的最小 Electron** 作 CI/手测目标（别拿真实 IDE 试错）。
4. 重签后 TCC/keychain 实际影响（asar 后端也应一并验证）。

### 8.6 结论
- 先做**后端抽象 + 统一 bootstrap/流水线**（即使只有 asar，也先把可插拔骨架搭好，零额外维护成本）。
- dyld/V8-hook 作为**可选后端**接入，**优先 Linux/Win**；mac 上默认仍 asar，dyld 仅在 asar 不可行时回退。
- 上线前必须解决 §8.5 的字节码缓存与 frida 两个前置问题，否则 mac 上 V8-hook 可能直接不可用。

## 9. macOS 注入技术对比 + 跨平台等价方案（proxy）

### 9.1 为什么 mac 原生注入注定比 Win/Linux 难（逐技术）
Win/Linux 加载库不强制代码签名（LD_PRELOAD/DLL 注入"免费"）；mac 对硬化+公证 app 强制 library
validation 并剥离 DYLD。

| 技术 | macOS 结局 |
|---|---|
| `DYLD_INSERT_LIBRARIES` | 硬化运行时剥离 → 需重签 + `allow-dyld-environment-variables` + `disable-library-validation` |
| `LC_LOAD_DYLIB` 注入 | 改二进制使签名失效 → 需重签 + 关 library validation |
| `task_for_pid` / mach inject | 硬化/平台进程 task port 即使 root 也被 SIP 拒 → 需关 SIP |
| `--inspect` / `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` | 被 fuse 关 |
| asar 补丁 | 签名封了 Resources → 需重签 |

**根本结论**：对硬化 app，加载外来原生代码**必然**二选一：重签名（换身份 → TCC/keychain/Team-ID
entitlement 副作用）或关 SIP（全系统降安全）。**"像 Linux/Win 一样零触碰"在 mac 上原理上不存在**。

### 9.2 真正跨平台等价的方案（针对"网络拦截"目标）
**本地 mitm 代理 + 受信根 CA**（呼应项目名 desktop-proxy）：
- 装本地代理 + 一张本地根 CA（一次性信任），目标 app 的 HTTPS 走它解密 → 观察 + 改写（含流式 SSE/WS）。
- **三平台一致**：Chromium 用系统信任库（Keychain/证书库/NSS），装了受信 CA 即认 mitm 证书 → renderer 的 fetch/XHR/WebSocket 全可拦。
- **零注入、零重签、抗更新**：不碰 app 二进制/asar，更新无影响。
- **让 app 走代理且不注入**：Cursor/Windsurf（VS Code 衍生）可在 `argv.json`/设置配代理+CA；或启动带 `--proxy-server=127.0.0.1:port`（flag 非 fuse）；Node 侧 `NODE_EXTRA_CA_CERTS` + `HTTPS_PROXY`（undici 需 ProxyAgent，稍弱）。
- **边界**：需用户信任 CA；证书钉扎端点失败（Electron 多用系统信任、少钉扎，AI API 一般可拦）；**只解决网络，不做 app 内 UI 注入**。

### 9.3 另一个干净向量：VS Code 扩展
Cursor/Windsurf 是 VS Code 衍生 → 直接写**扩展**（扩展宿主 Node 进程，官方支持、不重签、抗更新、零注入），可 monkey-patch 该进程的 http/https/fetch。（Codex 桌面版若非 VS Code 系则不适用。）

### 9.4 按能力拆分的推荐（不要死磕单一注入）
| 能力 | 最佳跨平台方案 |
|---|---|
| 网络观察/改写（项目核心） | **本地 mitm 代理 + CA**（三平台等价、零注入零重签）；app 内 CDP/Node 拦截作为"已注入时"的补充 |
| app 内 UI 浮层/设置页/插件运行时 | 必须进 app：mac 用 asar 重签（已实现，即 mac 原生等价物）；Win/Linux 可 v8_killer 零改注入；Cursor/Windsurf 可用扩展 |

→ "和 Win/Linux 一样好"的现实答案：**网络拦截走代理后端**（绕开 mac 全部签名痛点）；**app 内注入** mac 接受重签（asar 已做且 dyld 也省不掉重签），Win/Linux 才有零改红利。

### 9.6 现实校正：代理/扩展对"拦截 AI IDE 自己的请求"并不成立
§9.2/§9.3 对代理与扩展过于乐观。针对"拦截 AI IDE 自身的 LLM 请求"这个**核心用例**，两条"省注入"的路都不通：
- **代理 + CA 的真问题**：AI 请求由**主进程/Node（undici）**发出，**Node 不用系统钥匙串、用自带 CA bundle** → 装进 Keychain 的根 CA **Chromium 认、Node 不认**（这就是"证书问题"的本质）。要 Node 认需 `NODE_EXTRA_CA_CERTS`、要 undici 走代理需进程内 `ProxyAgent`（undici 默认忽略 `HTTPS_PROXY`）——这两者都要能往该进程**注入 env/代码**，又回到注入本身；再叠加证书钉扎 / HTTP3 直接绕过。**代理只对渲染层有效，漏掉 Node 源的核心流量。**
- **扩展的真问题**：Cursor/Windsurf 的 AI 调用在**自身主进程/专有代码**里，不在扩展宿主；扩展碰不到主进程 http 栈，看不到这些请求。

**修正结论**：拦截 AI IDE 自己的请求**必须在其主进程里跑代码 = 注入**。mac 上即 asar 补丁 + 重签（已实现），重签是**绕不过的平台税**。注入后，本项目已具备的 **Node `http`/`https`/`fetch`(undici)/`http2` monkey-patch + CDP** 即可**直接抓到 Node 源 AI 请求，无需 CA、无需代理**——这才是该用例的正解。代理后端仅对"渲染层流量"或"非 AI 用例"有补充价值，不应作为 AI 拦截主路径。

## 10. 决策：单一机制 = asar；不普做 V8-hook

**平台税是"mac + app 内注入"的固有属性，与机制无关**：mac 上 asar 或 dyld 都要重签（签名封了
`Contents/Resources`）；选 dyld 免不掉税，反而叠加原生/frida 脆弱性 → **mac 上 dyld 严格劣于 asar**。

**asar 补丁其实三平台通用，且只有 mac 收税**：

| 平台 | asar 的额外成本 |
|---|---|
| macOS | 破坏签名封印 → 重签 + integrity 哈希 + fuse（= 平台税） |
| Windows | app.asar 不在 .exe Authenticode 签名内 → 改它不破坏 exe 签名、照常运行；仅 asar-integrity fuse 开时处理，**无需重签** |
| Linux | 无代码签名 → 改完即用，零额外成本 |

**维护成本对比**：
- asar（单一、纯 TS）：一个补丁器 + 平台后置步骤；无原生依赖/frida/符号漂移/per-arch 构建。
- dyld/V8-hook 普做：原生 dylib(frida) × 3 平台 × 多 arch + V8 符号随版本漂移 + 字节码入口静默失效(三平台都中、仍需 asar 兜底) → 维护量成倍且替不掉 asar。

**决策**：
1. **统一以 asar 为唯一注入机制**（三平台），mac 接受重签平台税。
2. **不现在做、不普做 dyld/V8-hook**——对跨平台覆盖无边际收益，只增维护。
3. **保留 `InjectionBackend` 抽象**，把 V8-hook 留作未来**可选 fallback**（仅当某 app 的 asar 确实打不了补丁时再按需实现）。
4. 现在值得做的：把 asar 收进 `InjectionBackend`，统一 install/uninstall/doctor/watcher，并把 mac 的重签/integrity 等平台后置步骤隔离进该后端——即使只有 asar，也为未来 fallback 留好零摩擦接口。

### 9.5 建议把"拦截后端"也抽象化
与 §8.3 的 `InjectionBackend` 并列，引入 `InterceptionBackend`（`in-app` | `proxy`）：网络能力可由
"app 内注入"或"代理"任一提供，按平台/可行性自动选择，UI 能力仍走注入。这样 mac 的网络拦截可零注入达成，
与 Win/Linux 体验拉齐。
