# MVP 范围与里程碑

本文回答定义文档 § 18 留下的四个问题：**MVP 包含什么、目标平台优先级、自托管与托管服务的边界、以及安全审计安排在什么时候**。里程碑 M0–M6 与定义文档 § 14 对齐，但每个里程碑都补上了"完成的可验证标准"，否则里程碑会退化成愿望清单。

## 一、MVP 的边界

**MVP = M0 + M1 + M2。** 也就是说，一个用户能够：在自己的电脑上安装并常驻一个 daemon；用手机通过一次性配对码把它配上；对运行在本机上的 DSH 做**完整的界面访问**；远程启动、停止、重启 DSH 并看到状态；在任务完成或等待审批时收到通知。

明确**不在** MVP 内：

| 不包含 | 归属 | 原因 |
| :--- | :--- | :--- |
| 离线推送（App 未打开也能收到） | M3 | 需要推送通道，而推送默认关闭（ADR-0006） |
| 托管中继服务 | M4 | 需要有人承担运营与合规；自托管先跑通 |
| 团队房间、多用户共享一个 DSH | M6 | 定义文档 § 16 仍列为开放问题 |
| 文件传输、终端、完整桌面 | 不在路线图上 | 定义文档 § 5 明确为非目标 |
| 原生移动 App | M3 之后评估 | PWA 先验证协议与加密通路 |
| 旧 CPU 替代安装路径 | M5 | 需要先有可发布的产物 |
| 多 profile / 多实例管理 | M6 | 定义文档 § 16 仍列为开放问题 |

### MVP 的验收标准（每条都可机械验证）

1. **连通**：一台全新设备从打开 URL 到看见 DSH 界面，只需输入一次配对码，总耗时 < 2 分钟（定义文档 § 13）。
2. **保真**：远程界面与本机界面是同一个应用；会话切换、实时消息流、工具调用状态、以及长会话滚动都不降级。验收方式：在远程端完成一次真实的多轮编码任务，包含至少一次审批、一次工具调用、一次长输出。
3. **零知识**：中继进程在整个过程中不持有任何明文 payload。验收方式：端到端测试对中继的日志与转发的 payload 做明文特征串断言（见 ADR-0002 § 强制手段）。
4. **生命周期**：远程启动、停止、重启均可用；强制杀死 DSH 进程后 daemon 在退避窗口内自愈，且远端在自愈期间显示"正在恢复"而不是无响应。
5. **附着模式**：手动启动的 DSH 被 daemon 识别为附着模式，远程的生命周期按钮被禁用并说明原因，界面访问仍然可用。
6. **失败透明**：断开中继、杀死 daemon、撤销设备三种故障各自在远端有明确且不同的提示（§ 9.7）。
7. **配对安全**：配对码 300 秒过期、单次使用；重复使用已消费的码必须失败并有审计记录。
8. **回环绑定**：daemon 拒绝任何把 DSH 绑定到非 loopback 地址的配置；不存在能绕过该拒绝的配置项。

## 二、平台优先级

**第一优先：Linux 与 macOS 上的 daemon；iOS/Android 浏览器上的 PWA。** 这是"外出时用手机看进度"这一核心场景的最短路径（§ 7）。

**第二优先：Windows 上的 daemon。** 差异点在子进程管理与优雅停止（SIGTERM 对应物），协议与加密层无差异。Windows 是 M2 的收尾项，不是 M2 的阻塞项。

**第三优先：平板与桌面浏览器。** 它们复用同一份 PWA，几乎零额外成本。

旧 CPU 与旧浏览器的支持见 M5；不满足时的行为必须是**明确的错误信息**，而不是崩溃或静默失败（§ 12）。

## 三、自托管与托管服务的边界

**MVP 只支持自托管中继。** 这不是能力限制，而是顺序选择：中继的行为与限制必须先在一个用户可以自己检查、自己抓包、自己审计的实例上被验证，托管服务才有意义。

三种使用形态，按引入顺序：

| 形态 | 引入里程碑 | 说明 |
| :--- | :--- | :--- |
| 自托管中继（Docker 或二进制） | M0 | MVP 的唯一形态；`docs/operations/self-hosting.md` |
| 局域网直连（无中继） | 未排期 | 同一网络下 daemon 直接监听 loopback 并由客户端经内网访问。**尚未决定**是否值得引入：它需要一个额外的监听面，而零配置中继已经覆盖了主要场景 |
| 托管中继 | M4 | 需要先回答商业模式、运营主体、以及滥用处置；定义文档 § 16 列为开放问题 |

代码层面的准备：协议不区分中继的部署形态（自托管与托管运行同一份二进制），因此托管化不需要协议变更。真正的门槛在运营，不在技术。

## 四、安全审计计划

审计不是 M5 才开始的活动，而是分三段：

1. **M1 结束：内部威胁模型评审。** 产出是 `docs/security.md` 的定稿，特别是"中继在 TCB 内"这一条要写清楚（ADR-0005）。评审对象是协议与配对流程，方式是走查每一个信任边界与每一条"我们不做 X"的声明。
2. **M2 结束：实现评审。** 重点是生命周期管理引入的新攻击面：子进程启动参数是否可能被远端影响、白名单是否真的闭集、attach 模式是否有绕过路径。
3. **M5：第三方深度审计。** 定义文档 § 12 明确承诺这一点。审计范围至少包含：配对与密钥协商、帧复用与流控的边界、代理层的请求改写（谁能影响发往 DSH 的请求）、以及发布产物的可复现性。审计结果公开。
   范围说明与实际材料清单写在 [`../audit-scope.md`](../audit-scope.md)（第 36/37 轮），其中每条安全声明
   都指向一个"改坏它就红"的检查。**审计本身尚未进行**：因此"审计无高危"在 M5 的进度行里是未达成。

## 五、里程碑与可验证标准

| 里程碑 | 内容 | 完成标准 |
| :--- | :--- | :--- |
| **M0 概念验证** | daemon 监督 DSH、中继转发、PWA 壳能打开真实 DSH 界面 | 本机 + 一台外部设备完成一次完整会话；中继日志无明文 |
| **M1 安全与配对** | SPAKE2 配对、设备密钥、端到端加密、回环校验 | 未配对设备无法建立隧道；配对码单次且过期；两端通过共享向量；威胁模型定稿 |
| **M2 生命周期** | 启动/停止/重启/状态/自愈/attach 模式 | 上述 MVP 验收标准 1–8 全绿；三个平台各有一份安装说明 |
| **M3 移动体验** | PWA 安装、离线状态、推送（可选）、性能 | 移动端崩溃率 < 0.5%；长会话（>1000 条消息）滚动不卡顿；离线提示可读 |
| **M3 进度（第 32 轮）** | **进行中（可安装已完成；离线与性能待做）** | **可安装**：manifest + 192/512 图标（含 maskable）+ 外壳链接 + 中继的静态资源白名单（固定名字与 MIME，`.html` 仍不可达）。浏览器冒烟 **11/11**，其中三项是安装性：manifest 可被浏览器解析（`Page.getAppManifest`，0 错误、`name="dr.dsh"`、`start="/"`、3 个图标）、两个图标 200、外壳确实链接了它。**过程中修掉一个只有浏览器会报的缺陷**：外壳的 CSP 是 `default-src 'none'` 而没有给 `manifest-src`/`img-src` 开口子，于是 manifest 与图标被 CSP 拒掉、安装提示永远不出现，而服务器侧测试全绿（§ 五点六一）。**离线（第 33 轮完成）**：service worker 在安装时缓存 `/`、`shell.js`、manifest 与图标，之后对 `/client/**` 的 GET 走缓存优先；只缓存客户端自己的文件，DSH 的内容一条都不进缓存（由纯函数 `isClientOwned` 与它的测试固定）。实测 `scripts/browser-offline-smoke.mjs` **6/6**：断网后**重新加载仍然渲染外壳**、页面用一句话说明离线（已配对/未配对两种说法，都写明什么没有丢）、恢复网络后能正常连上。过程中修掉一个真实缺陷：worker 原先只在连接流程里注册，**从没连接过的设备什么都没缓存**。**M3 状态（第 34 轮）：完成（含一条明确的部分项）** —— 可安装（§ 五点六一）、离线（§ 五点六二）、
崩溃率（600 次真实运行、0 崩溃、95% 上界 0.50%）、长会话滚动（1000 个消息大小的块、0 个长帧；"DSH 自身
产生 1000 条消息"的更强版本未测并写明原因）。推送按 ADR-0006 默认关闭，本轮不实现也不声称。
**性能与崩溃率（第 34 轮）**：崩溃率的定义在 `apps/pwa/src/health.ts`（未捕获错误 / 未处理的 rejection / 未到达可用状态），计数留在页面内存里、**不上报**；`scripts/browser-soak-smoke.mjs` 反复做真实加载并按 **rule of three** 报数——零崩溃的 95% 上界是 `3/n`，因此短跑会被报成"样本不足以支持 0.5%"（退出码 2）而不是通过，要支持标准里的 0.5% 需要 **600 次**运行。滚动性能由 `scripts/browser-perf-smoke.mjs` 量：真实会话这次没有可滚动内容（记 skip，不记通过），把会话填充到 1000 个消息大小的块后 52720px 内容、180 帧、**0 个长帧**；脚本头部写明这是"在真实客户端里滚动 1000 个块"，**不是**"DSH 产生了 1000 条消息的会话"。**剩余**：推送（可选，ADR-0006 默认关闭）、真实 1000 条消息会话的测量。 |
| **M4 自托管与生态** | Docker 一键部署、文档、部署检测 | 自托管部署成功率 > 90%（以文档走查 + 新用户实测计）；反向代理超时能被启动期检测并警告 |
| **M4 进度（第 36 轮）** | **进行中（Docker、部署检测、保活完成；用户实测未做）** | **Docker**：仓库自带 `Dockerfile`（三阶段：构建客户端 → 只编译 `-p dr-dsh-relay` → debian-slim 非 root + `read_only` + HEALTHCHECK）与 `compose.yaml`；实测镜像建成、`/healthz` 正常、外壳与客户端资源 200。过程中修掉三个只有容器会暴露的问题：缺 `WORKDIR`、文件权限随 `COPY` 走导致 0600 的 manifest 在容器里 404（宿主机正常）、只编中继的镜像没有客户端。**部署检测**：中继在非回环绑定时警告（回环安静），daemon 认出"按固定节拍被掐断且从未承载会话"的 carrier 并打印一次点名 `proxy_read_timeout` 的警告；`scripts/deploy-probe.mjs` 用一个真的转发、空闲 21 秒断开的 TCP 代理实测（4 项断言，3 通过 + 1 项先失败于探针自身计数错误后修正）；过程中修掉 daemon 只在两条 carrier 结束路径上观察、漏掉代理超时真正走的那条。**并更正一处文档与代码不一致**：`Ping`/`Pong` 保活帧从未被任何一端发送。**剩余**：新用户实测（需要另一台干净机器/另一个人），托管化运营规则（配额、限流、投诉通道）。 第 36 轮做完了保活：两端各自每 30 秒发一个 **WebSocket 层**的 ping（不是协议里的 `Ping` 帧，理由见 `docs/protocol.md` § 3），`DSH_RELAY_KEEPALIVE_SECS` / `DSHD_KEEPALIVE_SECS` 可调、`0` 关闭；探针加到 **8/8**，在同一个空闲 12 秒断开的代理前分别只让一端 ping，两次都撑过 26 秒（0 次掐断），代理计数器上量到上游 30 字节 / 下游 10 字节——保活在日志里不留痕，字节是唯一的证据（§ 五点六五）。 |
| **M5 安全审计与稳定** | 第三方审计、崩溃监控、旧硬件兼容 | 审计无高危；崩溃上报可用；旧 CPU 有可用的替代安装路径 |
| **M5 进度（第 37 轮）** | **进行中（崩溃上报与旧 CPU 完成；审计范围已备、审计本身未做）** | **崩溃上报可用**：一跳、无服务器——客户端 → 自己那台 daemon → `$DSHD_STATE_DIR/crash-reports.jsonl`（0600），`drdshd crashes [--clear]` 读与删；daemon 自己重校验每条边界（条数/长度/序列化长度/控制字符）并具名拒绝，满 20 份后拒绝而不淘汰；实测 `scripts/pwa-crash-smoke.mjs` **9/9**、真实浏览器里 `browser-pairing-smoke.mjs` **13/13**（新加的三条：注入失败被计数、报告落到 daemon 且 `phase=ready`/`reached_ready=true`、文件 0600）。**这条浏览器断言抓到两个真实缺陷**：`control` 声明在连接处理函数内部，上报引用它时抛 `ReferenceError`（报告从未发出、页面无任何提示）；以及 session 先报 `ready` 再交出 tunnel，使上报被静默跳过。**旧 CPU**：`scripts/cpu-baseline-smoke.mjs` 用 qemu 模拟 2006 Core 2 / 2008 Nehalem / 2010 Westmere（三者都无 AVX）**13/13**，含 crypto 的 49 个测试与一致性向量，并让中继在模拟 CPU 上真的起服务；`drdshd doctor` 现在打印 CPU 与扩展的 present/absent。**审计**：范围与材料写进 [`../audit-scope.md`](../audit-scope.md)（含「声明 → 改坏就红的检查」表与自我怀疑清单），但**审计本身未进行**，因此「审计无高危」记为**未达成**。另修一处规格与实现不一致（wire 字段名一直是 `snake_case`，文档写成 `camelCase`），并加测试钉住每个 body 与每个 kind 的名字（§ 五点六六）。 |
| **M6 社区与扩展** | 多设备/多 daemon 管理、团队房间、去中心化推送 | 开放问题 § 16 中的相关条目有明确结论并落地 |
| **M6 进度（第 38 轮）** | **进行中（决策文档完成；房间密钥、审计日志、客户端多房间均已实现）** | **七条 ADR 落定**：多实例（一个 daemon 一个 DSH + 多个状态目录）、团队房间（明确不做，并写明只读角色在代理层无法诚实实现）、推送边界（Web Push 对推送服务不可读但对浏览器厂商可见，因此不称为端到端）、局域网直连（不做，出路是把中继放进局域网）、托管中继（不预埋数据收集）、审计日志（本机 `audit.jsonl`、滚动、永不上送）、房间密钥（首次运行生成并落盘 0600）。`mvp.md` § 六从"六个未决项"变成"七条已决定 + 五项仍未决定（每条写明为什么还没定）"。**实现已开始**：ADR-0013（房间密钥）第 38 轮落地——`run`/`pair` 默认读同一个 `$DSHD_STATE_DIR/room-key`（0600），不存在就生成，密钥从不打印，`--room-key` 只对本次运行生效且不写盘，与文件不一致时打印 NOTE；实测 `scripts/room-key-smoke.mjs` **12/12**（客户端用配对码拿到身份后，daemon 用文件里的密钥提供服务，客户端取回真实 DSH 界面 200 / 27923 字节）。审计日志（ADR-0012，同轮落地）：本机 `audit.jsonl`（0600），闭集事件（配对四类、撤销、隧道建立/释放、生命周期命令），30 天 / 10 000 行滚动、读取时同样按窗口过滤，`DSHD_AUDIT=0` 关闭且 `drdshd audit` 会区分「关闭」与「没有事件」，`drdshd doctor` 报告当前状态；实测 `scripts/audit-smoke.mjs` **16/16**，且日志里不含任何密钥材料。客户端多房间（ADR-0007，同轮落地）：一条设备身份 + 每房间一条记录（IndexedDB v2，v1 记录在升级时迁移并删除旧存储）、房间列表可切换与单独遗忘、再次配对**复用**同一身份（否则第一台机器会以「this device is not paired with that daemon any more」静默失联）；实测 `scripts/browser-rooms-smoke.mjs` **14/14**（含真实 v1 数据库的迁移、两台机器两行可分辨、切换后由**目标 daemon 的审计日志**证明连上的是它）。M6 的三项实现到此完成（0008/0010 按决策不做；0009 推送仍未实现且按 ADR-0006 默认关闭）。 |

## 五点五、当前进度（滚动更新）

