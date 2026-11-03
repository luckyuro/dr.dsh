# dr.dsh Daemon

> v0.2.0：`drdsh daemon ...` 与 `drdsh-daemon ...` 等价。Release 安装和管理由 Rust 完成；
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

- 使用已有 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，或让v0.2.0 包自动安装。
  模型账号/API key 仍需自行配置。本次集成验收覆盖 DSH **`0.2.2-alpha.2`** 与 **`0.2.1-rc.5`**；
  其余版本保留历史记录。
  上游更新后需重新核对[兼容记录](../docs/integration/dsh-surface.md)。
- 当前 DSH 与自动安装需要 **Node.js 24.9+ 和 npm**。daemon 二进制不需要 Rust 或 pnpm；
  npm 依赖若需本机编译，还需其要求的构建工具。
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
可追加 `--version v0.2.0` 固定二进制版本，或用 `--prefix /path/to/install` 修改安装目录。

| 参数 | 用途 | 首次安装时的默认值 |
| :--- | :--- | :--- |
| `--dsh /absolute/path/to/dsh` | 选择已有 DeepSeek Harness 可执行程序，保存其绝对路径 | v0.2.0 包私有安装固定 DSH；旧 Release 在 PATH 中查找 `dsh` |
| `--workdir /path/to/your/project` | 可选的 DSH 启动工作目录，须已存在 | 执行安装命令时的当前目录 |
| `--dsh-home /path/to/dsh-home` | DSH 自身的配置与数据目录 | `DSH_HOME`，未设置时为 `~/.dsh` |

`--dsh` 应填写可执行文件，不能填写 Harness 源码目录。若平时的 `dsh` 是 shell 别名或函数，
请提供后台服务可直接运行的可执行文件。重新安装时，省略的参数沿用已保存值。
已有进程占用默认端口 `3080` 时可加 `--port 3081`。检查状态时，等待 DSH HTTP 显示 `responding`；
持续失败时用 `drdsh-daemon logs` 查看原因。

v0.2.0 包在首次安装且未指定 `--dsh` 时，下载固定的 DSH `0.2.2-alpha.2` 到私有版本
目录，并装配随包插件；daemon 启动 DSH 时注入其 relay 与报告配置。已有 DSH 程序和外部
插件归属会保留。v0.2.0 起可用；包内命令、前提与恢复方法见
[DSH 自动安装](../docs/operations/dsh-provisioning.md)，模型登录仍由用户完成。

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
3. 配对成功后自动连接；DSH 运行时，真实 Harness 界面直接显示在当前页面。无需再点一次。

**保留 dr.dsh 页面**，它维持隧道。浮动 **dr** 按钮打开连接管理、重载与断开入口。
浏览器会保存配对，下次选择已登记电脑并连接即可。
配对失败或过期后重新运行 `drdsh-daemon pair`。手机访问中继地址，DSH 的本机端口不对外开放。

## 连接远端中继

v0.2.0 已提供 WSS、原生 TLS 和私有 CA 支持，见[TLS 配置](../docs/operations/tls.md)。

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
WSS 默认使用系统信任的根证书校验证书和主机名。
`run`、两种配对命令、`install` 和 `status` 可加 `--insecure` 跳过证书验证，
`--no-insecure` 恢复；安装时保存选择，其他命令只覆盖当次运行。
v0.2.0 支持在运行、配对和安装时加 `--ca-cert /path/ca.pem` 使用私有 CA。
已有 HTTPS 回环 DSH 可用 `run --attach <port> --attach-tls` 附着；托管 HTTPS DSH
安装时加 `--dsh-tls`，就绪检查和服务健康探针都会要求 HTTPS。详见 [TLS 配置](../docs/operations/tls.md)。
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

v0.2.0 包的新 daemon 归属安装默认装配随包插件，无需 pnpm。已有安装使用
`drdsh daemon install plugin --source <bundle>` 注册，或安装时加 `--with-plugin`。
卸载插件使用 `drdsh-daemon uninstall plugin`；安装或移除插件会重启原来运行的 DSH 宿主。

