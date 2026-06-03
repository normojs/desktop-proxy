# NATS 服务器部署(Docker 一键,配一次后零运维)

desktop-proxy 远程总线用 **NATS**(中继 + 事件总线 + 鉴权 + 主题 ACL),**只用 Docker** 部署。`scripts/nats-setup.sh` 一条命令搞定:装 Docker、拉镜像、TLS、去中心化 JWT 账号(MEMORY resolver,**无需 push**)、容器开机自启、防火墙,并打印桌面要粘贴的 `remote` 配置。**之后新增桌面/手机都不用再登服务器。**

```
手机/桌面 ──TLS──►  你的服务器: docker(nats)  ◄──TLS── 桌面/手机
                    端口 4222(tls) / 8443(wss)
```

---

## 一键安装(在线)

在**服务器**上以 root 或 sudo 执行:

```bash
curl -fsSL https://raw.githubusercontent.com/normojs/desktop-proxy/main/scripts/nats-setup.sh -o nats-setup.sh

# A) 有域名 + 自动签 Let's Encrypt(需 80 端口空闲、DNS 指向本机)
sudo DOMAIN=nats.your-domain.com TLS=letsencrypt bash nats-setup.sh

# B) 已有 nginx/证书(用现成证书,不抢 80)——推荐共存场景
sudo TLS=existing DOMAIN=nats.your-domain.com \
  CERT_FILE=/etc/letsencrypt/live/nats.your-domain.com/fullchain.pem \
  KEY_FILE=/etc/letsencrypt/live/nats.your-domain.com/privkey.pem bash nats-setup.sh

# C) 无域名快速自测(自签证书)
sudo bash nats-setup.sh
```

变量:`DOMAIN`、`TLS=letsencrypt|existing|selfsigned`、`PORT`(4222)、`WS_PORT`(8443)、`CERT_FILE/KEY_FILE`(existing)、`NATS_IMAGE`(默认 `nats:latest`)、`SKIP_NSC=1`。

---

## 中国大陆网络(代理 / 镜像)

github、docker.io、get.docker.com 在国内常慢/被墙。按需加这些变量(可组合):

```bash
sudo \
  PROXY=http://127.0.0.1:7890 \                # 代理:下载脚本依赖 + 安装 Docker 走它
  GH_MIRROR=https://ghfast.top/ \              # GitHub 镜像:下载 nsc(脚本失败会自动试备用镜像)
  DOCKER_MIRROR=https://docker.m.daocloud.io \ # Docker registry 镜像:拉 nats 镜像
  DOCKER_INSTALL_MIRROR=Aliyun \              # 用阿里云源安装 Docker 本身
  TLS=existing DOMAIN=nats.your-domain.com \
  CERT_FILE=/etc/letsencrypt/live/nats.your-domain.com/fullchain.pem \
  KEY_FILE=/etc/letsencrypt/live/nats.your-domain.com/privkey.pem \
  bash nats-setup.sh
```
- 没有代理也行:`GH_MIRROR` 解决 nsc 下载,`DOCKER_MIRROR` 解决镜像拉取,`DOCKER_INSTALL_MIRROR=Aliyun` 解决装 Docker。
- 连脚本本身都慢:`curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/normojs/desktop-proxy/main/scripts/nats-setup.sh -o nats-setup.sh`。
- 常见 registry 镜像:`https://docker.m.daocloud.io`、`https://dockerproxy.net`、或你自己的阿里云加速器地址。

---

## 服务器已有 nginx / 其他网站(共存)

NATS 用 `4222`/`8443`,与 nginx 的 `80`/`443` **不冲突**;**不要**让脚本用 `--standalone` 抢 80,改 `TLS=existing` 指向你已有证书。没有证书就用 **webroot** 免费签(只要 `certbot`,不用 `-nginx` 插件):
```nginx
# /etc/nginx/conf.d/nats.conf
server { listen 80; server_name nats.your-domain.com; root /var/www/html;
  location /.well-known/acme-challenge/ { allow all; } }
```
```bash
sudo mkdir -p /var/www/html && sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/html -d nats.your-domain.com --non-interactive --agree-tos -m admin@your-domain.com
```
然后用上面的 **B)** 命令(`TLS=existing` 指 `/etc/letsencrypt/live/nats.your-domain.com/`)。容器会自动只读挂载 `/etc/letsencrypt` 并以 `-u 0:0` 运行以读取私钥。

> 想让手机走标准 **443**:用现有 nginx 反代 `wss` 到 NATS(需把 NATS websocket 改 `no_tls` 内网端口);或把 `WS_PORT=443`(若 443 空闲)。

---

## 跑完之后(桌面 + 手机)

脚本结尾打印 `remote` 块(也存 `~/desktop-proxy-remote.json`),例如:
```json
{ "remote": { "enabled": true, "url": "tls://nats.your-domain.com:4222",
  "accountSeed": "SA...", "accountId": "A..." } }
```
- 粘进每台桌面的 `~/.desktop-proxy/config.json` → 重启被注入的 app(日志 `~/.desktop-proxy/log/main.log` 出现 `remote bus connected`)。
- 自签证书时额外加 `"caFile": "<服务器 cert.pem 拷到桌面后的路径>"`。
- 手机:桌面运行 `dprox pair` 出二维码扫码即接入(**本地现签**设备凭据,不碰服务器)。

---

## 重复执行 / 管理

- **幂等**:可随时重跑同一命令——已有账号/密钥**复用不变**(已配对设备继续有效),容器替换重启。
- 管理:`docker logs nats`(日志)、`docker ps`(状态)、`docker restart nats`、`docker rm -f nats`(删)。
- 升级镜像:`NATS_IMAGE=nats:2.11 ... bash nats-setup.sh` 或 `docker pull nats:latest && docker restart nats`。

---

## 安全须知
- `accountSeed` = 签发权限,**勿外泄**;泄露则在 nsc 轮换 APP 签名密钥后重跑脚本。
- 传输 TLS 加密;NATS(你的服务器)中间可见明文——服务器是你自己的,符合既定取舍。
- `remote.enabled=false`(默认)时桌面不连 NATS。
- 云服务器记得在**安全组**也放行 `4222`/`8443`。