| 里程碑 | 状态 | 已完成的部分 | 剩余 |
| :--- | :--- | :--- | :--- |
| **M0** | **完成** | **daemon 侧**：spawn `dsh web --no-open --port <p>`、解析就绪行、校验 loopback 绑定、令牌换 authority 绑定的 cookie、带 cookie 请求首页（实测 200 / 27923 字节）；`drdshd run`/`doctor`/`version` 可用；`crates/dr-dsh-daemon/tests/real_dsh.rs` 把 DSH 契约固定成可重跑的回归测试。**中继侧**：`/healthz`、静态壳、`/ws/daemon`、`/ws/client` 四个端点；房间注册与帧路由（daemon 扇出、客户端上行）；握手校验（角色必须与端点一致、房间 id 只在握手里、wire major 协商）；畸形帧拒绝而非转发；房间在 daemon 离开后停止宣告、两端都空才释放容量。实测：两个真实 WebSocket 对端经运行中的中继转发一帧，字节完全一致；daemon 离开后新客户端收到 `no daemon is serving this room`**加密隧道**：密钥派生（HKDF-SHA256，方向性密钥）、AES-256-GCM 封帧（计数器在明文头并进入 AAD）、客户端发起的盐交换、中继拨号与带退避的重连、拒绝即停、状态回调；端到端测试用**真实的**中继覆盖控制请求往返、错误密钥无法交换内容、拒绝即停、状态转换上报；并用一个按协议文档独立重写的 Node 客户端验证了跨语言密钥派生一致（派生出相同的 room id 与临时密钥）。**代理层**：远端请求经隧道到达 daemon，由 daemon 以它鉴权时的 loopback authority 执行（客户端的 `Host`/`Cookie`/`Origin` 被替换而非转发）、响应含大于单帧的 body 完整回传；拒绝携带绝对 URL 或穿越序列的目标并**把原因回告客户端**；端到端测试用真实中继 + 复刻 DSH 契约的假 harness 断言了 authority 改写、cookie 注入、body 往返；会话盐交换后增加了一个密封的**建立确认**，客户端因此不必猜何时可以发言。**会话建立竞态已修**：建立改为每连接一次、失败即丢弃 carrier（原先在同一连接上重试会在客户端握手中途重置计数器）；新增一个复现该场景的回归测试（并诚实注明它并非该修复的证明）。**三进程验收已通过**：真实 DSH + 真实中继 + 只持有房间密钥的客户端，一次代理 `GET /` 取回 DSH 自己的首页（27923 字节，含 `__DSH_BOOT__`），连续三次运行稳定（约 4.5 秒/次）；`crates/dr-dsh-daemon/tests/acceptance.rs` 以 `#[ignore]` 提交，并先自检端口未被占用——上一轮那次失败的真因是早先被强杀的 daemon 遗留的 `dsh web` 占着测试端口，使 supervisor 收养了它（attach 模式的正常行为，但在测试里会掩盖测试自身的结果）。**实时 feed 已通**：`/api/remote.mux` 的 WebSocket 升级在真实 DSH 上被接受（`DSH accepted the upgrade`），帧双向传输；代理解析一次握手后只搬运字节，不解析 DSH 在该 socket 上的协议。**PWA 隧道模块**：`apps/pwa/src/tunnel.ts` 实现客户端的房间派生、盐交换、封帧与流分发，只用 WebCrypto 与类型化数组，接口是可注入的 socket，因此**能在 Node 里测**（16 个测试）并能对着真实 daemon 跑：`scripts/pwa-tunnel-smoke.mjs` 已实测浏览器侧模块与 Rust daemon 完成握手（房间 id 与密钥一致）。过程中修掉一个真实缺陷：socket 的 close 注册原先在握手之后，握手期间断开会无人知晓。**会话交接的两处真实缺陷已修**：(a) 盐交换的计数器跨派生结转——发送方结转"已写"、接收方结转"已打开"，漏掉任一侧会让握手之后的每个请求以 `frame 0 arrived out of order; expected 1` 失败；crates/dr-dsh-crypto 的 `handover_tests` 直接固定该算术，`repeated_connections_each_get_a_working_session` 覆盖浏览器式的"连-说-断-重连"形状（6 个 carrier 测试全绿）。(b) daemon 原先按 stream id 而不是消息魔数区分控制面与代理面，导致浏览器客户端放在 stream 1 的代理请求被静默丢弃。**浏览器侧的代理客户端已模块化并测试**：`apps/pwa/src/proxy.ts` 负责请求编码与流式响应的状态机装配（head/body*/end，`failure` 也算结束），34 个 TS 测试覆盖编码、解码、越界、无 body、早到响应、订阅释放与完整往返；冒烟脚本也改为使用该模块，而不是手写一份格式。过程中修掉三个真实缺陷：(a) 响应在调用方 await 之前就完成时会被丢弃（真实运行因此卡住）；(b) 解码器读越界抛 `RangeError` 而非 `TunnelError`；(c) 握手期间断开无人知晓（上一轮）。**页面外壳与客户端分发**：中继 `/` 提供静态外壳（无用户数据、带 CSP），由 `DSH_RELAY_CLIENT_DIR` 指向构建产物时加载真实客户端，未安装时提供一页**说明如何构建**的页面（而不是 404——那会看起来像中继坏了）；`/client/<module>.js` 只提供扁平 `.js` 模块并拒绝 `..`、绝对路径、反斜杠与 `.ts`（实测 404）。新增 `pnpm --filter @dr.dsh/pwa build`（`tsc` 逐模块输出，import 重写为 `.js`），页面外壳 import 它并注册 service worker。PWA 侧新增 `session.ts`：连接 → 等工作线程接管本页 → 交付隧道的**顺序**被测试固定（先交付再等接管会让首次导航不被拦截）。**Service Worker 接线已完成**：worker 不再改写 URL 后自行 fetch（那会拦截自己并让页面挂死），而是由页面通过 `MessageChannel` 交付一个端口；被拦截的每个请求成为一条消息，页面用 `proxy.ts` 经隧道完成并回包。协议：`hand` / `request` / `response` / `failed`，`id` 用于并发配对（一次页面加载会同时取文档、样式与脚本）。`worker-service.ts` 用**真实的 `MessageChannel` 两端**测试（含并发不串包、失败回告、无隧道时明确报"尚未配对"、旧答复被丢弃而不抛、框架头不转发给浏览器）；`handoff.test.ts` 把 worker 与页面两端真正接起来跑通。共 58 个 PWA 测试。**浏览器侧的代理回程已在真实栈上跑通**：`scripts/pwa-tunnel-smoke.mjs` 连续 **12 次**运行全部成功（另有一次最终构建后的 8 次连跑同样全绿），每次都是「PWA 客户端 → 中继 → daemon → 真实 DSH」的一次完整代理 `GET /`：`tunnel established: true`、`response status: 200`、`response bytes: 27923`、`is the real DSH UI: yes (boot global present)`；这 12 次期间 daemon 日志中 `session error`/`out of order` 为 **0** 条，中继 `refused a connection` 为 **0** 条，500ms 退避为 **0** 条。为此修掉三个真实缺陷，每个都先在真实栈上复现、再落到回归测试：**(1) 会话确认缺失** —— daemon 在派生会话后会读一帧作为客户端确认，而客户端从不发这一帧，于是客户端的**第一个代理请求被当作确认吃掉**，随后永远等不到答复（表现为冒烟脚本挂死）。客户端现在在派生后先发这一帧再等 daemon 的确认；假 daemon（`tunnel.test.ts`）同步改成会读这一帧，原先它接受一个真实 daemon 会拒绝的客户端，正是这个盲点让缺陷一直不可见。**(2) 帧处理并发导致乱序** —— `absorb()` 对每帧独立启动异步解密，后到的 body 可能先完成，于是 `responseBody` 抢在 `responseStart` 之前到达，代理层（正确地）拒绝它。客户端现在把开帧串成一条链，严格按到达顺序处理；根因是「开帧是异步的，而每一帧消费的下一个计数器是确定的」，所以这一侧本来就有能力知道自己错了。**(3) 跨客户端的会话串线** —— 最后一个客户端离开后，中继仍把 daemon 留在房间路由表里，而一条 carrier 只承载一个客户端会话，于是下一个客户端的盐（counter 0）落进上一个会话（daemon 已到 counter 3），daemon 报 `frame 0 arrived out of order; expected 3`，客户端看到的是**自己握手中的帧认证失败**。中继现在在最后一个客户端离开时先用 `SESSION_OVER` 具名关闭该 carrier、再摘除路由，daemon 收到具名原因后 **20ms** 内重注册（原先走 500ms 退避，重注册窗口内到达的客户端会被 `no daemon is serving this room` 拒绝）；重注册是**有界**快路径（连续 8 次后回落到常规退避），否则一个「接受即关闭」的中继会把 daemon 变成忙等。**(4) 具名释放的载荷形状不匹配（本轮最后发现，也最值得记）** —— daemon 侧原先直接拿收到的文本与 `SESSION_OVER` 常量比较，但中继实际写出的是握手用的同一个 JSON 信封（`{"type":"close","reason":"session over"}`），裸字符串永远不会相等。于是「具名释放」这个特性**看起来实现了、实际一次都没生效**：每次会话结束都走 500ms 退避，重注册窗口内的客户端被 `no daemon is serving this room` 拒绝——实测 10 次里失败 8 次。更值得记的是**测试为什么没拦住**：daemon 侧的单测喂的是裸字符串 `SESSION_OVER`，也就是「我们以为中继会发的东西」，而不是中继真正发的东西，所以它在功能完全失效时依然全绿。修法有两部分：分类改为**解析信封**（并额外断言「仅包含该短语的原因」不算数，避免退化成子串匹配），单测的用例改为**中继真实写出的信封**，并**显式断言裸字符串不算释放**——最后这条正是原先掩盖问题的那个假设，现在它成了一个会失败的用例。修好后同样的 12 次连跑全部通过，退避日志 0 条、拒绝 0 条。**两个测试自身的缺陷也已修**：`session.test.ts` 的替身 daemon 与 `supervise.rs` 的 wrapper 文件——前者像客户端一样在 `await` 前读了 `openKey`，在高负载下会用临时密钥解确认帧而抛 `OperationError`；后者两个测试共用同一个 wrapper 路径，一个测试执行它时另一个正在截断它（`ExecutableFileBusy`）。两者都只在整套 `pnpm run verify` 的负载下才偶发，单独跑永远绿——这类缺陷只能靠整套跑多次才暴露。本轮 `pnpm run verify` 连续 3 次全绿：**Rust 124 个测试 + TS 104 个测试**（PWA 59、protocol 34、crypto 3、plugin 8），另有 5 个需真实 DSH 的 `#[ignore]` 验收测试。| 尚未在真实浏览器里打开过界面（环境无浏览器；客户端逻辑与接线已由 Node 侧测试与真实栈冒烟覆盖）；一条 carrier 仍只服务一个客户端——这是 M0 的既定形态，daemon 的模块文档已写死该契约，多客户端需要每客户端独立流（M2）；中继的 `SESSION_OVER` 与 daemon 对它的识别是两端共享的字符串，本轮已把它移入 `dr-dsh-proto` 并各加一个测试固定（中继侧断言被释放的 carrier 收到的是具名关闭且原因等于该常量，daemon 侧断言只有该常量被当作"释放"、其它原因与断连一律走退避）；这两个测试都验证过"改坏一侧就会失败" |
| **M1** | **进行中（配对核心完成，会话绑定与浏览器待做）** | **配对核心已落地（daemon 侧规范实现）**：`crates/dr-dsh-crypto` 新增 `pairing` 与 `device`、`registry` 三个模块。流程是 `drdshd pair` 生成 40 位熵的码（Crockford 风格 base32，去掉 `I/L/O/U`，`XXXX-XXXX-XXXX` 形式，300 秒 TTL），两端在**由码派生的会合房间**上跑 SPAKE2（`spake2` 的 Ed25519 群），客户端用新生成的 Ed25519 身份证明持有权，daemon 存公钥并回执。**码单次使用**：`PendingCode::consume` 在 SPAKE2 之前就把码烧掉，成功失败都一样——这是「40 位熵够不够」这个问题的真正答案，因为一次尝试消耗一个码，重试无法摊薄 2⁴⁰。**设备登记表**（`DeviceRegistry`）是唯一的授权模型：空表谁也不授权，没有「第一个设备赢」也没有本地套接字例外；只存公钥与标签，因此一份被拿走的登记表是麻烦而不是冒充工具；文件损坏时**失败关闭**（报错而不是退化成空表）。**配对交换本身走 carrier 帧**（临时会话密封），因为中继会拒绝在数据面上发文本的对端——这一条是被真实中继拒绝后才发现的，见 `docs/protocol.md` § 6.2.3。**实测**：`crates/dr-dsh-daemon/tests/pairing.rs` 在真实 `dr_dsh_relay::ingress` 上跑通「一个码登记一个设备且两端一致（房间 id 相同）」「错误码不登记任何设备」「同一个码不能登记第二个设备」「显示码经人眼往返解析（含大小写、空格、`O`→`0` 折叠）」「会合房间由码派生且与服务房间不同」，7 个测试全绿。**一个真实缺陷**：`DaemonPairing::finish` 最初只验证「客户端用所登记公钥自签的签名」，而签名只证明持有身份、不证明知道码——于是**用错误码的设备照样被登记**。现在确认值是**PAKE 密钥下的 HMAC**（`enrolment_confirmation`），常量时间比较；固定该性质的测试扮演「持有身份但没有码」的攻击者并出示一个**完全有效的自签名**，只有 MAC 检查能拒绝它，并且验证过「把实现改回签名校验，这个测试会红」。 | **会话层已绑定设备身份（本轮）**：登记表原先只是记录，现在它是授权边界。握手在盐交换之后、`established` 置位之前多出一步设备认证：daemon 用 `DevicePolicy` 决定是否要求证明，要求时发一个**每次连接新生成的 nonce**（在会话内密封，中继既读不到也换不掉），客户端用设备私钥对 `nonce || room` 签名（Ed25519，绑定房间以防一次响应被挪到另一个房间重放），daemon 用登记表里的公钥验签，失败则**具名拒绝并关闭 carrier**。**实测**：登记了 1 个设备后，真实栈上的 room-key 客户端被拒绝，错误是 `the daemon requires a paired device and this client is not paired`（不是挂起、不是超时）；未登记任何设备时，room-key 回退路径仍然 4/4 通过（27923 字节、`__DSH_BOOT__` 存在），daemon 启动时会明确打印当前策略（`devices: none enrolled — …` 或 `devices: N enrolled — …`）。**本轮又修掉两个真实缺陷**：(a) 客户端的设备认证步骤最初只在"持有身份"时才等待，于是**未配对的客户端拿到一个自称已建立、却永远不会被放行的隧道**（实测为挂起）；现在这一步对每个连接都执行，由 daemon 是否开口（以及短暂静默期）来结算。(b) 客户端在握手期间收到拒绝时，`Tunnel.open` 仍然 **resolve**；现在未绑定即视为失败，并且 socket 关闭也会结算这一步——否则客户端会等一个永远不会来的帧。**配对速率限制与审计已落地（本轮）**：`PairingGuard`（`crates/dr-dsh-crypto/src/throttle.rs`）在**生成配对码之前**检查「两次尝试间隔 ≥2 秒、连续 5 次失败锁定 300 秒」，状态写在 `$DSHD_STATE_DIR/pairing-throttle.json`（`drdshd pair` 是一次性进程，进程内计数器每次调用都归零——而这正是攻击者制造的模式）。审计事件 `pairing_refused` / `pairing_failed` / `pairing_locked_out` / `pairing_accepted` 以一行一条写 stderr，原因文本控制字符替换并截断（一条能被换行拆开的记录就不再是一条记录）。**实测**：真实中继上连续 4 次无人认领的尝试被允许，第 5 次触发锁定，第 6 次**在打印配对码之前**被拒绝（输出中没有 `code:` 行），锁定截止时间落盘并在进程退出后仍生效。**边界已写进 `docs/security.md` § 3.1**：这不是防猜测的主要手段（单次使用 + 40 位熵才是），锁定会在应用时清零计数以免被永久锁死（代价是按节拍攻击者每 5 分钟得 5 次而非 0 次），且限流按 daemon 全局计数而非按来源——daemon 只看到中继的一条连接，因此攻击者能让合法用户在 300 秒内配不上对，这是一个真实的可用性缺口而非疏忽。**撤销最后一个设备曾把门重新打开（本轮发现并修复）**：daemon 原先用「登记表里有几个设备」来决定策略——空表就回退到房间密钥。而「空表」恰恰是**撤销掉最后一个设备**之后的状态，于是 `drdshd devices --revoke <最后一个>` 会**重新打开用户正要关上的那扇门**，同时命令还打印「该设备再也连不上了」。现在策略由**登记表文件是否存在**决定：文件在（哪怕是空的）就要求每个客户端证明身份，文件从未创建才算「从未配对」。**实测**：撤销后重启 daemon，策略行不再是「任何持房间密钥的客户端都可以连接」，room-key 客户端被拒绝并得到 `the daemon requires a paired device and this client is not paired`（退出码 1）；日志同时把这种情况说明白（`devices: none enrolled, and this daemon has been paired before — so nobody may connect`）。回归测试固定在 `crates/dr-dsh-crypto/src/registry.rs` 里，测的是 daemon 依赖的那条性质，这样将来任何「把两种状态合并起来」的优化都会在这里失败。**配对现在有一个真正的对端（本轮）**：新增 `drdshd pair-as-device`——`drdshd pair` 跑 daemon 那一半，这条命令跑**设备**那一半，两者之间完成一次真实的配对。在此之前，配对流程只有「一个进程的两半互相对话」，证明的只是实现与自身一致；浏览器跑不了 SPAKE2（`dr_dsh_crypto::pairing` 模块文档写明了原因），所以流程一直没有客户端。现在身份被写到 `device.json`（**0600**，只含 seed、device id、房间根密钥与房间 id），`--out` 可指定位置，默认在状态目录下——把私钥写到「shell 恰好所在的目录」是一个会进备份、进 git、进共享文件夹的密钥。**实测（真实中继）**：`drdshd pair` 显示 `21N7-10D3-Z0`，`drdshd pair-as-device` 在 **0.2 秒**内完成，daemon 打印 `paired QYzGNsJvmnAyA--Ea0infA as "first"`，`drdshd devices` 列出它，写入文件权限为 `-rw-------`。**本轮修掉一个真实的设计缺陷**：配对房间的帧原先用**由配对码派生**的密钥密封，于是两端持有不同配对码时**根本打不开对方的帧**——一个打错的码会在 `establish` 里失败，而那里没有任何办法说明原因，客户端一直等到超时。**最可能的用户错误因此表现为「挂住」而不是一句话。** 现在传输密钥是一个常量（它本来就保护不了什么：房间 id 由码单向派生且中继可见，认证来自 SPAKE2），认证与传输因此分开。**实测**：错误码现在**立即**得到 `the daemon refused the pairing: pairing_failed`（退出码 1），不写任何身份文件，登记表保持为空。`drdshd pair` 还会打印会合房间（`room:`），配对端用 `--rendezvous` 指过去——这样打错码的错误是「码不对」而不是「那里没人」，对站在两台机器之间的人来说这是两句完全不同的话。**M1 剩余**：(a) ~~**浏览器无法配对**~~ —— **已解决（第 27 轮）**：同一个 SPAKE2 协议在 TypeScript 里重写了群运算，由 Rust 生成的向量逐字节固定，并在真实中继 + 真实 `drdshd pair` 上完成了完整配对（§ 五点五七）。(b) ~~**客户端的设备身份没有持久化**~~ —— **部分解决（第 27 轮）**：`apps/pwa/src/identity.ts` 已能生成、导出（PKCS#8）、从记录恢复并自检设备身份，配对后得到的房间密钥与房间都在记录里；**尚未完成的是浏览器的存储与配对 UI**（没有 IndexedDB 落盘、没有输入配对码的表单），因此"刷新页面仍然是同一台设备"这条路径还没有在浏览器里验证过。(c) **审计事件只覆盖配对**：速率限制与配对审计已落地（见下），但「隧道建立与断开」「设备撤销」还没有落到同一种格式上，目前走 `tracing`；保留策略仍是未决事项。(d) M1 结束要求的威胁模型定稿尚未走查。 |
| **M2** | **完成（第 31 轮；八条验收标准全绿，实现评审见 `docs/security.md` § 5.9）** | **生命周期与自愈已落地（本轮）**：`crates/dr-dsh-daemon/src/lifecycle.rs` 的 `Controller` 持有状态机与策略，进程仍归 `dsh::supervisor`，两者用 `Spawner`/`Running` trait 分开——这个分法是为了让「杀掉 DSH 它会不会回来」这类**跨时间的决策**能在不启真实进程的情况下被测。策略：崩溃后指数退避（500ms 起、上限 30s）、连续 5 次后**停止重试并报告**（无限重启会把「端口被占用」这类配置错误变成一个永不停止的 spawn 循环，填满进程表和日志却从不说明原因）；**操作者主动 stop 的退出不触发自愈**（否则 `stop` 根本没法用）。**实测（真实进程、真实信号）**：`crates/dr-dsh-daemon/tests/lifecycle.rs` 用 `kill -9` 杀真实子进程，观察退出被识别、状态进入 `Recovering`、退避后启动**新的** pid；另有测试断言主动 stop 之后不会被重新拉起、端口被占用时会**放弃并报错**而不是循环、attach 模式下**进程确实还活着**（不只是错误码对）。**真实栈实测（验收标准 4）**：`kill -9` 掉真实 DSH 后，daemon 约 5 秒内拉起新进程，随后冒烟脚本仍然 4/4 通过（27923 字节、`__DSH_BOOT__` 存在）。**远端在自愈期间看到的是什么**（验收标准 4 的后半句）：通过隧道读状态，恢复中为 `state:"starting"`、`pid:null`，恢复后为 `state:"running"` 且 pid 是新进程的——不是无响应，也不是谎报 running。**本轮修掉两个真实缺陷**：(a) **驱动的 watch 分支从未生效** —— `adopt()` 没有把「DSH 应该是运行着的」写进状态，于是第一次崩溃被当成「操作者要求的停止」，daemon 静静地不再拉起它（自愈从不生效，且日志里没有任何线索）。这是杀掉真实 DSH、看着一个毫无反应的 daemon 才发现的；现在有专门的回归测试，并且验证过「去掉修复该测试会红」。(b) **状态答复是陈旧的** —— `DaemonFacts` 在启动时把 pid 与生命周期状态**拷贝**了一份，于是每个状态答复都永远重复第一份快照：远端在恢复期间读到的是 `running` 加上那个**刚刚死掉**的进程的 pid，而这正是这个字段存在的唯一理由。现在这些值在共享句柄后面，每次答复都读当前值。**三平台安装说明已写（本轮）**：新增 `docs/operations/install.md`，覆盖 Linux（systemd **用户级**单元 + `enable-linger`）、macOS（LaunchAgent，含「`launchctl load` 不会重读已改动的 plist」这个最常见的坑）、Windows（计划任务或 NSSM，并明确写出「无法优雅停止 DSH」这一差异）。密钥通过 0600 的文件或用户环境变量传递，而不是写在单元文件里——单元文件会被 `systemctl cat` 打印、也会进日志。附着模式的说明从 `self-hosting.md` 移到这份文档（它讲的从来不是中继），并在 `docs/README.md` 建立索引。**实测**：`pnpm run docs:check` 通过（21 个 Markdown、202 条相对链接）。**「偶发失败」的结论已更正（本轮）**：我在前几轮反复记录过一个约每 9–10 次出现一次的失败（隧道报告已建立但代理请求无应答、daemon 侧无对应错误），并一直把它当作产品的已知缺陷。在**受控环境**下重测——清掉所有残留进程、确保同一房间密钥只有**一个** daemon——连续 **30 次全部通过**，daemon 日志零错误。真实成因是**我自己的测试环境**：多轮调试留下了多个共享同一房间密钥的 daemon，中继在它们之间反复转移房间，客户端偶尔接到一个正被接替的连接上。这不是产品缺陷，而是一个**操作陷阱**（两个 daemon 配同一个房间密钥会互相顶替），其代价与边界已在上一轮量化并写进 `crates/dr-dsh-daemon/src/uplink.rs` 的注释。同一轮里还实测了 M1 的拒绝对端：登记 1 个设备后，未配对的 room-key 客户端被拒绝并得到`the daemon requires a paired device and this client is not paired`（退出码 1，不是挂起）。**attach 模式已可用（本轮）**：`drdshd run --attach <port> [--attach-token <token>]`。**凭据模型**：attach 下 daemon 不在场，拿不到 DSH 的进程令牌，而 DSH 只会把界面发给持有「用它自己保管的密钥签名过的 cookie」的浏览器——读那个密钥意味着直接访问 DSH 的凭据存储，是 ADR-0003 明确禁止的耦合。因此凭据由**操作者提供**：DSH 启动时会打印 `?token=…`，把它连同 `--attach-token` 交给 daemon，daemon 执行与托管模式**完全相同**的换取流程。不提供 token 时 daemon 明确说明「状态与生命周期可用，但界面不可达」而不是假装可用。**实测（真实手工启动的 DSH + 真实中继）**：`--attach 46300 --attach-token <token>` 启动后 `index reachable: 27923 bytes (authentication and authority binding verified)`；PWA 客户端经隧道取回真实界面 **3/3**（`__DSH_BOOT__` 存在）；控制面冒烟 **12/12 断言**通过，其中三条是 stop/restart/start 各自被**具名拒绝**（`DSH on port 46300 was started outside this daemon, so the daemon will not stop or restart it. Interface access works normally; stop it yourself if you want it stopped.`）。**本轮修掉三个真实缺陷**：(1) **`owned` 在 attach 模式下谎报为 true** —— 而这正是客户端用来决定「生命周期按钮是否有意义」的字段，于是 daemon 一边说「我拥有它」一边拒绝每一个操作。现在它由 mode 推导；是控制面冒烟对着 attach 实例跑出来的。(2) **代理从错误的地方取令牌**：托管模式下去读 `--attach-token`，于是在一个完全正常的托管 daemon 上 panic（`unreachable!`）。现在两种模式共用一个凭据变量。(3) **端口被占用时的报错毫无帮助**：DSH 启动、绑定失败、退出，daemon 只报「exited before announcing readiness」，真正的原因埋在 DSH 的 debug 输出里。典型成因是**上一次运行遗留的 DSH**——它的 daemon 被杀掉后它还活着，永久占着端口。现在启动前先检查端口，报错直接点名这个成因并给出两条出路（停掉那个进程，或用 `--attach`）。**另修正一个我自己的错误结论**：我曾从一次测量得出「多 daemon 争用同一房间会把中继打到每分钟数千次重注册」，后来发现那次测量里两个测试 daemon **根本没启动**（端口被占用），数字描述的是另一个进程。重测后的结论小得多：两个 daemon 共用一个房间密钥时，把「重连计数在拨号成功时清零」改为「只在会话真正建立后清零」，churn 从 **284 次/分钟降到 175 次/分钟**，并且退避仍会到 30s 上限。代码注释已按实测数据改写——原先那句「数千次」是没有依据的。两个 daemon 共用一个房间密钥仍是配置错误，代价约为每秒 3 次请求；要让其中一个停下，需要一个能把它与「合法重连」区分开的信号，而从 daemon 的角度这两者完全一样。**面板已接线（本轮）**：`apps/pwa/src/panel.ts` 把控制面画成状态行 + 三个按钮，其中所有**判断**都在纯函数 `panelView(state)` 里——哪个按钮可用、显示哪句话、tone 是什么，因为「按钮在不可能成功时仍可点」和「把状态说成别的样子」正是最容易活下来的缺陷，而它们只能靠浏览器测才看得见。文案区分三种失败（项目定义 § 9.7）：**中继不可达**（daemon 自己报告的 `relay`）、**连不上你的电脑**（控制请求不再被答复）、**设备未配对**（握手的 `resume_reject`）——三者各有各的说法，并有测试断言三种说法**互不相同**。隧道断开时会**丢弃上一次状态**而不是继续显示「DSH is running」，因为陈旧的成功报告正是这个面板存在要避免的谎。页面外壳（`crates/dr-dsh-relay/src/assets.rs`）现在渲染这个面板：状态行、按钮、按钮旁的禁用原因（灰色按钮不给原因会被读成 bug），以及「Open the DSH interface」——接口**按需**打开而不是连上就跳转，因为一跳转就把持有隧道的页面卸载了，面板也就永远看不到了。**实测（无浏览器环境下的能做到的部分）**：中继指向构建产物时返回外壳、外壳 import 的三个模块（`session.js` / `panel.js` / `control.js`）**全部 200**，M0 代理 3/3、控制面冒烟 10/10 断言仍全绿。**本轮修掉一个真实安全问题**：中继的模块过滤器只检查扩展名与路径穿越，因此**会照常提供 `*.test.js`**——而客户端的测试模块里**写死了房间密钥与设备密钥**（我核对了 `dist/control.test.js` 里的固定密钥），同时 `dist/` 是累积目录：`tsconfig.build.json` 现在排除测试，但**早先构建留下的产物仍然在那里、仍然可被请求**。两处都修了：中继**按名字拒绝**测试模块（`*.test.js`、`*_test.js`，并加进拒绝用例），构建脚本**先清空 `dist`** 再编译（残留文件本身就是泄露路径）；实测 `/client/control.test.js` 现在返回 **404**。另加两个外壳契约测试：外壳 import 的模块名必须是中继愿意提供的名字，且面板写入的 DOM id 必须与标记里声明的一致——两处不匹配在浏览器里都只是一个空白框，没有任何报错。**控制面已接上并真正执行（本轮）**：`lifecycle_command`（start/stop/restart）经控制流到达驱动，答复是**驱动执行完之后**的真实状态。PWA 侧新增 `apps/pwa/src/control.ts`：`ControlClient.status()` / `.command(op)`，把状态答复解析成可渲染的形状（并区分 `accepted:false` 的**拒绝**与 `accepted:true, ok:false` 的**失败**——前者重试永远不会成功，后者才是「再试一次」），并提供 `describe()` 把六种生命周期状态与四种中继状态各写成一句不同的话（失败透明的文案基础，标准 6）。**实测（真实中继 + 真实 daemon）**：`scripts/pwa-control-smoke.mjs` 用 PWA 的控制面客户端对真实 daemon 完成「读状态 → stop → 再读状态确认已停 → start → 确认已运行」，11 项断言全过；stop 之后 `state` 为 `stopped`、`pid` 为 `null`，与「daemon 只是口头答应」有明确区别。**本轮修掉一个真实缺陷**：控制面最初**只回执、不执行**——它对 `start/stop/restart` 一律答复 `accepted: true` 并把当前状态原样回显，而操作从未交给驱动。远端因此被告知「已接受停止」而 DSH 仍在运行。是把这个冒烟脚本对着真实 daemon 跑、发现状态从未改变才暴露的；现在被接受的操作由驱动在 spawned 任务里执行并回答，拒绝则仍然即时内联返回。对应的 Rust 测试用**真实驱动**断言答复来自执行之后（只有 outbox 里能收到），而不是回显。 | **验收标准 6（失败透明）已在真实栈上逐条验证（本轮）**：三种故障在远端得到**三句不同的话**，而且客户端确实能分辨它们——它看到的证据不同：daemon 自报的 `relay` 状态、**自己的** socket 是否关闭、socket 打开但不再应答、以及握手阶段的具名拒绝。实测（真实中继 + 真实 daemon + 真实 DSH）：**断开中继** → `The connection to the relay dropped`（并提示「你的电脑可能仍在运行 DSH，这是本浏览器到中继之间的链路——先检查你自己的网络」）；**杀死 daemon**（中继与 DSH 仍在） → `Your computer is not answering`（提示可能是机器休眠或 daemon 停了）；**设备被撤销/未配对** → `the daemon requires a paired device and this client is not paired`。**本轮修掉一个真实缺陷**：面板最初把「中继断了」与「daemon 不应答」**合并成同一句话**——而 § 9.7 要求的正是把它们分开。两根因的证据不同（socket 关闭 vs socket 打开但静默），修法是把「carrier 关闭」作为独立事实告诉面板（`tunnel.onClosed` → `panel.socketDropped`），而不是让它从「请求超时」去猜。**另一个真实缺陷（可用性）**：状态请求与生命周期命令原先共用 30 秒超时，于是**用户盯着面板三十秒**才被告知 daemon 已经没了——这与「卡住」无法区分。现在状态请求 5 秒（它由 daemon 已持有的状态内联回答，不可能合理地耗时数秒），生命周期命令保留 30 秒（它确实是进程操作）。实测：杀死 daemon 后 **5 秒**报告，此前是 30 秒。**M2 剩余（第 31 轮更新）**：(a) ~~面板尚未在真实浏览器里打开过~~、~~MVP 验收标准未全绿~~、~~M2 结束的实现评审~~ —— 三条都已关闭：八条标准在真实浏览器/真实栈上逐条跑通（§ 五点六、§ 五点六十），实现评审已做完并写进 `docs/security.md` § 5.9（走查中发现并修掉一个真实缺陷：就绪行里的一次性令牌曾能被 `Debug` 与解析错误打印）。(b) **Windows 上的优雅停止**：daemon 无法向 DSH 发送 SIGTERM 的对应物，DSH 会被直接终止，插件树不走销毁流程——行为差异已写进安装说明；解决它需要平台特定的实现，本行把它记为收尾项而非阻塞项。(c) 中继的托管化运营规则（配额、限流、投诉通道）属 M4；已配对设备可无限次重启 DSH 这一条作为已知剩余风险写在 § 5.9。|

