# dr.dsh

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-dark.svg">
  <img src="assets/brand/logo.svg" alt="dr.dsh 鲸鱼隧道标志" width="360" height="96">
</picture>

[English](README.md) | 中文

**在手机或另一台电脑的浏览器里，继续使用自己电脑上的 DeepSeek Harness。**

dr.dsh 提供真实 DSH 界面的远程访问、进程管理与设备配对。
DSH 在你的电脑上运行，会话流量在浏览器与 daemon 之间端到端加密，经自托管的 relay 转发。

## 两个独立组件

| | Relay：中继服务器 | Daemon：DSH 所在电脑 |
| :--- | :--- | :--- |
| 功能 | 提供浏览器客户端（PWA）、转发加密流量、连接保活与健康检查 | 管理本机 DSH、设备配对、加密隧道、审计与崩溃记录 |
| 安装位置 | 你的服务器，也可与 daemon 同机 | 已安装 DSH 的电脑 |
| 一键安装 | [安装命令](#1-安装-relay) | [安装命令](#2-安装-daemon) |
| 管理命令 | `drdsh relay` | `drdsh daemon` |
| 独立说明 | **[Relay 安装与使用](relay/README.zh.md)** | **[Daemon 安装与使用](daemon/README.zh.md)** |

两侧各自拥有配置、程序目录、日志、系统服务和更新锁。更新或卸载一侧，不会重启或卸载另一侧。
中继重启会中断连接，需要重新连接；DSH 的进程继续运行。

```text
手机 / 浏览器 ⇄ Relay（中继 + PWA） ⇄ Daemon（你的电脑） → DSH
```

**当前版本 `0.1.1`，提供 GitHub Release 二进制包。** Linux x86_64 musl 提供混合包、relay 包与 daemon 包；
macOS Apple Silicon 提供 daemon 包。三个包使用同一套原生 CLI，同平台各包共用逐字节相同的二进制，包清单决定可用组件。
`drdsh-relay` / `drdsh-daemon` 是按名字选择组件的别名，详见[发布与安装](docs/operations/releases.md)。
没有 npm 发布包、官方托管中继或第三方安全审计。

## 快速开始

在各自机器上用 `curl` 直接安装。脚本自动识别系统和 CPU，从 GitHub Release 下载对应的二进制包，
核对 SHA-256 后安装。只需 curl、tar、sha256sum 或 shasum，无需克隆仓库、Rust、pnpm 或管理用 Node。
Daemon 所在机器仍需 Node 和已配置好模型的 DSH。
Linux 使用 `systemctl --user`，macOS 使用图形登录会话。下面 relay 安装在 Linux x86_64 服务器；
daemon 可安装在该服务器或 Apple Silicon Mac。Linux 同机部署也可选择下方的混合包命令。

### 1. 安装 Relay

安装器从 Release 下载 relay 和已经构建好的 PWA，并核对 SHA-256：

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/relay/install.sh | sh -s -- --start
export PATH="$HOME/.local/bin:$PATH"
drdsh relay status
```

看到 `relay health: responding` 后，中继已就绪。默认监听 `127.0.0.1:8787`。
手机或其他电脑可通过 `https://relay.example.com` 这样的域名访问：将 DNS 指向服务器，
再由 HTTPS 反向代理转发到本机 relay，见[域名配置步骤](relay/README.zh.md#使用域名)。
`--bind` 保持为本机监听 IP 和端口。

### 2. 安装 Daemon

在 DSH 电脑上执行，`--relay` 填写中继实际的 WebSocket 地址，使用它提供的 `ws://` 或 `wss://`。
以下地址适用于**同机中继**；使用 HTTPS 域名时可改为 `--relay wss://relay.example.com`，
WSS 需使用[包含本次修复的 daemon 构建](daemon/README.zh.md#连接远端中继)。
将 `/absolute/path/to/dsh` 替换为已安装的 **DeepSeek Harness 可执行程序**路径，可用 `command -v dsh` 查找：

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --dsh /absolute/path/to/dsh --relay ws://127.0.0.1:8787 --start
export PATH="$HOME/.local/bin:$PATH"
drdsh daemon status
```

`--dsh` 指定程序；可选的 `--workdir /path/to/your/project` 指定它启动时的工作目录。
首次安装省略这两项时，分别使用 PATH 中的 `dsh` 和当前目录；重新安装会沿用已保存的值。
已有 DSH 占用 `3080` 时可加 `--port 3081`。
具体路径见 [Git clone 与 npm 安装示例](daemon/README.zh.md#按安装方式指定-dsh)；
需要时可参考 [SSH 转发辅助说明](daemon/README.zh.md#ssh-转发可选)。
安装器不安装或配置上游 DSH。集成核对基准为 DSH `0.1.5-rc.2`，升级上游后需重新核对兼容性。

两套命令默认安装在 `~/.local/bin`。`export` 只影响当前终端，可加入 shell 配置以便以后使用。

Linux 同机安装两个组件：

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/install.sh | sh -s -- \
  --component mixed --dsh /absolute/path/to/dsh --start
```

省略 `--start` 只安装，不启动服务；加 `--enable` 开启登录自启动。根入口默认在 Linux 选择混合包，
macOS 选择 daemon。也可在管道的 **`sh` 一侧**设置环境变量，命令行参数优先：

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/install.sh | \
  DRDSH_COMPONENT=daemon DRDSH_VERSION=v0.1.1 DRDSH_PREFIX="$HOME/.local" sh
```

`DRDSH_VERSION` 默认 `latest`，`DRDSH_PREFIX` 默认 `~/.local`。
更多参数和离线安装见[发布与安装](docs/operations/releases.md)。

### 3. 配对并打开 DSH

在 DSH 电脑上运行，并保持命令等待：

```sh
drdsh daemon pair
```

1. 浏览器打开中继的 HTTPS 地址；同机试用可打开 [本机中继](http://127.0.0.1:8787)。
2. 在 **配对码或房间密钥** 中输入终端显示的配对码，点击 **连接**。
3. 配对成功后，再点一次 **连接** 建立隧道。
4. 点击 **打开 DeepSeek Harness 界面**，在新标签页使用 DSH。

**保留原来的 dr.dsh 标签页**，它维持连接。配对码约 5 分钟有效，一次使用；失败或过期后重新生成。
浏览器会记住配对，下次选择已保存的电脑连接即可，也可以添加多台电脑。

PWA 支持简体中文和英文，首次按浏览器语言偏好的顺序选择，未匹配时使用英文。
右上角的 **中文 / English** 按钮可随时切换，选择会按中继站点保存在当前浏览器中；
离线也可切换，不影响当前连接。隧道内的 DSH 界面保留自身的语言设置。

## 日常管理

| 操作 | Relay | Daemon |
| :--- | :--- | :--- |
| 启动 | `drdsh relay start` | `drdsh daemon start` |
| 停止 | `drdsh relay stop` | `drdsh daemon stop` |
| 重启 | `drdsh relay restart` | `drdsh daemon restart` |
| 状态 | `drdsh relay status` | `drdsh daemon status` |
| 跟随日志 | `drdsh relay logs --follow` | `drdsh daemon logs --follow` |
| 登录自启动 | `drdsh relay enable` | `drdsh daemon enable` |
| 从 Release 更新 | `drdsh relay update` | `drdsh daemon update` |
| 卸载 | `drdsh relay uninstall` | `drdsh daemon uninstall` |

`disable` 取消登录自启动，`stop` 停止当前服务。卸载保留各自配置、日志及 daemon 的配对数据。
PWA 随 Relay 安装；可选插件在安装时加 `--with-plugin`，或从解压包运行 `drdsh daemon install plugin --source <bundle>`。

旧统一安装使用 `scripts/install-legacy.sh` 和已有旧命令；新 `install.sh` 使用 Release。
已有用户请按[迁移说明](docs/operations/cli.md#从旧版安装迁移)保留配对状态。

## 使用前了解

- DSH 电脑需要保持开机、联网且不休眠。
- 远程浏览器需要 HTTPS。Daemon 支持 WS 和 WSS，按 `--relay` 中的协议连接。
- 目前没有后台推送，插件补充通知接收端也尚未实现；审批与提问在保持连接的真实 DSH 界面中处理。
- 中继同时分发浏览器客户端，其基础设施需要可信。当前尚无第三方安全审计，见[安全模型](docs/security.md)。

## 文档与开发

- **[Relay 文档](relay/README.zh.md)**：独立安装、命令、配置与 Docker 部署。
- **[Daemon 文档](daemon/README.zh.md)**：独立安装、远程连接、配对、插件与状态备份。
- [完整 CLI 与迁移](docs/operations/cli.md)、[故障排查](docs/operations/troubleshooting.md)、[MVP 进度](docs/product/mvp.md)。
- [架构](docs/architecture.md)、[设计决策](docs/decisions/README.md)、[贡献指南](docs/development/contributing.md)、[仓库规约](AGENTS.md)。

```sh
pnpm install
pnpm run verify
```

## 许可证

MIT。
