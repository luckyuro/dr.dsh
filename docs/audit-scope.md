# 第三方安全审计：范围与材料

本文是给**外部审计者**的范围说明，也是 M5 那条"审计无高危"的诚实边界：**这个结论不能由本仓库自称**。
能由我们做到的，是把"审计可以现在开始"这件事准备到位——范围、材料、可重放的实证、已知的高风险候选，
以及结论如何被公开。本文**不声称**已经过审计。

要一份计划而不是范围，看 [`product/mvp.md`](product/mvp.md) § 四（三段式审计：内部威胁模型评审 →
实现评审 → 第三方深度审计，前两段已完成）。威胁模型本身在 [`security.md`](security.md)，尤其 § 1（防谁、
不防谁）、§ 2（保证）、§ 5（**不保证什么**——那一节与保证同样重要，审计者应当从它开始）。

---

## 1. 审计对象

一个让用户从任意设备访问**自己电脑上**的 DSH 的系统，四个组件：

| 组件 | 位置 | 语言 | 为什么它在范围内 |
| :--- | :--- | :--- | :--- |
| 中继 | `crates/dr-dsh-relay` | Rust（axum/tokio） | 唯一面向公网的组件；零知识是它的全部卖点，也是它唯一值得被攻击的地方 |
| daemon | `crates/dr-dsh-daemon` | Rust | 持有本机权限：监督 DSH 进程、代理其 HTTP/WS 面、保管设备登记表与房间密钥 |
| 本地管理与分发 | `crates/dr-dsh-cli`、`scripts/release-install.sh`、`scripts/package-release.sh`；旧 `dr-dsh-relayctl` 回归路径 | Rust / Shell | 统一命令、按包分派、本地安装与用户服务；不携带 JS 管理运行时 |
| 协议与密码学 | `crates/dr-dsh-proto`、`crates/dr-dsh-crypto` | Rust（规范） | 帧编解码、密钥派生、SPAKE2 配对、设备身份 |
| 浏览器客户端 | `apps/pwa`、`packages/protocol`、`packages/crypto` | TypeScript | 与 Rust 端各自实现同一套协议（**跨语言分叉是这份清单里最现实的风险**） |

## 2. 范围内的四块（与 `product/mvp.md` § 四的承诺一一对应）

### 2.1 配对与密钥协商

- SPAKE2 的**两份独立实现**：Rust（`spake2` crate + `crates/dr-dsh-crypto/src/pairing.rs`）与
  TypeScript（`apps/pwa/src/ed25519.ts`，自写的扩展坐标群运算）。它们必须由同一套向量固定
  （`crates/dr-dsh-crypto/src/pairing.rs` 的向量 + `crates/dr-dsh-crypto/tests/pairing_vectors.rs`）。
  **审计者应当重点攻击 TS 那一份**：手写的群运算没有 Rust 侧的成熟度，而它的失效模式是"算错点仍
  然能跑通"。
- 配对码的熵与生命周期：40 位熵、300 秒 TTL、**单次使用**（`PendingCode::consume` 在 SPAKE2 之前
  就烧码）、5 次失败锁定 300 秒（`crates/dr-dsh-crypto/src/throttle.rs`）。
- 设备身份与授权：登记表是唯一授权模型；"表存在但为空"与"从未配对"是两种状态（撤销最后一个设备
  不能让门重新打开）；登记表损坏时失败关闭。
- 授权变更的留痕：配对、撤销、隧道建立与释放、生命周期命令都会写进本机审计日志（ADR-0012），
  审计者应当检查**事件集合是否闭集**、能否被伪造（控制字符）、以及是否真的不含内容。
- 会话层：HKDF 派生的方向性密钥、计数器进 AAD、跨盐交换的计数器结转、设备 nonce 挑战（绑房间）。

### 2.2 帧复用与流控的边界

- wire 格式与上限：`crates/dr-dsh-proto`（帧头、`MAX_PAYLOAD_LEN`、窗口、并发流、`WIRE_MAJOR` 协商）。
- **跨语言一致性**：`packages/protocol/conformance/vectors.json` 是规范性文件，两端都必须逐字节通过；
  向量由 `scripts/ws-conformance.mjs` 生成（`pnpm run gen:vectors`），改向量等同于 wire-breaking change。
