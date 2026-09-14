# ADR-0003：不 fork DSH —— 进程外监督 + 带鉴权的反向代理 + 一个薄插件

- 状态：已接受
- 日期：2026-09-11
- 决策影响：`crates/dr-dsh-daemon`、`plugins/dr.dsh`、`apps/pwa`

## 背景

"不修改 DSH 核心、独立项目、插件式集成"（§ 4、§ 11）说起来清楚，落地上必须先回答一个具体问题：**远程客户端最终看到的 DSH 界面，究竟由谁提供？** 有三种可能的形态，安全性差别很大。

调研 DSH 0.1.5-rc.2 后确认了三个硬事实，它们直接排除了若干想当然的做法：

1. **DSH 不可能被直接暴露。** `dsh web` 默认绑定 `127.0.0.1`，并且显式拒绝 `--host 0.0.0.0`，报错原文是"it would expose remote code execution to the network"。底层 webserver 的 schema 允许 `0.0.0.0`，但 CLI 层把它挡掉了——这是策略护栏，不是硬保证，我们不去绕它。
2. **DSH 的 Web 面有一道浏览器信任栅栏，裸反向代理必然失败。** 首页与 `/api` 都需要一个签名 cookie：`GET /?token=<进程令牌>` 会换取一个 **cookie 名与签名 audience 都绑定 Host authority** 的授权 cookie（`dsh-auth-<sha256(authority)>` = `v1.<payload>.<HMAC>`，默认 24 小时）。`/api` 还额外要求 Host 是 loopback 或 `trustedHosts`、且 `Origin` 与 Host 同源。任何"直接转发但保留远端 Host"的方案都会得到 401。
3. **DSH 没有任何 daemon 化能力**，但为监督者留了正式接口：`dsh web` 在 Loader settle 之后向 stdout 打印 `dsh web: <url>?token=<token>`，DSH 自己的文档注释写明监督者应当在观察到该行后立即建立连接。SIGTERM 会先 dispose 整棵树再退出，并有受限宽限期后强杀。

## 决策

**远程看到的永远是真实的 DSH Web UI；本项目只做"监督进程 + 带鉴权的反向代理 + 事件旁路"。**

### 1. 生命周期：外部进程监督

daemon 以 `dsh web --no-open --port <p>` 启动子进程：端口由 daemon 指定（不需要猜），`--no-open` 阻止在用户的机器上弹出浏览器窗口，而**就绪行仍然会打印**——它由 `printUrl` 触发，与 `--no-open` 无关。从该行解析出 `(port, launchToken)`。停止时发 SIGTERM 并等待 DSH 自己的优雅关闭，超时后强杀。重启、退避、自愈全部由 daemon 负责（`crates/dr-dsh-daemon/src/uplink.rs`、`docs/architecture.md` § Daemon）。

### 2. 流量：daemon 自己完成 DSH 的鉴权，然后以 loopback authority 反向代理

daemon 不转发远端浏览器的凭据，而是**自己换取 DSH 的授权 cookie**：用就绪行里的令牌执行一次 `GET /?token=…`，拿到绑定 loopback authority 的 cookie，之后所有代理请求都带着它，并把 Host 改写为 `127.0.0.1:<port>`。

这样做的三个后果，全部是想要的：

- **DSH 的信任模型不被绕过**：它要求的鉴权一次不少地被执行了，只是执行者是用户自己机器上的进程。我们不使用 `--trusted-host` 去放宽栅栏，也不伪造 Origin。
- **远端浏览器不持有 DSH 凭据**：令牌与 cookie 都留在 daemon 内，远端只持有自己的隧道密钥。凭据不进入任何它无法保护的存储。
- **authority 在整条链路上保持一致**：cookie 绑定 `127.0.0.1:<port>`，代理始终以该 authority 访问，因此首页、`/api`、以及 WebSocket 升级（`/api/remote.mux`）走同一套规则，没有特例。

### 3. 客户端：Service Worker 把页面请求改写进隧道

远端页面由中继提供静态应用壳，页面的 Service Worker 把 DSH 路径的请求改写到隧道前缀（`/__dr/dsh/…`），再由中继转发密文。浏览器不需要知道 DSH 的存在，也不需要任何 `--trusted-host` 配置。细节见 ADR-0005。

