# 安装 daemon

v0.1.0 提供原生统一 CLI 与 Release 安装；平台矩阵和新命令见[二进制发布](releases.md)。
本文后面的 raw binary 命令仍可用于源码调试。

本文覆盖 **Linux、macOS、Windows** 三个平台。中继的部署（含 Docker）在
[`self-hosting.md`](self-hosting.md)；这里只讲 daemon——那台**运行着 DSH 的电脑**上常驻的进程。

## 推荐：Daemon 独立安装与命令

macOS Apple Silicon / Linux x86_64 可在任意目录直接运行：

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- --start
export PATH="$HOME/.local/bin:$PATH"
drdsh daemon status
drdsh daemon restart
drdsh daemon logs --follow
```

先准备可连接的中继；Daemon 完整使用入口见 [`../../daemon/README.zh.md`](../../daemon/README.zh.md)，
两侧配置和旧安装迁移见 [`cli.md`](cli.md)。下面保留手工构建、旧 CPU 与附着模式说明。
Windows 的一键路径是启用 systemd 的 WSL2；原生 Windows 仍需手工运行二进制。

## 先决条件（三个平台相同）

| 需要的 | 为什么 | 怎么确认 |
| :--- | :--- | :--- |
| **Rust stable** | 仅源码构建需要；Release 安装不需要 | `cargo --version` |
| **Node.js 22.19+ 或 24+** | DSH 本身是一个 Node 程序 | `node --version` |
| **DSH 已安装** | daemon 监督它，不替代它 | `dsh --version` |
| **一个中继地址** | 远端设备靠它找到你的电脑 | 见 [`self-hosting.md`](self-hosting.md) |

**房间密钥不用你管**：第一次运行 `drdshd run`（或 `drdshd pair`）时它会自动生成，写到状态目录里的
`room-key`（0600），之后两个命令都从那里读。它不会打印出来——配对是把密钥交给设备的唯一方式，打印
一次"方便一下"的密钥会留在终端回滚、`journalctl` 和你粘贴出去的日志里。

需要手工管理密钥时（例如从别处导入一把），`drdshd room-key` 仍然可用：

```sh
cargo run -p dr-dsh-daemon -- room-key    # 打印一把新的；不写任何文件
```

给 `run` / `pair` 传 `--room-key` 会**只对这次运行**生效，且**不写盘**；如果它与状态目录里的那把不同，
启动时会明确告诉你（这正是以前那个安静失败的地方）。**要备份的是整个状态目录**（`$DSHD_STATE_DIR`）：
它同时装着这把密钥与设备登记表，删掉它等于所有已配对设备都要重新配对。

## 构建

三个平台同一条命令：

```sh
cargo build --release -p dr-dsh-daemon -p dr-dsh-relay
```

产物是 `target/release/drdshd`（Windows 上是 `drdshd.exe`）。把它放到 `PATH` 上的某个目录，
或者用绝对路径配置下面的服务单元。

## 旧机器（旧 CPU）

M5 要求"旧 CPU 有可用的替代安装路径"，因为这是**装完才炸**的一类问题：一个用 `target-cpu=native`
编译出来的二进制在老机器上装得好好的，第一次运行直接 `SIGILL`——看起来像下载坏了，而不是这台机器
不支持。

**支持的下限是各架构的 baseline**：x86-64 是 SSE2（2003 年后的所有 x86-64 CPU），aarch64 是
armv8-a。仓库里没有任何地方设置 `target-cpu=native`，也没有开 `+avx2`；标量路径一直都在，因为
RustCrypto 那一套是纯 Rust 实现，硬件加速（AES-NI、SHA-NI、AVX2）是**运行时**按 CPUID 选的。

**这条声明是被测过的，不是读代码得出的**：`scripts/cpu-baseline-smoke.mjs` 用 qemu 把 CPU 模拟成
2006 年的 Core 2、2008 年的 Nehalem、2010 年的 Westmere（三者都没有 AVX/AVX2），在这三种 CPU 上
分别跑 `drdshd version` / `doctor` / `room-key`，再把 `dr-dsh-crypto`（49 个测试，含 SPAKE2、
Ed25519、AES-GCM）、`dr-dsh-proto` 与一致性向量全部跑一遍，最后让中继在模拟 CPU 上真的起服务并
回答 `/healthz`。三种 CPU 覆盖了两条实现路径：Westmere 报 `aes` 可用（走 AES-NI），Core 2 与
Nehalem 报 `aes` 缺失（走软件实现）。**13/13 通过**。

在那台老机器上：

```sh
drdshd doctor     # 会打印这一台 CPU 的架构与扩展（present/absent），以及"按 baseline 编译"
```

`doctor` 里的 CPU 一行**从不判失败**：老 CPU 不是配置错误。它的用途是让一次求助从事实开始——
"我这台是 Nehalem、没有 avx2" 比"跑不起来"有用得多。

已知边界（写清楚，免得被读成"任何机器都能跑"）：

- **平台**：只有 64 位 x86（x86-64 baseline）与 aarch64 是我们声称支持并测过的；**i686 等纯 32 位
  x86 不构建也不支持**。ARM 目标（`aarch64-unknown-linux-gnu`、`armv7-unknown-linux-gnueabihf`）
  在本机 `cargo check --workspace --target <triple>` **通过**，`dr-dsh-crypto` / `dr-dsh-proto`
  这两个纯 Rust crate 还能编译出 aarch64 的 rlib——但**没有**真机或模拟运行证据，也没有交叉链接
  的产物（本机没装交叉链接器）。要在树莓派一类机器上用，就从那台机器上构建，并在装完后用
  `drdshd doctor` 与一次真实配对来确认。
- **macOS 与 Windows 上的旧 CPU**：同一条 baseline 逻辑适用于这两个平台的目标三元组，但上面的
  模拟测试是在 Linux 上做的；那两个平台没有等价的实测证据。
- **从源码构建**是旧机器上最稳的路径（用那台机器自己的 baseline），也是本文一直以来的默认路径；
  预编译产物已通过 [Release](releases.md) 提供；npm、签名与可复现构建仍未完成
  （[`../audit-scope.md`](../audit-scope.md) § 2.4），也是定义文档"提供 npm 等替代安装"这句承诺
  目前**没有兑现**的地方。

## 先自检，再常驻

```sh
drdshd doctor            # 检查 DSH 是否可执行、端口是否可用、回环绑定是否正常、CPU 与扩展
drdshd run --relay wss://relay.example     # 房间密钥自动读/生成，见下
```

**先把 `drdshd run` 在前台跑通**，看到它打印 `room: …` 且远端能打开界面，再交给进程管理器。
一个起不来的 systemd 单元只会给你一行 `failed`，而前台运行会告诉你原因。

---

## Linux 与 macOS 常驻

独立入口自动生成用户级 systemd / LaunchAgent 定义，并保存 DSH 的绝对路径、工作目录和状态目录：

```sh
drdsh-daemonctl enable      # 下次登录自动启动
drdsh-daemonctl start       # 现在启动
drdsh-daemonctl stop
drdsh-daemonctl disable     # 取消下次登录自启动
```

细节见 [`cli.md`](cli.md)。Linux 注销后保留用户服务需要管理员运行
`loginctl enable-linger <用户>`；macOS LaunchAgent 依赖 GUI 登录，合盖休眠仍会使网络不可用。

**服务参数不需要房间密钥。** daemon 自动从状态目录读/生成 `room-key`；`--room-key` 接受密钥本身，
不接受文件路径。不要把密钥写进 unit、plist、任务定义或命令日志。

原始 `drdshd` 仍可交给自己的进程管理器，命令为 `drdshd run --relay ws://127.0.0.1:8787`。
设置 `DSHD_DSH=/绝对路径/dsh` 与 `DSHD_STATE_DIR=/绝对路径/state`，明确工作目录与 PATH。
Unix 上 SIGTERM 与 Ctrl-C 共用停止流程，会清理托管的 DSH。

