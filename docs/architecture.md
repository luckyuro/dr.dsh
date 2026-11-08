# 架构

本文描述 dr.dsh 的组件边界与数据流。**为什么这样设计**记录在 [`decisions/`](decisions/) 的 ADR 中；本文只描述"是什么"与"数据怎么走"。

---

## 1. 组件模型

支持两种运行方式：插件配置 `relayUrl` 后可独立启动随包原生隧道，无需安装 daemon 服务；
需要远程启动、重启或崩溃恢复时，启用常驻 daemon。两者复用相同的加密、配对和代理代码。
独立模式的连接随 DSH 退出，状态报告为 `owned=false`；下图描述常驻 daemon 模式。
两种模式的权限和生命周期差异见 [ADR-0026](decisions/0026-plugin-owned-tunnel.md)。

```
                    ┌──────────────────────────────────────────────┐
   用户的手机 / 平板 │  远程客户端（PWA）                            │
   或另一台电脑     │  · 配对界面 · 隧道管理 · 真实的 DSH 界面容器    │
                    │  · Service Worker：把 DSH 请求改写进隧道       │
                    └───────────────┬──────────────────────────────┘
                                    │ ① 静态应用壳（无用户数据）
                                    │ ② WSS：不透明帧
                    ┌───────────────▼──────────────────────────────┐
                    │  中继服务 drdsh-relay（Rust）                    │
                    │  · 房间注册表 · 帧头路由 · 容量与速率限制       │
                    │  · 无密钥、无数据库、不写 payload              │
                    └───────────────┬──────────────────────────────┘
                                    │ ③ WSS：不透明帧（出站拨号）
                    ┌───────────────▼──────────────────────────────┐
   用户的电脑       │  本地代理 drdshd（Rust）                        │
                    │  · 生命周期监督 · 带鉴权的反向代理             │
                    │  · 端到端加密端点 · 通知聚合                   │
                    └───────┬───────────────────────┬──────────────┘
                            │ ④ loopback HTTP/WS     │ ⑤ loopback HTTP
                    ┌───────▼──────────────┐  ┌─────▼────────────────┐
                    │  DSH Host            │  │  DSH 插件（可选）     │
                    │  dsh web             │  │  @dr.dsh/        │
                    │  127.0.0.1:<port>    │  │  dsh-plugin          │
                    └──────────────────────┘  └──────────────────────┘
```

### 1.1 中继 `drdsh-relay`

**职责**：维护房间注册表；把 daemon 与已配对的客户端连接接在一起；在这条链路之间转发 carrier 帧；执行容量限制。

**边界（不可跨越）**：

- 不链接 `dr-dsh-crypto`，也不链接任何密码学 crate。它没有解密能力。
- 不链接 `dr-dsh-proto` 的 `control` 模块。它只解析 18 字节帧头。
- 不依赖任何 DSH 包。
- 不持久化 payload；没有数据库。

**状态**：内存中的房间表（`crates/dr-dsh-relay/src/rooms.rs`），有上限（`DSH_RELAY_MAX_ROOMS`）。进程重启即遗忘，这不影响正确性：房间是可重建的路由句柄，不是数据。

**数据路径**：一条连接在握手时声明角色与房间，之后每个二进制消息都被当作 carrier 帧校验后投递：
daemon 和该房间唯一的活跃客户端相互转发。当前 carrier 只支持一个加密会话，第二客户端在握手
阶段明确拒绝，避免新握手污染旧会话。中继不解析或持久化 payload，见
[ADR-0024](decisions/0024-embedded-harness-session-isolation.md)。

每连接发送队列固定为 64 帧。队列满时在房间锁外等待容量，以背压限制读取速度，不能丢弃
密文帧后继续发送。关闭信号独立于数据队列，单次排队或写入 30 秒没有进展时结束连接；
见 [ADR-0021](decisions/0021-bounded-relay-backpressure.md)。这不依赖端点实现协议窗口流控。

