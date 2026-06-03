# ADR: 配置缓存、统一存储、事件总线、流量落盘

## 背景（现状）
- **配置**：`userRoot/config.json`，`readConfig()` 每次同步读整文件；`fs.watch` 防抖→重读→`broadcastToRenderers`。`readConfig()` 在热路径被频繁调用（如 `maxResponseBodyBytes` 每次响应体捕获、`isPluginEnabled`）。
- **插件存储**：同一个 `api.storage` —— 主作用域落 `userRoot/plugin-<id>.json`（fs），渲染作用域落 `localStorage`，**两者不互通**；`scope:"both"` 插件出现分裂，且 localStorage 非持久、按 origin 隔离。
- **消息**：主→渲染 `broadcastToRenderers`；渲染→主 `invoke`；网络事件走 `MainNetwork` hub 回调；插件用裸 `api.ipc`。**无统一 pub/sub**。
- **流量**：内存环形缓冲 + HAR 导出，**不落盘**。

## 决策

### 1. 配置内存缓存 + 原子写
- 进程内缓存 `Config`；`readConfig()` 返回缓存。`writeConfig()` 用 `tmp + rename` 原子写并更新缓存。`fs.watch` 命中 `config.json` 时**失效缓存**（再读即重载），随后广播。
- 收益：消除热路径同步 I/O；多写者下整文件覆盖风险降低（原子写）。

### 2. 统一插件存储到主进程
- 新增主进程 KV `storage.ts`：每插件 `userRoot/plugin-<id>.json`，内存缓存 + 原子写。
- 主作用域 `api.storage` 直接用它；渲染作用域 `api.storage` 改为**代理到主**：
  - 构造时 `ipcRenderer.sendSync(storage:snapshot, id)` 同步取快照 → 本地缓存，保证 `get/all` 同步语义。
  - `set/delete` 改本地缓存 + 异步 `send` 持久化到主。
- 收益：主/渲染**共享、持久、对 "both" 插件一致**。（框架 UI 的 presets 仍可用 localStorage，属纯本机偏好。）

### 3. 事件总线 `api.events`（跨主↔渲染↔插件 pub/sub）
- SDK：`events.on(topic, handler)` / `events.emit(topic, data)`。
- 路由经主进程：渲染 `emit` → `events:emit` IPC → 主 fanout（主作用域订阅者 + `broadcastToRenderers(events:msg)`）；主作用域 `emit` 同样 fanout。渲染 host 单一 `on(events:msg)` 按 topic 分发。
- 框架同时在总线上发布约定 topic：`config:changed`、`plugins:changed`（便于插件订阅）。

### 4. 流量可选落盘
- `traffic-persist.ts`：`createTrafficWriter(dir, maxBytes)` 追加 NDJSON，超阈值轮转（`traffic.ndjson` → `traffic.1.ndjson`，保留 1 份）。
- 录制器 `setSink(fn|null)`：每条**定型**条目（响应结束/出错/WS 关闭）写出。
- 新增 config `persistTraffic`（默认关，避免敏感数据无意落盘）；`syncTrafficCapture` 据此设置 sink。

## 顺序
1 配置缓存 → 2 统一存储 → 3 事件总线 → 4 流量落盘。每步 build/typecheck/test/lint。