- 中继对畸形帧的处理：拒绝而不转发（`crates/dr-dsh-relay/tests/routing.rs`），以及它对 payload 的
  完全无知（`crates/dr-dsh-relay/tests/zero_knowledge.rs`）。

### 2.3 代理层的请求改写（谁能影响发往 DSH 的请求）

这是"远端能做什么"的实际边界，也是最容易出细节漏洞的一层：

- 发往 DSH 的请求由 daemon 用它**自己鉴权时的 loopback authority** 重建；客户端的 `Host`/`Cookie`/
  `Origin`/`Referer` 被替换而不是转发（`is_authority_owned`）；body 由 daemon 拥有时 `content-length`
  被丢弃（`is_body_owned`）。
- 目标只接受 origin-form；绝对 URL、穿越序列、跨主机 authority 被拒绝并把原因回告客户端。
- `/api/remote.mux` 的 WebSocket 升级与帧双向搬运（代理解析一次握手后只搬字节）。
- 客户端侧的同源边界：Service Worker 只改写同源请求、只缓存客户端自己的文件、`/` 只在导航请求上
  被缓存（`apps/pwa/src/offline.ts` 的 `isClientOwned` / `isCacheable`）。

### 2.4 发布产物的可复现性

- 依赖锁定：`Cargo.lock`、`pnpm-lock.yaml`（`pnpm run verify` 用 `--frozen-lockfile` 的路径见 `Dockerfile`）。
- 构建基线：没有 `target-cpu=native`、没有 `+avx2`；旧 CPU 的可运行性由 `scripts/cpu-baseline-smoke.mjs`
  在模拟的 Core 2 / Nehalem / Westmere 上实测（13/13）。
- 容器镜像：`Dockerfile` 三阶段（客户端 → 只编 `-p dr-dsh-relay` → debian-slim 非 root + `read_only`），
  构建命令与 `compose.yaml` 在 [`operations/self-hosting.md`](operations/self-hosting.md)。
- **发布现状**：v0.1.0 提供四个 Release tar.gz 与 SHA256SUMS，脚本和构建目标见
  [二进制发布](operations/releases.md)。**已知不足**：没有独立签名、自动 CI 发布或可复现构建认证；
  同源下载的摘要只校验传输内容，不提供独立供应链信任。

统一 CLI 的混合二进制同时包含 daemon 与 relay；relay 包使用同一份二进制，包清单禁用 daemon 命令；CLI 管理层
使用 SHA-256 保持服务名兼容。以下依赖约束针对网络 relay crate，不能声称混合二进制无密码学能力。

### 2.5 零知识是**构建期**属性

ADR-0002 把"中继不持有明文"实现为依赖图上的约束，而不是行为承诺。审计者应当尝试**破坏**它：给中继
加一个依赖、改一个 feature、在 `crates/dr-dsh-relay` 里 import `dr-dsh-crypto` 或 `dr-dsh-proto::control`，
然后确认 `crates/dr-dsh-relay/tests/zero_knowledge.rs` 会失败。仓库规则（[`../AGENTS.md`](../AGENTS.md)）
把这条列为五条硬规则之一。

## 3. 明确不在范围内

写出来是为了不让预算花在这些地方：

| 不在范围内 | 原因 |
| :--- | :--- |
| DSH 自身的漏洞 | 上游项目，不由本仓库维护；我们只监督并代理它（ADR-0003） |
| 浏览器与 WebCrypto 的实现 | 平台代码；我们只用它的公开接口 |
| 用户机器的操作系统安全、磁盘加密、恶意软件 | 威胁模型明确排除（`security.md` § 1） |
| DSH 的插件生态与用户自己的 prompt/agent 配置 | 同一台机器上的本机代码，与本系统无关 |
| 托管中继的运营、合规与滥用处置 | 尚未有托管服务（`product/mvp.md` § 三、§ 六） |
| "已配对设备 = 本机操作权"这条边界**之内**的攻击 | 已配对设备本来就能做 DSH 能做的一切；这条边界本身在 § 5.3 与 § 5.9 写明 |
| 供应链（crates.io / npm 上游包的实现） | 依赖清单在范围内，上游包自身的代码不在 |