**房间的生命周期**：daemon 离开时房间立刻停止对外宣告，新客户端得到 `reject`。已排队的末尾
回执仍可交付；daemon 重新注册时关闭并移除旧客户端，旧会话不能沿用新 carrier 的盐和计数器。
两端都空了才释放容量槽。旧连接迟到的清理不能移除替代它的新连接；这些行为由
`crates/dr-dsh-relay/tests/routing.rs` 与房间单元测试覆盖。

**默认监听**：`127.0.0.1:8787`（`DSH_RELAY_BIND`）。`drdsh relay` 的 CLI 宿主可通过
`--tls-cert` / `--tls-key` 直接提供 HTTPS/WSS，也可由反向代理终止 TLS。TLS 库只进入宿主和
daemon，不进入 relay crate（[ADR-0018](decisions/0018-tls-transport.md)）。默认回环的理由是
"安全默认"：即使中继只承载密文，把公网暴露也应当是显式动作。

**对外端点**：`GET /healthz`（只有计数，从不列出房间）、`GET /`（静态应用壳）、`GET /client/<module>.js`（客户端模块）、`GET /ws/daemon`、`GET /ws/client`。握手与拒绝规则的规范描述在 [`protocol.md`](protocol.md) § 5.1。

**客户端如何被服务**：页面外壳打开隧道，把专属 `MessageChannel` 的一端交给 Service Worker，
另一端由页面用 `proxy.ts` 服务。每次交接绑定外壳、viewId 和 iframe 文档，HTTP 请求只进入所属
视图。`hand` / `handed` 确认交接，`bind-view` / `bound` 绑定文档，`unhand` 释放路由；
`request` / `response-stream` / `failed` 通过 id 对应请求（也接受旧页面的 `response`）。Worker 不自行 fetch 隧道地址，避免递归拦截。
后台线程冷启动时请求外壳恢复端口；更新时先结束旧 Worker 的长驻请求，再由新 Worker 接管。

HTTP 响应头和正文在 daemon 与 PWA 中逐段转发；插件热更新的 `/plugins/events` SSE 无需等待
连接结束即可交付。页面向 Worker 转移 `ReadableStream`，浏览器预检会验证这项能力；仅界面 HTML
为注入启动脚本而收集全文。浏览器暂停消费时，每条响应最多暂存 8 MiB，超限会明确失败。
视图退出或 Worker 更换会取消本地读流；现有 wire 没有单条 HTTP 取消消息，迟到片段会被丢弃，
直到该响应或 carrier 结束，carrier 关闭同时结束 daemon 的上游请求。
Worker 正常更换时只对 SSE 以 EOF 结束，使浏览器重新订阅；其他响应的中断仍表现为失败，避免误收截断正文。
DSH 的大型 WebSocket 文本快照通过 PX v2 分片，浏览器校验顺序及 UTF-8 后一次性交付，最大 8 MiB；
carrier 仍为 64 KiB。普通消息继续使用 PX v1，具体升级边界见 [ADR-0028](decisions/0028-streaming-and-large-snapshots.md)。

**客户端分发**：中继把客户端模块从 `DSH_RELAY_CLIENT_DIR` 指向的目录读出（由 `pnpm --filter @dr.dsh/pwa build` 产出）。它不内嵌构建产物——那意味着把生成物提交进仓库并逐行评审。未安装客户端时仍然提供一页说明如何构建，而不是 404：404 会让"缺一个目录"看起来像"中继坏了"。只提供扁平 `.js` 模块，且拒绝 `..`、绝对路径、反斜杠与 `.ts`。

### 1.2 本地代理 `drdshd`

**职责**（按重要性）：

1. **监督 DSH**：启动、健康检查、异常恢复、优雅停止、状态上报。
2. **代理 DSH**：把隧道里来的 HTTP/WS 流翻译成对 `127.0.0.1:<port>` 的请求，并完成 DSH 自己的鉴权。
3. **终结端到端加密**：唯一持有会话密钥的本地组件。
4. **上报与聚合**：把状态与事件变成给远端的帧；把可选通知推给已连接客户端。

**边界**：

- 只以常量 `127.0.0.1` 访问 DSH；配置里没有 host 字段。
- 只接受四种生命周期操作，且不接受任何远端传入的启动参数。
- 报告端点只监听回环并需要报告令牌；本机管理使用默认关闭的私有 Unix socket，不共享报告权限。

