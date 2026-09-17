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
- 一个运行中的中继，具有可访问的 `ws://` 或 `wss://` 地址。

## 一键安装并启动

在 DSH 电脑上执行；将 `/absolute/path/to/dsh` 替换为已安装的 **DeepSeek Harness 可执行程序**路径。
若 `dsh` 在 PATH 中，可用 `command -v dsh` 查看路径；Git clone 和 npm 的具体写法见
[按安装方式指定 DSH](#按安装方式指定-dsh)：

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --dsh /absolute/path/to/dsh --relay ws://127.0.0.1:8787 --start
export PATH="$HOME/.local/bin:$PATH"
drdsh-daemon status
```

安装器自动识别系统和 CPU，从 Release 下载 daemon 并校验 SHA-256，默认安装到 `~/.local`，无需 sudo 或源码仓库。
可追加 `--version v0.1.1` 固定二进制版本，或用 `--prefix /path/to/install` 修改安装目录。

| 参数 | 用途 | 首次安装时的默认值 |
| :--- | :--- | :--- |
| `--dsh /absolute/path/to/dsh` | 用于启动 DeepSeek Harness 的可执行程序，安装器保存其绝对路径 | 在 PATH 中查找 `dsh` |
| `--workdir /path/to/your/project` | 可选的 DSH 启动工作目录，须已存在 | 执行安装命令时的当前目录 |
| `--dsh-home /path/to/dsh-home` | DSH 自身的配置与数据目录 | `DSH_HOME`，未设置时为 `~/.dsh` |

`--dsh` 应填写可执行文件，不能填写 Harness 源码目录。若平时的 `dsh` 是 shell 别名或函数，
请提供后台服务可直接运行的可执行文件。安装器不安装或配置上游 DSH；重新安装时，省略的参数沿用已保存值。
已有进程占用默认端口 `3080` 时可加 `--port 3081`。检查状态时，等待 DSH HTTP 显示 `responding`；
持续失败时用 `drdsh-daemon logs` 查看原因。

`export` 只影响当前终端；可加入 shell 配置，也可直接运行 `~/.local/bin/drdsh-daemon`。
电脑需要保持开机、联网且不休眠。

## 按安装方式指定 DSH

`--dsh` 接收一个能直接执行的文件路径，daemon 会给它追加 `web --no-open --port …`。
以下示例中的 `/path/to/your/project` 是已存在的项目目录；将中继地址换成你实际使用的 `ws://` 或 `wss://` 地址。

### Git clone

如果 DSH 来自 `git clone`，先在检出的仓库内完成[上游构建步骤](https://github.com/deepseek-ai/deepseek-harness#run-from-source)：

```sh
cd /absolute/path/to/deepseek-harness
pnpm install
pnpm run build
command -v node
```

构建后的 CLI 入口是 `apps/cli/lib/bin.js`，见[上游 CLI 清单](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/package.json)。
创建一个独立的可执行启动脚本。**先将下面两处绝对路径替换成 `command -v node` 的结果和自己的 DSH 仓库路径**：

```sh
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/dsh-from-source" <<'SH'
#!/bin/sh
exec "/absolute/path/to/node" "/absolute/path/to/deepseek-harness/apps/cli/lib/bin.js" "$@"
SH
chmod +x "$HOME/.local/bin/dsh-from-source"
"$HOME/.local/bin/dsh-from-source" --version

curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --dsh "$HOME/.local/bin/dsh-from-source" --workdir /path/to/your/project \
  --relay ws://127.0.0.1:8787 --start
```

启动脚本使用绝对路径定位 Node 和 DSH；`exec` 让 daemon 直接监督 Node，`"$@"` 将参数完整传给 DSH。
脚本保留 daemon 设置的工作目录，因此 `--workdir` 可指向自己的项目。保留构建产物和 `node_modules`；
只克隆仓库还不能运行，`--dsh` 也不能写成 `pnpm dsh` 这样的整条命令。

### npm

对于 npm 全局安装，在同一终端确认 DSH 可执行程序，再把它交给 daemon；已经装好时跳过第一行：

```sh
npm install -g @deepseek-ai/dsh
"$(npm prefix -g)/bin/dsh" --version

curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --dsh "$(npm prefix -g)/bin/dsh" --workdir /path/to/your/project \
  --relay ws://127.0.0.1:8787 --start
```

macOS、Linux 和 WSL2 的 npm 全局可执行入口位于 `$(npm prefix -g)/bin`，见
[npm 目录说明](https://docs.npmjs.com/cli/v11/configuring-npm/folders#executables)。
也可用 `command -v dsh` 找到已安装的入口，并传 `--dsh /找到的绝对路径/dsh`。
若是项目内的 npm 安装，指定 `--dsh /absolute/path/to/npm-project/node_modules/.bin/dsh`。
仅运行过 `npx @deepseek-ai/dsh web` 时，PATH 中可能没有固定的 `dsh`；先完成全局或项目内安装。

安装 daemon 时使用能运行 Node 的同一个终端，安装器会保存当前 PATH。
以后更换 Node 版本或移动 DSH 目录，更新启动脚本（如有），并重新安装 daemon、显式传入新的 `--dsh`，以更新路径和 PATH。
DSH 配置仍通过 `--dsh-home` 指定；无需把配置目录或 npm 包目录填到 `--workdir`。

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

WSS 已在当前源码中实现，尚未发布到 Release；需要包含此改动的构建，见[构建与发布说明](../docs/operations/releases.md)。

`--relay` 是 daemon 的参数，用来指定它连接的中继。按中继实际提供的协议填写：
`ws://` 就使用 WS，`wss://` 就使用 TLS 连接。

| 中继端点 | Daemon 参数 |
| :--- | :--- |
| 本机 WS 监听 | `--relay ws://127.0.0.1:8787` |
| 通过域名访问的 WS 监听 | `--relay ws://relay.example.com:8787` |
| HTTPS 代理后的 WSS 端点 | `--relay wss://relay.example.com` |

已有安装可重新运行安装器来指定中继：

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --relay wss://relay.example.com --start
```

地址填写到主机和端口即可，不要追加 `/ws/daemon` 或 `/ws/client`，daemon 会自动选择端点。
WSS 使用系统信任的根证书校验证书和主机名。
浏览器打开 `https://relay.example.com`，两种地址应到达同一个中继。
域名配置见 [Relay 说明](../relay/README.zh.md#使用域名)。

### SSH 转发（可选）

如果选择经 SSH 连接 relay，可把远端 relay 的 WS 监听端口转发到 DSH 电脑。
假设 relay 在 SSH 服务器的 `127.0.0.1:8787` 监听，服务器允许 TCP 转发；在 **DSH / daemon 电脑**的一个终端运行：

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:8788:127.0.0.1:8787 user@relay.example.com
```

将 `user@relay.example.com` 换成自己的 SSH 用户和服务器；SSH 使用其他端口时加 `-p <端口>`。
本地 `8788` 必须空闲，最后的 `127.0.0.1:8787` 是 **SSH 服务器上的 relay**。
保持该终端运行，在第二个终端检查转发并更新已有 daemon 的中继地址：

```sh
curl -fsS http://127.0.0.1:8788/healthz
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --relay ws://127.0.0.1:8788 --start
drdsh-daemon pair
```

首次安装时再按上文加 `--dsh` 和可选的 `--workdir`。daemon 与配对命令使用保存的本地 WS 地址；
浏览器仍可通过 `https://relay.example.com` 到达同一个 relay。
如果另一台电脑的浏览器也要走 SSH，在那台电脑另建同样的转发，再打开 `http://127.0.0.1:8788`；
这个回环地址只属于执行转发的电脑。

SSH 连接需要自行保持；退出 SSH 后转发停止，daemon 会等待中继恢复连接。dr.dsh 不启动或管理 SSH 进程。
参数含义见 [OpenSSH 本地转发说明](https://man.openbsd.org/ssh.1#L)。

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