## 4. 审计者需要的材料

| 材料 | 位置 / 命令 |
| :--- | :--- |
| 仓库 | 本仓库根目录（`Cargo.toml`、`pnpm-workspace.yaml`） |
| 规范 | [`protocol.md`](protocol.md)（帧、握手、控制消息）、[`architecture.md`](architecture.md)（组件与数据流） |
| 威胁模型与保证 | [`security.md`](security.md) § 1–2、§ 5（剩余风险） |
| 决策记录（含被否决的方案） | [`decisions/`](decisions/)（尤其 0002 零知识、0003 不 fork、0004 wire、0005 PWA） |
| 一条命令跑完全部检查 | `pnpm run verify`（Rust 检查 + clippy `-D warnings` + Rust/TS 测试 + 导入隔离 + 文档链接） |
| 起一个完整栈 | [`operations/self-hosting.md`](operations/self-hosting.md)（中继）+ [`operations/install.md`](operations/install.md)（daemon） |
| 可重放的实证脚本 | `scripts/pwa-tunnel-smoke.mjs`、`scripts/pwa-control-smoke.mjs`、`scripts/pwa-crash-smoke.mjs`、`scripts/deploy-probe.mjs`、`scripts/cpu-baseline-smoke.mjs`、`scripts/browser-*.mjs` |
| 需要真实 DSH 的验收测试 | `cargo test --workspace -- --ignored`（`crates/dr-dsh-daemon/tests/real_dsh.rs`、`acceptance.rs`） |

### 4.1 声明 → 会失败的检查

每一条安全声明都应当有一个"改坏它就红"的检查。这张表是审计的入口：**如果某条声明在这里找不到
对应的强制手段，那条声明就是散文**。

| 声明 | 强制手段 |
| :--- | :--- |
| 中继不持有明文，且在构建期被强制 | `crates/dr-dsh-relay/tests/zero_knowledge.rs`（4 个测试，含"扫描器能发现预期形状"的自检） |
| 中继拒绝畸形帧而不转发 | `crates/dr-dsh-relay/tests/routing.rs`（含"刚 park 的 carrier 上只有保活流量"） |
| 两端 wire 格式一致 | `packages/protocol/conformance/vectors.json` + `crates/dr-dsh-proto/tests/conformance.rs` + `apps/pwa/src/tunnel.test.ts`（nonce/AAD 布局） |
| 控制面白名单是闭集 | `crates/dr-dsh-daemon/src/control.rs` 的 `no_operation_can_carry_an_argument_into_the_driver` |
| 控制面字段名（wire）不被改名 | `crates/dr-dsh-proto/src/control.rs` 的 `every_body_keeps_its_wire_field_names` / `every_kind_keeps_its_wire_name` |
| 发往 DSH 的请求由 daemon 决定 authority | `crates/dr-dsh-daemon/tests/proxy.rs`（authority、body、跨主机目标拒绝）+ `apps/pwa/src/proxy.test.ts` |
| 配对码单次使用、过期、限流 | `crates/dr-dsh-crypto/src/{pairing,throttle,registry}.rs` 的测试 + `crates/dr-dsh-daemon/tests/pairing.rs` |
| 未配对设备进不来（且撤销最后一个设备不会重新开门） | `crates/dr-dsh-crypto/src/registry.rs` 的策略测试 + 真实栈冒烟 |
| 密钥不出现在日志/Debug/解析错误里 | `crates/dr-dsh-daemon/src/dsh/ready.rs` 的 `a_credential_never_appears_in_a_parse_error_or_a_debug_print` |
| DSH 只被绑在回环 | `crates/dr-dsh-daemon/src/config.rs` 的 `base_url_is_always_loopback` + `real_dsh.rs` 的拒绝测试 |
| 只有 `dsh-surface.ts` 能 import DSH | `node scripts/check-dsh-isolation.mjs`（`pnpm run lint:imports`） |
| 离线缓存只碰客户端自己的文件 | `apps/pwa/src/offline.test.ts`（`isClientOwned` / `isCacheable`）+ `scripts/browser-offline-smoke.mjs` |
| 崩溃上报的边界（条数、长度、控制字符、0600） | `crates/dr-dsh-daemon/src/crashlog.rs` + `src/control.rs` 的测试 + `scripts/pwa-crash-smoke.mjs`（9/9） |
| 审计日志只记事件、不记内容、本机 0600、可关闭且「关闭」与「空」可区分 | `crates/dr-dsh-daemon/src/audit.rs`（13 个测试）+ `scripts/audit-smoke.mjs`（16/16，含「文件里不含房间密钥」） |
| 房间密钥不落命令行、不打印、损坏即失败 | `crates/dr-dsh-daemon/src/roomkey.rs`（9 个测试）+ `scripts/room-key-smoke.mjs`（12/12） |
| 旧 CPU 上可运行 | `scripts/cpu-baseline-smoke.mjs`（模拟 Core 2 / Nehalem / Westmere 上 13/13） |
| 反向代理超时能被认出并点名 | `crates/dr-dsh-daemon/src/deployment.rs` 的单测 + `scripts/deploy-probe.mjs`（8/8） |

