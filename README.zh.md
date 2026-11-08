# dr.dsh

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-dark.svg">
  <img src="assets/brand/logo.svg" alt="dr.dsh 鲸鱼隧道标志" width="360" height="96">
</picture>

[English](README.md) | 中文

**在手机或另一台电脑的浏览器里，继续使用自己电脑上的 DeepSeek Harness。**

DSH 和会话数据留在你的电脑上。dr.dsh 将真实的 DSH 界面送到浏览器，流量在两端加密，
通过你部署的 Relay 中继转发。

[下载 v0.2.0](https://github.com/luckyuro/dr.dsh/releases/tag/v0.2.0) ·
[安装与升级](docs/operations/releases.md) · [故障排查](docs/operations/troubleshooting.md)

## 选择运行方式

两种方式都需要一个 Relay。Relay 提供网页客户端；DSH 所在电脑主动连接它，无需开放 DSH 端口。

| 你的需要 | 选择 | DSH 关闭后 |
| :--- | :--- | :--- |
| 自动安装 DSH，或需要远程启停、重启和崩溃恢复 | **常驻 Daemon**，按下方快速开始安装 | Daemon 仍可接收启动命令 |
| 已有 DSH，只需在它运行时远程访问 | **[DSH 插件](daemon/README.zh.md#从-dsh-插件管理-daemon)**，配置 `relayUrl` | 插件隧道一起退出；在本机重新启动 DSH |

```text
手机 / 浏览器 ⇄ Relay（服务器 + PWA） ⇄ Daemon 或插件隧道（你的电脑） → DSH
```

发布包支持 **Linux x86_64（musl）** 和 **macOS Apple Silicon**。Linux 提供 Relay、Daemon 和混合包；
macOS 提供 Daemon 包。独立插件包包含这两个平台的原生程序。
已发布的 v0.2.0 包使用 DSH `0.2.2-alpha.2`；当前源码支持 `0.2.2-rc.1`，同时回归 `0.2.1-rc.5`。
自动安装会固定已验收的 DSH 与 Cordis 依赖组合，详见[兼容记录](docs/integration/dsh-surface.md)。

当前源码还加入了结构化诊断与输入校验，修复了自定义管理实例接管、持续响应和长会话快照。
这些改动尚未包含在 v0.2.0 下载包中。具体变更和配套升级要求见[未发布的源码更新](docs/operations/releases.md#未发布的源码更新)，
实测范围见 [11 月 7 日验收记录](docs/operations/acceptance-2026-11-07.md)。

## 快速开始

准备一台 Linux 中继服务器和一台运行 DSH 的电脑，可以是同一台 Linux 机器。
安装脚本需要 curl、tar 和 sha256sum 或 shasum；DSH 电脑另需 **Node 24.9+ 与 npm**。
Linux 需要 systemd 用户会话，macOS 需要登录会话。安装无需 Rust、pnpm 或克隆仓库。
运行模型任务前，需在 DSH 中配置自己的账号或 API key。

### 1. 安装 Relay

在 Linux 中继服务器执行：

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/relay/install.sh | sh -s -- --start
export PATH="$HOME/.local/bin:$PATH"
drdsh relay status
```

出现 `relay health: responding` 表示就绪。默认监听 `127.0.0.1:8787`。
为手机或其他电脑配置 HTTPS 域名，例如 `https://relay.example.com`：
按[域名配置](relay/README.zh.md#使用域名)设置 DNS 和反向代理，或使用[原生 TLS](docs/operations/tls.md)。
`--bind` 填监听 IP 和端口；它不是域名或 WebSocket 地址。

### 2. 安装 Daemon

在 DSH 电脑上执行，将示例域名换成你的中继：

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --relay wss://relay.example.com --start
export PATH="$HOME/.local/bin:$PATH"
drdsh daemon status
```

首次安装会下载固定版本的 DSH 和随包插件。已有 DSH 时，加
`--dsh /absolute/path/to/dsh` 指定它的**可执行文件**；重新安装会沿用已保存的路径和配置。
这两种安装方式的数据边界见 [DSH 自动安装](docs/operations/dsh-provisioning.md)。

常用选项：

| 选项 | 用途 |
| :--- | :--- |
| `--workdir /path/to/project` | 设置初始工作目录，默认当前目录 |
| `--port 3081` | 避开已有 DSH 占用的端口 |
| `--enable` | 登录时自动启动；`--start` 只控制本次启动 |
| `--version v0.2.0` | 固定 Release；默认安装最新版本 |
| `--prefix /path/to/install` | 修改安装位置，默认 `~/.local` |

同机试用时可用 `--relay ws://127.0.0.1:8787`。Linux 同机安装两个组件可用
[混合包入口](docs/operations/releases.md#从-release-安装)。省略 `--start` 只安装。
将 `~/.local/bin` 加入 shell 配置后，以后打开终端也能使用 `drdsh`。

### 3. 配对并打开 DSH

在 DSH 电脑上运行，并保持命令等待：

```sh
drdsh daemon pair
```

1. 在另一台设备打开中继的 HTTPS 地址；同机试用可打开 [本机中继](http://127.0.0.1:8787)。
2. 输入配对码，点击 **连接**或按回车。配对成功后会自动连接，DSH 运行时直接显示 Harness。
3. 下次访问时，选择已保存的电脑，将配对码栏留空，再点 **连接**。

配对码约 5 分钟有效，只能尝试一次；过期或配对失败时重新生成。
如果提示“配对已保存，但连接未能建立”，先恢复 DSH 或隧道，再留空重连，无需生成新码。

浮动 **dr** 按钮打开连接管理，可拖动到左右边缘；在其中重载界面、断开或切换电脑。
关闭管理对话框会保留会话。同一台电脑同时只接受一个浏览器连接，换设备前请先断开旧页面。
PWA 支持中文和英文，语言选择按中继站点保存在当前浏览器中，离线也可切换。

## 日常管理

| 操作 | Relay 服务器 | DSH 电脑 |
| :--- | :--- | :--- |
| 查看状态 | `drdsh relay status` | `drdsh daemon status` |
| 查看日志 | `drdsh relay logs --follow` | `drdsh daemon logs --follow` |
| 启动 / 停止 / 重启 | `drdsh relay start / stop / restart` | `drdsh daemon start / stop / restart` |
| 登录自启动 | `drdsh relay enable` | `drdsh daemon enable` |
| 更新 | `drdsh relay update` | `drdsh daemon update` |
| 卸载 | `drdsh relay uninstall` | `drdsh daemon uninstall` |

表中的 `start / stop / restart` 表示三个独立子命令，例如 `drdsh daemon restart`。
两侧有独立的程序、配置、服务和日志，更新或卸载一侧不会重启另一侧。
`disable` 取消自启动；卸载保留配置、日志和配对数据。
Relay 更新包括 PWA；nginx 独立托管客户端时，还需同步 `client/`。

也可从本机 DSH 的 **dr.dsh 管理** 页面完成授权、安装、配置、配对和维护。
配对码可点击复制；管理授权 15 分钟后失效。DSH 停止时管理页一起停止，后台安装作业仍会继续。
详细步骤见[插件与管理页](daemon/README.zh.md#从-dsh-插件管理-daemon)。

## 使用前了解

- DSH 电脑需要保持开机、联网且不休眠。远程浏览器需要 HTTPS；localhost HTTP 仅用于同机测试。
- 可选插件将任务结束、审批请求等通知送到已连接页面；没有离线后台推送。审批仍在 DSH 界面处理。
- 中继分发浏览器代码，需要信任自己的中继基础设施。当前没有第三方审计、独立签名或官方托管中继。
- 升级先查看[发布说明](docs/operations/releases.md)与[安全边界](docs/security.md)。旧统一安装按[迁移说明](docs/operations/cli.md#从旧版安装迁移)处理。

## 文档与开发

- [Relay 安装与使用](relay/README.zh.md)、[Daemon 安装与使用](daemon/README.zh.md)、[文档索引](docs/README.md)。
- [架构](docs/architecture.md)、[设计决策](docs/decisions/README.md)、[贡献指南](docs/development/contributing.md)、[仓库规约](AGENTS.md)。

```sh
pnpm install
pnpm run verify
```

MIT 许可证。