进度行必须与代码同步更新：`pnpm run verify` 全绿是"已完成"的前提，实测过的结论要写进对应文档（例如 DSH 契约的实测记录在 [`../integration/dsh-surface.md`](../integration/dsh-surface.md)）。

## 五点五五、在真实浏览器里跑：五个只有浏览器能看见的缺陷（第 21 轮）

这一轮装上了 headless Chromium（Playwright）并把**真实的客户端**放进**真实的浏览器**里跑。
结果值得单独记一段，因为它推翻了前几轮的一个隐含假设：**「协议层通过」不等于「浏览器里能用」**。
第一次运行，页面在浏览器里**什么都不做**，而在此之前所有测试都是绿的。

七个缺陷，每一个都只有在浏览器里才看得见：

1. **外壳的内联脚本被中继自己的 CSP 拦掉了。** 中继用 `default-src 'none'` 提供外壳（这对一个处理密钥的页面是正确的策略），
   而它同时**禁止内联脚本**——于是页面加载、表单可见、点「Connect」毫无反应，控制台里只有一条 CSP 违规。
   **从 M0 起，客户端在浏览器里从未真正运行过。** 修法是把外壳的代码移成一个由中继提供的模块（`/client/shell.js`），
   并只放开页面真正需要的东西：`script-src 'self'`、`connect-src 'self'`。策略仍然严格，只是不再自相矛盾。
2. **Service Worker 无法取得根作用域。** 它位于 `/client/`，默认作用域就是 `/client/`，于是注册被拒绝、什么都拦截不到。
   修法是中继为该文件返回 `Service-Worker-Allowed: /`。
3. **同一个 Worker 被注册成经典脚本，却使用 ES 导入**，于是求值失败（`ServiceWorker script evaluation failed`）。
   修法是按模块注册。
4. **外壳导航到了 Worker 自己的命名空间**（`/__dr/dsh/`）——而 Worker 不拦截该前缀，于是中继回 404、页面全白。
   更根本的是：**Service Worker 不拦截对「它自己那个页面」的导航**，而外壳就在 `/`，所以「打开界面」曾经无处可去。
   修法是给界面一个自己的路径 `/__dr/interface`，由页面请求它、Worker 把它翻译成 DSH 的 `/`。
5. **Worker 把页面路径原样转发给 DSH**，于是 DSH 收到 `/__dr/interface` 并回 404。路由规则（`toTunnelRequest`）
   写了却**从未被调用**。修法是补上 `toDshPath`：客户端命名空间与 DSH 命名空间之间唯一的翻译点。

另外两处只有浏览器能暴露的：`/assets/` 被当作「客户端的静态资源」放行——**而 DSH 自己的界面包就在 `/assets/` 下**，
于是界面加载了 HTML、随后向中继要自己的 JavaScript、拿到 404；以及 `tunnel.ts` 的帧链用了两次赋值
（`chain = chain.then(...)` 然后 `chain = chain.catch(...)`），同一轮到达的两帧会互相覆盖处理器，
丢掉的那条以 unhandled rejection 的形式出现。

**当前状态**：界面 HTML 与它的资源现在**确实经由隧道抵达浏览器**（`/assets/index-*.js` 等请求都走隧道，
不再 404），面板在浏览器里正常工作。但 DSH 自己的模块加载器停在 `window.__ModuleLoader__.mode === "queue"`，
界面尚未真正渲染出来。**这是本轮结束时仍未解决的问题**，下一次从它开始：需要查清加载器在等什么事件
（以及 Service Worker 是否能介入 DSH 的 WebSocket 升级——`fetch` 处理器通常拿不到升级请求）。
**第 22 轮续查的结果与当前卡点**

又修掉两个只有浏览器会暴露的问题：