受管 DSH 启动前检查其合成配置；默认 auto 目录选择器改用 DSH 内置的主机目录浏览器，
通过私有临时 overlay 随子进程生效。已有显式目录选择配置与 attach 实例保持原行为；不改
用户 profile override 或包依赖，见 [ADR-0025](decisions/0025-host-directory-browser.md)。

**状态**（daemon 自己的目录，权限 `0600`）：

- 房间身份密钥（Ed25519）与房间 id。
- 已配对设备公钥与元信息（名称、配对时间、最后可见时间、是否允许控制）。
- 配置（relay URL、DSH 端口与可执行文件、是否托管）。

**不保存**：会话内容、代码、DSH 凭据、payload。

### 1.3 DSH 插件 `@dr.dsh/dsh-plugin`（可选）

**职责**：在 DSH 进程内订阅事件，转推最小化通知；在本机 DSH 中提供 `/_drdsh/manage`
页面，调用原生管理层安装、配置、配对与维护 daemon。

**为什么可选**：最要紧的两类通知（审批、提问）已经由 DSH 自己的跨进程事件通道转发，不需要插件。插件补的是 `session/event`、`subagent/*`、`goal/changed` 这些不跨进程的事件，以及未来的生命周期控制路由。没有插件时，远程访问、生命周期管理、关键通知全部可用。

**边界**：插件本身不实现隧道密码学或进程监督；独立模式由其持有随包原生连接的生命周期。
页面的生命周期操作交给独立 daemon 或 OS 作业；
DSH 停止时插件页面也停止。DSH 的事件、Web 服务和启动生命周期假设均限制在
`plugins/dr.dsh/src/dsh-surface.ts`（ADR-0003）。管理服务按可选子树加载，失败不取消事件报告。
当前兼容基准与实际验收版本见 [DSH 集成面](integration/dsh-surface.md)，历史事件报告兼容不代表管理面兼容。

### 1.4 远程客户端 PWA

**职责**：配对；建立并维持隧道；把 DSH 请求改写进隧道；展示 DSH 界面；展示状态、离线提示与通知。

连接成功且 DSH 运行时，shell 在当前页内嵌入 Harness 文档，自己继续持有加密隧道。iframe 的
WebSocket 通过校验来源后的专属 MessagePort 交给父页；HTTP 通过 Service Worker 按 viewId
绑定到对应 shell，多个房间不共用最后一次交接的端口。HTTP 与 WS 共用每隧道的流号分配器，
加密发送按计数器顺序排队。配对表单支持回车提交；配对完成后直接使用新身份连接，无需再次点击。
新配对引起 daemon 权限更新与重新注册时，仅对中继明确的空房间拒绝短暂重试（约 5 秒）；
房间占用、设备拒绝和加密握手失败仍直接报告。断开或切换电脑先销毁旧 iframe 文档，再关闭其传输，
避免旧文档在切换期间继续请求或将主动关闭记为页面故障。
连接暂时失败会保留已保存的配对并给出留空重连指引。首次连接使用完整页面；进入 Harness 后由可拖拽、左右吸附的
浮动按钮打开连接管理对话框，重载与断开入口放在对话框里。关闭对话框保留 iframe 和会话，
Harness 本身占满视口。按钮的位置保存在当前浏览器，窗口变小后会限制在可见范围内。

**边界**：不持有 DSH 凭据；除隧道之外没有触达 DSH 的路径。

### 1.5 输入校验与诊断展示

`packages/validation` 是插件服务端、管理页和 PWA 共用的纯 ESM 模块，提供字段问题、
规范化输入与 Standard Schema V1 接口，不依赖 UI 框架。输入格式检查不替代本机权限或加密设备验证。
管理页按概览、配置、设备、诊断和维护分区；PWA 在连接前检查凭据格式与浏览器 API，保存的电脑优先展示。

原生 `doctor --json` 生成版本化本机报告，管理页独立的诊断模型负责状态汇总、筛选、建议与旧文本回退。
失败、未知格式或截断结果不能显示为全部通过。报告不覆盖中继可达性或模型任务。
共享模块打包进入插件和 PWA，不从远程 CDN 加载；PWA 与其余模块一起原子预缓存。
决策见 [ADR-0027](decisions/0027-validation-and-diagnostics.md)，接口与框架验证见
[校验接入指南](development/validation.md)。

