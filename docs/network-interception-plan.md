# 进程内全量网络拦截 — 详细实现方案

> 目标：在**不依赖外部代理 / CA 证书**（L4）的前提下，尽可能在 Electron 进程内拦截
> 应用发起的各类网络请求（页面、Electron net、Node http/https/http2），统一汇入
> `api.network`，支持**旁路观察**与**改写/拦阻/mock**。裸 TCP/UDP/原生连接进程内不可行，
> 不在范围内。

## 1. 总体架构：三条腿 + 统一出口

```
                       ┌──────────────── 统一出口 ────────────────┐
插件 (renderer/main) ──│  api.network: onRequest / onResponse /   │
                       │  onWebSocket / intercept(control)        │
                       └──────────────────────────────────────────┘
                                        ▲  (每条事件带 source 标签)
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
 ┌──────┴──────┐               ┌────────┴────────┐             ┌─────────┴────────┐
 │ 腿1 渲染层   │               │ 腿2 主进程 Node  │             │ 腿3 主进程       │
 │ CDP Fetch   │               │ http/https/http2 │             │ webRequest       │
 │ (+WS 事件)  │               │ monkey-patch     │             │ (头级补充)        │
 └─────────────┘               └──────────────────┘             └──────────────────┘
   覆盖页面所有请求               覆盖 axios/got/node-fetch          覆盖 Electron net
   (绕开 contextIsolation)        等 Node 网络库                     与子资源(头/重定向)
```

三条腿都在**主进程**汇聚到一个 `NetworkHub`，由它路由给插件处理器（主进程插件直接调用；
渲染进程插件经 IPC 往返），再把决策应用回各拦截器。

## 2. 统一数据模型

在 `plugin-sdk` 扩展（保持向后兼容，新增字段为可选）：

```ts
export type NetworkSource =
  | "renderer-cdp"   // 腿1：CDP Fetch
  | "node-http"      // 腿2：Node http/https/http2
  | "web-request"    // 腿3：session.webRequest
  | "renderer-hook"; // 旧：渲染层 fetch/XHR hook（contextIsolation 下可能失效）

export interface NetworkRequest {
  id: string;
  source: NetworkSource;          // 新增
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;            // 二进制用 base64，配 bodyEncoding
  bodyEncoding?: "utf8" | "base64";
  resourceType?: string;          // document/xhr/fetch/websocket/...
  timestamp: number;
  _type: "fetch" | "xhr" | "websocket" | "node";
}

export interface NetworkResponse {
  id: string;
  requestId: string;
  source: NetworkSource;          // 新增
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  bodyEncoding?: "utf8" | "base64";
  truncated?: boolean;
  timestamp: number;
}

// 改写/拦阻/mock 的控制对象（拦截语义）
export interface NetworkRequestControl {
  continue(mods?: {
    url?: string; method?: string;
    headers?: Record<string, string>; body?: string;
  }): void;
  fulfill(res: {                  // 直接 mock 返回，不发真请求
    status: number;
    headers?: Record<string, string>;
    body?: string; bodyEncoding?: "utf8" | "base64";
  }): void;
  fail(reason?: string): void;    // 拦阻
}

export interface WebSocketFrame {
  id: string;                     // 连接 id
  url: string;
  direction: "sent" | "received";
  opcode: number;                 // 1=text 2=binary
  payload: string;                // text 或 base64
  timestamp: number;
}
```

## 3. 插件 API（`api.network` v2，向后兼容）

```ts
export interface PluginNetwork {
  // 旧（保留，纯观察 / 简单改 url-method-headers）
  onRequest(handler: NetworkRequestHandler): UnsubscribeFn;
  onResponse(handler: NetworkResponseHandler): UnsubscribeFn;

  // 新：全控制拦截（continue/fulfill/fail），第一个 act 的 handler 生效
  intercept(
    handler: (req: NetworkRequest, control: NetworkRequestControl) => void | Promise<void>,
    filter?: { urls?: string[]; sources?: NetworkSource[] },
  ): UnsubscribeFn;

  // 新：WebSocket 旁路（观察；出站改写为 Phase 4 可选）
  onWebSocket(handler: (frame: WebSocketFrame) => void): UnsubscribeFn;
}
```

语义：
- `onRequest`/`onResponse` = 旁路 + 简单改写（兼容现状）。
- `intercept` = 完整拦截：handler 调用 `control.continue/fulfill/fail` 之一即「决定」并停止后续 handler；都不调用则放行。
- **优先级**：同一请求先跑 `intercept`（可短路 fulfill/fail/continue-with-mods）；未短路再跑 `onRequest`（仅观察/改 headers）；`onResponse` 始终旁路。
- 所有事件带 `source`，插件可按来源过滤。

## 4. 各拦截器详细设计

### 腿1：渲染层 CDP Fetch 拦截器（主拦截器，绕开 contextIsolation）

文件：`packages/runtime/src/net/cdp-intercept.ts`，复用现有 `MainCDP` hub。

