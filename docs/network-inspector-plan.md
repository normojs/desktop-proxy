# 网络检查器（Network Inspector）方案

在 P5 流量录制器之上，做成 DevTools Network + mitmproxy 风格的检查器：进程内拦截、**无需 TLS 解密/CA**、覆盖**主进程 + 渲染进程**。本文给出**完整筛选维度 + 过滤 DSL + 功能目录 + 分阶段计划**。

## 1. 筛选维度（尽量穷举）

| 维度 | 例子 |
|---|---|
| 全文/URL | host、path、query 子串/正则 |
| 类别(category) | ai / auth / telemetry / api / asset / websocket / update / doc / other |
| 服务(service) | openai / anthropic / google / deepseek / … |
| 来源(source) | main / renderer（含具体 webContents id） / node-http / web-request / renderer-cdp |
| 方法(method) | GET / POST / PUT / DELETE / … |
| 协议/类型(kind) | http / https / ws / **sse**（响应 `text/event-stream`） |
| 状态(status) | 精确、区间(2xx/3xx/4xx/5xx)、errors-only、pending、blocked、mocked |
| 时延(time) | slower-than / faster-than、TTFB、总耗时 |
| 大小(size) | 请求体/响应体/合计 的 larger-than / smaller-than |
| 头(headers) | has:header、header 名=值（请求或响应）、content-type |
| 体(body) | 请求体/响应体 子串或正则**全文搜索**（mitmproxy 式） |
| AI 专属 | model=gpt-4o、is:stream、token/用量、估算成本 |
| 标签(tags) | mocked / blocked / raced(winner|loser) / truncated / error / has-auth |
| 时间窗 | since:5m、captured between |
| 否定/组合 | `-domain:telemetry`、多个条件 AND |

## 2. 过滤查询 DSL（核心，覆盖"还没想到"的条件）

搜索框支持 DevTools 式 `key:op value`，空格 = AND，前缀 `-` = 取反，引号 = 短语：

```
status:>=400 method:POST domain:openai.com larger-than:1k is:stream
body:"insufficient_quota" -domain:telemetry has:authorization model:gpt-4o
category:ai source:main slower-than:1s res-size:>10k since:10m
```

支持的 key（建议）：`status`(支持 `>=/<=/>/</=` 与 `2xx`)、`method`、`kind`、`category`、`service`、`source`、`domain`/`host`、`path`、`type`(content-type)、`size`/`req-size`/`res-size`(`larger-than`/`smaller-than` 或 `>`/`<`，带 `k`/`m` 单位)、`time`/`slower-than`/`faster-than`、`has`(header 存在)、`header`(名=值)、`body`/`req-body`/`res-body`(子串，`/re/` 表正则)、`model`、`is`(stream|ws|mocked|blocked|raced|error|truncated|pending)、`since`(`30s`/`5m`/`1h`)；裸词 = URL/服务/摘要全文。

**实现**：`parseQuery(text) → Predicate[]`，`matchEntry(entry, predicate)`——**纯函数、强可测**。快捷胶囊（类别/方法/Kind/Errors-only）只是写入/切换 DSL 的语法糖。

## 3. 详情面板功能

- Tabs：**Summary**（分析：category/service/model/stream/状态/来源/标签）、**Headers**（请求+响应，可搜）、**Payload**（JSON 美化/原始/表单解析）、**Response**（JSON 美化 + 预览 + 原始；SSE 按事件分段）、**Timing**（TTFB/流式条）、**Cookies**。
- 操作：**Copy as cURL** / **Copy as fetch** / 复制 URL/响应；**Replay**（重发）、**Edit & resend**（改头/体后重发，复用 intercept/race 基础设施）；标记/Pin。
- 安全：token/密钥**脱敏显示**；可一键"flag 含敏感信息的请求"。

## 4. 其他功能

- 列表：列排序、按域名/类别**分组**、实时跟随(auto-scroll)+暂停、行内类别徽章、错误高亮。
- 统计条：总数/各类别计数/已传输字节/错误率/AI **token 与估算成本**汇总。
- 导出：HAR（已有）、**导出当前筛选子集**、复制选中。
- 高级：两条请求 **diff**；**保存的过滤预设**；自定义**高亮/告警规则**（如"任何泄露 token 的请求标红"）；节流/延迟注入（联动 intercept）。

## 5. 分阶段计划

- **P-insp-1（先做，纯逻辑可测）**：分析层 `net/traffic-analyze.ts`（category/service/label/kind/method/tags）+ **过滤 DSL 引擎** `net/traffic-filter.ts`（`parseQuery`/`matchEntry`，纯函数 + 单测）+ 录制器接入（摘要带分析字段、`traffic:detail` IPC 返回完整头/体）。
- **P-insp-2**：把浅色视觉稿移植进 Network 页（内联样式）：DSL 搜索框 + 快捷胶囊 + 列表 + 详情面板（Summary/Headers/Payload/Response/Timing）+ 统计条 + HAR。
- **P-insp-3**：Copy as cURL/fetch、Replay & edit-resend、body 全文搜索、AI token/成本、导出筛选子集。
- **P-insp-4**：diff、预设、告警规则、分组、跟随/暂停。

## 现状
- ✅ **P-insp-1**：`net/traffic-analyze.ts`（分类）+ `net/traffic-filter.ts`（DSL `parseQuery`/`matchEntry`）+ 录制器 `list(query)`/`detail(id)` + IPC `traffic:list(query)`/`traffic:detail`。纯逻辑单测覆盖。
- ✅ **P-insp-2**：`packages/preload/src/traffic-page.ts` 重做为检查器（内联样式、闭合 Shadow-DOM）：DSL 搜索 + 类别/方法/Kind/Errors 快捷胶囊（写入 DSL）+ 列表（类别徽章/状态色/服务/大小/耗时/来源）+ 详情面板（摘要网格 + Endpoint/Headers/Payload/Response(SSE 分段) tabs + **Copy as cURL**）+ Capture 开关 + HAR 导出 + Clear。
- ✅ **P-insp-3**：`net/traffic-cost.ts`（解析 OpenAI/Anthropic/Google usage + 价格表估算成本，纯函数单测）；录制器摘要带 `usage`、`list` 聚合 stats（bytes/errors/AI calls·tokens·cost）、**`toHar(query)` 导出筛选子集**；IPC **`traffic:replay`**（重发请求，经 node 拦截自动录制）；UI 统计栏显示 AI 成本、导出用当前 DSL、详情面板 **Replay** 按钮 + Tokens/Est.cost 摘要格。（body 全文搜索已在 DSL；edit-resend 留 P-insp-4。）
- ✅ **P-insp-4**：详情面板 **Edit & resend** 编辑器（改 method/url/头/体，编辑头**整体替换**以支持删除头）；**保存预设**（localStorage 保存/应用/删除）；**Follow** 自动刷新（1.5s）；**Group by domain** 分组。
- ⏳ 后续：diff（对比两条请求）、告警/高亮规则。

## 6. 建议的 v1 范围
P-insp-1 全部 + P-insp-2 的"DSL 搜索 + 类别/方法/Kind/状态/大小/时延过滤 + 详情(Summary/Headers/Payload/Response/Timing) + 统计 + HAR + Copy as cURL"。其余进 v2/v3。