## 5. 已知的高风险候选（我们自己认为最该被攻击的地方）

按"如果它坏了，后果最大 / 最难在事后发现"排序。**这不是审计结论**，是我们的自我怀疑清单：

1. **中继在客户端的可信计算基里**（`security.md` § 5.1）：客户端 JS 由中继提供，一个被攻破的中继可以
   给某个用户发一份作恶的客户端。协议层的零知识不能防这一条，能防的是"浏览器拿得到的那份代码是否
   可被独立核对"。审计者应当评估这条边界在现实中的可行性（例如用户如何核对它拿到的 JS）。
2. **配对限流按 daemon 全局计数，而不是按来源**（§ 3.1）：一个攻击者可以让合法用户在 300 秒内配不上对。
   这是可用性缺口，不是冒充缺口——但它是被利用成本最低的一条。
3. **已配对设备可以无限次下发 `restart`**（§ 5.9）：没有速率限制，只有串行化。
4. **`--attach-token` 走命令行**会出现在 `ps` 与 shell 历史里（§ 5.9 第 2 条）。
5. **Windows 上没有优雅停止**：DSH 被直接终止，插件树不走销毁流程。
6. **TypeScript 侧的密码学实现**（§ 3.2）：手写群运算 + 手写帧解析，是跨语言分叉最可能出现的地方。
7. **崩溃上报里的错误消息可能含 URL 或路径**（§ 5.10）：已截断、已去控制字符、只落在本机，但"报告里
   可能出现用户数据"这条要如实承认。
8. **房间密钥的配置方式尚未决定**（`product/mvp.md` § 六）：目前要求操作者在 `run` 与 `pair` 里各给一次，
   两次不一致的失效方式是安静的。

## 6. 结论与流程

- 本仓库**不声称**"无高危"。这条结论只能由一份独立报告给出，M5 的完成标准里它因此是**未达成**状态，
  而不是"已完成"（见 [`product/mvp.md`](product/mvp.md) 的 M5 进度行）。
- 审计结果公开：发现的条目、修复、以及复评结论都会写回 [`security.md`](security.md) 的 § 5（新开一小节，
  与 § 5.7 / § 5.9 的两次内部走查并列）。ADR 的结论不会被改写——修正是新开一条 ADR。
- 一条发现的最小可用格式：**影响**（谁能做什么）、**复现**（命令或代码路径）、**根因**（哪一行/哪个假设）、
  **建议**、以及**我们是否接受**（接受的风险也会写进 § 5，并说明代价）。
- 本文档自身也是审计对象：如果某条声明在 § 4.1 找不到强制手段，请把它作为发现报出来。