- **外壳的 CSP 不允许客户端自己的请求。** 隧道的模块请求是 QueryPort 形式的单 URL（`/plugins/??a,b`），
  而**路径里的 `??` 让该 URL 在 CSP 看来不是同源**，于是 `connect-src 'self'` 拒绝它、载体 socket 根本打不开，
  界面停在那里没有任何指向原因的报错。CSP 现在显式列出这个页面真正会连的源。
- **接口的相对 URL 会在嵌套路径下解析错。** DSH 的 HTML 用 `./assets/index-*.js`，它相对**文档 URL** 解析；
  文档在 `/__dr/interface`，于是 `./assets/x` 变成 `/__dr/assets/x`，DSH 从没见过这个请求。
  `toDshPath` 现在把「从接口解析到隧道前缀下」的路径还原成它本来的意思。

**当前卡点（精确定位）**：浏览器**请求了** `/plugins/??…`（Playwright 的 request 事件看得到），
但**既没有 response 事件也没有 requestfailed**，`window.__ModuleLoader__.pendingQueue` 为 `0`、
`mode` 停在 `"queue"`、`__DSH_BOOT__` 未定义。而同一个 URL **经隧道直接取回是 200、20809 字节、
内容以 `window.__ModuleLoader__.load({...})` 开头**。也就是说：数据通路是好的，脚本在浏览器里没有被执行。

下一次的具体起点：给 Service Worker 的 `fetch` 处理器加一条日志，看它是否真的收到了 `/plugins/??…`——
这能立刻把「Worker 没收到」与「Worker 收到了但响应没被执行」分开，而这两种情况下一步查的东西完全不同。
**第 26 轮：查清了为什么任务发不出去——一个 400，而且它不在我们的链路上**

上一轮停在「DSH 要求先选 workspace」。这一轮去把这个前置条件补上，过程中定位到一个更根本的现象：

**所有 RPC 调用的信封在 DSH 那里都被拒为 `HTTP 400` 且响应体为空**，包括：
- 我们的代理客户端发的（`POST /api/workspace/create`、`/api/session/modelCatalog`，带与浏览器相同的
  `{"type":"client-request","rpcId":…,"method":…,"payload":{"args":…}}` 信封）；
- **在界面页面内部**用 `fetch` 发的同一条调用；
- **界面自己**在「Add workspace…」里发的 `/api/directoryPicker/list`——它自己的 UI 明确显示
  `client api: directoryPicker/list failed: transport failure … HTTP 400`。

也就是说，**这不是隧道的问题，也不是我的客户端的问题**：界面在没有任何远程访问参与的情况下，
调用自己的 RPC 就已经拿到 400。而初始化时那些调用（`session/modelCatalog`、`agentPresets/list`、
`dynamicCordisRunner/inventory` 等）在抓包里同样是 400——界面之所以还能渲染，是因为它对失败的调用做了降级，
首页不需要它们也能画出来。

**因此第 2 条的剩余部分卡在一个与本项目无关的前置条件上**：这台环境里的 DSH 的 RPC 面不接受调用
（很可能是 profile 或凭据未配置完整），而任务的发起路径正是走 RPC。要继续需要在那台 DSH 上把它修好，
那是 DSH 侧的配置问题，不是 dr.dsh 的缺陷。

> **第 29 轮更正：这个结论是错的，而且错得很典型。** 那个 `400` 是我们的：daemon 把客户端的
> `content-length` 原样转发，然后又按自己实际发送的 body **追加了一个**，于是一个 POST 带着两个
> `Content-Length` 出去，Node 的 HTTP 解析器在任何应用代码之前就以空体 `400` 拒绝。上一条里那句
> 「界面在没有远程访问参与时也会 400」当时并没有被真正验证过——那次"在界面页面内部"发的调用，
> 走的仍然是隧道。决定性的一步是**绕过本项目**直接对 DSH 发同一个请求：单个 `Content-Length` → 200，
> 两个 → 400。详见 § 五点五九。

**这一轮的另一半产出**：把这几种可能性分开确认了，而不是笼统地记成「界面用不了」——
代理链路（代理客户端的 POST 确实到达了 DSH，daemon 日志有 `PROXY request … POST /api/workspace/create`）、
信封形状（与浏览器发出的逐字段一致）、以及**界面自身的 RPC 也不通**（决定性的一条）。

**第 25 轮：试图在界面里真的跑一次任务，卡在 DSH 自己的前置条件上**

下一步按计划是「在界面里驱动 DSH 完成一次真实任务」。新增 `scripts/browser-task-smoke.mjs`：
打开界面、确认实时 socket 打开、新建会话、点开输入框、键入提示词、回车、等待回答。
它现在**走到了第三步就停下**，而停下的是一个**产品事实而不是缺陷**：

**新建的会话要求先选一个 workspace**，界面显示 `Choose a workspace to start` 并等待。
这台机器上的 DSH 从未被指定过 workspace，所以**这台机器上无法发送任何消息**——远程访问没有坏，
是这个 DSH 还没有工作目录。脚本把这种情况报成 **skip 并退出 2**，而不是通过或失败：
「远程访问不通」与「这台 DSH 没有 workspace」需要两套完全不同的排查动作。

**为什么没有自动创建 workspace**：那要在**用户的 DSH profile** 里登记一个目录。这是对用户环境的
持久改动，不该由一个冒烟脚本顺手做掉；而且用哪个目录也不该由测试决定。脚本因此留了口子
（用一次界面选好 workspace 即可，或按提示设置环境变量），并把「turn skipped」写在结论里。

这一轮同时确认了另外两件事：**界面的输入框是 `contenteditable` 而不是 textarea**（探针查出来的），
以及**必须用 `type()` 逐字输入而不能直接赋值**——编辑器靠输入事件跟踪状态，直接改文本会让它以为输入框是空的，
回车因此什么也不做且不报错。

**第 24 轮：WebSocket 也被隧道承载了，第 2 条闭环**

上一轮留下的最后一项是 DSH 的 `/api/remote.mux`：界面渲染出来了，但那个 socket 直接打到中继、失败，右下角显示
`Reconnecting…`。根因是一个 Service Worker **无法拦截 WebSocket 升级**——`fetch` 处理器看不到升级请求，
`respondWith` 也造不出 `101`。所以替换只能发生在**页面里**。

实现分三块，都在本轮：

- **`apps/pwa/src/proxy.ts` 扩展了 WebSocket 平面**：`encodeWsOpen` / `encodeWsData`，以及 `wsOpened` / `wsData`
  的解析。daemon 侧的 `WsOpen`/`WsOpened`/`WsData`/`WsClose` 从 M0 就在（并且用真实 DSH 验证过升级会被接受），
  缺的一直是客户端这一半。
- **`apps/pwa/src/websocket.ts`**：一个 `tunneledWebSocket(tunnel, nextStream)`，返回形状与平台一致的构造函数。
  它**不是** WebSocket 实现——不解析帧、不做握手；那两件事分别由页面下一层与 DSH 上一层的真实实现负责，
  过隧道的是**消息**，所以 ping/pong 与分片帧留在它们该在的地方。
- **`apps/pwa/src/ws-bootstrap.js`**：由 Service Worker 注入界面文档（插在页面自己的第一个 `<script>` 之前，
  否则应用已经拿到原生构造函数了）。隧道不在这个页面里——它在外壳页面里——所以两者用一个
  `BroadcastChannel` 通信，外壳负责把消息搬进隧道。

**实测（headless Chromium + 真实中继 + 真实 daemon + 真实 DSH）**：`scripts/browser-smoke.mjs` **8/8 全过**，
其中「the multiplexed WebSocket opens through the tunnel」是本轮从**已知限制断言**翻成**正向断言**的那一条——
上一轮它断言的还是「尚未被隧道承载」。界面正文不再出现 `Reconnecting…`，渲染 254 个节点。

**一致性由测试固定，而不是靠我读代码**：`scripts/ws-conformance.mjs` 用**客户端真实的编码器**产出字节，
`crates/dr-dsh-daemon/tests/ws_conformance.rs` 用**daemon 真实的解码器**读它们，`pnpm run verify` 会在两者不一致时失败。
这条检查在本轮立刻抓到一个真实错误：`wsData` 的第一个字段是**帧类型字节**（1 文本 / 3 关闭），
而我最初的编码器写的是长度前缀——一个只有对端在隧道尽头才会发现的错误。

**第 23 轮：界面在真实浏览器里渲染出来了**

根因是前一轮那个矛盾（「Worker 收到了请求，页面却没收到」）的答案，而且是我自己写错的地方：

- **隧道住在外壳页面里，而导航会把那个页面换掉。** 页面持有载体 socket 并替 Worker 回答请求，Worker 自己
  **无法**持有一条隧道。原来的「打开界面」用 `location.assign` 在**同一个标签页**导航——外壳页面随即被替换、
  它的脚本结束，界面于是在一个**没人服务**的隧道里加载：HTML 由隧道抵达（所以看起来在动），
  之后的每个资源都挂住。Officer 侧的埋点把这一点钉死了：只有 `GET /` 到达页面，`/plugins/??…` 与 `/assets/*`
  **从未到达**，尽管 Worker 记录到自己把每一条都发出去了。
  修法是**在新标签页里打开界面**（`window.open`），外壳页面因此继续活着并继续服务隧道。

**现在的实测结果（headless Chromium + 真实中继 + 真实 daemon + 真实 DSH）**：

| 检查 | 结果 |
| :--- | :--- |
| 外壳加载、面板报告 DSH running | 通过 |
| `window.__DSH_BOOT__` 存在 | 通过（object） |
| `__ModuleLoader__.mode` | `"live"` |
| 界面渲染 | 通过 —— **253–271 个节点**，标题 `DSH Local Build`，正文含版本号 `0.1.5-rc.2-c291e79`、`New Session`、`Workspaces`、`No sessions yet`、`Settings` |
| 一条大响应完整穿过隧道 | 通过 —— 27923 字节，正文含 `__DSH_BOOT__` |
| 控制台错误 / 失败请求 | 0 |

**尚未通过的一项，以及它的性质**：DSH 的 `ws://…/api/remote.mux` **没有**被隧道承载。
**Service Worker 无法拦截 WebSocket 升级**——`fetch` 处理器拿不到升级请求，`respondWith` 也造不出 `101`。
所以那个 socket 直接打到中继、失败，界面右下角显示 `Reconnecting...`。这是保真验收标准里「实时消息流」所依赖的那条链路，
因此**不能算通过**。

**下一步的具体做法**（不需要猜）：在界面页面里**替换 `window.WebSocket`** 构造函数，把帧经由隧道搬运——
daemon 侧的 `proxy` 平面**已经有** `WsOpen`/`WsOpened`/`WsData`/`WsClose` 消息与处理代码（M0 时就实现了，
并且用真实 DSH 验证过升级被接受），缺的只是客户端这一侧的构造函数接替。替换必须发生在 DSH 的脚本运行之前，
而这正是需要设计的地方：`window.open` 打开的页面里注入时机不由外壳控制，可能要让界面页面自己先加载一小段引导脚本。

## 五点五七、浏览器自己配对（第 27 轮）

M1 的进度行里长期写着一条"诚实地不可用"：WebCrypto 没有 SPAKE2，也没有可达 Ed25519 群的路径，
所以浏览器只能粘贴房间密钥，不能输入配对码。本轮把这条结论变成了一个可用的实现，并在此过程中
暴露出两个此前完全看不见的真实缺陷——两个都只有在**真实的 `drdshd pair` + 真实中继 + 真实 daemon**
上才会出现。

### 做了什么

1. **TypeScript 里的 Ed25519 群与 SPAKE2 客户端**（`apps/pwa/src/ed25519.ts`、`spake2.ts`）。
   协议一个字节也没改：盲化点、密码到标量的 HKDF、transcript 的六段布局都与 `spake2` crate 相同。
   重写的只有群运算（BigInt 扩展坐标）。
2. **规范向量**：`packages/crypto/conformance/pairing-vectors.json` 由
   `crates/dr-dsh-crypto/tests/pairing_vectors.rs` 生成（Rust 侧注入固定标量，因此固定的是**交换**而不是
   分布），两端各自断言，改一端不改另一端就红。五个用例覆盖普通码、全零码、全 1 码、零标量退化点与
   接近群阶的标量；每个用例都记录密码标量、两个临时标量、两条消息、交换出的密钥、确认值、登记密钥
   与回执。
3. **配对交换的客户端**（`apps/pwa/src/pair.ts`）与**设备身份**（`identity.ts`：生成、PKCS#8 导出、
   恢复时自检并重新推导 device id）。
4. **真实栈冒烟**：`scripts/pwa-pairing-smoke.mjs`——真实中继 + 真实 `drdshd pair` + 真实 daemon +
   真实 DSH，12 项断言全过。这是验收标准 1 第一次被完整走通：

   ```text
   code: 66T6-B7F7-R1
   ok  the browser client paired and derived an identity — device PMw3eK7MIJP8u_yfaO_iKg
   ok  the daemon reported the enrolment — exit 0
   ok  the device received the room key the daemon serves
   ok  the registry lists the device the client enrolled
   ok  the record restores the identity and self-checks
   ok  the daemon requires the enrolled device — devices: 1 enrolled
   ok  the daemon accepted the restored device
   ok  the interface came back through the tunnel — status 200
   ok  the response is the real DSH interface — 27923 bytes
   ok  a client without the identity is refused
   ```

### 缺陷一：浏览器多发了一帧，而四个替身 daemon 都在等它

浏览器隧道在盐之后会补发一个字节 `k` 作为"会话确认"。**没有任何一端在读它**：daemon 的握手在自己
发出 `k` 之后就结束了。于是它成了别人读到的第一条消息：

- 已登记设备的连接上，它被当作**设备挑战的应答**读走 → `bad_proof` 拒绝。也就是说，在真实栈上
  **浏览器从来无法连上一个登记过设备的 daemon**（这条路径此前只在替身 daemon 上测过）。
- 配对房间上，它被当作**客户端的 SPAKE2 消息**读走。真实 `drdshd pair` 的原文是：
  `the peer's pair_begin message was not usable: a SPAKE2 message is 33 bytes, got 1`。

**测试为什么没拦住**：`control.test.ts`、`panel.test.ts`、`device.test.ts`、`session.test.ts` 四个替身
daemon 都写着"先跳过一帧确认"，它们与客户端共享了同一个错误假设。修法是删掉那一帧，并把替身 daemon
改成"先发挑战、再读应答"；`tunnel.test.ts` 现在的断言是**盐之后线上什么都没有**（并额外断言调用方的
第一帧就是紧随其后的那一帧），替换了原来那条鼓励错误行为的断言。

### 缺陷二：配对回执把房间密钥交给了中继，同时给设备一把没人认的钥匙

两个问题出在同一个字段上（`pair_accept.root_key`）：

1. **它是由 PAKE 派生的密钥，不是 daemon 服务的房间密钥。** daemon 按 `--room-key` 停靠，设备按回执
   里的密钥推导房间——于是每个刚配好的设备都在敲一扇没人开的门，唯一的现象是
   `no daemon is serving this room`。修法是让 `drdshd pair` 也要求 `--room-key`（与 `drdshd run` 同一个
   值），回执携带**它实际服务的那个密钥**。
2. **它明文过线。** 配对房间的传输根是一个公开常量（`transport_root()`），所以那一帧中继读得到：
   等于把 daemon 的长寿命密钥交给中继，而这正是零知识要防的事。

修法是一次做完的：房间密钥用 **PAKE 派生的登记密钥**密封（`nonce || AES-256-GCM`，AAD 绑定设备公钥），
设备打开后校验它推导出的房间与 daemon 宣告的房间一致。派生密钥从此只当 KEK 用——名字也从
"root key"改成了 `enrolment_key`，因为把两种含义都叫"root key"正是这个缺陷的成因。

**证据**：`crates/dr-dsh-daemon/tests/pairing.rs` 的
`the_relay_cannot_read_the_room_key_out_of_the_receipt` 扮演中继——只用公开值连接、读遍 daemon 发出的
每一帧、断言房间密钥（原文与 base64）都不在其中，并验证诚实设备仍然拿得到它。**把实现改回"明文发送"，
该测试会红**（验证过）。

### 仍未完成

- **浏览器的配对 UI 与身份持久化**：模块都有了（`pair.ts` 返回可直接落盘的记录），但外壳里还没有输入
  配对码的表单，记录也还没有写进 IndexedDB。因此"打开 URL → 输入配对码 → 看见界面"这条**用户路径**
  尚未在浏览器里跑过；本轮验证的是它下面的每一段。
- 冒烟脚本的默认 `--dsh-path target/test-bin` 依赖工作区里的临时包装脚本，因此它是一份**可重跑的本地
  证据**，而不是 CI 里能直接跑的检查（与其它 `*-smoke.mjs` 一致）。

## 五点五八、在浏览器里用配对码走完（第 28 轮）

第 27 轮把配对码这条路在真实栈上走通了，但跑的是同一批模块，不是页面。这一轮把它接进外壳，
并在**真实浏览器**里走完了验收标准 1 的原文：打开 URL → 输入一次配对码 → 看见 DSH 界面。

### 做了什么

1. **一个字段，两种凭据**（`apps/pwa/src/credential.ts`）：配对码是 10 个字符、房间密钥是 43 个
   base64url 字符，形状不会混淆，所以页面不需要让用户先选"我要用哪种"。分类是**纯函数并带测试**，
   因为这个判断失败的后果是静默的：把配对码当成房间密钥会去推导一个没人服务的房间，然后把责任
   推给中继。
2. **配对结果落盘**（`apps/pwa/src/storage.ts`）：IndexedDB（不是 `localStorage`——后者是同步字符串
   表，源内任何脚本随时可读）。记录里是设备私钥（PKCS#8）、房间密钥、device id 与房间；读回来时
   `restoreDevice` 会重新推导 device id **并校验房间密钥与房间一致**，任何一处不符都报"请重新配对"，
   而不是让它在 daemon 那边表现为"设备已被撤销"。
