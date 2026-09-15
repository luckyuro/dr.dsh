# dr.dsh Relay

[English](README.md) · [项目首页](../README.zh.md) · [Daemon](../daemon/README.zh.md)

**部署在服务器上的中继，负责提供浏览器客户端和转发加密流量。**
Relay 可以独立安装、更新和运行；服务器无需安装 DSH。

## 功能

- 提供浏览器客户端（PWA），供手机或其他电脑访问。
- 将客户端与 daemon 的连接按房间接通，转发端到端加密的流量。
- 提供连接保活、容量限制和 `/healthz` 健康检查。

DSH 的启动、配对、设备登记与密钥保管由 [daemon](../daemon/README.zh.md) 负责。

## 一键安装

源码安装需要 Node.js 24+（或 22 系列的 22.19+）、Rust stable、pnpm 12.3.4 与平台编译工具链。
服务管理支持 macOS 的图形登录会话、Linux 的 `systemctl --user` 会话，以及启用 systemd 的 WSL2。

在中继服务器上执行：

```sh
git clone https://github.com/luckyuro/dr.dsh.git
cd dr.dsh
sh relay/install.sh --start
export PATH="$HOME/.local/bin:$PATH"
drdsh-relayctl status
```

安装器只构建中继与 PWA。默认安装到 `~/.local`，无需 sudo。
`status` 显示 `relay health: responding` 后，可以打开 [本机页面](http://127.0.0.1:8787)。
页面可用后，安装并启动 daemon 才能配对和访问 DSH。

`export` 只对当前终端生效；可将它加入 shell 配置，也可以直接运行 `~/.local/bin/drdsh-relayctl`。

## 对外提供访问

中继默认只监听 `127.0.0.1:8787`。其他设备需要一个可访问、证书受信任的 **HTTPS 入口**，
由同机反向代理转发到这个端口。配置例子见[自托管指南](../docs/operations/self-hosting.md)。

把浏览器的 HTTPS 地址交给使用者。daemon 与中继同机时连接 `ws://127.0.0.1:8787`；
分开部署时，当前 daemon 需要[通过 SSH 等安全连接转接](../daemon/README.zh.md#连接远端中继)，尚不能直连 WSS。

## 常用命令

| 操作 | 命令 |
| :--- | :--- |
| 启动 / 停止 / 重启 | `drdsh-relayctl start` / `drdsh-relayctl stop` / `drdsh-relayctl restart` |
| 查看状态 / 最近日志 | `drdsh-relayctl status` / `drdsh-relayctl logs` |
| 跟随日志 | `drdsh-relayctl logs --follow` |
| 开启 / 关闭登录自启动 | `drdsh-relayctl enable` / `drdsh-relayctl disable` |
| 更新中继与 PWA | `drdsh-relayctl install --source /path/to/dr.dsh` |
| 只更新 PWA | `drdsh-relayctl install client` |
| 卸载中继与 PWA | `drdsh-relayctl uninstall` |

修改监听端口时重新安装，例如 `drdsh-relayctl install --bind 127.0.0.1:8788`。
更新和重启只操作 relay；已有连接会中断并需要重新建立，daemon 与它托管的 DSH 进程继续运行。
`enable` / `disable` 只改变登录自启动，立即启停使用 `start` / `stop`。

## 独立的文件与配置

以下路径以默认的 `~/.local` 为前缀；可用 `--prefix /path/to/install` 修改。

| 路径 | 内容 |
| :--- | :--- |
| `bin/drdsh-relayctl` | 中继专用管理命令 |
| `etc/dr.dsh/relay.json` | 中继配置与安装记录 |
| `lib/dr.dsh/relay/bin/drdsh-relay` | 中继二进制 |
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

从旧版 `drdsh` 安装迁入时，参见[迁移说明](../docs/operations/cli.md#从旧版安装迁移)。
