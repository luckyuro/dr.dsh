# 架构

本文描述 dr.dsh 的组件边界与数据流。**为什么这样设计**记录在 [`decisions/`](decisions/) 的 ADR 中；本文只描述"是什么"与"数据怎么走"。

---

## 1. 组件模型

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

**数据路径（已实现，M0）**：一条连接在握手时声明角色与房间，之后每个二进制消息都被当作 carrier 帧校验后投递：daemon 的帧扇出给该房间的全部客户端，客户端的帧投给 daemon。整个数据路径是"一次查表 + 一次通道发送"，中继既不解析 payload，也不留副本。

**房间的生命周期**：daemon 离开时房间立刻停止对外宣告（此时到达的客户端会得到 `reject`，而不是无限等待一个不会来的对端）；房间本身在仍有客户端时保留，这样重连的 daemon 可以继续服务它们；两端都空了才释放容量槽。这一条有集成测试覆盖（`crates/dr-dsh-relay/tests/routing.rs`）。

**默认监听**：`127.0.0.1:8787`（`DSH_RELAY_BIND`），生产部署时由运维自己的反向代理终止 TLS 并对外暴露。默认回环的理由是"安全默认"：即使中继只承载密文，把公网暴露也应当是显式动作。

**对外端点**：`GET /healthz`（只有计数，从不列出房间）、`GET /`（静态应用壳）、`GET /client/<module>.js`（客户端模块）、`GET /ws/daemon`、`GET /ws/client`。握手与拒绝规则的规范描述在 [`protocol.md`](protocol.md) § 5.1。

**客户端如何被服务**：页面外壳（中继提供）打开隧道，把 `MessageChannel` 的一端交给 Service Worker，另一端由页面用 `proxy.ts` 服务。Worker 不再改写 URL 后自行 `fetch`——那会拦截它自己，页面永远不加载。协议只有四种消息（`hand` / `request` / `response` / `failed`），`id` 负责并发配对。

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
- 本地控制端点只监听回环并需要本地令牌。

**状态**（daemon 自己的目录，权限 `0600`）：

- 房间身份密钥（Ed25519）与房间 id。
- 已配对设备公钥与元信息（名称、配对时间、最后可见时间、是否允许控制）。
- 配置（relay URL、DSH 端口与可执行文件、是否托管）。

**不保存**：会话内容、代码、DSH 凭据、payload。

### 1.3 DSH 插件 `@dr.dsh/dsh-plugin`（可选）

**职责**：在 DSH 进程内订阅插件能看到的事件，转推给本地 daemon。

**为什么可选**：最要紧的两类通知（审批、提问）已经由 DSH 自己的跨进程事件通道转发，不需要插件。插件补的是 `session/event`、`subagent/*`、`goal/changed` 这些不跨进程的事件，以及未来的生命周期控制路由。没有插件时，远程访问、生命周期管理、关键通知全部可用。

**边界**：不加密、不代理、不管理生命周期。它是本项目唯一 import `@deepseek-ai/*` 的地方，且所有此类假设被限制在 `plugins/dr.dsh/src/dsh-surface.ts` 一个文件内（ADR-0003）。

### 1.4 远程客户端 PWA

**职责**：配对；建立并维持隧道；把 DSH 请求改写进隧道；展示 DSH 界面；展示状态、离线提示与通知。

**边界**：不持有 DSH 凭据；除隧道之外没有触达 DSH 的路径。

---

## 2. 数据流

### 本机安装与服务入口

`relay/install.sh` / `drdsh-relayctl` 与 `daemon/install.sh` / `drdsh-daemonctl` 是两个独立入口。
各自在 `<prefix>/lib/dr.dsh/relay`、`<prefix>/lib/dr.dsh/daemon` 安装程序，使用独立的
`relay.json` / `daemon.json`、服务身份、日志与更新锁。PWA 归 relay，插件归 daemon；
更新仅重启相关宿主。源码中的 CLI 与服务管理实现共享，安装后的管理文件各自保存，见
[ADR-0015](decisions/0015-independent-relay-and-daemon.md)。

`install.sh` / `drdsh` 从源码安装各组件，保存 DSH 的绝对路径、工作目录和状态目录，
通过用户级 launchd / systemd 启停 Rust 二进制。PWA 随中继分发；插件通过 DSH 的 web profile
安装命令注册。该运维入口不增加网络接口或协议消息，见
[ADR-0014](decisions/0014-installation-and-services.md) 与[命令说明](operations/cli.md)。该统一入口保留为旧安装兼容路径。

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
  ├─ 建立健康检查循环（HTTP 探测 + 进程存活）        ← M2
  └─ 向 relay 拨号，注册房间                          ← M0 剩余部分
```

**已实现并实测的部分**（`crates/dr-dsh-daemon/tests/acceptance.rs`，`DSH_BIN=… cargo test -p dr-dsh-daemon --test acceptance -- --ignored`）：

```
DshClient ──▶ 中继 ──▶ daemon ──▶ loopback ──▶ 真实的 dsh web
```

一次代理 `GET /` 取回 DSH 自己的首页 27923 字节（以只有 DSH 注入的 `__DSH_BOOT__` 为证），authority 与 cookie 由 daemon 替换。健康检查循环（自愈）与 PWA 联通是 M0 的剩余部分。

**为什么必须解析就绪行**：DSH 没有 daemon 模式，也没有本地发现文件；就绪行是它提供给监督者的正式接口（其源码注释写明"监督者应在观察到该行后立即建立连接"）。它是本项目中唯一一处依赖非版本化上游契约的地方，因此：

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
- **daemon 本地控制端点是否改用 unix domain socket**：会提高跨平台成本，收益是更小的本地暴露面。
- **推送通道的具体实现**：Web Push 与自托管推送的选择，取决于 Web Push 端到端边界的结论（ADR-0006）。