**关键原则（流式安全）**：请求改写/拦阻/mock 用 `Fetch` **仅请求阶段**；响应观察用
`Network` **被动域**。**绝不用 `Fetch` 响应阶段取 body**——它会在响应头处暂停并由
`getResponseBody` 缓冲整个 body，从而破坏 SSE/流式（与此前修复的 fetch 阻塞 bug 同性质）。

- 启用：`Fetch.enable({ patterns: [{ urlPattern: "*", requestStage: "Request" }] })` + `Network.enable`。
- **请求**：处理 `Fetch.requestPaused`（只会在请求阶段触发，无 `responseStatusCode`）：
  构造 `NetworkRequest{source:"renderer-cdp"}`（`request.postData` 取请求体），走
  `NetworkHub.dispatchRequest()`：
  - continue(mods) → `Fetch.continueRequest({requestId, url?, method?, headers?, postData?})`
  - fulfill(res) → `Fetch.fulfillRequest({requestId, responseCode, responseHeaders, body(base64)})`（mock 在此处整体替换）
  - fail → `Fetch.failRequest({requestId, errorReason:"BlockedByClient"})`
  - 无决策 → `Fetch.continueRequest({requestId})`
  - **超时兜底**：决策默认 3s 未返回 → `continueRequest`，防卡死（复用已有 timeout 模式）。
- **响应（流式安全，被动）**：`Network.responseReceived`（拿 status/headers）→ 待
  `Network.loadingFinished` 后再 `Network.getResponseBody`（被动读取，**不暂停流**，body 上限截断）。
  对流式/SSE，body 在结束后才可得（符合「不阻塞 app」）。
- **请求↔响应关联**：`Fetch.requestPaused` 带 `networkId`，等于 `Network` 域的 `requestId`，
  用它把 Fetch 改写到的请求与 Network 观察到的响应对齐。
- **优势**：网络层拦截，**不受 contextIsolation 影响**，覆盖页面所有请求（含子资源/fetch/XHR）。
- **去重**：CDP 为渲染层**主**拦截器；旧 JS hook 默认**关闭**（否则同一请求双份事件）。
- **生命周期/性能**：仅当存在 intercept/onResponse handler 时才 `Fetch.enable`/`Network.enable`；
  handler 全部移除时 disable，去掉常态开销。

### 腿1b：WebSocket（CDP 事件，旁路）

同一 webContents 上 `Network.enable` → 监听：
`Network.webSocketCreated` / `webSocketFrameSent` / `webSocketFrameReceived` / `webSocketClosed`
→ 构造 `WebSocketFrame` 走 `onWebSocket`。**只读**（CDP 不能改 WS 帧）。
出站改写（可选 Phase 4）：主世界注入 hook 包 `WebSocket.prototype.send`。

### 腿2：Node http/https/http2 monkey-patch（主进程）

文件：`packages/runtime/src/net/node-intercept.ts`，在 runtime 入口**早于 app 主代码**调用（loader 已保证）。

- patch 单例（之后所有 `require('http'|'https')` 都生效）：
  - 包 `http.request` / `http.get` / `https.request` / `https.get`。
  - 归一化 options（string url / URL / options 对象三种入参）。
  - **请求改写**：调用原始前跑 `NetworkHub.dispatchRequest()`（同步或短超时）→ 改 host/path/headers，或 `fail` 则不发起、销毁。
  - **请求体捕获**：包返回的 `ClientRequest` 的 `write`/`end`，累加（带上限）。
  - **响应捕获**：监听 `'response'`，给响应流挂一个 `PassThrough` tee（或监听 `data`/`end` 累加，**不消费原流**），读到 body 走 `dispatchResponse`。
  - 二进制按 base64 + 上限截断（复用 `maxResponseBodyBytes`）。
- `http2.connect`（Phase 2）：包 session/stream，复杂度更高。
- `globalThis.fetch`（undici，Phase 2）：包全局 fetch / undici dispatcher。
- **覆盖**：axios(http adapter)/got/node-fetch/request 等所有走 Node http 的库。**这是当前最大缺口**。

### 腿3：webRequest（保留，头级补充）

现有 `network.ts` 不变，给主进程 Chromium net.request 与子资源做头级旁路/改写，事件标 `source:"web-request"`。body 仍不可得（CDP 才有）。

### 旧 fetch/XHR hook 的处置

- 现状在 contextIsolation 下可能**拦不到页面主世界**——降级为「可选语义层」：仅当检测到与页面同世界时有效，标 `source:"renderer-hook"`。
- 默认**以 CDP Fetch 为渲染层主拦截器**；JS hook 作为补充（或 config 关闭）。文档明确说明。

### 覆盖边界（明确不覆盖 / 归属）

- Electron `net.request` 走 **Chromium**（非 Node http）→ Node patch 抓不到，由 `webRequest`
  覆盖（头级）；其 body 一般不可得（除非该请求归属某 webContents 由 CDP 看到）。
- Node 端 `ws` 库（Node http upgrade + socket）**不在 v1**；渲染层 WebSocket 由 CDP 覆盖。
- 裸 TCP / UDP / 原生模块自连：**进程内不可行**（需 L4 代理或 OS 级，已排除）。

## 5. NetworkHub（主进程统一编排）