3. **会话可以带身份**（`session.ts`）：`Session.start` 接受"用户输入的密钥"和/或"本机已配对的身份"。
   两者都在时**以输入的密钥为准**；只有当下发的密钥与记录里的房间密钥是同一把时，才带身份——否则
   给另一台 daemon 粘贴密钥会以 `bad_proof` 被拒，而用户做的一切都是对的。
4. **外壳接线**（`shell.js` + 中继的页面标记）：载入时读一次存储，显示"已配对为 …"并给出"忘记此设备"；
   Connect 时按输入决定配对、连接还是两者都做。配对成功后**不自动连接**——那一刻 daemon 可能还没
   启动，自动连接会稳定地失败一次，而这不是用户做错了什么。
5. **真实浏览器冒烟**（`scripts/browser-pairing-smoke.mjs`）：真实中继 + 真实 `drdshd pair` + 真实
   daemon（**强制要求已登记设备**）+ 真实 DSH。**10/10** 通过：

   ```text
   ok  a fresh browser reports no stored device
   ok  the page reports the device it paired as — Paired as S3OIparFmQ1WoFhiXfcCoA.
   ok  the device record is in IndexedDB — device S3OIparFmQ1WoFhiXfcCoA
   ok  the daemon requires the enrolled device — devices: 1 enrolled
   ok  an enrolled daemon accepts the paired browser — DSH is running
   ok  the DSH interface rendered through the tunnel — 254 nodes, title "DSH Local Build"
   ok  the whole journey fits in the two minutes the criterion allows — 8.2s
   ok  after a reload the browser reconnects with nothing typed — … → DSH is running
   ok  no console errors
   ```

   （第 36/37 轮给这条脚本加了三项断言：注入一次失败让页面记录它、浏览器把一份崩溃上报送回 daemon、
   落盘文件权限是 0600。现在是 **13/13**，实测与两个真实缺陷见 § 五点六六——这里保留当时的 10/10
   输出，因为它记录的是那一轮的运行。）

### 缺陷：刷新一次就把自己锁在门外

服务端的路由规则里，`/` 与其他 DSH 路径一样是**被隧道拦截**的。在配对流程接进来之前这看不出问题，
因为没人刷新过：`browser-pairing-smoke.mjs` 一 `reload`，导航就被 Service Worker 拦下、转成一条
"请 DSH 给我 `/`"的隧道请求——而持有隧道的那张页面**正在被替换**，于是没有人回答，页面白屏。

修法是承认 `/` 在两个命名空间里都有意义，而区分它们的东西是**请求模式**：`navigate` 是有人打开或
刷新外壳（从服务端取），其余（`fetch`/XHR）来自界面页面——它认为自己就是 DSH，应该走隧道。
这条规则必须同步判断（`clients.get()` 是异步的，而 `respondWith` 不能等），所以 `Request.mode` 是
唯一可用的判据。修好后两条浏览器冒烟同时通过：房间密钥路径 8/8（界面里的 `fetch('/')` 仍然走隧道），
配对路径 9/9（刷新后自动接上）。

### 现在的可用形态

一台全新设备：打开中继地址 → 把 `drdshd pair` 打印的码粘进唯一的输入框 → 点 Connect → 配对完成、
面板显示 daemon 状态 → 点"Open the DeepSeek Harness interface"在另一个标签页里看到真实界面。
刷新、休眠唤醒、第二天再来：直接点 Connect，不需要再输入任何东西。撤销设备仍走
`drdshd devices --revoke <id>`，被撤销的设备下次连接会得到具名拒绝。

## 五点五九、两个只有真实 DSH 能暴露的缺陷（第 29 轮）

第 26 轮把「任务发不出去」归因于 DSH 侧。这一轮去验证那个归因，发现它是错的：**两个缺陷都在我们这一侧**，
而且各自都有一个"看起来像 DSH 的问题"的症状。修好之后，验收标准 2 的核心第一次真的跑通了。

### 缺陷一：每个 POST 都带着两个 `Content-Length`（它让整个 RPC 面看起来是坏的）

`crates/dr-dsh-daemon/src/dsh/client.rs` 的转发循环把客户端的头原样带走，`finish()` 又按**自己实际发送的
body** 设一次 `Content-Length`。于是出网请求带着两个 `Content-Length`。Node 的 HTTP 解析器在任何应用
代码之前就拒绝它：

```text
POST /api/session/list，一个 Content-Length  -> 200
POST /api/session/list，两个 Content-Length  -> 400（空响应体）
```

DSH 的每一个 RPC 都是带 JSON body 的 POST，所以**每一个都返回空 400**；而 `GET` 没有 `Content-Length`，
所以取界面一直正常，只有 RPC 全灭。第 26 轮看到的正是这个形状，却被读成了"DSH 的 RPC 面不接受调用"。

**为什么当时的证据看起来那么强**：那条"界面自己在 Add workspace… 里也 400"的记录，是在**经隧道的界面**
里观察到的——路径没变，变的只是我读它的方式。真正的判决性实验是绕过本项目直接对 DSH 说话（本轮做的）。

**修法与回归测试**：`content-length` 归 daemon 所有（它重新分帧），不转发客户端的声明。测试放在
`client.rs` 里一个**裸 TCP 服务器**上：它数请求头里出现几次 `content-length`，一次回 200、否则回 400
（就是 Node 的行为）。**把修复改回去，这个测试会红**（验证过两次）。这里必须用裸 socket 而不是
hyper/axum 的测试服务器：后者交给处理器的 header map 已经把重复项合并了，用它搭的假 harness 对真实
DSH 会拒绝的请求照样满意——这正是这个缺陷能从一整套绿测试里穿过去的原因。

### 缺陷二：注入的 `WebSocket` 只喊 `onopen`，不派发事件（它让实时界面永远在加载）

界面里的 `WebSocket` 被替换成 `ws-bootstrap.js` 的隧道版本。第二处缺陷是它把事件**当属性调用**：

```js
this.onopen?.call(this, new Event('open'));      // 只有 onopen 这一种写法能收到
```

而 DSH 自己的流客户端用的是 `socket.addEventListener('open', …)` 与 `addEventListener('message', …)`
（`packages/api/gateway/src/client/stream-client.ts`）。于是**界面的 mux socket 永远停在 CONNECTING**：
工作区列表、会话列表、一轮对话的输出全部无限等待，页面看起来只是"慢"。

最刺眼的是它为什么没被发现：`browser-smoke.mjs` 的检查写的是 `socket.onopen = …`——**用属性写法的检查
去验证一个只支持属性写法的替身**，两边共享同一个错误假设，所以一直是绿的。修法是让 `on*` 成为**注册真实
监听器的访问器**，并且只走 `dispatchEvent`（`MessageEvent`/`CloseEvent`，平台没有 `CloseEvent` 时退回
带同样字段的 `Event`）。两条冒烟脚本的 mux 检查同时改成 `addEventListener` **并且要求一次真实流往返**
（发一个 `$events` 流请求，等它的 `item` 帧回来）：这正是能抓住这个缺陷的形状。

### 现在的证据

`scripts/browser-task-smoke.mjs`（真实 Chromium + 真实中继 + 真实 daemon + 真实 DSH + 真实模型）**8/8**：

```text
ok  the interface is rendered
ok  the live socket opens and answers a stream request
ok  a workspace was selected through the interface
ok  a session opened
ok  the prompt is in the composer
ok  the message was accepted
    the answer contains the marker: ["DSH-REMOTE-F7BYV5"]
ok  the model answered through the tunnel
ok  no uncaught errors in the interface
```

提示词要求模型只回一个随机令牌，检查要求这个令牌出现在**不是输入框、也不是用户自己那条消息**的叶子节点里
——"页面变长了"不算回答，早先那版检查就是这么被骗过去的。

**顺带说明两处环境副作用**（本轮为了让工作区前置条件成立而做的，都是界面自己的正常操作）：
这台 DSH 的 workspace 列表里多了一条指向 `/home/jjshi` 的条目，以及一条指向 `target/task-workspace` 的条目；
它们写在 `~/.dsh/storages/workspace.json`（DSH 自己的存储，不在本仓库里）。

## 五点六十、验收标准 2 的完整场景（第 30 轮）

标准 2 的验收方式写得很具体：**在远程端完成一次真实的多轮编码任务，包含至少一次审批、一次工具调用、
一次长输出**。前几轮跑通的是一轮短答，这一轮把四件事一次跑完，`scripts/browser-task-smoke.mjs --full`
**13/13**：

```text
ok  the interface is rendered
ok  the live socket opens and answers a stream request
ok  a workspace was selected through the interface
ok  a session opened
ok  the session was switched to view-only
ok  the message was accepted
ok  an approval prompt reached the remote user
ok  the approval was granted from the remote end
ok  the tool call completed after the approval
ok  the second message was accepted
ok  the second turn answered, so the session is multi-turn
ok  a long answer rendered in the remote page — longest rendered block: 31149 characters
ok  no uncaught errors in the interface
```

### 审批不是"点一下就能测"的：先要有一件被拒绝的事

第一次尝试让模型写文件时，它**直接成功了**——因为会话的默认模式是 `workspace-write`（"工作区内修改"），
而那个文件在工作区内。也就是说：**在这个模式下审批流程根本不会被触发**，无论提示词怎么写。

要看到审批，需要让沙箱先拒绝一次。DSH 的权限模型是 `sandbox`（`view only` / `workspace-write` /
`full access`）与 `approval`（`ask` / `never`）两个维度的组合，而 `workspace-write` 配的是"更宽的访问才
需要批准"。因此脚本先把会话切到 **view only（仅可查看）**，再要求写文件：沙箱拒绝 → agent 请求升级 →
界面弹出审批卡片：

```text
等待审批 | escalate sandbox to workspace-write: The read-only sandbox blocked this write; …
        | printf 'APPROVED\n' > ./result.txt | 拒绝 | 允许一次
```

脚本点"允许一次"，工具随即执行，模型把令牌交回来。**这条链路值得单独记一句**：它是"远端用户对一个
本机权限升级说同意"这件事第一次真正跑通——它同时用到了实时流（审批卡片是推过来的）、代理（批准后的
命令在 daemon 那侧执行）与界面（卡片渲染在 DSH 自己的组件里）。

### 两个测量本身的坑（都改了）

1. **"页面变长了"不等于"回答了"**。第一版检查是"提示词之后的内容超过 40 字"，而页面边框文字本身就能
   满足它。现在要求：一个**随机令牌**出现在**既不是输入框、也不是用户自己那条消息**的叶子节点里。
2. **"长输出"不能用整页文本的增长来量**。第二轮回答期间页面**变短了 342 个字符**——界面会虚拟化较早的
   内容，旧的离开 DOM 与新的进来同时发生。改为量**最长的单个渲染块**：这一轮是 31149 个字符。

### 结论

验收标准 2 的验收方式（多轮 + 审批 + 工具调用 + 长输出）四件都在真实浏览器、真实中继、真实 daemon、
真实 DSH、真实模型上跑通。标准里另半句"长会话（>1000 条消息）滚动不降级"属于 M3 的性能项，本轮没有
测它，也不声称它。

### 补记（第 32 轮）：审批的触发方式改了，因为权限模式选择器在这个 DSH 版本里不生效

上面那次成功用的是"先把会话切到 view only"。改名之后重跑时它不再生效，于是去量了一次：**菜单会打开、
点选项、菜单关闭，但按钮上的标签不变**；同一时刻记录界面的 mux 通道，**点击没有发出任何一帧**——而
同一个 socket 在别处（工作区流、会话流）工作正常。也就是说这不是隧道的问题，是这个版本的界面里那个
选择器没有把选择送出去。

因此脚本不再依赖它：改成**让沙箱拒绝一件默认策略下本来就会拒绝的事**（写 `/etc/…`，在会话工作区之外
且不是临时目录）。`workspace-write` 配 `approval: ask` 的语义正是"更宽的访问才需要批准"，所以这是**出厂
配置**下的审批，而不是测试临时安排出来的状态。

另外，agent 会不会**请求**升级是模型的判断，不是 daemon 的行为：有一次它直接回答"写不了"而没有申请。
脚本因此允许重试一次（提示词里把"要申请升级"说死），并且**仍然要求一张真实的审批卡片**；拿不到卡片时
会打印对话尾部，而不是只说一句失败。

## 五点六一、M3 起步：可安装、以及一条被 CSP 挡住的安装路径（第 32 轮）

M3 的完成标准是三件事：崩溃率 < 0.5%、长会话（>1000 条消息）滚动不卡顿、离线提示可读。这一轮做的是
它们的前提——**这个客户端要能作为一个应用被装上手机**——并在做的过程中撞到一个只有浏览器才会报的缺陷。

### 做了什么

1. **Web app manifest**（`apps/pwa/static/manifest.webmanifest`）：名称、`start_url: /`、`scope: /`、
   `display: standalone`、主题色，以及 192 / 512 普通图标和独立的 512 `maskable` 图标。
   图标统一由鲸鱼 SVG 导出；`maskable` 使用满底和中心安全留白，见[品牌素材](../../assets/brand/README.md)。
2. **图标**：`apps/pwa/static/icon-{192,512}.png`，由一段 40 行的 PNG 写出程序生成（纯色圆角方块 +
   三道递减的横条），而不是引入一个图形库——两个文件不值得给这个项目加一条依赖。生成脚本在
   `apps/pwa/static/` 的注释里说明了形状的选择：项目没有可嵌入的字体，手画的文字比一个几何图形更难看。
3. **外壳链接 manifest**，并带上 `theme-color`、`icon` 与 `apple-touch-icon`。
4. **中继的静态资源白名单**（`crates/dr-dsh-relay/src/assets.rs`）：中继此前只提供扁平 `.js` 模块，
   manifest 与图标无处可取。现在多了一张**固定名字与固定 MIME 的表**（三个名字），仍然保持原有的拒绝
   规则：非白名单一律 404，`.html` 依然不可达，`..` 与嵌套路径依然被拒。三处必须一致（中继提供什么、
   外壳要什么、构建拷贝什么），因此有一个测试同时读这三份来源——不一致的表现是"安装提示永远不出现，
   且没有任何报错"。

### 缺陷：`default-src 'none'` 把 manifest 和图标一起挡住了

第一次在真实浏览器里跑安装性检查，结果是：

```text
FAIL  the app manifest parses and names what an install needs — 0 manifest error(s); name=undefined icons=0
FAIL  no console errors — Loading the image '…/client/icon-192.png' violates … "default-src 'none'"
FAIL  no failed requests — …/client/icon-192.png (csp) | …/client/manifest.webmanifest (csp)
```

外壳的 CSP 是 `default-src 'none'`，而它没有给 `manifest-src` 与 `img-src` 开口子。这条策略本身是对的
（它保护的是一个处理密钥的页面），但**它把"可安装"这件事悄悄取消了**：manifest 被拒、图标被拒，
安装提示不会出现，而服务器侧的任何测试都看不见——这正是第 21 轮那五个缺陷的同一类，也是"检查必须
在浏览器里做"的又一次证明。修法是给这两个指令开 `'self'`：manifest 与图标都由客户端目录提供，源外
的任何东西仍然不可以是图片、不可以是 manifest。

修好后同一组检查：

```text
ok  the app manifest parses and names what an install needs — 0 manifest error(s); name="dr.dsh" start="/" icons=3
ok  the manifest icons load — /client/icon-192.png: 200, /client/icon-512.png: 200
ok  the page links the manifest it was served — http://127.0.0.1:8860/client/manifest.webmanifest
ok  no console errors
ok  no failed requests
```

浏览器冒烟因此从 8 项变成 **11/11**（manifest 可解析、图标可加载、外壳确实链接了它）。

### M3 剩余

- **离线状态**：目前离线时页面根本加载不出来（外壳来自中继）。计划是让 service worker 在安装时缓存
  外壳自身，并在离线时给出可读的说明；验证方式是 Playwright 的 `context.setOffline(true)` 后重新加载。
- **性能**：长会话（>1000 条消息）的滚动帧时预算，以及一个诚实的崩溃率测量口径——本项目没有遥测
  （ADR-0006 的默认关闭原则），所以"崩溃率"只能在自有冒烟里测，文档必须写清楚数字的来源。
- **推送**：M3 标准里是可选项，且 ADR-0006 已把推送默认关闭；是否在这一轮实现取决于前两项完成后的余量。

## 五点六二、M3 第二步：离线（第 33 轮）

M3 的离线标准只有一句"离线提示可读"，但它有一个前提：**离线时页面得先能打开**。而在这之前不能——
外壳、模块、图标全部由中继提供，断网时浏览器给出的是它自己的错误页，用户什么也学不到。

### 做了什么

1. **service worker 缓存客户端自己的文件**（`apps/pwa/src/offline.ts` 定策略，`service-worker.ts` 执行）：
   安装时预缓存 `/`、`shell.js`、manifest 与两个图标，之后对 `/client/**` 的 GET 走**缓存优先 + 后台刷新**。
   **只缓存客户端自己的东西**：DSH 的界面、资源与 RPC 是某个用户的实时内容，缓存它们等于把会话数据放进
   一个比会话活得久的浏览器缓存里，而隧道的意义正是"内容只存在于两端"。这条边界是一个纯函数
   （`isClientOwned`），因此可以在 Node 里逐条断言。
2. **一句话，两个版本**（`offlineNotice`）：已配对的人失去的是"到中继的链路"，不是配对本身，也不是
   他那台电脑上的 DSH；未配对的人则连开始都做不到。两句都写明**什么没有丢**——人真正会担心的正是这两件事。
3. **外壳在加载时就注册 worker**，而不是等用户点 Connect。这是一个真实缺陷：worker 只在连接流程里注册，
   于是**从没连接过的设备什么都没缓存**，第一次离线打开就是浏览器错误页。现在加载即注册（失败只警告，
   页面照常可用，只是不能离线用）。