---

## 2. 数据流

### 本机安装与服务入口

`relay/install.sh` / `daemon/install.sh` 从 Release 安装对应组件；统一入口为 `drdsh relay ...` /
`drdsh daemon ...`，名称别名为 `drdsh-relay` / `drdsh-daemon`。混合包也运行两个独立服务进程。
各自在 `<prefix>/lib/dr.dsh/relay`、`<prefix>/lib/dr.dsh/daemon` 安装程序，使用独立的
`relay.json` / `daemon.json`、服务身份、日志与更新锁。PWA 归 relay，插件默认归 daemon；
更新仅重启相关宿主，见 [ADR-0015](decisions/0015-independent-relay-and-daemon.md)。
两侧的新安装管理都由 `dr-dsh-cli` Rust 程序实现；Node 仅供 DSH、插件和构建/测试。
各包共用同平台的同一二进制，通过包清单和调用名限制组件；该二进制包含 daemon 密码学实现，
不能声称整个 CLI 满足 relay crate 的密码学依赖约束。具体分发边界见 [ADR-0017](decisions/0017-multicall-release-packages.md)。
`relay/package.sh` 在构建机组装原生程序与 PWA。首页源文件由 Rust 与 PWA 构建共享，nginx 也可直接
托管静态客户端，只把 WebSocket 与健康检查转交 relay，见
[ADR-0016](decisions/0016-native-relay-management.md)。

`install.sh` / `drdsh` 从源码安装各组件，保存 DSH 的绝对路径、工作目录和状态目录，
通过用户级 launchd / systemd 启停 Rust 二进制。PWA 随中继分发；插件通过 DSH 的 web profile
安装命令注册。该运维入口不增加网络接口或协议消息，见
[ADR-0014](decisions/0014-installation-and-services.md) 与[命令说明](operations/cli.md)。该统一入口保留为旧安装兼容路径。

### 本机结构化管理与运行状态

`drdsh daemon manage` 提供版本化 JSON 入口；`daemon.json` 仍是唯一安装配置来源。
插件可显式设为外部归属，由 DSH 包管理器管理；报告开关独立于插件包归属。
运行时管理默认关闭，启用后只在私有 Unix socket 上提供状态、配对、设备与 DSH 生命周期操作。
该接口不接入 DSH RPC、TCP 或远端隧道，报告令牌不授予管理权限。

每个规范化状态目录用 OS 文件锁保证单个 daemon；设备事务锁独立且只覆盖短暂的读改写。
配对提交合并最新登记，运行中设备变更立即通知鉴权策略；旧 CLI 直接修改文件时，daemon 每
200 毫秒检查。首次配对关闭纯房间密钥会话，撤销关闭对应设备的活跃代理和通知，登记丢失或
损坏时拒绝访问。设备变更无需重启 DSH。

协议和运行边界见[本机管理接口](operations/daemon-management.md) 与
[ADR-0022](decisions/0022-plugin-managed-daemon-foundation.md)。

### 插件页面、原生包与 OS 作业

```text
本机 DSH 页面 → DSH 鉴权 + 本机 capability → 插件闭集 JSON → 原生 CLI
                                                        ├─ daemon.json
                                                        ├─ 私有运行时 socket
                                                        └─ systemd / launchd 作业
远端隧道 → daemon 代理 → 拒绝 /_drdsh 管理命名空间
```

DSH 包管理器安装的单包包括页面与匹配平台的 native。native 复制到插件目录以外的私有缓存，
先检查清单、平台、版本和文件类型，再校验缓存完整性；缺包明确失败，不使用旧 Release 凑数。
页面不能提供 native 下载地址或命令，只能选择本机管理层公开的操作和配置字段。

