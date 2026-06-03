# NATS 服务器部署教程（去中心化 JWT，配一次后零服务器操作）

desktop-proxy 远程总线用 **NATS**(中继 + 事件总线 + 鉴权 + 主题级 ACL)。采用**去中心化 JWT + nats-resolver**:服务器**只配置一次**;之后桌面用账号签名密钥在**本地签发**自己的 hub 凭据,`desktop-proxy pair` 为每台手机**本地现签** device 凭据——**新增桌面/手机都不用再登服务器**。

```
手机(原生App) ─TLS─┐
                    ├─►  你的服务器: nats-server(operator+APP账号+nats-resolver)  ◄─TLS─ 桌面
浏览器/CLI  ─wss─┘        验签即放行(账号已知),不需逐用户配置/重载
```

> 适用:一台有公网 IP/域名的 Linux VPS。下面以 Ubuntu 为例。

---

## 一键安装(在线,最省事)

在**服务器**上以 root 或 sudo 执行——脚本自动完成 **安装 nats-server + nsc + 证书 + 去中心化 JWT 账号(operator/SYS/APP + nats-resolver)+ 开机自启 + 防火墙**,并在结尾打印好桌面要粘贴的 `remote` 配置(`url/accountSeed/accountId`):

```bash
# 域名 + Let's Encrypt + systemd 开机自启(推荐)
curl -fsSL https://raw.githubusercontent.com/normojs/desktop-proxy/main/scripts/nats-setup.sh -o nats-setup.sh
sudo DOMAIN=nats.your-domain.com TLS=letsencrypt PM=systemd bash nats-setup.sh

# 无域名快速自测(自签证书,管道直跑)
curl -fsSL https://raw.githubusercontent.com/normojs/desktop-proxy/main/scripts/nats-setup.sh | sudo bash

# Docker(restart=unless-stopped 即开机自启)
curl -fsSL https://raw.githubusercontent.com/normojs/desktop-proxy/main/scripts/nats-setup.sh -o nats-setup.sh
sudo PM=docker DOMAIN=nats.your-domain.com TLS=letsencrypt bash nats-setup.sh
```
变量:`DOMAIN`(可选)、`TLS=letsencrypt|selfsigned`、`PM=systemd|pm2|docker`、`PORT`(4222)、`WS_PORT`(8443)、`SKIP_NSC=1`(跳过账号自动化,手动做)。

**跑完后**:把脚本打印(也存于 `~/desktop-proxy-remote.json`)的 `remote` 块粘进每台桌面的 `~/.desktop-proxy/config.json` → 重启 app → `desktop-proxy pair` 加手机。**之后新增桌面/手机零服务器操作。** 下面是手动分步版(用于排错或自定义)。

---

## 部署方式与开机自启(三选一)

- **systemd(推荐)**:见 A5;`systemctl enable --now nats` 即**开机自启**。
- **pm2**:
  ```bash
  npm i -g pm2
  pm2 start /usr/local/bin/nats-server --name nats -- -c /etc/nats/nats-server.conf
  pm2 save          # 记住当前进程
  pm2 startup       # 按提示执行它打印的一条 sudo 命令 → 开机自启
  ```
- **Docker**(`--restart unless-stopped` 即开机自启,需 docker 服务自身已 enable):
  ```bash
  docker run -d --name nats --restart unless-stopped \
    -p 4222:4222 -p 8443:8443 -v /etc/nats:/etc/nats nats:2.14 -c /etc/nats/nats-server.conf
  ```

---

## A. 一次性:服务器与账号(只做一次)

### A1. 安装组件
```bash
# nats-server
VER=v2.14.2; ARCH=amd64   # arm64 视架构
curl -L -o /tmp/n.tar.gz "https://github.com/nats-io/nats-server/releases/download/${VER}/nats-server-${VER}-linux-${ARCH}.tar.gz"
tar -xzf /tmp/n.tar.gz -C /tmp && sudo install /tmp/nats-server-*/nats-server /usr/local/bin/nats-server

# nsc(凭据管理)与 nats(CLI 自测)
curl -L https://github.com/nats-io/nsc/releases/latest/download/nsc-linux-amd64.zip -o /tmp/nsc.zip && sudo unzip -o /tmp/nsc.zip -d /usr/local/bin
curl -sf https://binaries.nats.dev/nats-io/natscli/nats@latest | sh && sudo install nats /usr/local/bin/nats
```

### A2. TLS 证书
```bash
# 有域名(推荐)
sudo apt install -y certbot && sudo certbot certonly --standalone -d nats.your-domain.com
# 证书: /etc/letsencrypt/live/nats.your-domain.com/{fullchain,privkey}.pem
```
（无域名可自签,但客户端需信任该 CA;生产用 Let's Encrypt。）

### A3. 用 nsc 建 operator / SYS / APP 账号 + 签名密钥
```bash
nsc add operator --generate-signing-key --sys --name DP
nsc edit operator --require-signing-keys --account-jwt-server-url "nats://127.0.0.1:4222"

nsc add account APP
nsc edit account APP --sk generate        # 给 APP 生成一个“签名密钥”(用于签发用户 JWT)
```

**(可选但推荐)把签名密钥设为"作用域(scoped)",强制把签出的用户限制在 `dp.>`**——即使桌面上的签名密钥泄露,也只能签发被限制在 `dp.>` 的用户:
```bash
SK=$(nsc describe account APP -J | jq -r '.nats.signing_keys[0].key // .nats.signing_keys[0]')
nsc edit signing-key --account APP --sk "$SK" --role dpdevice \
  --allow-pub "dp.>" --allow-sub "dp.>" --allow-pub "_INBOX.>" --allow-sub "_INBOX.>"
```