### 实测

新增 `scripts/browser-offline-smoke.mjs`（真实 Chromium，`context.setOffline(true)`），**6/6**：

```text
ok  the service worker cached the client's own files — /, /client/control.js, … /client/shell.js, /client/storage.js
ok  the shell still loads with no network — title "dr.dsh"
ok  the page says it is offline, in words a person can act on — offline: This device is offline, so dr.dsh cannot reach the relay. …
ok  the shell's own code ran while offline
ok  reconnecting after the outage works — DSH is running
ok  no console errors
```

缓存清单本身也是一条证据：里面**只有** `/` 与 `/client/*`，没有一条 DSH 的路径。

### 缓存引入的回归：`/` 对"导航"是外壳，对"取数据"是 DSH

第一版缓存分支只看路径与方法，于是**界面页面自己发的 `fetch('/')`（取 DSH 首页）也被缓存命中**，
拿到的是外壳的 HTML。浏览器冒烟立刻报出来：

```text
FAIL  a large response arrives intact through the worker — status 200, 3853 bytes, boot global in body: false
```

3853 字节正是外壳。修法是把第 29 轮为路由建立的那条区分搬进缓存判定：**`/` 只有 `mode === 'navigate'`
时才是外壳**，其余（`fetch`/XHR）来自把 `/` 当作 DSH 根的界面页面，必须走隧道；`/client/**` 则无论如何
都是客户端的。同一个区分在同一个项目里第二次变得关键，因此它在两边都有注释指向对方。

### M3 剩余

- **性能**：长会话（>1000 条消息）滚动的帧时预算；以及一个诚实的崩溃率口径——本项目没有遥测
  （ADR-0006 默认关闭），所以数字只能来自自有冒烟，文档必须写清来源，不能写成"用户崩溃率"。
- **推送**：M3 标准里是可选项，ADR-0006 已把它默认关闭；是否实现取决于前一项之后的余量。

## 五点六三、M3 第三步：性能与崩溃率（第 34 轮）

M3 剩下的两条标准都需要"量"，而这个项目**没有遥测**（ADR-0006：推送与一切上报默认关闭）。所以两条都只能
由我们自己的运行得出，而**样本能支撑什么结论**必须和数字一起写出来。

### 崩溃率：定义、量法，以及"0 次"到底说明了什么

- **定义**（`apps/pwa/src/health.ts`）：客户端里一次未捕获错误、一次未处理的 promise rejection，
  或者一次**从未到达可用状态**的启动。计数在页面内存里，由外壳的两个监听器写入
  `window.__DR_DSH_HEALTH__`，**不发送到任何地方**。
- **量法**（`scripts/browser-soak-smoke.mjs`）：每次运行都是真实的一次加载——外壳加载、模块执行、
  service worker 接管、隧道连上、面板报告 DSH 正常。默认 20 次，可 `--runs N`。
- **算术**（与数字同等重要）：零次崩溃的 95% 单侧上界是 `3/n`（rule of three）。因此脚本不打印
  "崩溃率 0%"，而是：

  ```text
  12 runs, 0 crashes: observed 0.00%, 95% upper bound 25.00%, target 0.50%
  this sample cannot support a claim about 0.50%: the bound needs at least 600 runs
  ```

  也就是说：短跑**不能**支持 0.5% 的结论，只能证明"没有高频崩溃"。要真的对上标准的 0.5%，需要
  **600 次**运行；少于这个数的样本会被脚本报成 skip（退出码 2），而不是通过。
  这个口径被写进测试：`health.test.ts` 固定了 `3/n`、`599` 不够、`600` 够。
- **实测（真实中继 + 真实 daemon + 真实 DSH，600 次运行）**：

  ```text
  run 600: 780ms, errors 0, rejections 0
  600 runs, 0 crashes: observed 0.00%, 95% upper bound 0.50%, target 0.50%
  the sample supports a claim about 0.50%
  ```

  每次运行约 0.4–0.9 秒（加载外壳 → service worker 接管 → 连接 → 面板报告 DSH 正常），600 次里
  **零崩溃**，因此 95% 上界恰好落在 0.5% 上——这是**自有冒烟里的**数字，不是用户崩溃率；两者之间的
  差距（真实用户、真实手机、真实网络）写在这里而不是省掉。

### 长会话滚动：两次测量错误，都是"测的不是那件事"

标准写的是"长会话（>1000 条消息）滚动不卡顿"。第一次实现量的是 `document.scrollingElement`，
输出很漂亮——**p50/p95 都是 16.7ms**——但那是**一个空闲页面的 vsync 间隔**：真实会话的内容高度是
720px，**根本没有可滚动的东西**。一个"滚动从未发生"却报出 16.7ms 的测量比没有测量更糟，因为它看起来
像证据。

修法分两步：先**找到真正在滚动的容器**（`overflow-y` 可滚动且内容高于视口的最深元素），再让探测函数
**自包含**（Playwright 只序列化被传入的那个函数，所以辅助函数在页面里不存在——第二次失败就是
`findScroller is not defined`）。修正后：

```text
skip  the real interface scrolls without a pathological frame — this session has nothing to scroll (html (720px of content in 720px))
  padded with 1000 blocks into body (no scrolling container existed), scroll height 52720px
ok    scrolling 1000 message-sized blocks stays within the frame budget — p50 16.7ms, p95 16.7ms, worst 16.8ms, 0 long frames, scrolling html (52720px of content in 720px)
```

**这两行说的是不同的事，脚本也照实说**：第一行是真实会话——这次没有可滚动内容，因此记 **skip** 而不是
通过；第二行是把会话**填充到 1000 个消息大小的块**之后的真实测量：52720px 内容、180 帧、**0 个长帧**。
它是"在真实客户端里滚动 1000 个块"的测量，**不是**"DSH 自己产生了 1000 条消息的会话"——这台机器上
没有那样的会话，而造一个需要往 DSH 自己的会话存储里写数据，本项目不做这件事。这个差距写在脚本头部，
也写在这里。

指标本身是**掉帧**：帧间隔被量化到一个 vsync（16.7ms），所以只有"某个帧明显变长"才是信息，
p50/p95 相同并不说明流畅度，`long frames` 才是。

### 一个顺带暴露的构建问题

`health.ts` 里接口把 `samples` 写成 `readonly string[]` 而实现里在 push：`tsc` 因此失败，
而 `pnpm --filter … build` 的第一步是 `rm -rf dist`，于是**客户端目录被清空后没有重建**，中继开始
对 `/client/shell.js` 返回 404。我是在跑浏览器冒烟时看到的（面板永远不出现）。教训有两条，都值得记：
构建失败必须**先跑 `pnpm run typecheck:ts` 再跑浏览器冒烟**；而"目录被清空 + 构建失败"的组合会让一个
纯类型错误表现成"页面加载不出来"。

### M3 结论

三条标准逐条对应：

| 标准 | 结果 |
| :--- | :--- |
| PWA 安装 | **达成**：manifest + 图标 + 中继白名单，浏览器冒烟 11/11（§ 五点六一） |
| 离线提示可读 | **达成**：断网后仍能加载外壳并给出两版之一的句子（已配对/未配对），离线冒烟 6/6（§ 五点六二） |
| 崩溃率 < 0.5% | **达成（口径已写明）**：600 次真实运行、0 次崩溃，95% 上界 0.50%；数字来自自有冒烟而非用户遥测 |
| 长会话（>1000 条消息）滚动不卡顿 | **部分**：真实客户端里滚动 1000 个消息大小的块（52720px、180 帧）**0 个长帧**；"DSH 自己产生 1000 条消息的会话"这个更强的版本**没有测**，因为给 DSH 播种历史需要写它自己的会话存储，本项目不做 |

推送是标准里的可选项，而 ADR-0006 已把推送默认关闭：本轮**不实现**，也不声称。

M3 因此记为**完成（含一条明确的部分项）**，下面两条留给后续里程碑：真实千条消息会话的测量方法、
推送的端到端边界（ADR-0006 的未决项）。

## 五点六四、M4 第一步：Docker 一键部署与部署检测（第 35 轮）

M4 的完成标准是两条：**自托管部署成功率 > 90%**（以文档走查 + 新用户实测计）与**反向代理超时能被启动期
检测并警告**。这一轮做的是前者的部署形态与后者的检测，并把"文档走查"这一半按字面做了一遍。

### 一、Docker：仓库现在自带 `Dockerfile` 与 `compose.yaml`

三阶段构建：`node` 阶段构建 PWA 产物（中继要提供它，所以**必须在镜像里**）、`rust` 阶段只编译
`-p dr-dsh-relay`（daemon 与所有面向 DSH 的依赖**不在镜像里**——这是把零知识写成构建步骤）、
`debian-slim` 运行阶段放二进制 + 客户端产物，非 root 用户，`read_only: true`，`HEALTHCHECK` 打
`/healthz`。

**实测**（本机 Docker，`sudo docker build`）：
- 镜像建成并跑起来，`/healthz` 返回 `{"service":"drdsh-relay","version":"0.0.0","wire":[0,1],"rooms":0,"max_rooms":1024}`，
  `/` 返回标题为 `dr.dsh` 的外壳，`/client/shell.js` 200、`/client/icon-192.png` 200、
  `/client/manifest.webmanifest` **200 `application/manifest+json`**；
- 容器启动时打印了那条非回环警告（镜像里的 `DSH_RELAY_BIND=0.0.0.0:8787`）；
- **端到端**：让一个真实 daemon 连到**容器里的中继**（`ws://127.0.0.1:8791`），再用 PWA 客户端取回界面——
  `tunnel established: true`、`response status: 200`、`response bytes: 27923`、`is the real DSH UI: yes`。
  也就是"部署起来"之后它确实在转发，而不只是"进程活着"。

**三个只有容器才会暴露的问题**（都已修，并写进 `docs/operations/self-hosting.md`）：

1. **缺 `WORKDIR`**：客户端阶段的 `COPY` 落在 `/` 而不是 `/src`，运行阶段的
   `COPY --from=client /src/apps/pwa/dist` 于是找不到东西；报错点名的是**目标路径**，不是缺失的 `WORKDIR`。
2. **文件权限跟着 `COPY` 走，而运行用户不是创建者**：`apps/pwa/static/manifest.webmanifest` 在仓库里是
   `0600`（写入工具默认如此），容器里非 root 的 `drdsh` 读不到 → **manifest 404，而同批用脚本生成的图标
   200**（0644）。宿主机上中继以属主运行，所以本地一切正常——这正是"只在部署里出现"的那类问题。修法：
   源文件 chmod 644 + 两处 `COPY --chmod`，镜像不再依赖宿主机的 umask。
3. **只构建中继的镜像会得到一个没有客户端的页面**：文档里早先那份模板只编 `drdsh-relay`，访问时看到的是
   "客户端未安装"页。它说实话，但不是用户要的东西。

### 二、部署检测：两条警告

- **中继**：绑到非回环地址时在启动横幅后打印一条警告，说清什么会跨过那张网络（密文、客户端包、room id，
  以及"你在跑这个"本身），并指向代理超时；**回环上保持安静**——每次正常启动都提醒一次的提醒没人读。
- **daemon**：认得出"按固定节拍被掐断"的 carrier。代理超时与中继重启从 daemon 角度看是同一件事，
  能区分它们的是**形状**（≥20 秒、连续三次彼此相差 ≤20%、且**从未承载过客户端会话**）。命中后打印
  **一次**警告，并把观察到的时长原样写进去，再给出 nginx 的具体改法。

**实测**（`scripts/deploy-probe.mjs`）：起一个真实中继，前面放一个**真的会转发、但空闲 21 秒就断开**的 TCP
代理，让 daemon 连上去。4 项断言里 3 项通过：中继在非回环上警告、在回环上安静、daemon 认出节拍并点名
`proxy_read_timeout`。**第 4 项（"只说一次"）先报了失败，是探针自己的计数错误**：警告文本里
`proxy_read_timeout` 出现两次（一次解释 nginx 默认值，一次给出建议值），我数的是这个词而不是整条警告。
改成按警告开头计数后通过。

写这个探针的过程中还修掉一个真实缺陷：**daemon 原来只在两条 carrier 结束路径上观察**（`next_inbound`
错误、发送失败），而**代理超时走的恰恰是第三条**——daemon 已停靠房间、正在等第一个客户端时连接被关闭，
那条路径直接 `break`，没有任何观察。症状是"daemon 每分钟重连一次，但永远不打印那条解释原因的警告"。

### 三、一处文档与代码不一致（已更正）

`self-hosting.md` 有两处写着"中继与端点之间会用 `Ping`/`Pong` 帧保活"。**代码里没有任何一端发送它们**：
协议定义了帧类型（`docs/protocol.md` § 3），但唯一的用法在测试里。这两句在写下的那一刻就不成立。
现在文档说的是事实：没有保活，所以代理的空闲超时必须自己放宽，而 daemon 的检测是用来告诉你原因的。
给 carrier 加周期性保活列为 M4 的后续项。**（第 36 轮已实现，见 § 五点六五；实现的是 WebSocket 层的 ping，这两个帧类型仍然无人发送。）**

### 四、"文档走查"这一半

按上面重写的 `self-hosting.md` 逐条走过一遍：构建、起服务、健康检查、客户端资源、代理配置、部署检测的
两条警告——每一步都在本机执行过并有输出。**"新用户实测"这一半没有做**：那需要另一个人（或至少另一台
干净机器）按文档操作，本轮只有我一个人在同一台机器上走查。因此 M4 的"部署成功率 > 90%"记为**部分**：
走查这一半完成，用户实测那一半未做。

## 五点六五、M4 收尾：carrier 保活（第 36 轮）

M4 剩下的"保活帧"做完了。**实现的是 WebSocket 层的 ping，不是协议里早就定义好的 `Ping`/`Pong`
帧**（`0x0030`/`0x0031`）——理由写在 `docs/protocol.md` § 3：保活要骗过的是反向代理，所以它必须是
代理看得见的字节，而 WebSocket 控制帧由对端的 WebSocket 实现自动应答，不需要任何一端跑我们的代码，
中继也一如既往地不解析 payload。改用协议层 `Ping` 的收益只是"用我们自己的帧"，代价是中继第一次需要
理解某种帧的语义，而它现在的贫瘠正是它的安全属性（ADR-0002）。那两个帧类型保留原值，免得将来把这两个
数字分给别的语义。

两端各自独立，默认 30 秒，`0` 关闭；非数字让进程启动失败而不是被读成"关闭"（两者在日志里长得一样，
后者会静默地拿掉这层保护）：

| 端 | 环境变量 | 默认 | 它覆盖的安静状态 |
| :--- | :--- | :--- | :--- |
| 中继 | `DSH_RELAY_KEEPALIVE_SECS` | `30` | room 已 park、客户端还没连上；以及会话建立后两端都没话说 |
| daemon | `DSHD_KEEPALIVE_SECS` | `30` | 同上，方向相反 |

### 三件被失败教出来的事

1. **`tokio::time::interval` 的第一次 tick 立即触发。** 于是每个对端刚 park 就吃到一记 ping——在连接
   可证明存活的那一刻发的噪音。先报的警的不是新测试，而是 `routing.rs` 里两条**既有**断言：一条把
   "刚 park 的 carrier 上没有流量"读成了泄漏的帧（`a malformed frame reached the daemon as Ping(b"")`），
   另一条在接管房间的用例里读到了它。改成 `interval_at(now + every, every)`，并把"第一个 ping 在
   一个间隔之后"写成断言。
2. **daemon 的保活必须覆盖 park 阶段。** 等第一个客户端的这段时间是 carrier 一生中最长的安静期，
   也正是代理超时真正掐断的那一段（daemon 的检测警告写的就是"从未承载会话"）。只给"已建立会话"的
   读循环加 ticker，保活保护的恰好是最不需要它的阶段。实现上这一点有代价：`establish()` 里等 salt
   的读要被 ticker 打断，而**取消一个读是安全的**（半截帧缓存在 WebSocket 内部），打断握手不是——
   所以 tick 分支只负责记下"该发 ping 了"，真正发送发生在 `select!` 之外。
3. **归属问题。** "carrier 活下来了"本身不能证明是谁救的，所以探针的两组场景各关掉一端：3a 关中继的
   保活（`DSH_RELAY_KEEPALIVE_SECS=0`），3b 关 daemon 的（`DSHD_KEEPALIVE_SECS=0`）。只有这样才能把
   存活归因于正在 ping 的那一端，而不是"保活这东西在某个地方生效了"。

### 验证

- `pnpm run verify` **全绿**：Rust **218** 个测试（另 5 个需真实 DSH 的 `#[ignore]`）+ TS **205** 个
  （PWA 166、protocol 34、plugin 8、crypto 3）+ `docs:check`（21 个 Markdown、204 条相对链接）。
- `cargo test -p dr-dsh-relay --test routing` **9/9**，新增 `a_quiet_carrier_is_pinged_but_not_the_moment_it_parks`。
- `crates/dr-dsh-daemon/tests/keepalive.rs` **2/2**（新增）。这里的中继只在 WebSocket 层被伪装：真中继
  按设计**丢弃**对端的 ping（`routing.rs` 断言了这一点），所以透过真中继，ping 是看不见的——要断言
  daemon 发了什么，只能自己接那条 socket。断言只有两条：park 之后先安静半个间隔，然后 ping 持续到来；
  以及 `DSHD_KEEPALIVE_SECS=0` 时整段窗口里一个字节都不发。
- **变异检验**（测试是不是跟着实现写的）：把中继的 `interval_at` 改回 `interval`，`routing.rs` 立刻
  两条断言失败；把 daemon 的 `establish_with(ticker)` 改回 `establish()`，`keepalive.rs` 那条失败。