安装插件后，daemon 服务会启用本机报告接收器，将任务结束、审批请求、目标完成及子代理结束通知
经加密隧道送到已配对且保持连接的 dr.dsh 页面。页面内显示通知列表与未读数，审批和目标完成会突出提示；
处理审批与提问仍使用真实 DSH 界面。通知只有事件类型、严重度、时间和不透明会话引用，不包含正文。

从源码直接运行时，先把 bundle 注册到 DSH，再使用 `drdsh daemon run --plugin-reports`；
也可设置 `DSHD_PLUGIN_REPORTS=1`（`0` 关闭，未设置默认关闭）。安装管理优先使用显式的
`pluginReportsEnabled`，旧配置继续按插件安装记录设置此开关。
daemon 只监听 `127.0.0.1` 的随机空闲端口，并为受管 DSH 注入每次启动随机生成的报告令牌；
不需要手工配置固定端口或保存令牌。手动启动 DSH 时报告保持停用，但兼容版本仍可加载本机
管理页面；attach 模式不支持报告。

通知需要配对设备身份鉴权，只有房间密钥的旧连接不会收到。断线时不保存或补发，重连和切换电脑会清空页面列表；
保留 dr.dsh 标签页和隧道连接才能收到。后台 Web Push、系统通知权限和离线通知均未实现。
配对和撤销会在 daemon 运行期间生效，无需重启 DSH；撤销会关闭该设备的现有访问。

## 从 DSH 插件管理 Daemon

完整插件包包含页面和匹配平台的原生管理器。当前兼容 **DSH `0.2.2-alpha.2`** 与 `0.2.1-rc.5`；
原生管理验收范围见[本机管理记录](../docs/operations/daemon-management.md#验证)。原生包支持 Linux x86_64 musl 与 macOS Apple Silicon，
需要当前用户的 systemd 或 launchd 会话。

从 [v0.2.0 Release](https://github.com/luckyuro/dr.dsh/releases/tag/v0.2.0) 下载 `drdsh-plugin-0.2.0.tgz`
及其 `.sha256`，按[校验步骤](../docs/operations/releases.md#独立插件包)验证后，通过 DSH 安装：

```sh
dsh plugin --profile web add /absolute/path/drdsh-plugin-0.2.0.tgz
dsh web
```

打开 DSH 的本机登录链接，再点 **dr.dsh 管理**（`/_drdsh/manage`）。通过页面的本机浏览器
授权或私有解锁文件取得管理权，填写中继地址，核对当前 DSH profile 的默认路径并安装 daemon。
当前 DSH 是手动启动时，先安装不启动的服务，再检查并确认接管计划，让 daemon 重启并监督
当前宿主。之后可直接在页面创建并复制配对码，到 Relay 的 PWA 一次提交完成配对与连接。

只需要 DSH 运行期间远程访问时，也可跳过 daemon 安装，按[独立连接步骤](../docs/integration/dsh-surface.md#42-不安装-daemon-服务的插件连接)配置 `relayUrl`。

DSH 登录本身不授予管理权。本机启动链接 5 分钟内单次有效，管理会话 15 分钟有效，插件
重启后失效；daemon 拒绝远端 HTTP 和 WebSocket 到达管理命名空间。解锁文件内容必须保密。

安装、更新和会停止宿主的操作由独立 OS 作业执行并保存结果。停止 DSH 会关闭管理页面；
重新启动后打开页面、重新授权并查询实际结果。整个 daemon 已停止时，需本机 CLI 或用户
服务管理器恢复它，不能指望已消失的页面继续响应。

插件安装 daemon 时固定采用外部插件归属，并开启报告与本机管理。插件包继续由 DSH 拥有，
daemon 更新或卸载不会注销插件；已有 CLI 安装保留原归属。
`drdsh daemon manage` 与私有 Unix 运行时接口仍可用于本机自动化。

使用 `scripts/package-plugin.mjs --native <target>=<binary> --output <new.tgz>` 构建完整包，
`--native` 可重复以包含两种平台。这是本地打包入口，不表示已经发布 npm 包。
只有源码或旧报告插件的包若缺少匹配 native，不能执行页面的原生管理操作。
构建、授权、作业、接管、配置及 JSON 协议见[本机管理指南](../docs/operations/daemon-management.md)。

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
