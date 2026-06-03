# ADR: 统一消息协议 + 远程总线(NATS)与手机端

## 决策
- **远程传输 = NATS**(自建,开源 CNCF):单进程同时充当**事件总线 + 中继 + 鉴权 + 主题级 ACL + TLS**。桌面与手机都**拨出**连到你服务器的 NATS,手机**从不直连桌面**。
- **加密**:两侧↔NATS 均 TLS;NATS(自有服务器)中间见明文,**接受**(暂不做应用层 E2E)。
- **协议全量收敛**:定义一套与传输无关的协议;app 内走 Electron IPC,远程走 NATS,**同一套语义**。
- **手机端 = 原生 App**(Swift / Kotlin,均有 NATS 客户端)。

## 协议(传输无关)
统一信封 `Envelope`:
- `event`:`{ kind:"event", topic, data }` —— 单向 pub/sub(对应 `api.events`、`traffic:entry`、`config:changed`)。
- `req` / `res`:`{ kind:"req", id, method, params }` → `{ kind:"res", id, ok, result|error }` —— 双向 RPC(`traffic.list/detail/replay`、`config.get/set`、`plugin.list/toggle`…)。**任一侧均可发起**(桌面→手机的审批就是反向 req)。

**BusRouter**(纯逻辑,可多传输):`handle(method,fn)` / `request(method,params,target)` / `publish(topic,data)` / `subscribe(topic,fn)` / `addTransport(name,t)`。主进程的 router 挂**两个传输(IPC + NATS)**并在两侧**桥接**事件与 RPC;渲染端/手机端是**叶子 router**(单传输)。

**BusTransport** 接口:`send(env, target?)` + `setReceiver(fn)`。实现:`IpcTransport`(app 内)、`NatsTransport`(远程)。

## NATS 主题映射(按桌面实例)
- 事件:`dp.<instanceId>.event.<topic>`
- RPC:`dp.<instanceId>.rpc.<method>`(NATS request/reply)
- 审批:`dp.<instanceId>.approval.<id>`(桌面发起,手机 allow/deny)

## 配对 + ACL
- 桌面生成 `instanceId` + 一份**限定到 `dp.<instanceId>.>` 子集**的 NATS 凭据(nkey/JWT 或带 permissions 的用户),显示**二维码**(含 NATS 地址 + 凭据)。
- 手机扫码即获授权;**ACL 直接用 NATS 主题权限**(手机默认不能订阅含密钥的流量主题、不能发控制类主题)。

## 开发顺序(分阶段;每步 build/typecheck/test/lint)
- **A 协议收敛(纯本地,行为不变)**
  - A1. ✅ `BusRouter` + `Envelope` + `BusTransport` 接口(`plugin-sdk/bus.ts`,纯逻辑 + 9 单测)。
  - A2. ✅ `IpcTransport`(主 `runtime/bus-ipc.ts` 多对等 hub / 渲染 `preload/bus-ipc.ts` 叶子),单通道 `ch("bus")` 承载信封。
  - A3. ✅ `api.events` 迁到 bus(主 hub `bridge:true`,渲染叶子;行为不变)。
  - A4. ✅ 手机相关面收敛为 bus RPC:`config.get/set`、`plugin.list/toggle`、`traffic.list/detail/clear`(逻辑单点在 `bus.handle`,旧 IPC 通道**委托**到 bus;远程客户端可直接调)。
  - A5. ⏳(可延后)其余通道迁入:`traffic.replay/export`、fs/cdp/net/storage;以及渲染端逐步改用 `bus.request`。
  - A6 → 并入 B:独立进程(CLI/手机)用不了 Electron IPC,需网络传输(NATS),故 Node 客户端库随 B 一起做。
- **B 远程打通(代码完成,联调需你的 NATS 服务器)**
  - B1. ✅ `net/nats-transport.ts`:`createNatsHubTransport`(桌面)+ `createNatsClientTransport`(手机/CLI);`net/remote-subjects.ts` 主题/配对/ACL(纯逻辑,10 单测,hub 映射用 mock 连接测)。
  - B2. ✅ 配对:`desktop-proxy pair` 打印二维码 + `desktopproxy://pair?d=...`(含 instanceId/url/设备凭据);ACL = NATS 主题权限。
  - B3. ✅ 主进程接线:config `remote{enabled,url,user,pass,deviceUser,devicePass}` + `instanceId` 自动生成;`syncRemote()` 启动/配置变更时连/断并 `addTransport("nats")`(默认关);`removeTransport` 热关闭。
  - B4. ✅ 部署教程 `docs/nats-deploy.md`(安装/TLS/用户+ACL/WebSocket/systemd/防火墙/自测/配对)。
  - B5. ✅ **去中心化 JWT(配一次,零服务器操作)**:`net/remote-jwt.ts` 用 `nats-jwt`+`nkeys.js` **本地签发** hub/device 用户 JWT(权限来自 `remote-subjects`,3 单测);`syncRemote` 在有 `accountSeed`+`accountId` 时用 `jwtAuthenticator` 连接(否则回退 user/pass);`pair` JWT 模式**现签** device 凭据塞二维码;部署教程重写为一次性 `nsc` operator/APP/作用域签名密钥 + `nats-resolver`。
  - B6. ⏳ 联调:你服务器按 `docs/nats-deploy.md` 配置一次 → 桌面填 `remote.{url,accountSeed,accountId}` 重启 → `pair` 出码 → 手机/CLI 连。**之后新增桌面/手机零服务器操作。**
- **C 原生 App**
  - C1. Swift(iOS)/Kotlin(Android)NATS 客户端:远程检查器 + 通知 + 审批。
  - C2. 可选 JetStream(离线通知/持久化);可选应用层 E2E。

## 环境说明
A 全程可在本仓库实现+单测。B 需要一台可达的 NATS 服务器联调。C 为独立原生工程(本仓库外)。