- 手工核对了 daemon 的启动横幅与非法值：`DSHD_KEEPALIVE_SECS=7` 时打印
  `carrier keepalive: a WebSocket ping every 7s (DSHD_KEEPALIVE_SECS = 0 turns it off)`；
  `DSHD_KEEPALIVE_SECS=nope` 时**退出码 1** 并只打印一行 `drdshd: DSHD_KEEPALIVE_SECS is not a number: "nope"`，
  没有启动 DSH、也没有进入重连循环。
- `scripts/deploy-probe.mjs` **8/8**（第 2 组 4 条检测 + 第 3 组 4 条保活），本轮实测数字：
  - 3a：空闲 12 秒就断开的代理前面，parked carrier 撑过 **26 秒**安静窗口，**0 次掐断**、daemon 日志
    无重连；上游跨过 **30 字节**——5 个带掩码的空 ping × 6 字节，与"5 秒一个 ping、窗口 26 秒"对得上。
  - 3b：挂着真实客户端会话（PWA 自己的 `Tunnel` + `ControlClient`，跑在 node 里），同样撑过 26 秒，
    前后两次 `status` 都有应答、socket 未断；下游跨过 **10 字节**——5 个不带掩码的 ping × 2 字节。
  - 保活在日志里什么都不留下，**唯一的证据就是一条本无话可说的 socket 上跨过的字节**，所以探针在
    代理里加了双向计数器，并把字节数写进断言明细。

保活并不意味着可以不管超时：任何短于 30 秒的超时照样会掐断，链路上还可能有一跳你不知道。`self-hosting.md`
的「保活」与「超时陷阱」两节按这个事实重写了，`troubleshooting.md` 第 3 条里那句"端点之间会用
`Ping`/`Pong` 帧保活"（第 35 轮查出的不成立陈述）也换成了现在的事实。

## 五点六六、M5：崩溃上报、旧 CPU、审计范围（第 37 轮）

M5 的三项里，两项做完了，第三项（第三方审计）只能由别人做——因此 M5 的整体状态是**进行中**，而
"审计无高危"这一条**未达成**，不是"已完成"。三项分别如下。

### 一、崩溃上报可用（做完）

**没有服务器**：报告只走一跳，客户端 → 它已经配对的那台 daemon（密文隧道内）→
`$DSHD_STATE_DIR/crash-reports.jsonl`（0600），由 `drdshd crashes` 读、`drdshd crashes --clear` 删。
字段是完整清单：客户端版本、phase、`reached_ready`、错误/rejection 计数、最多 20 条 × 200 字节的失败
描述、UA、时间戳；**类型里没有地方放**房间密钥、设备私钥、配对码、消息内容或 URL。边界写在
`docs/security.md` § 5.10（含一条诚实的余地：错误消息本身可能含 URL，所以两次截断、两次去控制字符）。

daemon 不信客户端：条数、每条长度、整份报告的序列化长度、控制字符都自己再校验一遍，超限**具名拒绝**
（不是截断后收下——少了两百条失败的"报告"在撒谎）；文件满 20 份后拒绝而不是淘汰（被淘汰的正是要找的
那份）。客户端侧只在**这一次运行确实失败过**时才发，且**每次加载页只发一份**。

**实测**：`scripts/pwa-crash-smoke.mjs` **9/9**（真实中继 + 真实 daemon + Node 客户端：收下并落盘、
0600、`drdshd crashes` 能打印、超限被拒且磁盘无变化、不是报告的 body 被拒、清除后可再次写入）；
`scripts/browser-pairing-smoke.mjs` 加了三项后 **13/13**——真实浏览器里注入一次失败，连上之后报告
真的落到了 daemon 的状态目录（`phase=ready`、`reached_ready=true`、样例会带上那句话）、文件 0600、
控制台零错误。Rust 侧 `crashlog.rs` 7 个测试 + 控制面 3 个；TS 侧 `health`/`control`/`tunnel` 各加了测试。

**这条浏览器断言抓到了两个真实缺陷**，都是 Node 侧测试看不见的：

1. **`control is not defined`。** 崩溃上报引用了 `control`，而那个 `let` 声明在连接处理函数**内部**——
   ES 模块是严格模式，于是它抛 `ReferenceError`，被 `void` 掉的 promise 吞进 unhandled rejection：
   报告永远发不出去，页面上什么也看不出来。修法是把绑定提到模块作用域。
2. **session 先报 `ready` 再交出 tunnel。** 于是在 `ready` 那一刻还没有 control 客户端可用，上报被
   静默跳过。现在 `ready`/`failed` 与 `onTunnel` 两处都调用（"每次加载只发一份"的守卫保证只发一次）。

### 二、旧 CPU 的替代安装路径（做完）

**支持的下限是各架构的 baseline**（x86-64 = SSE2，aarch64 = armv8-a）：仓库里没有 `target-cpu=native`，
也没有开 `+avx2`，RustCrypto 的硬件加速是运行时按 CPUID 选的，标量路径一直都在。声明是被测过的：
`scripts/cpu-baseline-smoke.mjs` 用 qemu 把 CPU 模拟成 **2006 年的 Core 2、2008 年的 Nehalem、
2010 年的 Westmere**（三者都没有 AVX/AVX2），在每种 CPU 上跑 `version` / `doctor` / `room-key`，
再把 `dr-dsh-crypto`（49 个测试，含 SPAKE2、Ed25519、AES-GCM）、`dr-dsh-proto` 与一致性向量跑完，
最后让**中继在模拟 CPU 上真的起服务并回答 `/healthz`**——**13/13**。三种 CPU 覆盖两条实现路径：
Westmere 报 `aes` 可用（走 AES-NI），Core 2 与 Nehalem 报 `aes` 缺失（走软件实现）。

每组里有一条是**在测模拟本身**：`doctor` 必须报告这些扩展**缺失**，否则一个忽略 `-cpu` 的 qemu 会让
其余断言全部通过却什么都没证明。`drdshd doctor` 新增的 CPU 一行**从不判失败**（老 CPU 不是配置错误），
它把架构与扩展的 present/absent 打出来，让一次求助从事实开始。明确不支持：**纯 32 位的老机器**
（不分发 i686/armv7）；macOS/Windows 上的旧 CPU 适用同一条逻辑但没有等价的模拟实测。

### 三、审计范围文档（做完准备，审计本身未做）

[`../audit-scope.md`](../audit-scope.md)：审计对象、范围内四块（配对与密钥协商、帧复用与流控边界、
代理层请求改写、产物可复现性）、明确不在范围内的事、审计者需要的材料，以及**一张"声明 → 改坏它就红的
检查"表**——如果某条声明在表里找不到强制手段，那条声明就是散文，请按发现报出来。同一份文档里还有
**我们自己的高风险候选清单**（中继在客户端 TCB 内、配对限流按 daemon 全局计数、已配对设备可无限重启、
`--attach-token` 走命令行、Windows 无优雅停止、TS 侧手写密码学、崩溃上报里的错误消息、房间密钥配置
方式未决），按"坏了后果最大 / 最难事后发现"排序。

**这一项不能算完成**：M5 的完成标准写的是"审计无高危"，那是外部结论。本仓库不声称它。

### 四、顺手修掉的一处规格与实现不一致

要新增控制消息时去核对"新字段该叫什么"，发现 **wire 上的字段名一直是 `snake_case`**，而
`crates/dr-dsh-proto` 的模块文档与 `docs/protocol.md` § 7 都写着"一律 `camelCase`"，并把 TypeScript
镜像当作证据——镜像当时也确实是 camelCase。问题是**两端从来没用过那套名字**：daemon 写 `local_url`，
浏览器读的也是 `local_url`。分叉能活下来，是因为此前**没有任何测试提到过一个多词字段**。

现在：文档改成事实（含"这里原先写错了"的说明），TypeScript 镜像的字段名与 wire 对齐，`LifecycleResult`
补上客户端一直在读、而规范类型里缺失的 `accepted`，控制面改为**构造规范类型再序列化**（不再手写
JSON——手写正是 `accepted` 缺失的原因），并加了两条把每个 body 与每个 kind 的 wire 名字逐字钉住的测试。

### 五、这一轮的验证

- `pnpm run verify` **全绿**：Rust **255** 个测试 + TS **226** 个（PWA 181、protocol 34、plugin 8、crypto 3）
  + `docs:check`（29 个 Markdown、270 条相对链接；README 的快速开始与本轮新增文档的链接都算在内）。
- `scripts/pwa-crash-smoke.mjs` **9/9**；`scripts/cpu-baseline-smoke.mjs` **13/13**；
  `scripts/browser-pairing-smoke.mjs` **13/13**（真实浏览器，计时 7.9 秒）。
- **Docker 复验**（保活与崩溃上报之后重建镜像，两次）：容器里跑的是带保活的中继（启动日志
  `keepalive_secs`），`/healthz` 正常、外壳 3853 字节、`/client/shell.js` 200，且镜像里的客户端确实
  含崩溃上报（`/client/health.js` 有 `hasSomethingToReport`、`shell.js` 有 `reportOwnFailures`）；
  并让一个**真实 daemon 连到容器里的中继**，`scripts/pwa-tunnel-smoke.mjs` 取回真实 DSH 界面
  **27923 字节**、`__DSH_BOOT__` 存在。

## 五点六七、M6 的决策文档（第 37 轮）

M6 的目标是"多设备/多 daemon 管理、团队房间、去中心化推送"，完成标准是"开放问题 § 16 中的相关条目
**有明确结论**并落地"。本轮做的是前半句：**七条 ADR**，每条都有结论、被否决的方案与代价。落地是
M6 的实现阶段，尚未开始——本节把"已决定"与"已实现"分开写，避免把文档读成代码。

| ADR | 一句话结论 | 现状 |
| :--- | :--- | :--- |
| [0007](../decisions/0007-multiple-instances.md) 多实例 | 一个 daemon 一个 DSH；同机多实例 = 多个 daemon + 多个 `DSHD_STATE_DIR`；客户端一个设备身份 + 每房间一条记录 | **客户端部分已实现（第 38 轮，§ 五点七十）**；daemon 侧本就如此（多实例 = 多进程） |
| [0008](../decisions/0008-team-rooms.md) 团队房间 | **不做**多人共享一个 DSH；只读角色在代理层无法诚实实现，前置条件是角色模型 + 代理面审计 + DSH 多用户 | 决策已定（即"不做"），无需实现 |
| [0009](../decisions/0009-push-boundary.md) 推送边界 | 唯一称为端到端的是隧道；Web Push 的内容**对推送服务不可读、对浏览器厂商可见**，因此文档与 UI 里不称为端到端；去中心化推送排在 M6 之后 | 措辞已定；`security.md` § 5.4 已按此表述，推送实现本身仍未做（ADR-0006 默认关闭） |
| [0010](../decisions/0010-lan-direct.md) 局域网直连 | **不做**；daemon 永远只出站，局域网低延迟的出路是把中继放在局域网内 | 决策已定；`self-hosting.md` 加了"把中继放在局域网"的说明 |
| [0011](../decisions/0011-hosting-rules.md) 托管中继 | 自托管是唯一支持形态；中继**不预埋**任何为托管化的数据收集，限流留在自托管默认上；托管化的前置物是运营文档 | 决策已定；中继现状与之一致（无需改动） |
| [0012](../decisions/0012-audit-log-retention.md) 审计日志 | 本机 `audit.jsonl`（0600）、30 天 / 10 000 行滚动、只记事件不记内容、**永不上送**、`drdshd audit [--clear]` | 决策已定，**未实现**（当前审计仍只覆盖配对且走 stderr） |
| [0013](../decisions/0013-room-key-provisioning.md) 房间密钥 | 首次运行生成并落盘 `$DSHD_STATE_DIR/room-key`（0600），`run`/`pair` 都从那里读；`--room-key` 可覆盖但**不写盘**，且与文件不一致时要出声 | **已实现（第 38 轮，§ 五点六八）** |

三条 ADR 顺带修正/收紧了既有表述：

- ADR-0008 把"只读设备"这个隐含期待明确否掉——`may_control` 只限制生命周期命令，代理面对 DSH 界面的
  任何操作都不设限，因此今天不存在"只读协作"；`mvp.md` § 三的"不包含"表加上了团队房间。
- ADR-0010 把一个未决项变成"不做 + 一条零代码替代方案"（局域网内跑中继），并写明将来重新评估的三个条件。
- ADR-0011 把"托管化"从代码问题移回运营问题，并明确禁止为中继预埋 IP/房间 id 的持久化——自托管用户
  不该为将来可能的托管承担代价。

**M6 的实现工作**（按依赖排序）：~~房间密钥生成与落盘（0013）~~、~~审计日志模块与 `drdshd audit`（0012）~~、
~~客户端多房间记录与列表（0007）~~ **均已完成（第 38 轮）** → 推送通道（0009，可选，按 ADR-0006 默认关闭）。
团队房间（0008）与局域网直连（0010）按结论不做。

## 五点六八、M6 实现第一步：房间密钥（第 38 轮）

[ADR-0013](../decisions/0013-room-key-provisioning.md) 是三项已决事项里最小、也最先该做的一项，因为它
消除的是一个**安静的**失效：`drdshd run` 与 `drdshd pair` 以前各自要求 `--room-key`，给成不同的值就会
得到一个永远连不上的设备，现象是 `no daemon is serving this room`——既不说密钥，也不说是哪个命令错了。

### 实现（新增 `crates/dr-dsh-daemon/src/roomkey.rs`）

解析顺序：`--room-key` → `$DSHD_STATE_DIR/room-key` → 生成一把并写进去（0600）。三条"不做"写在模块
文档里，每条都有理由：

- **不打印密钥**。配对是把密钥交给设备的唯一方式；打印一次"方便一下"的密钥会留在终端回滚、
  `journalctl` 和粘贴出去的日志里。打印的是**路径**——备份或删除时才需要它。
- **不把命令行给的密钥写盘**。命令行是泄露路径（shell 历史、`ps`、systemd 的 `Environment=`），
  所以 `--room-key` 只对这次运行生效；它与文件里的值不同时打印一条 `NOTE`，说明文件没有被改动。
- **不替换读不出来的密钥**。文件被截断或损坏时报错并**带上路径、长度、以及替换它的代价**（"每个用旧
  密钥配对的设备都要重新配对"）。悄悄重新生成会让所有已配对设备失效——与设备登记表"损坏即失败关闭"
  同一条规则。文件用 `create_new` 打开，所以"不覆盖"是系统调用层面的性质，不是注释里的承诺。

### 验证

- `roomkey` 单元测试 **9/9**：首次生成并 0600、第二次读到同一把、命令行密钥不落盘、与文件冲突时被
  报告且文件不变、同一把不算冲突、损坏/截断/空文件各自失败且原文件一字未动、**公告与 `Debug` 里
  都不含密钥**。
- `scripts/room-key-smoke.mjs` **12/12**（真实中继 + 真实二进制 + PWA 自己的配对与隧道模块）：
  `pair` 不带 `--room-key` 生成并落盘 0600 且**从不打印密钥** → 客户端用打印出来的配对码配对，
  拿到的密钥与文件里的**逐字节相同** → `run` 不带 `--room-key` 读到同一个文件，服务的房间等于
  用文件推导出的房间 → 客户端带着配对得到的设备身份取回**真实 DSH 界面 200 / 27923 字节
  （`__DSH_BOOT__` 存在）** → 另一把 `--room-key` 被使用并打印 NOTE、文件不变 → 损坏的密钥文件让
  进程**以非零退出并说明原因**，文件保持原样。
- 文档同步：`install.md` 的两个命令不再要求密钥并写明"要备份的是整个状态目录"；`troubleshooting.md`
  新增 § 3.5（`no daemon is serving this room` 的三种成因，含"会合房间与服务房间不同是正常的"）；
  `drdshd --help` 说明默认来源。

### 下一项

ADR-0012（审计日志）：本机 `audit.jsonl`、30 天 / 10 000 行滚动、闭集事件、`drdshd audit [--clear]`、
`DSHD_AUDIT=0` 关闭开关。它是"谁在什么时候动过这台机器"的答案，也是团队房间（ADR-0008）被否决的
前置条件之一。

## 五点六九、M6 实现第二步：审计日志（第 38 轮）

[ADR-0012](../decisions/0012-audit-log-retention.md) 要回答的是"谁在什么时候动过这台机器"。在它之前，
审计事件只覆盖配对、而且只写 stderr——重定向到哪里、留多久、谁能读，全都不确定。

### 实现（新增 `crates/dr-dsh-daemon/src/audit.rs`）

- **落点与格式**：`$DSHD_STATE_DIR/audit.jsonl`，一行一个 JSON 对象，0600。五个字段，手写序列化而不是
  在结构体上 `#[derive]`：字段集**就是**隐私承诺，将来给结构体加一个字段会悄悄削弱它。
- **闭集事件**：配对四类（accepted/refused/failed/locked_out）、`device_revoked`、
  `tunnel_established`、`tunnel_released`、`lifecycle_command`；闭集结果 `ok` / `refused` / `failed`。
  事件表同时被写入端与读取端使用（`Event::as_str` / `Event::parse` 是同一份列表），所以加一个事件而
  忘了另一端会**在测试里失败**，而不是变成一行读不出来的记录。
- **保留**：30 天或 10 000 行，先到者为准，在写入路径上执行（daemon 是前台进程，没有 cron 可依赖）。
  需要丢弃时通过临时文件 + `rename` 重写——审计日志是唯一一个"少了几行"与"有人删了几行"必须能区分的
  文件。不需要丢弃时只追加，不做任何重写。
- **读取时同样过滤**：daemon 很久没跑过的机器上，文件可能装着超出窗口的记录；`drdshd audit` 按同一个
  窗口过滤并把隐藏了几条说出来。
- **读不出来的行保留**：一行不是本版本认识的记录时，它既留在文件里、也在 `drdshd audit` 与
  `drdshd doctor` 里被点名——删掉它等于销毁"有人写了一行解释不了的东西"这个事实。
