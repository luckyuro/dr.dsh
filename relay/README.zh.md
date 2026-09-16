# dr.dsh Relay

[English](README.md) · [项目首页](../README.zh.md) · [Daemon](../daemon/README.zh.md)

**部署在服务器上的中继，负责提供浏览器客户端和转发加密流量。**
Relay 可以独立安装、更新和运行；使用离线包时，服务器无需 DSH、Node.js、pnpm 或 Rust。

## 功能

- 提供浏览器客户端（PWA），供手机或其他电脑访问。
- 将客户端与 daemon 的连接按房间接通，转发端到端加密的流量。
- 提供连接保活、容量限制和 `/healthz` 健康检查。

DSH 的启动、配对、设备登记与密钥保管由 [daemon](../daemon/README.zh.md) 负责。

## 安装：服务器无需 Node

Linux x86_64 从 Release 下载静态 musl 程序和预构建 PWA，校验 SHA-256 后安装：

```sh
sh relay/install.sh --start
export PATH="$HOME/.local/bin:$PATH"
drdsh relay status
```

下载需要 Shell、curl、tar、sha256sum 或 shasum。安装和运维不需要 Node、pnpm、Rust、Python 或 jq。
默认安装到 `~/.local`，无需 sudo；服务需要 Linux `systemctl --user` 会话。不加 `--start` / `--enable`
时保持停止且不开自启动。`drdsh-relay ...` 与 `drdsh relay ...` 等价，独立包不能改名启用 daemon。

离线使用时，下载并校验 `drdsh-relay-x86_64-unknown-linux-musl.tar.gz`，解压后运行包内
`sh install.sh --start`。首次发布的 macOS 包只有 daemon，relay 可从源码构建。
混合包、平台矩阵和固定版本见[发布说明](../docs/operations/releases.md)。

### 从源码安装

先构建 PWA 和 CLI，再运行原生安装器：

```sh
pnpm --filter @dr.dsh/pwa build
cargo build -p dr-dsh-cli
target/debug/drdsh relay install --source "$PWD" --skip-build --build-profile debug --start
```

可用 `--client-dir` 指定预构建 PWA。缺少文件会在停止服务前报错，原生安装器不运行 pnpm。
旧 `relay/package.sh` / `relay/install-source.sh` 保留作迁移回归路径；新分发使用
`scripts/build-release.sh` 和 `scripts/package-release.sh`。

## 对外提供访问

中继默认只监听 `127.0.0.1:8787`。其他设备需要一个可访问、证书受信任的 **HTTPS 入口**，
由同机反向代理转发到这个端口。配置例子见[自托管指南](../docs/operations/self-hosting.md)。

把浏览器的 HTTPS 地址交给使用者。daemon 与中继同机时连接 `ws://127.0.0.1:8787`；
分开部署时，当前 daemon 需要[通过 SSH 等安全连接转接](../daemon/README.zh.md#连接远端中继)，尚不能直连 WSS。

## nginx 直接托管 PWA

PWA 是纯静态文件，服务器不执行其中的 JavaScript。构建包含首页 `index.html`、JS、图标和 manifest。
[nginx 配置示例](nginx.conf.example)让 nginx 从公开目录读取 `/` 与 `/client/*`，仅将 `/ws/*`
和 `/healthz` 转发给 Rust relay。也可以让 nginx 代理全部请求，由 relay 自带的静态服务提供页面。

直接托管时把包内 `client/` 复制到 `/srv/dr.dsh-relay/client` 等目录，授予 nginx 用户读取和目录遍历权限。
不要把私有安装目录整体开放。修改示例中的域名、证书、root 与 relay 端口，并保留同源 HTTPS、CSP、
Content-Type、缓存头和 worker 的 `Service-Worker-Allowed: /`；更新时同步替换公开资源副本。
DSH 的真实页面由浏览器 Service Worker 通过加密隧道取得，nginx 不直接访问 DSH。

## 常用命令

| 操作 | 命令 |
| :--- | :--- |
| 启动 / 停止 / 重启 | `drdsh-relay start` / `drdsh-relay stop` / `drdsh-relay restart` |
| 查看状态 / 最近日志 | `drdsh-relay status` / `drdsh-relay logs` |
| 跟随日志 | `drdsh-relay logs --follow` |
| 开启 / 关闭登录自启动 | `drdsh-relay enable` / `drdsh-relay disable` |
| 更新中继与 PWA | `drdsh relay update` |
| 只更新 PWA | `drdsh relay install client --source /path/to/bundle` |
| 卸载中继与 PWA | `drdsh-relay uninstall` |

修改监听端口时重新安装，例如 `sh relay/install.sh --bind 127.0.0.1:8788`。
更新和重启只操作 relay；已有连接会中断并需要重新建立，daemon 与它托管的 DSH 进程继续运行。
`enable` / `disable` 只改变登录自启动，立即启停使用 `start` / `stop`。

## 独立的文件与配置

以下路径以默认的 `~/.local` 为前缀；可用 `--prefix /path/to/install` 修改。

| 路径 | 内容 |
| :--- | :--- |
| `bin/drdsh-relay` | 中继专用管理命令 |
| `etc/dr.dsh/relay.json` | 中继配置与安装记录 |
| `lib/dr.dsh/relay/bin/drdsh` | 中继二进制 |
| `lib/dr.dsh/relay/bin/drdsh` | 原生管理程序 |
| `lib/dr.dsh/relay/client` | PWA 静态文件 |
| `lib/dr.dsh/relay/services` | 系统服务定义 |
| `lib/dr.dsh/relay/logs` | macOS 日志；Linux 使用用户 journal |

Relay 配置不包含 DSH 路径、工作目录或密钥目录。卸载保留自己的配置和日志，不删除 daemon 的文件。
即使两个组件安装在同一前缀，管理命令、配置、服务、更新锁与程序目录也各自独立。

## 使用 Docker

也可以在仓库根目录使用 Docker Compose，替代上面的用户服务安装：

```sh
docker compose up --build -d
```

Docker 实例使用 Compose 管理：

| 操作 | 命令 |
| :--- | :--- |
| 状态 | `docker compose ps` |
| 重启 | `docker compose restart relay` |
| 日志 | `docker compose logs -f relay` |
| 停止并移除容器 | `docker compose down` |

镜像从源码构建，包含 PWA；宿主机无需 Rust、Node.js 或 DSH。HTTPS 仍由你的反向代理提供。

## 实现与边界

实现位于 [`crates/dr-dsh-relay`](../crates/dr-dsh-relay)，客户端位于 [`apps/pwa`](../apps/pwa)。
中继没有会话解密能力，不持有密钥，也没有会话数据库。它同时分发客户端代码，因此其基础设施仍需可信。
详见[安全模型](../docs/security.md)与[零知识中继决策](../docs/decisions/0002-zero-knowledge-relay.md)。

已有独立 `relay.json` 安装可用同一 `--prefix` 运行新安装器，沿用服务身份和配置并替换 JS 管理文件。
从旧版 `drdsh` 统一安装迁入时，参见[迁移说明](../docs/operations/cli.md#从旧版安装迁移)。