## Windows

一键安装与服务命令在启用 systemd 的 WSL2 内使用；DSH、Node 和 Rust 也应安装在同一 WSL2 环境中。

原生 Windows 可以手工构建并前台运行：

```powershell
cargo build --release -p dr-dsh-daemon
$env:DSHD_STATE_DIR = "$env:LOCALAPPDATA\dr.dsh"
.\target\release\drdshd.exe run --relay ws://127.0.0.1:8787
```

原生 Windows 计划任务/NSSM 的自动生成尚未实现。daemon 停止 DSH 时会走强杀路径，插件树不会走
Unix 上的优雅销毁流程；这是已有平台限制。

---

## 附着模式：DSH 已经在你手里跑着

如果你不想让 daemon 管进程——比如你用一个自己的终端或自己的进程管理器跑 DSH——用附着模式：

```sh
# 1. 自己启动 DSH，记下它打印的 ?token=…
dsh web --no-open --port 3080

# 2. 让 daemon 附着上去
drdshd run --attach 3080 --attach-token '<token>' --relay wss://relay.example --room-key <key>
```

**为什么需要 token。** DSH 只把界面发给持有「用它自己保管的密钥签名过的 cookie」的浏览器。daemon 在托管模式下能换到这个 cookie，
是因为它**读到了 DSH 启动时打印的那一行**；附着模式下它不在场，而那个密钥存在 DSH 的凭据存储里——去读它意味着直接依赖 DSH 的内部存储，
这是本项目明确不做的耦合。所以凭据由你转交一次。