文件：`packages/runtime/src/net/hub.ts`

```ts
class NetworkHub {
  // 插件处理器（main-scope 直接存；renderer-scope 经 IPC 代理）
  registerRequestHandler(target, handler): UnsubscribeFn
  registerResponseHandler(...) / registerWebSocketHandler(...)

  async dispatchRequest(req): Promise<Decision>   // 串行跑 handlers，首个 act 生效，带超时
  dispatchResponse(res): void                     // 旁路 fan-out
  dispatchWebSocket(frame): void
}
```

- **主进程插件**：handler 在进程内，直接 `await`。
- **渲染进程插件**：handler 在渲染层。Hub 经 IPC `net:request-paused {id, req}` 发到**对应 webContents**，渲染层 `plugin-host` 跑插件 handler，回 `net:decision {id, decision}`；Hub 应用。带超时兜底。
- 路由：CDP 拦截天然按 webContents，决策回到该窗口的渲染插件。

## 6. IPC 通道（均经 `ch()` 前缀）

| 通道 | 方向 | 用途 |
|---|---|---|
| `net:request-paused` | main→renderer | 把暂停的请求交给渲染插件决策 |
| `net:decision` | renderer→main | 回传 continue/fulfill/fail |
| `net:response` | main→renderer | 旁路响应事件 |
| `net:websocket` | main→renderer | WS 帧事件 |
| `net:register` / `net:unregister` | renderer→main | 渲染插件声明它要拦截（含 filter） |

## 7. 配置与权限

```jsonc
{
  "network": {
    "renderer": "cdp",        // "cdp" | "hook" | "off"
    "node": true,             // Node http/https patch
    "webRequest": true,
    "websocket": true,
    "maxResponseBodyBytes": 1048576
  }
}
```
- 拦截属强能力，沿用 `permissions: ["network"]` 门控 + `enforcePermissions`。
- `intercept`（可改写/mock/block）比 `onRequest` 更危险，建议单独权限 `network:intercept`。

## 8. 性能与安全

- CDP Fetch 全量拦截有开销：默认只在「有 intercept handler」时启用 Response 阶段；纯旁路用 Network 事件（`Network.responseReceived`+`getResponseBody`）更轻。
- 所有决策**超时兜底**（默认 3s → 放行），防卡死（已有先例）。
- body 一律**上限截断 + 二进制 base64**，避免内存爆。
- Node patch 要极其小心**不改变原始语义**（错误传播、流背压、`http.Agent`、keep-alive）；tee 用 PassThrough 不消费原流。
- 改写/mock 能让插件伪造响应——安全敏感，需权限 + 文档警示。

## 9. 分阶段实现计划

| 阶段 | 内容 | 价值 | 依赖 |
|---|---|---|---|
| **P1 ✅(已完成)** | 腿2 Node http/https monkey-patch（**观察**：请求含 body + 响应截断，加 source；改写/block 留待 intercept 控制 API） | 最大缺口、自包含 | 无 |
| **P2 ✅(已完成)** | 腿1 CDP **Network 被动域**渲染观察（旁路 + 取 body，流式安全），feed main api.network；`source:"renderer-cdp"`；config `cdpNetwork` 开关 | 高（绕开 contextIsolation） | 现有 CDP 层 |
| **P3a ✅(已完成)** | `api.network.intercept`（continue/fulfill/fail）经 CDP Fetch 请求阶段 + `interceptResponse`（改写真实响应，**仅命中 URL 缓冲**，其余保持流式）；**主作用域**决策；config `cdpIntercept`；决策超时兜底 | 完整改写/mock/block + 响应改写（主作用域） | P2 |
| **P3b** | 渲染插件 intercept 的 IPC 往返（NetworkHub 路由到拥有该 wc 的渲染插件） | 渲染作用域 intercept | P3a |
| **P4** | WebSocket 旁路（CDP 事件）`onWebSocket`；可选出站改写 | 中 | P2 |
| **P5** | http2 / undici / EventSource；流量查看页 + HAR 导出 | 补全 | P1–P4 |

每阶段：实现 + 纯逻辑单测（归一化/截断/决策选择）+ README 更新 + 提交。

## 10. 兼容性与回退

- `api.network.onRequest/onResponse` 签名不变，老插件无感（新增 `source` 为可选字段）。
- Node patch 若出错 → try/catch 回退到原始函数，绝不阻断 app 网络。
- CDP attach 失败（DevTools 已开）→ 回退到 webRequest 头级 + JS hook。
- 各拦截器可经 config 单独关闭。

## 11. 测试策略

- 纯逻辑单测（Vitest）：options 归一化、body 截断、`intercept` 首个 act 选择、decision 超时回退、WS 帧解析。
- 拦截器本体依赖 Electron/Node 运行时，难单测 → 提供一个最小 Electron 冒烟脚本（手动/可选 CI）。

---

### 落地建议
建议从 **P1（Node http/https 拦截）** 开始：缺口最大、完全进程内、不涉及 CDP/IPC 往返，能立刻让「Node 侧请求」可见可改。随后 P2/P3 把渲染层用 CDP 做实。