### A4. 生成服务器配置(operator + SYS + nats-resolver)
```bash
sudo mkdir -p /etc/nats/jwt
nsc generate config --nats-resolver --sys-account SYS | sudo tee /etc/nats/resolver.conf >/dev/null
# 把 resolver.conf 里的 dir 指到可写目录,例如 /etc/nats/jwt(若未自动写入)
```

`/etc/nats/nats-server.conf`:
```hocon
host: "0.0.0.0"
port: 4222
tls {
  cert_file: "/etc/letsencrypt/live/nats.your-domain.com/fullchain.pem"
  key_file:  "/etc/letsencrypt/live/nats.your-domain.com/privkey.pem"
}
websocket {                      # 给浏览器/部分手机栈(wss)
  port: 8443
  tls {
    cert_file: "/etc/letsencrypt/live/nats.your-domain.com/fullchain.pem"
    key_file:  "/etc/letsencrypt/live/nats.your-domain.com/privkey.pem"
  }
}
include "resolver.conf"          # operator + SYS + nats-resolver(A4 生成)
max_payload: 8MB
```

### A5. systemd 常驻 + 防火墙 + 推送账号
```bash
sudo tee /etc/systemd/system/nats.service >/dev/null <<'EOF'
[Unit]
Description=NATS Server
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/bin/nats-server -c /etc/nats/nats-server.conf
Restart=always
RestartSec=2
LimitNOFILE=100000
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now nats
sudo ufw allow 4222/tcp && sudo ufw allow 8443/tcp

# 把 operator/APP 账号 JWT 推送到运行中的 resolver(以后改账号才需要再 push)
nsc push -A
```

### A6. 取出桌面要用的两样东西
desktop-proxy 桌面端需要 **APP 账号签名密钥的 SEED** 和 **APP 账号的公钥 ID**:
```bash
# APP 账号公钥 ID(issuer_account, A 开头)
nsc describe account APP -J | jq -r '.sub'

# APP 签名密钥的公钥(A 开头,与上面不同)
SKPUB=$(nsc describe account APP -J | jq -r '.nats.signing_keys[0].key // .nats.signing_keys[0]')
echo "$SKPUB"

# 该签名密钥的 SEED(SA 开头)——在 nsc 密钥库里:
cat "$(nsc env -J | jq -r '.stores')/../keys/keys/${SKPUB:0:1}/${SKPUB:1:2}/${SKPUB}.nk" 2>/dev/null \
  || find ~/.local/share/nats/nsc -name "${SKPUB}.nk" -exec cat {} \;
```
> 记下:`accountId = APP 账号公钥 ID(sub)`、`accountSeed = 签名密钥 SEED(SA...)`。**SEED 是敏感凭据,妥善保管。**

至此**服务器侧全部完成,以后不用再动**。

---

## B. 桌面端接入(每台桌面一次,无需登服务器)

编辑 `~/.desktop-proxy/config.json`:
```json
{
  "remote": {
    "enabled": true,
    "url": "tls://nats.your-domain.com:4222",
    "accountSeed": "SA...(A6 的签名密钥 SEED)",
    "accountId": "A...(A6 的 APP 账号公钥 ID)"
  }
}
```
- `url`:原生 App/桌面用 `tls://...:4222`;走 WebSocket 用 `wss://nats.your-domain.com:8443`。
- **自签证书**时,把服务器的 `cert.pem` 拷到桌面,并加 `"caFile": "/path/to/cert.pem"` 让桌面信任它(Let's Encrypt 域名证书则不需要)。
- 重启被注入的 app。桌面会**本地签发 hub 凭据**并连上(日志 `~/.desktop-proxy/log/main.log` 出现 `remote bus connected`)。`instanceId` 会自动生成并写入 config。

> 多台桌面:把同样的 `accountSeed/accountId/url` 填进各自的 config 即可;每台自动用各自 `instanceId` 隔离主题。**不需要在服务器加任何用户。**

---

## C. 配对手机(每台手机一次,无需登服务器)

```bash
desktop-proxy pair --name "我的 Mac"
```
- JWT 模式下,这会**本地现签**一个仅限本实例 `dp.<instanceId>.*` 的 device JWT,打印二维码 + `desktopproxy://pair?d=...`。手机原生 App 扫码即接入。
- 每扫一次都是一份新的设备凭据;**全程不碰服务器。**

---

## D. 自测(可选,用 NATS CLI 验证连通与 ACL)
```bash
# 用 APP 签名密钥临时签一个用户做测试,或直接观察桌面连接日志。
nats --server tls://nats.your-domain.com:4222 --creds <某 .creds> rtt
```

---

## 安全须知
- `accountSeed` = 签发权限,**勿外泄**;泄露时在 nsc 里轮换 APP 签名密钥并 `nsc push -A`,旧桌面需更新 config。
- 用了**作用域签名密钥**(A3 可选步骤)时,即使 seed 泄露,签出的用户也被限制在 `dp.>`,影响面最小。
- 传输 TLS 加密;NATS(你的服务器)中间可见明文——服务器是你自己的,符合既定取舍。需"零知识中继"时可在 payload 上叠应用层 E2E(后续可选)。
- `remote.enabled=false`(默认)时桌面不连 NATS、不开任何端口。

---

## 静态回退(可选,不想用 nsc 时)
若暂不想用 JWT,可用静态 user/pass:在 `nats-server.conf` 的 `authorization.users` 里按 `dp.<ID>.*` 手动建 `hub_<ID>/dev_<ID>` 两用户(每台桌面都要加,**非零操作**),桌面 config 用 `remote.user/pass/deviceUser/devicePass`。详见本仓库历史版本;推荐还是用上面的 JWT 模式。