**不带 `--attach-token` 会怎样。** daemon 正常启动并明确告诉你：状态与生命周期可用，但**界面不可达**。它不会假装可用，
也不会在你第一次打开界面时才失败。

**附着模式下不能做生命周期操作。** daemon 没有启动那个进程，也就不知道它是怎么配置的，因此 `start`/`stop`/`restart` 会被**具名拒绝**：

> DSH on port 3080 was started outside this daemon, so the daemon will not stop or restart it.
> Interface access works normally; stop it yourself if you want it stopped.

远端界面上的相应按钮是禁用的，原因就显示在按钮旁边。**界面访问不受影响**——这正是附着模式存在的意义。


## 装好之后

1. **配对设备**（推荐）：
   ```sh
   drdshd pair --relay wss://relay.example        # 房间密钥不存在时会自动生成并落盘
   ```
   把打印出来的码输入到远端设备。配对回执把房间密钥**密封**后交给设备，设备之后按它推导房间；
   而 `drdshd run` 与 `drdshd pair` 默认读**同一个文件**，所以"两个命令给了不同的密钥"这个曾经
   安静失败的坑不存在了（实测 `scripts/room-key-smoke.mjs` 12/12）。
   配对之后只有已登记的设备能连上，房间密钥本身不再能开门；用 `drdshd devices` 查看或撤销。

2. **或者继续用房间密钥**：不配对时 daemon 会在启动时打印
   `devices: none enrolled — any client holding the room key may connect`。
   这是给尚未配对的部署留的路径，不是推荐状态。

3. **远端打开界面**：用手机或另一台电脑访问你的中继地址，把 `drdshd pair` 打印的码粘进唯一的
   输入框，点 Connect。配对完成后这一台设备就被记住了（存在浏览器的 IndexedDB 里），以后
   只点 Connect 即可；点「Open the DeepSeek Harness interface」在另一个标签页里看到真实界面。
   没有配对时也可以直接粘贴房间密钥——那是尚未配对的部署的回退路径，不是推荐状态。

   **同一台电脑上跑多个 daemon**（例如工作与个人两个 profile）就是多开进程：每个 daemon 用自己的
   `DSHD_STATE_DIR`、自己的端口、自己生成的房间密钥，于是它是**另一个房间**。用同一个浏览器分别与
   它们配对即可——浏览器只保留**一条设备身份**，每配对一次就多一条房间记录，页面上会列出
   「Your computers」，可以点选、切换、单独 Forget（ADR-0007）。

4. **远程生命周期**：界面上可以启动、停止、重启 DSH。若 DSH 是你自己启动的（attach 模式），
   这三个按钮会被禁用并说明原因，而界面访问不受影响。

5. **看审计日志**：谁配对了、哪台设备连上了、会话什么时候结束、谁下发了生命周期命令——
   `drdshd audit` 把它们按时间打印出来：
   ```sh
   drdshd audit            # 本机 $DSHD_STATE_DIR/audit.jsonl，最新在最后
   drdshd audit --clear    # 删掉
   ```
   记录**只在这台机器上**（0600，30 天 / 10 000 行滚动），**永不自动上送**；`DSHD_AUDIT=0` 可以整个
   关掉，关掉时 `drdshd audit` 会直说"审计已关闭"而不是显示"没有事件"（两者含义完全不同）。
   `drdshd doctor` 会报告当前状态——因为写失败按设计是无声的（磁盘满不该让隧道停下来）。

6. **看崩溃报告**：远端页面自己失败时（未捕获错误、未处理的 rejection、或一次从未可用的运行），
   它会把一份摘要经隧道发回**这台机器**，存在状态目录里那个 0600 的 `crash-reports.jsonl`：
   ```sh
   drdshd crashes            # 打印存下来的报告（原文一行一份）
   drdshd crashes --clear    # 删掉它们
   ```
   **没有服务器**：报告不上传，只落在你自己的机器上（`docs/security.md` § 5.10 写了里面有
   什么、没有什么）。最多存 20 份，满了之后 daemon 会拒收并在答复里让你清一下——它不会悄悄
   丢掉旧的那份，因为被丢掉的往往正是要找的那份。

## 排错

先看 [`troubleshooting.md`](troubleshooting.md)。三条最常见的：

- **`port <p> is already in use`** —— 上一次运行遗留的 DSH 还占着端口。停掉那个进程，
  或用 `--attach <p>` 直接用它。
- **远端一直显示「连不上你的电脑」** —— 看 daemon 的日志里 `relay:` 那几行；
  `Reconnecting` 表示你的电脑连不上中继，与远端无关。
- **daemon 起来了但界面打不开** —— 检查 `drdshd doctor`，以及你的中继是否可达。