DSH 的登录、真实 loopback 连接和同源检查之后，管理 API 还需要独立的短期 Bearer。
它由 `0600` 本机 capability 或 5 分钟单次启动链接换取，15 分钟失效，插件卸载或 DSH 重启即撤销。
首页仅注入固定入口，不放秘密；本机启动链接只交 OS 浏览器与私有文件。daemon 对 HTTP 与
WebSocket 共用路径拒绝，分离 query 后按有界解码与点目录归一检查 `/_drdsh`。

安装、更新、卸载和会终止宿主的操作提交独立 OS 作业，持久结果不依赖页面或 DSH 存活。
首次接管先准备不启动的安装，再由原生层识别当前宿主的进程身份，用户确认后重新校验并交接。
普通 attach 模式不自动取得停止手动进程的权限。停止服务后页面可能不可达，须以保存的 job ID
和实际运行状态判断结果。设计与代价见 [ADR-0023](decisions/0023-plugin-local-management.md)。

### 2.1 启动与就绪

```
drdshd run
  │
  ├─ 读配置，校验（relay URL、DSH 端口、可执行文件）
  ├─ 生成/加载房间身份密钥与房间 id
  ├─ spawn: dsh web --no-open --port <p>   ← 参数由 daemon 生成，远端无法影响
  │     └─ 等待 stdout 上的就绪行：dsh web: http://127.0.0.1:<p>?token=<T>
  │            ↑ 这一行同时给出端口与进程令牌；`--no-open` 不会抑制它
  ├─ 校验就绪行指向 loopback（非 loopback 直接拒绝，不做代理）
  ├─ GET http://127.0.0.1:<p>/?token=<T>   (Host: 127.0.0.1:<p>)
  │     → 303 + Set-Cookie: dsh-auth-<sha256(authority)>=v1.…
  │     ← cookie 绑定 authority 127.0.0.1:<p>，默认 30 天有效
  ├─ GET / 验证一次（首页必须 200，否则说明 authority 在两跳之间变了）
  ├─ 建立健康检查循环（HTTP 探测 + 进程存活）
  └─ 向 relay 拨号，注册房间
```

**已实现并实测的部分**（`crates/dr-dsh-daemon/tests/acceptance.rs`，`DSH_BIN=… cargo test -p dr-dsh-daemon --test acceptance -- --ignored`）：

```
DshClient ──▶ 中继 ──▶ daemon ──▶ loopback ──▶ 真实的 dsh web
```

