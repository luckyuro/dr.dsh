# Relay 与 Daemon 的安装和管理

新安装用 curl 运行两个独立入口，无需源码目录。它们可以在不同机器运行，也可以安装到同一机器、同一 prefix，
各自管理自己的程序、配置、服务、日志与更新锁：

| | Relay | Daemon |
| :--- | :--- | :--- |
| 安装 | [Relay 安装命令](../../relay/README.zh.md#安装服务器无需-node) | [Daemon 安装命令](../../daemon/README.zh.md#一键安装并启动) |
| 命令 | `drdsh relay` | `drdsh daemon` |
| 管理范围 | relay + PWA | daemon + 可选插件 |
| 配置 | `<prefix>/etc/dr.dsh/relay.json` | `<prefix>/etc/dr.dsh/daemon.json` |
| 程序目录 | `<prefix>/lib/dr.dsh/relay` | `<prefix>/lib/dr.dsh/daemon` |
| 默认状态目录 | 不创建 | `<prefix>/share/dr.dsh/daemon` |
| 使用指南 | [Relay](../../relay/README.zh.md) | [Daemon](../../daemon/README.zh.md) |

默认 prefix 是 `~/.local`；两个管理命令都安装到 `<prefix>/bin`。将此目录加入 PATH 后：

```sh
drdsh relay status
drdsh daemon status
drdsh relay restart
drdsh daemon restart
```

两侧都支持 `start`、`stop`、`restart`、`status`、`logs [--follow]`、`enable`、`disable`、
`install`、`update`、`uninstall`。Daemon 额外支持 `pair`、`doctor`、`devices`、`audit`、`crashes`。
只更新 PWA 使用 `drdsh relay install client --source <bundle>`；可选插件使用
`drdsh daemon install plugin --source <bundle>` / `uninstall plugin`，或首次安装时加 `--with-plugin`。

重复安装保留未覆盖的配置，只重启对应的宿主。卸载保留自身配置和数据，不影响另一侧程序。
Relay 不接受 DSH 的 `--dsh`、`--workdir`、`--state-dir` 等选项；Daemon 不接受中继监听用的 `--bind`。
Relay 管理由独立 Rust 程序实现。离线包安装、更新和运维无需 Node、pnpm 或 Rust；源码安装只编译
Rust，PWA 必须在构建机预先准备，可通过 `--client-dir` 指定。打包与静态 nginx 部署见
[Relay 说明](../../relay/README.zh.md) 和 [ADR-0016](../decisions/0016-native-relay-management.md)。
两侧 Release 安装和管理都不需要 Node、Rust 或 pnpm；DSH 自身需要 Node。
根 `install.sh` 可选择混合包，两侧管理仍隔离。别名为 `drdsh-relay` / `drdsh-daemon`，
原 `*ctl` 名字保留。平台矩阵与更新见[二进制发布](releases.md)。

实现与兼容决策见 [ADR-0015](../decisions/0015-independent-relay-and-daemon.md)。

## 从旧版安装迁移

已有**独立** `relay.json` 安装可直接运行新 relay 包里的 `sh install.sh --prefix <原前缀>`。
配置、服务身份与端口保持兼容，正在运行的 relay 在更新后恢复；JS 管理文件替换为原生程序。
以后更新使用 `drdsh relay install --source /path/to/new-bundle`。这条路径无需 Node，也不修改 daemon。

下面的步骤仅用于更早的**统一**安装：

旧入口 `sh scripts/install-legacy.sh` / 旧 `drdsh` 继续管理 `<prefix>/etc/dr.dsh/config.json`，
新命令管理上表的独立配置。它们不会自动接管彼此的进程或复制配对身份。

如需保留旧配对迁移，在原安装机器上操作：

1. 备份旧配置与完整状态目录。记下旧配置中的 `state`、`relay`、`port`、`bind`、`dsh`、
   `dshHome`、`workdir` 和 `prefix`，后续安装沿用需要保留的值。
2. 停止并卸载旧程序，配置、日志和配对状态会保留；旧插件注册也随卸载移除：

   ```sh
   drdsh disable
   drdsh stop
   drdsh uninstall all
   ```

3. 分别运行 [Relay](../../relay/README.zh.md#安装服务器无需-node) 和
   [Daemon](../../daemon/README.zh.md#一键安装并启动) 的 curl 安装命令，在 `sh -s --` 后传入原来的设置。
   **Daemon 的 `--state-dir` 必须指向旧 `state` 目录**才能沿用配对；`--dsh-home` 沿用原来的 DSH home。
   原来使用非默认 prefix 的安装，两侧命令也传入原 `--prefix`。
4. 按需重新安装插件，使用新命令 `start` / `status` 并从浏览器连接确认，再用 `enable` 恢复登录自启动。
   浏览器入口地址也应保持原样，以使用该站点保存的配对记录。

不要让两个 daemon 同时使用同一状态目录或 DSH 端口。只替换管理入口不需要重新生成密钥。

## 旧版统一入口

本节只说明旧 Node CLI 的历史命令；新安装使用前面的原生入口。旧 `drdsh` 负责统一安装记录。当前提供 **macOS launchd、Linux systemd 用户服务**；
Windows 可在启用 systemd 的 WSL2 内运行同一套命令，原生 Windows 服务安装尚未实现。
安装器从当前源码构建，仅用于旧统一记录；新的 Release 下载入口见上文。

## 准备

需要 Node.js 22.19+（22 系列）或 24+、Rust stable、pnpm（版本见根 `package.json`）。
daemon 和插件还需要已经安装好的 DSH；可用 `--dsh /绝对路径/dsh` 指定它。
中继单独安装不需要 DSH；基础 daemon 不需要 pnpm；插件单独安装不需要 Rust。

先取得源码并进入仓库。默认安装到 `~/.local`，不需要 sudo；Linux 需要可用的
`systemctl --user` 会话和支持 `--chdir` 的 GNU `/usr/bin/env`，macOS 需要当前用户的 GUI 登录会话。

## 每个组件一条命令

```sh
# 在本机一起安装 daemon、中继和 PWA，并立即启动
sh scripts/install-legacy.sh all --start

# 运行 DSH 的电脑：使用本机中继或已转接到本机的中继入口
sh scripts/install-legacy.sh daemon --relay ws://127.0.0.1:8787 --start

# 中继服务器：自动构建和安装 PWA
sh scripts/install-legacy.sh relay --start

# 单独构建/更新 PWA 静态资源
sh scripts/install-legacy.sh client

# 安装可选插件，调用 DSH 的 web profile 插件管理命令
sh scripts/install-legacy.sh plugin

# 全部组件，包括可选插件
sh scripts/install-legacy.sh all --with-plugin --start
```

首次安装后，把命令目录加进当前 shell 的 PATH：

```sh
export PATH="$HOME/.local/bin:$PATH"
drdsh --help
```

也可以直接运行 `~/.local/bin/drdsh`。安装器会打印实际路径，不改写 shell 启动文件。
只有 `--start` 才会启动新服务，只有 `--enable` 才会开启登录自启动。
默认中继只监听 `127.0.0.1:8787`；需要公开服务时配置反向代理，见
[`self-hosting.md`](self-hosting.md)。当前 daemon 的 WebSocket 依赖未启用 TLS，直接拨
`wss://` 仍不可用；跨机器的 daemon 链路需要现有的安全转接（例如 SSH 本地转发到中继）。
本安装器不配置证书或 TLS 转接。

## 日常命令

| 目的 | 命令 |
| :--- | :--- |
| 启动已安装的服务 | `drdsh start` |
| 停止 | `drdsh stop` |
| 重启 | `drdsh restart` |
| 只重启 DSH 所在的 daemon | `drdsh restart daemon` |
| 只重启中继 | `drdsh restart relay` |
| 查看进程与 HTTP 响应 | `drdsh status` |
| 查看最近 100 行日志 | `drdsh logs daemon` / `drdsh logs relay` |
| 跟随日志 | `drdsh logs daemon --follow` |
| 登录后自动启动 | `drdsh enable` |
| 取消登录自启动 | `drdsh disable` |
| 配对新设备 | `drdsh pair` |
| 本机自检 | `drdsh doctor` |
| 设备登记与撤销 | `drdsh devices` / `drdsh devices --revoke <id>` |
| 审计与崩溃记录 | `drdsh audit` / `drdsh crashes` |
| 卸载单个组件 | `drdsh uninstall plugin` / `drdsh uninstall daemon` |
| 卸载程序与服务，保留配置、配对数据和日志 | `drdsh uninstall all` |

`start` 对已运行的进程不重复启动。`restart` 先停 daemon 再停 relay，随后按相反顺序启动；
只选一个组件时只操作它。macOS 使用 `bootout` 后等待旧 PID 退出；Linux 使用 systemd 的停止等待。
daemon 收到 SIGTERM 或 Ctrl-C 时都会停止自己托管的 DSH；附着的 DSH 不属于它。

`start` 确认服务进程启动，DSH 的初始化可能仍在进行。`status` 进一步探测中继 `/healthz`
与 DSH 的 HTTP 响应；后者**不验证 DSH 鉴权或完整隧道**，完整连通性应通过 `pair` 与浏览器验证。
任何所选服务停止或 HTTP 无响应，`status` 返回退出码 1；正常返回 0。
`doctor` 会探测端口可用性，在 DSH 已运行时可能报告端口被占用，运行中优先用 `status`。

PWA 和插件没有独立的后台进程：`drdsh restart client` 管理中继，`drdsh restart plugin`
管理 daemon 及它托管的 DSH（需要同一安装目录内已安装对应宿主）。独立构建的 PWA 位于
`<prefix>/lib/dr.dsh/client`，可交给你自己运行的中继。

插件通过 `dsh plugin --profile web add <安装后的插件目录>` 注册；只使用
[上游插件安装契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)，
不改上游源码。**当前 daemon 还没有插件使用的 `POST /report` 接收端**，插件安装/加载不代表
补充通知可端到端工作；关键审批与提问继续经真实 DSH 界面传输。安装/卸载插件会重启同一 prefix 中
原来运行的 daemon，以更新 DSH 的 bundle 集合；独立运行的 DSH 需要自行重启。

## 配置、升级与多实例

```sh
drdsh install daemon --dsh /opt/dsh/bin/dsh --workdir /path/to/project --port 3081
drdsh install relay --bind 127.0.0.1:8788

# 拉取/切换到所需源码后重新安装；保留未显式覆盖的设置
drdsh install all --source /path/to/dr.dsh
```

先完成构建并检查所有产物，再停止相关服务、替换产物并恢复原来运行的服务。
单独更新客户端或中继只重启 relay；单独更新 daemon 或插件只重启 daemon。
`install all` 仍更新两个宿主；不属于所选组件的配置参数会被拒绝。
构建失败或缺少产物时，原有服务继续运行。插件注册失败会返回失败；已安装成功的核心组件仍保留，
修复 DSH/pnpm 后重新运行 `install plugin`。替换期间的磁盘故障可能需要重新安装。

自定义安装目录形成独立的一组服务，服务名称包含目录的哈希：

```sh
sh scripts/install-legacy.sh all --prefix "$HOME/drdsh-work" --port 3082 --bind 127.0.0.1:8789 \
  --relay ws://127.0.0.1:8789 --start
"$HOME/drdsh-work/bin/drdsh" status
```

安装后的命令记得自己的 prefix，从任何目录都可运行。也可向任何命令传 `--prefix <path>`。

| 路径 | 内容 |
| :--- | :--- |
| `<prefix>/bin` | `drdsh`、`drdshd`、`drdsh-relay` |
| `<prefix>/etc/dr.dsh/config.json` | 中继地址、DSH 可执行文件、工作目录、PATH、组件记录等明文设置 |
| `<prefix>/share/dr.dsh` | 默认 daemon 状态目录，含房间密钥、设备登记、审计与崩溃记录 |
| `<prefix>/lib/dr.dsh/client`、`plugin` | 独立于源码树的已安装产物 |
| `<prefix>/lib/dr.dsh/services` | 生成的 plist / systemd unit |
| `<prefix>/lib/dr.dsh/logs` | macOS 服务日志；Linux 使用用户 journal |

状态目录可在安装时用 `--state-dir` 或 `DSHD_STATE_DIR` 指定；所有 `drdsh pair/devices/audit/crashes`
使用保存的同一目录。不要把 `--room-key` 放进服务参数；由 daemon 自动生成并以 0600 保存。
默认 `~/.local` 下的状态目录与未指定 XDG 的原始 `drdshd` 默认目录相同。已有部署使用 XDG 或其他目录时，
安装时显式传 `--state-dir` 迁入同一份身份，避免新建另一间房间。

`disable` 只取消下次登录自启动，停止当前服务另用 `stop`。Linux 如需注销后继续运行，
由管理员执行 `loginctl enable-linger <用户>`。macOS LaunchAgent 仅服务当前登录用户。

源码不在原处时，用 `--source` 指定新位置。Node.js 路径变化后从源码重新运行安装器，更新启动脚本。
同一 prefix 的安装与服务变更会互斥；命令被强制杀死遗留 `.operation-lock` 时，确认旧命令已退出后删除
该**空目录**再重试。卸载保留的状态不要随意删除，否则设备需要重新配对。

## 开发验证

```sh
pnpm run test:cli
cargo build --workspace
pnpm --filter @dr.dsh/pwa build
pnpm run smoke:services

# Linux 上可单独验证服务管理，不需要 Rust/DSH
pnpm run smoke:systemd
```

冒烟脚本创建临时 prefix，调用真实服务管理器、真实 daemon 与中继，验证安装、重复启动、重启、
客户端更新、登录自启动开关、卸载与密钥保留。DSH 使用仓库已有 HTTP 替身，插件注册使用替身 CLI，
因此该脚本不等同于真实 DSH 的升级验收。脚本用 `finally` 撤下临时服务，失败时保留日志供诊断。

已有构建产物可用 `--skip-build --build-profile debug` 安装，正式自用默认 `release`；
缺少任何必要文件都会在停止已有服务前报错。

`node scripts/nginx-static-smoke.mjs` 还可验证 nginx 直接托管 PWA：需要 nginx、Playwright Chromium
和已构建的产物。可用 `NGINX_BIN`、`PLAYWRIGHT_MODULE` 与 `CHROMIUM_BIN` 指定测试机的工具位置。
这些工具只用于开发验收，不是 relay 服务器依赖。

### 原生 Relay 与静态 PWA 验证（2026-09-17）

- macOS launchd：`service-smoke.mjs` **41 项真实进程检查通过**。Relay 命令 PATH 不含 Node、pnpm
  或 Cargo，覆盖离线包、完整/PWA 更新、损坏包不停止服务、操作锁、另一侧 PID/配置与配对状态保留。
  另验证旧的独立 Node relay 管理器与新程序沿用同一服务身份，迁移后 daemon 不被重启。
- Debian 12 / ARM64 / systemd 252 容器：`relay-bundle-smoke.sh` **7 项通过**。容器未安装 Node、pnpm、
  Cargo、Python 或 jq，使用真实 relay 与原生管理器验证特殊路径、首次安装不启动、重复启停、自启动、
  PWA/完整更新、日志、卸载重装和端口保留。测试使用用户服务会话，curl 仅用于断言 HTTP 响应。
- nginx 1.31.5 + Chromium：`nginx-static-smoke.mjs` **11 项通过**。Relay 未配置有效客户端目录，
  nginx 直接提供静态资源，浏览器完成配对、隧道、鉴权后的 DSH 替身页面与离线外壳。HTTP 回环用于
  本地验收；远端部署仍需配置示例中的 HTTPS 与可信证书。

### 本次验证（2026-09-15）

- `pnpm run verify` 通过，包括新增 CLI 参数/配置/转义测试与文档链接检查。
- macOS launchd：`service-smoke.mjs` **21 项通过**，使用真实 daemon、中继、PWA 与 DSH 替身，
  包括启动中取消、插件独立卸载/重装、失败不打断原有服务，以及卸载保留密钥。
- macOS：从源码按默认 release 路径执行 `sh scripts/install-legacy.sh relay --start`，完成健康检查、重启与卸载。
- Debian 12 / systemd 252 容器：`systemd-smoke.mjs` **10 项通过**。使用真实 systemd 用户管理器
  与替身进程验证模板和管理命令；未在该环境运行完整 Rust/DSH 链路。测试目录若挂载为 `noexec`，
  需把 `TMPDIR` 指向可执行的临时目录。
- 本机没有上游 DSH 安装，插件测试使用替身 CLI，真实 DSH bundle 安装与升级验收尚未执行。

### 独立组件验证（2026-09-16）

- CLI 单元检查 **7 项通过**：包含跨组件命令和配置拒绝、目录与服务身份隔离、中继无需 DSH 设置。
- macOS 真实进程检查 **34 项通过**：两套独立安装入口、互不修改配置和 PID 的更新、独立卸载与重装、
  状态保留，以及旧版安装的生命周期检查。使用真实 daemon、中继与 PWA，DSH 和插件 CLI 使用替身。