### 4. 事件：优先用 DSH 已有的跨进程通道，插件只补缺口

DSH Gateway 的跨进程转发事件是一个**编译期硬编码的允许列表**（19 项，包含 `approval/request`、`user-questions/request`、`api-session/*`、`goal/activation-changed`），且注册是单例、第三方插件无法扩充。这意味着：

- **关键通知（审批、提问）不需要插件**：它们已经在转发列表里，经由被代理的 `/api/remote.mux` 就能到达远端。
- **更丰富的事件需要插件**：`session/event`、`subagent/*`、`goal/changed` 不跨进程。要拿到它们，只能在 web profile 内挂一个 bundle 插件（`plugins/dr.dsh`），由它在进程内订阅并 POST 给本地 daemon。
- 插件是**可选增强**，不是运行前提。没有它，远程访问、生命周期管理、关键通知全部可用。

## 被否决的方案

### 自建一个远程专用 API，只暴露"必要的 DSH 能力"

- 否决理由：这会立刻分叉出第二个 DSH 语义实现，并且违反 § 4"远程客户端完整访问 DSH Web 界面"。用户要的是自己的界面，不是我们裁剪过的子集。任何 DSH 新增的能力都会在我们的 API 里缺席。

### 用 DSH SDK（stdio JSON-RPC）驱动一个独立 runtime

- 否决理由：SDK 是给"另一个进程驱动一个完整 DSH runtime"用的，无法附着到**已经运行**的 `dsh web`；它只提供 4 类通知且没有审批流（client→server 通知尚未实现）；它的 jsonrpc server 还要求 stdout 干净，与 `dsh web` 打印 URL 行冲突。它可以作为未来的补充通道，但不能作为远程访问的主路径。

### 写一个插件把 DSH 暴露到非 loopback 地址

- 否决理由：这正是 DSH 自己刚刚拒绝的事情（"would expose remote code execution to the network"）。用插件绕过核心的安全决定，既不尊重上游，也会把攻击面从"我们的隧道"扩大到"用户的整个局域网"。dr.dsh 的策略是：**我们不改变 DSH 的绑定，只代理它。**

### 依赖 `--trusted-host` 让 DSH 接受远端 authority

- 否决理由：`--trusted-host` 的语义是"这个部署服务于这些非 loopback authority"，它会放宽 `/api` 的 Host 栅栏。用它来服务隧道，等于把一个 DNS-rebinding 防护打开一个洞，只为了省掉一次 cookie 换取。而且它并不解决根本问题：cookie 仍然绑定 authority，仍然需要一致的 authority 语义。

## 后果

### 正面

- 远程界面就是本机界面，DSH 的每次升级（新增面板、新增工具、新增流式协议）自动对远程可见，我们不需要跟进。
- DSH 的鉴权与信任模型完整保留，我们只做它的客户端。
- 上游破坏性变更的影响面被压缩到两个已知契约：就绪行的格式，以及插件依赖的事件名与 payload（后者集中在 `plugins/dr.dsh/src/dsh-surface.ts`，并有启动期守卫）。

### 负面与代价

- 依赖就绪行这一**非正式契约**。它有源码注释背书，但没有版本化的稳定性承诺。缓解：解析失败时给出明确错误而不是静默等待；把解析逻辑集中一处；`docs/integration/dsh-surface.md` 记录已核对的上游位置。
- 远端页面会被 DSH 判定为"非 loopback"，因此部分依赖 `isLoopback` 的设置面板会降级（例如设置持久化退回内存）。这不是 bug，是 DSH 把 loopback 当作"操作者本机"的既有设计。我们在 `docs/operations/troubleshooting.md` 中如实说明，并接受这一限制。
- 代理必须正确处理流式与升级，否则表现为"页面能开、实时更新不动"。这是 M0 的核心验收项。

### 需要持续留意

- 如果 DSH 未来提供官方的远程/中继缝隙，应当重新评估本 ADR，优先使用上游方案而不是继续维护代理层。
- 如果 DSH 的 `session/event` 之类的进程内事件进入跨进程转发列表，插件的一部分存在理由消失；插件应随之缩小，而不是扩张。