`GET /` 经加密隧道取回 DSH 自己的首页（以 DSH 注入的 `__DSH_BOOT__` 为证），authority 与 cookie 由 daemon 替换；`/api/remote.mux` 的 `$events` 就绪项也经同一路径往返。2026-10-22 在 DSH `0.2.1-rc.2` 上的进程与浏览器实测结果见[兼容记录](integration/dsh-surface.md#2026-10-22-兼容验收dsh-021-rc2)。

**为什么必须解析就绪行**：DSH 没有 daemon 模式，也没有本地发现文件；就绪行是它提供给监督者的接口（其源码注释写明"监督者应在观察到该行后立即建立连接"）。与插件管理服务一样，这些契约没有独立的稳定版本承诺，因此：

- 解析逻辑集中在一处；
- 解析失败时给出明确错误（"DSH 已启动但未打印就绪行，可能是版本不兼容"），而不是静默等待；
- `drdshd doctor` 可以单独验证这一环，集成测试 `crates/dr-dsh-daemon/tests/supervise.rs` 用一个复刻了四个外部可见行为的替身 harness 覆盖了它；
- 已核对的上游位置记录在 [`integration/dsh-surface.md`](integration/dsh-surface.md)。

### 2.2 会话引导（bootstrap）：远端如何访问到 DSH

这是整个系统最容易做错的一段，因为 DSH 的授权 cookie **绑定 Host authority**，而远端浏览器的 authority 是 `relay.example`，不是 `127.0.0.1`。

```
远端浏览器                 中继                 daemon                 DSH
     │                       │                     │                    │
     │ ① 打开 https://relay.example                │                    │
     ├──────────────────────▶│                     │                    │
     │◀── 静态应用壳（无用户数据，可缓存、可审计） ──┤                    │
     │                       │                     │                    │
     │ ② 输入配对码 → SPAKE2（经隧道，密文）        │                    │
     ├───────────────────────┼────────────────────▶│                    │
     │                       │                     │ ③ 登记设备公钥      │
     │◀── 设备密钥已登记，隧道建立 ─────────────────┤                    │
     │                       │                     │                    │
     │ ④ control: session_bootstrap_request         │                    │
     ├───────────────────────┼────────────────────▶│                    │
     │                       │                     │ ⑤ 用令牌换 cookie   │
     │                       │                     ├───────────────────▶│
     │                       │                     │◀── 303 + Set-Cookie│
     │◀── bootstrap{path, authority, expires} ──────┤                    │
     │                       │                     │                    │
     │ ⑥ 同源访问 bootstrap path（浏览器收下 cookie 到本页 origin）        │
     ├───────────────────────┼────────────────────▶│                    │
     │                       │                     ├── 带 cookie 请求 ──▶│
     │◀── DSH 界面 ───────────┼─────────────────────┤◀── 页面/资源 ──────│
     │                       │                     │                    │
     │ ⑦ 之后每个 DSH 请求由 Service Worker 改写为 /__dr/dsh/<path>       │
     ├───────────────────────┼────────────────────▶│                    │
     │                       │                     ├─ Host: 127.0.0.1:p ─▶│
     │                       │                     │  Cookie: dsh-auth-… │
     │◀── 响应（含 /api 与 WebSocket 升级） ────────┤◀───────────────────│
```

要点：

- **DSH 的鉴权没有被跳过**：daemon 完整执行了"令牌换 cookie"这一步，只是执行者是用户自己机器上的进程（ADR-0003）。
- **authority 全链路一致**：cookie 绑定 `127.0.0.1:<p>`，daemon 也始终以该 authority 访问，因此首页、`/api`、以及 WebSocket 升级（`/api/remote.mux`）走同一套规则，没有特例。
- **远端不持有 DSH 凭据**：令牌与 cookie 都留在 daemon 内。
- **页面请求交给 Service Worker**：它把 DSH 路径改写到隧道前缀；改写规则是一个纯函数（`apps/pwa/src/routing.ts`），有单元测试。

### 2.3 一次普通请求的生命周期

```
页面 fetch /api/sessionController/list
  → SW: /__dr/dsh/api/sessionController/list        （同源，cookie jar 适用）
    → 中继：按房间把帧转给该房间的 daemon            （payload 是密文）
      → daemon：解密 → 打开一条到 DSH 的流
        → DSH: POST http://127.0.0.1:<p>/api/sessionController/list
               Host: 127.0.0.1:<p>
               Cookie: dsh-auth-<sha256("127.0.0.1:<p>")>=v1.…
        ← 响应流式回传（大响应被切成 ≤64 KiB 的帧，按窗口交错）
      ← 加密 → 帧
    ← 转发
  ← SW 返回响应
```

### 2.4 实时事件

两条路径，取决于事件是否在 DSH 的跨进程转发列表里：

| 事件 | 路径 | 需要插件 |
| :--- | :--- | :--- |
| 审批请求、用户提问、`api-session/*`、`goal/activation-changed` | DSH Gateway 的 WS 多路复用（`/api/remote.mux`）经代理到达远端 | 否 |
| `session/event`、`subagent/*`、`goal/changed`、`agent/status` | 插件在进程内订阅 → loopback HTTP → daemon → 通知帧 → 远端 | 是 |

第一条路径是免费的：它本来就是 DSH 的界面流量，被我们原样代理。第二条路径是插件存在的全部理由。

插件路径已实现四类事件：`turn_complete`、`approval_requested`（含用户提问）、`goal_complete`、
`subagent_complete`；`agent/status` 不上报。显式启用插件报告后，daemon 在 `127.0.0.1` 随机端口
接受带临时 Bearer 令牌的 `POST /report`，再发已有 `notification` 控制消息给完成设备鉴权的连接。
端口与令牌只传给受管 DSH 子进程，不写配置；attach 模式拒绝启用。
队列有界，未连接不保存；PWA 的通知列表在断开、重连、切换机器时清空。
不新增 relay 接口，不改变共享 wire 格式，也不启用 Web Push，见
[ADR-0020](decisions/0020-plugin-realtime-notifications.md)。

### 2.5 生命周期操作

```
远端点击"重启"
  → control: lifecycle_command{op: "restart"}
    → daemon 校验：设备是否有控制权限、是否为托管模式、操作是否在白名单内
      → 若为 attach 模式：拒绝并说明原因（远端显示"该实例由你手动启动"）
      → SIGTERM → 等待 DSH 优雅退出（其自身有受限宽限期）
      → 重新 spawn → 等待就绪行 → 重新换 cookie
    → lifecycle_result{ok, state, error}
  → daemon 同时向所有已连接客户端广播新的状态
```

**白名单是闭集**：`LifecycleOp` 里没有第五个值，协议里也没有承载启动参数的字段。这不是"我们记得校验"，而是"没有东西可以传"。

---

## 3. 状态模型

远端看到的状态来自 daemon 的单一事实来源（`dr-dsh-proto::control::Status`）：

| 字段 | 含义 |
| :--- | :--- |
| `state` | `stopped` / `starting` / `running` / `stopping` / `failed` / `attached` |
| `local_url` | DSH 正在监听的回环 URL（仅在运行时有值） |
| `pid` | DSH 进程 id（仅托管模式） |
| `uptime_secs` | 当前这轮运行的时长 |
| `owned` | 该进程是否由本 daemon 拥有（attach 模式为 false） |
| `last_error` | 上一次失败的可读原因 |
| `relay` | `connected` / `reconnecting` / `rejected` / `unreachable` |
| `protocol` | daemon 支持的协议版本，用于诊断 |

**为什么把 `relay` 放在状态里**：失败透明是产品要求。用户必须能区分"我的电脑没开机"（daemon 不在线）与"我的电脑在，但 DSH 挂了"（daemon 在线，`state = failed`，有 `last_error`）。这两种情况在远端的表现必须不同。

---

## 4. 失败与恢复

| 故障 | daemon 行为 | 远端表现 |
| :--- | :--- | :--- |
| DSH 进程崩溃 | 按退避重启（`uplink::Backoff`），期间状态为 `starting` | 显示"正在恢复"与重启次数 |
| DSH 启动即失败 | 停止重试，状态 `failed` + `last_error` | 显示失败原因与建议动作 |
| 中继不可达 | 保持监督 DSH 不变，上行按抖动指数退避重连 | 显示"计算机离线"，本地 DSH 不受影响 |
| 中继拒绝连接（房间不存在/设备被撤销） | 停止无意义重试，状态 `rejected` | 显示"该设备已被撤销"或"房间无效" |
| 隧道断开 | 客户端保持界面并显示离线；恢复后重建视图 | 明确的离线横幅，而不是空白页 |
| 客户端设备被撤销 | daemon 拒绝其握手并断开 | 显示"已从此电脑移除"，并回到配对界面 |
| 就绪行解析失败 | 记录原始输出，状态 `failed`，给出"可能是 DSH 版本不兼容" | 可读的错误 + 收集信息指引 |

**原则**：daemon 的本地职责（监督 DSH）与上行职责（连中继）互不阻塞。失去中继永远不能让本地会话受影响。

---

## 5. 协议与加密的落点

- 帧格式、流、窗口、握手：见 [`protocol.md`](protocol.md)。
- 密钥、配对、AEAD、AAD、nonce：见 [`security.md`](security.md) § 2 与 § 6。
- 为什么协议存在两份实现：见 [ADR-0004](decisions/0004-wire-protocol.md)。

---

## 6. 尚未决定的架构问题

如实列出，避免它们在实现里被"顺手决定"：

- **局域网直连是否需要**：若引入，需要一个额外的监听面与信任规则（`docs/product/mvp.md` § 六）。
- **一个 daemon 管理多个 DSH 实例**：状态模型需要扩展（每个实例一份 `Status`？房间与实例的关系？）。
- **本机管理的 Windows 支持**：当前私有 Unix socket 与 OS 作业覆盖 macOS/Linux；原生 Windows 的权限与服务实现仍需独立设计。
- **推送通道的具体实现**：Web Push 与自托管推送的选择，取决于 Web Push 端到端边界的结论（ADR-0006）。