- **失败不阻断**：写不进去（磁盘满、目录被删）只打印一次警告，隧道与配对照常工作。把"审计写不下去"
  变成"服务不可用"，等于给能写满磁盘的人一个拒绝服务。`drdshd doctor` 会把这件事显示出来——这正是
  它需要出现在 doctor 里的原因：这个失败按设计是无声的。
- **`DSHD_AUDIT=0` 关闭**，且 `drdshd audit` 会明确说"审计已关闭"，而不是显示"没有事件"——两者对排障的
  含义完全相反。

隧道事件由 uplink 记录（它是唯一同时知道"会话开始"与"会话结束"、以及"哪台设备"的地方）：为此
`Transport` 现在记住验证过的设备 id（`bound_device()`），`CarrierConfig` 带上审计目录。生命周期命令由
控制面在**结果产生之后**记录——审计要回答的是"进程发生了什么"，不是"有人问了什么"。

### 验证

- `audit` 单元测试 **13/13**：一行一个事件且字段集固定、每个事件与结果都能往返、0600、控制字符不能
  伪造第二行或终端转义、超期条目在下次写入时被删、超过行数上限时最旧的被删（最新的还在）、读不出来的
  行被保留并上报、不需要丢弃时不重写（无残留临时文件）、超期条目在读取时被隐藏、`DSHD_AUDIT` 只有
  恰好 `0` 才关闭、清除幂等、**写入失败不 panic 也不返回错误**。
- `describe_time` 的 UTC 换算有单独测试（epoch、2023-11-14T22:13:20Z、2000-02-29 闰日、`u64::MAX`
  不 panic）——手写日历算术必须被测，而它存在的理由是"不想为了一个时间戳给 daemon 加一个日期库"。
- `scripts/audit-smoke.mjs` **16/16**（真实中继 + 真实二进制 + PWA 的配对/隧道/控制面模块）：一次配对
  留下一行并带上设备与标签、日志 0600、一次会话建立记录**设备 id**、控制面的 stop 记录结果、客户端
  断开后记录释放、撤销设备作为操作者动作被记录、**整个文件不含房间密钥**、一个被限流的配对在
  **生成码之前**被拒并把 `pairing_refused` 与原因写进日志、`drdshd audit` 把五类事件连同设备 id
  打印出来、`DSHD_AUDIT=0` 时说的是"关闭"、清除后读取端仍可用、以及一个带 `DSHD_AUDIT=0` 启动的
  daemon **完全不创建文件**。
- 过程中修掉一个**测试自身的竞态**：客户端配对一完成就杀掉 daemon 侧的 `pair` 进程，会与它随后写
  `pairing_accepted` 的那一步赛跑（现象是"配对事件缺失，其它事件都在"）。现在等它打印 `paired` 再杀。

## 五点七十、M6 实现第三步：客户端多房间（第 38 轮）

[ADR-0007](../decisions/0007-multiple-instances.md) 的最后一块是客户端：**一条设备身份 + 每房间一条记录**。
在这之前，浏览器只存一条记录（身份与房间密钥捆在一起），于是与第二台电脑配对会**静默替换**第一台的
密钥——第一台机器从此连不上，而页面上没有任何地方能看出丢了什么。

### 实现

- `apps/pwa/src/storage.ts` 重写为两个存储：`identity`（私钥、公钥、device id，全浏览器一份）与
  `rooms`（每房间一条：房间密钥、房间 id、标签、配对时间、上次使用时间）。IndexedDB 版本从 1 升到 2，
  升级事务里把 v1 的记录拆成两份、**并删除旧的 `device` 存储**——同一把私钥留两份就是两个泄露面。
  迁移是纯函数（`migrateLegacy`），因此能在 Node 里测；升级本身在浏览器里实测（见下）。
- `identity.ts`：`IdentityRecord`（身份）与 `DeviceRecord`（配对结果 = 身份 + 房间）分开；原先放在
  `restoreDevice` 里的"房间密钥必须与房间 id 相符"检查移到 `checkRoom`，因为房间现在是**调用方选的**。
- `session.connect({ roomKey, room, device })`：房间显式传入（身份不再携带房间），并在打开 socket 之前
  校验房间记录与自己的密钥一致、身份与自己的公钥一致——两类损坏都在能说清"重新配对"的地方失败。
- `pair.ts`：`pairWithCode` 接受一个既有身份并**复用它**。这是本轮最关键的修正：第二次配对时若照旧
  生成新身份，第二台 daemon 会登记新设备，而第一台会回答 "this device is not paired with that daemon
  any more"——两台机器只有一台能用。**是两房间浏览器实测抓到的**（第一版实现就是这样，上面那句页面
  文字原样来自那次失败）。
- `shell.js`：加载时读身份与房间列表，渲染"Your computers"列表（选中项、上次使用时间、单独的 Forget
  按钮），连接时用选中的房间；连上后把该房间标为最近使用。列表标签是 `浏览器名 · 房间 id 前 4 位`——
  第一版给两行都写"Chrome on Linux"，因为标签只用了浏览器名（同样是实测抓到的）。

### 验证

- `storage.test.ts` **11/11**：v1 记录迁移成一份身份 + 一个房间（含标签来自房间 id 这一事实）、损坏的
  v1 记录迁移为 `null` 而不是半个配对、身份与房间各自的形状校验、列表排序与稳定次序、内存存储的
  "第二次配对是新增而不是替换"、"忘记一个房间保留身份"、"重新配同一台机器保留首次配对时间与上次使用时间"。
- `session.test.ts` 新增"房间密钥与房间名不符时在打开 socket 之前就拒绝"；`pair.test.ts` 新增
  "第二次配对出示浏览器已有身份"（同一公钥、同一 device id）与"没有身份时仍然生成新的"。
- `scripts/browser-rooms-smoke.mjs` **14/14**（真实中继 + 两个真实 daemon + 真实浏览器）：**真实 v1
  数据库的迁移**（先拦掉 shell、用 IndexedDB API 手写旧记录，再让页面打开它——迁移后 identity/rooms
  都在、旧的 `device` 存储消失）、第一次配对成为一台机器、第二次配对**新增**而不是替换、两行**可分辨**、
  切换后连接的是**被选中的那台**（由两台 daemon 各自的审计日志证明：laptop 0→1、desktop 0→0）、
  两台 daemon 列出**同一个 device id**（一条身份两处授权）、忘掉一台之后另一台仍可用、控制台零错误。

### M6 到这里的完整状态

三项已实现（房间密钥 0013、审计日志 0012、客户端多房间 0007），两项按决策不做（团队房间 0008、
局域网直连 0010），推送（0009）仍未实现且按 ADR-0006 默认关闭。**M6 因此仍是"进行中"而不是"完成"**：
剩下的是推送通道这一可选项，以及已经在文档里写明"不做"的两项——它们不是待办，是结论。
另外两件已知的收尾项：房间**重命名**还没有 UI（标签目前由浏览器名与房间 id 前缀自动生成，ADR-0007 的
"一个人能分辨两台机器"因此靠的是 id 前缀而不是人给的名字）；多实例在同一台机器上时两个 daemon 的
浏览器标签会带不同房间前缀，但 daemon 侧 `drdshd devices` 里同一台设备同名——那是设备标签，不是房间标签。

## 五点六、MVP 验收标准的当前状态

八条标准逐条对照，**哪些有证据、哪些没有**。写这张表的目的是让「M2 完成」这句话有具体的含义，
而不是让读者从各阶段的进度行里自己推断。

| # | 标准 | 状态 | 证据 |
| :--- | :--- | :--- | :--- |
| 1 | 连通：新设备输入一次配对码即可 | **已达成** | 真实浏览器（Chromium）里走完原文路径：全新页面（无存储）→ 输入一次 `drdshd pair` 的码 → 配对完成 → 连接上**要求已登记设备**的 daemon → 真实 DSH 界面渲染（254 节点）→ **刷新后无需再输入任何东西**即重新连上。`scripts/browser-pairing-smoke.mjs` **13/13**（第 37 轮加了一条浏览器侧的崩溃上报检查，见 § 五点六六），其中一条是计时：**从码被打印到界面渲染完成 7.9 秒**，断言 `< 120 秒`（标准里的"总耗时 < 2 分钟"）；同一批模块在真实栈上的非浏览器路径另有一条 `scripts/pwa-pairing-smoke.mjs` **12/12**（§ 五点五七、§ 五点五八）。 |
| 2 | 保真：远程界面就是本机界面，长会话不降级 | **已达成（验收方式四件全跑通）** | 真实浏览器里界面**已经渲染并活着**：`__DSH_BOOT__` 存在、`__ModuleLoader__.mode` 为 `live`、254 个节点、标题 `DSH Local Build`、正文含版本与导航、**不再显示 `Reconnecting…`**；HTTP 与 WebSocket 两条链路都由隧道承载；一条 27923 字节的响应完整穿过；控制台零错误；浏览器冒烟 8/8。**第 29 轮起可以真的跑任务了**：`scripts/browser-task-smoke.mjs` **8/8** 通过——界面渲染、mux 实时流应答、工作区选择、新建会话、发送提示词、**模型的原话（一个随机令牌）经隧道回到渲染出来的页面**。**第 30 轮补齐了标准的验收方式**：`scripts/browser-task-smoke.mjs --full` **13/13**——把会话切到 view only 使沙箱先拒绝，agent 请求升级，**审批卡片经实时流抵达远端**并被点下"允许一次"，工具执行完成并把令牌交回；随后第二轮回答渲染出 **31149 字符**的单个块。即「多轮 + 至少一次审批 + 一次工具调用 + 一次长输出」四件都在真实浏览器里跑通（§ 五点六十）。标准里另半句"长会话（>1000 条消息）滚动不降级"属 M3 的性能项，**未测、也不声称**。 |
| 3 | 零知识：中继不持有明文 | **已达成** | `crates/dr-dsh-relay/tests/zero_knowledge.rs`（依赖闭包中无任何密码学 crate、中继不触碰 payload 语义）；ADR-0002 的强制手段。 |
| 4 | 生命周期：远程启停重启 + 自愈 + 「正在恢复」 | **已达成** | 真实 `kill -9` 后约 5 秒拉起新进程并继续服务；远端在恢复期间读到 `state:"starting"`、`pid:null`，恢复后是新 pid。 |
| 5 | 附着模式：按钮禁用并说明原因，界面仍可用 | **已达成** | 手工启动的 DSH + `--attach --attach-token`：界面 3/3 取回真实 DSH，`start`/`stop`/`restart` 各自被具名拒绝，控制面 12/12 断言。 |
| 6 | 失败透明：三种故障各有明确且不同的提示 | **已达成** | 真实栈逐条实测：断中继 → 「The connection to the relay dropped」；杀 daemon → 「Your computer is not answering」；未配对 → 「the daemon requires a paired device and this client is not paired」。 |
| 7 | 配对安全：码 300 秒过期、单次使用、有审计 | **已达成** | `PendingCode::consume` 在 SPAKE2 之前烧码（单测固定）；过期与「过期后不会复活」有测试；实测 5 次失败锁定 300 秒、第 6 次**在生成码之前**被拒；审计事件四类。 |
| 8 | 回环绑定：拒绝把 DSH 绑到非 loopback | **已达成** | DSH 对 `--host 0.0.0.0` 硬拒绝，daemon 从不传该参数；daemon 自己的 `dsh_base_url()` 只产出 `127.0.0.1`，并有测试固定。 |

**结论：M2 完成。** 八条验收标准**全部达成并有实测**——标准 1 在真实浏览器里用配对码走通并计时
（8.2 秒，§ 五点五八），标准 2 的验收方式（多轮 + 审批 + 工具调用 + 长输出）在真实浏览器里跑完
（§ 五点六十），其余六条各自的证据见上表；三个平台各有安装说明（`docs/operations/install.md`）；
M2 结束要求的**实现评审**已做完并记录在 `docs/security.md` § 5.9；`pnpm run verify` 全绿。

两件事**明确不在"M2 完成"之内**，列在这里以免被读成"没有"：

1. **Windows 上的优雅停止**：daemon 无法向 DSH 发送 SIGTERM 的对应物，DSH 被直接终止，插件树不走销毁
   流程。安装说明写明了这一差异；解决它需要平台特定实现，记为 M2 的收尾项。
2. **已配对设备可无限次重启 DSH**：驱动串行执行命令但没有限流。它落在"拿到已配对设备就等于拿到本机
   操作权"的边界内，因此不在 MVP 内修，但作为已知剩余风险记在 § 5.9。

## 五点七一、M4 安装与运维补充（2026-09-15）

新增 `install.sh` 和统一 `drdsh` 命令，可分别安装 daemon、中继、PWA、可选插件，并管理启动、
停止、重启、状态、日志、登录自启动、设备配对和卸载。使用用户级 launchd/systemd，配置与房间
身份在升级/卸载时保留；daemon 支持服务管理器的 SIGTERM，并在启动中取消时清理子进程。

验证：`pnpm run verify` 通过；macOS 真实二进制服务冒烟 **21 项**、默认 release 中继安装/重启/卸载
通过；Debian 12/systemd 用户管理器替身进程验证 **10 项**。DSH 使用替身，真实插件升级仪式未测。
此项补齐源码安装与运维入口，发布流水线、原生 Windows 服务、插件上报接收端与 daemon WSS
仍未实现；不据此声称已达到新用户部署成功率目标。命令与边界见 [`../operations/cli.md`](../operations/cli.md)。

## 五点七二、Relay 与 Daemon 独立入口（2026-09-16）

新增 `relay/`、`daemon/` 两套安装脚本与中英文说明，分别提供 `drdsh-relayctl` 和 `drdsh-daemonctl`。
即使同机、同 prefix，两侧也分别保存配置、程序、日志、系统服务与更新锁。PWA 随 relay 安装，
插件属于 daemon；更新或卸载一侧不会重启或卸载另一侧。旧 `drdsh` 入口保留兼容，迁移时显式沿用原状态目录。

`pnpm run verify` 通过；CLI 检查 **7 项**、macOS 真实进程检查 **34 项**通过，包括两侧 PID/配置不受
对方更新影响、独立卸载与重装、配对状态保留。DSH 与插件 CLI 使用替身，未新增上游 DSH 实测结论。
见 [ADR-0015](../decisions/0015-independent-relay-and-daemon.md) 和[安装与迁移说明](../operations/cli.md)。

## 六、仍待决定的事项

本节记录**尚未决定**的点。已经被决定的移到了 ADR，并在下面留一行指针——写在这里的每一条都应当
能回答"为什么还没定"。

**已决定（第 37 轮，M6 的决策文档）**：

| 原来的问题 | 结论 | 记录 |
| :--- | :--- | :--- |
| Web Push 的端到端边界 | 唯一称为端到端的是隧道；Web Push 对推送服务不可读、对浏览器厂商可见，因此**不称为端到端** | [ADR-0009](../decisions/0009-push-boundary.md) |
| 局域网直连是否需要 | **不做**；daemon 永远只出站，局域网低延迟的出路是把中继放在局域网内 | [ADR-0010](../decisions/0010-lan-direct.md) |
| 中继的滥用处置 | 自托管是唯一支持形态；中继不预埋任何为托管化的数据收集，限流留在自托管默认上 | [ADR-0011](../decisions/0011-hosting-rules.md) |
| 多 DSH 实例 | 一个 daemon 一个 DSH；同机多实例靠多个 daemon + 多个状态目录，客户端记住多个房间 | [ADR-0007](../decisions/0007-multiple-instances.md) |
| 审计日志的保留策略 | 本机 `audit.jsonl`（0600）、30 天 / 10 000 行滚动、只记事件不记内容、**永不上送** | [ADR-0012](../decisions/0012-audit-log-retention.md) |
| 房间密钥的配置方式 | 首次运行生成并落盘 0600，`run`/`pair` 都从那里读；命令行可覆盖但**不写盘** | [ADR-0013](../decisions/0013-room-key-provisioning.md) |
| 团队房间 | **不做**多人共享一个 DSH；只读角色在代理层无法诚实实现 | [ADR-0008](../decisions/0008-team-rooms.md) |

**仍未决定**（每条都写清为什么还没定）：

- **托管服务的运营主体与商业模式**：技术形态已经决定（ADR-0011），剩下的问题不是本仓库能回答的：
  谁承担滥用责任、谁付费、在哪些司法辖区运营。在有人愿意署名承担之前，自托管是唯一形态。
- **多实例的客户端 UI 细节**：ADR-0007 定了"一个身份 + 每房间一条记录"，但房间列表的呈现
  （排序、命名、离线房间怎么显示）没有定；它应当由真实使用决定，而不是先在文档里画出来。
- **Windows 上 DSH 的优雅停止**：daemon 无法向 DSH 发送 SIGTERM 的对应物，DSH 被直接终止，插件树
  不走销毁流程（`docs/security.md` § 5.9 第 3 条）。解决它需要平台特定实现，目前记为 M2 的收尾项。
- **反向代理之外的入口形态**：CDN、云负载均衡、隧道服务（Cloudflare Tunnel 之类）都被文档讨论过，
  但没有一条被实测过（`operations/self-hosting.md` 只覆盖 nginx 与 Caddy）。它们各自会引入自己的
  空闲超时与头部改写，实测之前不写进"支持"。
- **发布产物与可复现构建**：v0.1.0 提供四个 Release tar 与 SHA256SUMS，见[发布说明](../operations/releases.md)。
  独立签名、自动 CI 发布和可复现构建仍是审计范围 § 2.4 的工程缺口。


### v0.1.0 原生统一 CLI 与分发

新增 `drdsh relay` / `drdsh daemon`、名称别名和包清单组件限制。CLI 打印 ASCII Logo；
两侧安装运维使用 Rust。Linux x86_64 musl 发布 mixed/relay/daemon，macOS arm64 发布 daemon。
安装脚本从 GitHub Release 下载并校验摘要，`update` 保持组件服务隔离；PWA 可由 nginx 静态托管。
设计与边界见 [ADR-0017](../decisions/0017-multicall-release-packages.md)。
