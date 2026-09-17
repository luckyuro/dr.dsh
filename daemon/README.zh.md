# dr.dsh Daemon

> v0.1.0：`drdsh daemon ...` 与 `drdsh-daemon ...` 等价。Release 安装和管理由 Rust 完成；
> 服务器不需要 Cargo 或 pnpm，Node 仅供 DSH。支持 macOS arm64 与 Linux x86_64 musl。
> 见[发布与安装](../docs/operations/releases.md)。

[English](README.md) · [项目首页](../README.zh.md) · [Relay](../relay/README.zh.md)

**安装在运行 DSH 的电脑上，负责管理 DSH 并建立远程加密连接。**
Daemon 独立安装和运行，主动连接已有的 relay。

## 功能

- 启动、监督、停止、重启本机 DSH，并代理它的真实界面。
- 与浏览器配对、建立端到端加密隧道、保存设备登记和房间密钥。
- 保持与中继的连接，记录本机审计日志与崩溃报告。
- 可附着到已有 DSH 进程；此模式不提供远程启停与重启。

浏览器客户端（PWA）的分发与密文转发由 [relay](../relay/README.zh.md) 负责。

## 安装前准备

- 已安装并配置好 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，能在本机运行任务。
  本仓库的集成核对基准是 DSH **`0.1.5-rc.2`**；上游更新后需重新核对兼容性。
- DSH 需要 Node.js 24+（或 22 系列的 22.19+）。Release 安装不需要 Rust、编译工具链或 pnpm。
- macOS 图形登录会话或 Linux `systemctl --user` 会话；Windows 使用启用 systemd 的 WSL2，DSH 也安装在同一 WSL2 环境。
- 一个运行中的中继。同机中继使用 `ws://127.0.0.1:8787`；远端中继先按下文建立安全转接。

## 一键安装并启动

在 DSH 电脑上执行；将项目路径替换成已有目录：

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --relay ws://127.0.0.1:8787 --workdir /path/to/your/project --start
export PATH="$HOME/.local/bin:$PATH"
drdsh-daemon status
```

安装器自动识别系统和 CPU，从 Release 下载 daemon 并校验 SHA-256，默认安装到 `~/.local`，无需 sudo 或源码仓库。
可追加 `--version v0.1.1` 固定二进制版本，或用 `--prefix /path/to/install` 修改安装目录。
DSH 不在 PATH 中时添加 `--dsh /绝对路径/dsh`；已有进程占用默认端口 `3080` 时可加 `--port 3081`。
省略 `--workdir` 会使用当前目录。检查状态时，等待 DSH HTTP 显示 `responding`；
持续失败时用 `drdsh-daemon logs` 查看原因。

`export` 只影响当前终端；可加入 shell 配置，也可直接运行 `~/.local/bin/drdsh-daemon`。
电脑需要保持开机、联网且不休眠。

## 配对并使用 DSH

```sh
drdsh-daemon pair
```

保持命令运行，在约 5 分钟内使用配对码：

1. 在手机或另一台电脑打开**中继的 HTTPS 地址**。同机试用可打开 [本机中继](http://127.0.0.1:8787)。
2. 将配对码填入 **Pairing code or room key**，点击 **Connect**。
3. 显示 **Paired** 后，再点击一次 **Connect**。
4. 点击 **Open the DeepSeek Harness interface**，在新标签页使用 DSH。

**保留原来的 dr.dsh 标签页**，它维持隧道。浏览器会保存配对，下次选择已登记电脑并连接即可。
配对失败或过期后重新运行 `drdsh-daemon pair`。手机访问中继地址，DSH 的本机端口不对外开放。

## 连接远端中继

当前 daemon 尚不能直接连接 `wss://`。可以在 DSH 电脑上用 SSH 将服务器的中继转接到本机：

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8788:127.0.0.1:8787 user@relay-host
```

替换 SSH 用户和服务器地址，保持命令运行。在另一个终端安装或更新 daemon，使用
`--relay ws://127.0.0.1:8788`。例如，已有安装可运行：

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --relay ws://127.0.0.1:8788 --start
```

浏览器继续打开服务器的 HTTPS 地址。两种地址必须到达同一个中继。
SSH 连接由你维护，daemon 的登录自启动不会自动启动 SSH。

## 常用命令

| 操作 | 命令 |
| :--- | :--- |
| 启动 / 停止 / 重启 daemon 及其托管的 DSH | `drdsh-daemon start` / `drdsh-daemon stop` / `drdsh-daemon restart` |
| 状态 / 最近日志 | `drdsh-daemon status` / `drdsh-daemon logs` |
| 跟随日志 | `drdsh-daemon logs --follow` |
| 开启 / 关闭登录自启动 | `drdsh-daemon enable` / `drdsh-daemon disable` |
| 新设备配对 / 查看设备 | `drdsh-daemon pair` / `drdsh-daemon devices` |
| 撤销设备 | `drdsh-daemon devices --revoke <id>` |
| 审计 / 崩溃记录 | `drdsh-daemon audit` / `drdsh-daemon crashes` |
| 从 Release 更新 | `drdsh daemon update` |
| 卸载 daemon 与可选插件 | `drdsh-daemon uninstall` |

这些命令只管理 daemon。更新会重启原来运行的 daemon 及其 DSH，保留配对信息；relay 的进程与配置不变。
`enable` / `disable` 只改变登录自启动，立即启停使用 `start` / `stop`。
`status` 检查进程与 DSH HTTP 响应；完整连通性通过浏览器验证。

## 可选插件

Release 包已带插件源文件，无需 pnpm。使用 `drdsh daemon install plugin --source <bundle>` 注册，或安装时加 `--with-plugin`。
卸载插件使用 `drdsh-daemon uninstall plugin`；安装或移除插件会重启原来运行的 DSH 宿主。

插件的补充通知接收端和后台推送尚未实现。当前可在真实 DSH 界面中处理审批与提问。

## 独立的文件与配置

默认前缀为 `~/.local`，可用 `--prefix /path/to/install` 修改：

| 路径 | 内容 |
| :--- | :--- |
| `bin/drdsh-daemon` | daemon 专用管理命令 |
| `etc/dr.dsh/daemon.json` | DSH 路径、工作目录、中继地址与安装记录 |
| `lib/dr.dsh/daemon/bin/drdsh` | daemon 二进制 |
| `lib/dr.dsh/daemon/plugin` | 可选插件 |
| `lib/dr.dsh/daemon/services` | 系统服务定义 |
| `lib/dr.dsh/daemon/logs` | macOS 日志；Linux 使用用户 journal |
| `share/dr.dsh/daemon` | 房间密钥、设备登记、审计与崩溃记录；可用 `--state-dir` 修改 |

请备份完整状态目录。卸载保留配置与状态，不删除 relay 的文件。旧版 `drdsh` 使用不同的安装记录；
保留原配对迁移时参见[迁移说明](../docs/operations/cli.md#从旧版安装迁移)。

实现位于 [`crates/dr-dsh-daemon`](../crates/dr-dsh-daemon)。
更多说明：[附着模式](../docs/operations/install.md#附着模式dsh-已经在你手里跑着)、
[故障排查](../docs/operations/troubleshooting.md)、[安全模型](../docs/security.md)。
