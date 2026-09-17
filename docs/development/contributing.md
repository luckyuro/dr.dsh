# 贡献指南

本文是 dr.dsh 的贡献流程：先决条件、验证命令、仓库布局、评审会强制的五条硬规则，以及四类常见改动（通知事件、生命周期操作、协议消息、DSH 升级）的具体做法。

动手之前先读 [`../architecture.md`](../architecture.md)（组件边界与数据流）与 [`../README.md`](../README.md)（文档索引）；如果你要改的是决策而不是实现，读 [`../decisions/`](../decisions/)——那里记录了每条设计**以及被否决的方案**，先确认你的改动不是被否决过的那个。

## 先决条件

| 工具 | 版本要求 | 依据与说明 |
| :--- | :--- | :--- |
| Node | `^22.19.0 \|\| >=24.0.0` | `package.json` 的 `engines`。TypeScript 用 node 自带的 test runner + type-stripping 直接运行 `.ts`，没有转译步骤 |
| pnpm | 12（`packageManager: pnpm@12.3.4`） | 用 `corepack enable` 或你惯用的方式让它与 `packageManager` 字段一致；workspace 定义在 `pnpm-workspace.yaml` |
| Rust | stable（`rust-toolchain.toml` 固定 `channel = "stable"`，组件 `rustfmt` + `clippy`） | workspace 的 MSRV 是 `rust-version = "1.88"`，edition 2024，resolver 3。`stable` 是刻意的：daemon 要交付给最终用户，不能要求 nightly |
| Docker | 可选 | 日常开发不需要。M4 才交付 Docker 一键部署（[`../product/mvp.md`](../product/mvp.md) § 五）；想在本地复现自托管部署时看 [`../operations/self-hosting.md`](../operations/self-hosting.md) |

开发环境实测过的版本组合：node v24.15.0、pnpm 12.3.4、rustc 1.98.1。

## 起步

```bash
pnpm install

# 注意：根 cargo build 只构建 default-members（dr-dsh-proto、dr-dsh-crypto）。
# 这是刻意的——见 Cargo.toml 的注释：不想让"顺手一次构建"把感知 DSH 的二进制链接进中继。
cargo check --workspace --all-targets
cargo build -p dr-dsh-daemon -p dr-dsh-relay      # 需要可执行文件时显式指定
cargo run -p dr-dsh-daemon -- doctor          # 今天就能跑的真实自检
```

TypeScript 侧不需要构建步骤：`node --test` 直接跑 `src/*.test.ts`，`tsc -b` 只做类型检查与声明产物。

## 验证命令

`pnpm run verify` 是唯一的准入门槛，按顺序执行以下八步（定义见 `package.json`）：

| 命令 | 实际执行 | 覆盖什么 |
| :--- | :--- | :--- |
| `pnpm run check:rs` | `cargo check --workspace --all-targets` | 全部 crate（含测试目标）能否编译 |
| `pnpm run lint:rs` | `cargo clippy --workspace --all-targets -- -D warnings` | workspace lint：`unsafe_code = "forbid"`，`unwrap_used`/`expect_used`/`panic`/`todo` 都是警告，而 `-D warnings` 把它们升级成错误 |
| `pnpm run test:rs` | `cargo test --workspace` | Rust 单元测试 + `crates/dr-dsh-proto/tests/conformance.rs` 的共享向量 |
| `pnpm run typecheck:ts` | `pnpm -r --if-present run typecheck` | 每个 TS 包跑 `tsc -b`；`apps/pwa` 跑两个项目（页面 + Service Worker） |
| `pnpm run test:ts` | `pnpm -r --if-present run test` | 每个 TS 包的 `node --test` |
| `pnpm run test:cli` | `node --test scripts/drdsh.test.mjs` | 独立组件命令与配置边界、路径转义、服务定义 |
| `pnpm run lint:imports` | `node scripts/check-dsh-isolation.mjs` | 硬规则 2：除 `dsh-surface.ts` 外任何文件 import `@deepseek-ai/*` 都失败（type-only 与动态 import 同样被拒） |
| `pnpm run docs:check` | `node scripts/check-doc-links.mjs` | 硬规则 5：所有 Markdown 的相对链接必须指向存在的文件；外部 URL 只记录、不抓取 |

单项命令（排查某一层时用）：

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p dr-dsh-daemon -- doctor
pnpm run typecheck:ts
pnpm run test:ts
pnpm run lint:imports
pnpm run docs:check
pnpm run fmt:rs          # cargo fmt --all
```

Daemon 的 WS/WSS 连接还需真实进程验证：先 `cargo build -p dr-dsh-cli`，再执行
`pnpm run smoke:transport`。脚本需要 Node 和 OpenSSL，自带中继、TLS 代理和临时 CA，
覆盖 WS/WSS 加密控制往返、WSS 配对、拒绝不受信任证书与主机名不匹配；不会修改系统信任库。
安装器参数归属使用 `pnpm run smoke:release` 验证，包括 relay 帮助不显示 daemon 的 `--relay`。

说明两点：

- 命令说明若出现分歧，以 `package.json` 的 `verify` 为准。
- `pnpm-workspace.yaml` 的 `allowBuilds: {}` 表示依赖的生命周期脚本默认被拒绝。确实需要某个依赖的构建脚本时，要显式加进这个列表——这是刻意让"引入一个会跑脚本的依赖"成为一次可见的改动。

## 仓库布局

```
crates/
  dr-dsh-proto/        wire 协议的规范来源：帧、多路复用、控制消息、共享向量测试（库）
  dr-dsh-crypto/       配对（SPAKE2）、会话密钥、AEAD（库）
  dr-dsh-daemon/       bin `drdshd`：监督 DSH、代理、端到端加密端点、doctor
  dr-dsh-relay/        bin `drdsh-relay`：零知识转发、room 表与容量限制
packages/
  protocol/        TypeScript 镜像 + conformance/vectors.json（规范性文件）
  crypto/          浏览器侧 WebCrypto 实现
plugins/
  dr.dsh/      DSH bundle 插件；唯一允许 import @deepseek-ai/* 的地方（限 dsh-surface.ts）
apps/
  pwa/             远程客户端：routing.ts（纯函数改写）+ service-worker.ts
scripts/           check-doc-links.mjs、check-dsh-isolation.mjs：无依赖、离线
                   browser-*.mjs（Playwright 浏览器冒烟）、pwa-*.mjs（Node 侧真实栈冒烟）
                   deploy-probe.mjs、cpu-baseline-smoke.mjs（qemu 模拟旧 CPU）、ws-conformance.mjs
docs/              见 docs/README.md
```

改动应该放在哪：

| 你要改的东西 | 位置 |
| :--- | :--- |
| 帧格式、流控、控制消息 | `crates/dr-dsh-proto`（规范）+ `packages/protocol`（镜像）+ 向量文件 |
| 配对、密钥派生、AEAD | `crates/dr-dsh-crypto`（规范）+ `packages/crypto`（镜像） |
| DSH 监督、代理、加密端点 | `crates/dr-dsh-daemon` |
| 中继路由、room、限制 | `crates/dr-dsh-relay` |
| DSH 事件订阅与上报 | `plugins/dr.dsh`（只碰 `dsh-surface.ts` 里的契约假设） |
| 远端页面、隧道改写 | `apps/pwa`（`routing.ts` 是纯函数，改它必须带测试） |
| 决策依据 | `docs/decisions/`（新增 ADR，而不是改旧 ADR 的结论） |

`docs/` 下的文档用中文撰写；根目录的 `README.md` 是英文入口、`README.zh.md` 是中文入口。

## 五条硬规则

这五条与 [`../../AGENTS.md`](../../AGENTS.md) 一致。违反其中任何一条的改动都会被要求返工，理由写在括号里。

### 规则 1：`crates/dr-dsh-relay` 不得依赖任何密码学 crate，也不得依赖 `dr-dsh-proto::control`

**理由**：零知识是**构建期属性**，不是承诺。中继没有解密能力，因为它没有可以解密的代码，也没有密钥；`control` 模块的缺席意味着它无法解析 payload 语义，只能解析 carrier 帧头（[`../decisions/0002-zero-knowledge-relay.md`](../decisions/0002-zero-knowledge-relay.md)、[`../security.md`](../security.md) § 2.1）。中继也不能依赖任何 DSH 包，否则它会"顺手"长出理解 harness 流量的能力。

**评审怎么查**：

```bash
cargo tree -p dr-dsh-relay
cargo test -p dr-dsh-relay      # 其中 tests/zero_knowledge.rs 静态强制这条规则
git diff crates/dr-dsh-relay/Cargo.toml
```

`crates/dr-dsh-relay/tests/zero_knowledge.rs` 是这条规则的机械版本，它在 `cargo test` 里做三件事：检查 `[dependencies]` 里没有密码学 crate 或 `dr-dsh-crypto`（后者在 `dependencies`、`dev-dependencies`、`build-dependencies` 三处都查）；扫描 `src/**.rs` 的代码行，禁止出现 `dr_dsh_crypto` 与 `dr_dsh_proto::control`（注释行被刻意跳过——关于这条边界的说明文字是这份文件想鼓励的）；并用一个"扫描确实看到了预期的形状"的测试防止前两条因为什么都没扫到而静默通过。它失败时几乎从不是"在这里加个依赖"就能修好的：正确做法是把行为挪到一个端点后面，或者挪进 daemon——那才是合法持有密钥的一侧。

**一个已验证的细节**：完整闭包里会出现 `crypto-common` 与 `rand_chacha`，它们来自 axum 的 WebSocket 栈（`sha1` 用于握手，`tungstenite` 带 `rand`；可用 `cargo tree -p dr-dsh-relay -i crypto-common` 复现）。这**不是**违规：规则针对的是直接声明的密码学依赖与"是否具备解密能力"。但也不要因为它们已经在里面就顺势再加密码学依赖。任何新增依赖都需要说明理由，新增密码学能力需要先有一条 ADR。

### 规则 2：除 `plugins/dr.dsh/src/dsh-surface.ts` 外，任何模块不得 import `@deepseek-ai/*`

**理由**：DSH 是 developer preview，官方声明会有破坏性变更。把所有 harness 假设（事件名、payload 形状、服务键、路由注册）锁在一个文件里，升级时的代价就是"读一个文件、修一个测试"，而不是全仓库散点式的破坏（[`../decisions/0003-no-fork-integration.md`](../decisions/0003-no-fork-integration.md)）。

**评审怎么查**：`pnpm run lint:imports`（`scripts/check-dsh-isolation.mjs`）。它扫描全部 `.ts`（跳过 `dist`、`dist-worker`、`node_modules`、`target`、`.git`），拒绝裸 `@deepseek-ai/*` 的静态 import、`export … from`、type-only import 与动态 `import()`。

**要加一个新的 harness 事实时**：加在 `dsh-surface.ts` 里——`DSH_SURFACE` 增加一条带 `why` 与 `required` 的条目，必要时补进 `KNOWN_EVENT_NAMES`，并把 `VERIFIED_DSH_VERSION` 更新为实际核对的版本。守卫（`assertSupportedSurface`）只做浅探测，它的局限写在文件注释里：Cordis 接受任意事件名，`ctx.on('typo', …)` 不会报错、只会永不触发，因此 payload 形状的漂移只能靠升级测试覆盖。

### 规则 3：协议改动必须同时更新两端与共享向量

**理由**：协议存在两份实现（Rust 规范、TypeScript 镜像），它们之间没有共享代码，只有共享规范与 [`../../packages/protocol/conformance/vectors.json`](../../packages/protocol/conformance/vectors.json)。这份向量文件是**规范性文件**：Rust 侧用 `include_str!` 编译进测试二进制（`crates/dr-dsh-proto/tests/conformance.rs`），TypeScript 侧用 `node:fs` 读同一份文件（`packages/protocol/src/conformance.ts`）。**改动任何一个向量的期望值都是 wire-breaking change**（[`../decisions/0004-wire-protocol.md`](../decisions/0004-wire-protocol.md)）。

**两端都必须做到**：逐字节解码每个 `frames` 向量、逐字节重新编码回原字节、按给定原因拒绝每个 `rejections` 向量、把截断输入判为"不完整"而不是错误。

**版本规则**（[`../protocol.md`](../protocol.md) § 8）：

| 变更 | 需要 |
| :--- | :--- |
| 新增帧类型、新增控制消息 `kind`、新增 `NotificationEvent` | minor 版本 +1 |
| 修改帧头布局、`payload_len` 上限、HKDF 标签、AAD 构造、握手消息字段语义、向量期望值 | major 版本 +1，且需要 ADR |

协商规则：major 不等即拒绝；minor 向下兼容，但**不得发送未协商的帧类型或消息**。

### 规则 4：TypeScript 必须能在 node 的 type-stripping 下直接运行

**理由**：测试与部分构建路径不经过转译，直接由 node 执行 `.ts` 源码。任何需要"生成运行时代码"的语法都会在这些路径上失败（`packages/protocol/src/index.ts` 的注释里写明了这一点）。

具体禁止与替代：

| 禁止 | 替代 | 仓库里的例子 |
| :--- | :--- | :--- |
| `enum` | 冻结对象 `as const` + 派生类型 | `FrameType`（`packages/protocol/src/index.ts`） |
| 构造函数参数属性 `constructor(private x: T)` | 显式字段声明 + 构造函数里赋值 | `Reporter`（`plugins/dr.dsh/src/reporter.ts`） |
| 装饰器 | 普通函数与显式调用 | 全仓库无装饰器 |

另外两个相关约定：相对 import 要带 `.ts` 扩展名（`tsconfig.base.json` 打开了 `allowImportingTsExtensions` 与 `rewriteRelativeImportExtensions`）；配置文件里的 `@deepseek-ai/*` 例外不适用——规则 2 由上面的脚本机械执行。

### 规则 5：行为变化必须带文档变化

**理由**：文档是交付物的一部分，不是事后补充。本仓库的文档交叉引用很密（安全模型引用 ADR，README 引用贡献指南，排障文档引用集成面），一个被移动的文件会静默产生死链，而安全文档里的死链比没有链接更糟——它告诉读者"某个地方能证明这个说法"，但读者到不了那里（`scripts/check-doc-links.mjs` 的文件头注释）。

**评审怎么查**：`pnpm run docs:check`。它只检查相对链接的目标是否存在，外部 URL 只记录、不抓取（一个会因为别人网站宕机而变红的检查，会教人忽略这个检查）。改行为时同步更新：受影响的 `docs/` 文档、相关的 ADR（新增，不改旧结论）、以及 `docs/README.md` 的索引（如果你新增了文档）。

## 如何新增一个通知事件

通知的分类与最小化是产品决策，规范版本在 [`../decisions/0006-notifications.md`](../decisions/0006-notifications.md) 与 [`../security.md`](../security.md) § 2.6。步骤如下：

1. **在规范里加变体**：`crates/dr-dsh-proto/src/control.rs` 的 `NotificationEvent`。它是 serde `snake_case` 枚举，新增变体是加法改动，按规则 3 需要 **minor 版本 +1**。
2. **镜像到 TypeScript**：`packages/protocol/src/control.ts` 的 `NotificationEvent` union 加同一字面量。两处必须逐字一致。
3. **在插件里决定严重度与映射**：`plugins/dr.dsh/src/reporter.ts`。文件头有一张映射表（哪个 harness 事件 → 哪个 report → 哪个 `severity`），它是产品决策的落点。你需要：在 `ReportEvent` 里加值、在 `start()` 里订阅对应事件、为 payload 写一个**窄化**而不是断言的分类函数（参照 `classifySessionEvent`），并补测试——无法识别的 payload 必须返回 `undefined`，绝不能抛异常，因为它在 harness 的事件处理器里运行。
4. **把名字加进配置白名单**：`plugins/dr.dsh/cordis.patch.yml` 的 `report:` 列表，以及 `plugins/dr.dsh/src/index.ts` 的 `DEFAULTS.report`。**漏掉这一步事件会被静默丢弃**：`Reporter` 对不在 `config.report` 里的事件只累加 `dropped` 计数，不发请求。
5. **同步文档**：[`../protocol.md`](../protocol.md) § 7 的控制消息表、[`../integration/dsh-surface.md`](../integration/dsh-surface.md) § 4（如果事件来源有变化）。

两点提醒：

- `Config` 的注释说"未知的事件名应当是启动错误，而不是静默 no-op"，但当前 `apply()` 只校验 loopback 与 surface guard，名字拼错不会报错——这一校验尚未实现，何时补上由 M1/M2 的插件工作决定。在那之前，拼错的表现就是"事件永远不出现"。
- 内容最小化是类型的性质，不是纪律：`Notification` 里没有承载正文、路径、代码或模型输出的字段，`sessionRef` 是不透明句柄。不要为了"顺便显示一下"而加字段——通知载荷是最可能经由推送通道离开隧道的东西。

## 如何新增一个生命周期操作

### 白名单为什么是闭集

`LifecycleOp` 只有 `start`、`stop`、`restart`，而且协议里**不存在**承载启动参数的字段：daemon 从自己锁定的配置启动 DSH，没有任何代码路径会执行一个由对端命名的命令。这不是"我们记得校验"，而是"没有东西可以传"（[`../security.md`](../security.md) § 2.3、[`../architecture.md`](../architecture.md) § 2.5、[`../protocol.md`](../protocol.md) § 7）。

所以新增一个操作的门槛不是"加个分支"，而是：它必须是**不需要任何对端参数**就能表达的动宾短语；否则它就不是一个操作，而是一个远程命令执行通道，那与本项目的核心承诺冲突。ADR-0003 已经把"自建一个远程专用 API"和"用插件把 DSH 暴露到非回环地址"两个方向否决掉了——不要用生命周期操作绕回去。

### 步骤

1. **加操作**：`crates/dr-dsh-proto/src/control.rs` 的 `LifecycleOp`；`packages/protocol/src/control.ts` 的 `LifecycleOp` union。若新操作会产生新的中间态，同时扩展 `LifecycleState`。
2. **在 daemon 里实现**：`crates/dr-dsh-daemon` 的监督逻辑。所有参数必须来自 daemon 自己的配置；如果实现需要"知道 DSH 是怎么被启动的"，那在 attach 模式下必须返回拒绝（`LifecycleState::Attached`）并给出可读原因，而不是猜。
3. **检查权限闸门**：设备级是 `DeviceSummary.may_control`，daemon 级是 `Config.allow_lifecycle`。默认拒绝：新操作要经过这两道闸门，而不是绕过它们。
4. **结果与广播**：返回 `LifecycleResult { ok, state, error }`，并让客户端不靠猜就知道结果；失败要说明是哪一侧失败、为什么。
5. **测试与文档**：daemon 侧单元测试；`docs/protocol.md` § 7 的表；如果改变了远端可见行为，更新用户文档与 [`../product/mvp.md`](../product/mvp.md) 的对应验收标准。

## 如何新增一条协议消息

先判断它属于哪一层，因为两层的修改位置与版本后果不同（[`../protocol.md`](../protocol.md) § 1）：

| 层 | 内容 | 改哪里 |
| :--- | :--- | :--- |
| Carrier 平面 | 18 字节帧头、帧类型、流 id、流控窗口 | `crates/dr-dsh-proto` 的 `frame`/`mux` + `packages/protocol` 的镜像 + **向量文件** |
| Payload 平面 | 控制消息（`control` envelope）、握手消息（控制流上的 envelope）、被代理的 DSH 流量 | `crates/dr-dsh-proto/src/control.rs` + `packages/protocol/src/control.ts` |

步骤：

1. **在 Rust 里定义规范，字段名在线上是 `camelCase`**：控制消息加 `ControlKind` 变体与 body 类型；握手消息按 `{ "type", "id", "args" }` 的信封加字段。Rust 结构体用 `snake_case` 字段（本地命名习惯），**序列化时必须映射到 `camelCase`**（`#[serde(rename_all = "camelCase")]`），这是规范：`crates/dr-dsh-proto/src/control.rs` 的模块文档与 [`../protocol.md`](../protocol.md) § 7 都写明了这一点，理由是线上 JSON 与浏览器调试器、以及 TS 镜像保持一致。Rust `at_ms` ↔ 线上/TS `atMs`、`local_url` ↔ `localUrl`、`can_control` ↔ `canControl`。
   - **不要**让 `snake_case` 泄漏到线上：那会让两端在字段名上静默分叉，而这正是共享向量与规范存在的理由。
   - daemon 本地面（插件上报 `POST /report` 的 body）同样是 camelCase（`atMs`、`sessionRef`，见 [`../protocol.md`](../protocol.md) § 7.1 与 `plugins/dr.dsh/src/reporter.ts`）；它是本地契约，但沿用同一约定以免出现两套拼写。改它要同时改两侧的测试。
2. **镜像到 TypeScript**：`packages/protocol/src/control.ts` 的 interface 是同一份文档的 TS 视图，字段名与线上一一对应，不需要再做转换。
3. **决定它走哪条道**：控制消息走加密流上的 `{ "kind", "id", "body" }`；握手消息走控制流（stream 0）；如果它需要新的帧类型或新的帧头语义，那就属于 carrier 平面，必须按规则 3 加向量。
4. **定版本**：按上面的版本规则表决定 minor 还是 major；major 需要一条 ADR。不要靠"反正两端一起发"来跳过版本协商——`minor` 只做加法，且不得发送未协商的类型。
5. **两端都测**：Rust 单元测试 + TS 的 `node --test`；如果动了向量，确认 `cargo test --workspace` 与 `pnpm run test:ts` 都通过。
6. **同步文档**：[`../protocol.md`](../protocol.md) 对应章节；若这条消息影响远端可见行为，还要更新 [`../architecture.md`](../architecture.md) 的数据流与 [`../security.md`](../security.md) 中相关的保证或非保证。

## DSH 升级仪式

DSH 每次版本变更后，必须执行 [`../integration/dsh-surface.md`](../integration/dsh-surface.md) § 7 的七步升级仪式，并把每一步的实际结果写进 PR 描述。**这里不复述那七步**：清单的规范版本只保留一处，避免两处漂移；"如果没有时间做全套"时至少要做哪三步，也写在那里。

本仓库侧随之要动的只有两处记录：`plugins/dr.dsh/src/dsh-surface.ts` 的 `VERIFIED_DSH_VERSION`（实际核对的版本）与 `plugins/dr.dsh/package.json` 的 `engines.dsh`（兼容范围）。两者都改了之后，`pnpm run test:ts` 是验证守卫与窄化逻辑是否仍成立的最短路径。

## 提交与 PR 期望

安装与服务管理入口在 [`../operations/cli.md`](../operations/cli.md)。修改该入口时，除了
`pnpm run test:cli`，还应运行对应平台的 `pnpm run smoke:services` 或 `pnpm run smoke:systemd`。
`check:rs` 会先生成 WebSocket 测试向量，确保干净检出的 `verify` 不依赖旧 `target/` 内容。

- **小步、一个 PR 一个关注点。** 不要把"顺手重构 + 协议改动"混在一起：协议改动需要对照向量与版本规则逐条核对，混在一起会让评审无法判断哪一处是行为变化。
- **`pnpm run verify` 全绿。** 在 PR 描述里贴出你跑的命令与结果。红着的检查不要靠"本地环境问题"解释——`docs:check` 与 `lint:imports` 都是离线的、无依赖的。
- **写明这次改动服务于哪个里程碑。** 里程碑与完成标准见 [`../product/mvp.md`](../product/mvp.md) § 五（M0 概念验证 → M6 社区与扩展）。如果你不确定它属于哪个里程碑，就写"不确定"并说明理由，不要猜。
- **决策写进 ADR。** 有争议的设计（"为什么不用 X"）属于 `docs/decisions/`，且必须记录被否决的方案与理由；不要修改一条已接受 ADR 的结论，新增一条并在其中引用它。
- **新增依赖要说明理由。** `crates/dr-dsh-relay` 的新依赖需要先有 ADR（规则 1）；pnpm 侧需要构建脚本的依赖要显式加进 `pnpm-workspace.yaml` 的 `allowBuilds`。
- **不要留下 `todo!()` 或 `TODO`。** clippy 已把 `todo` 配置为警告，而 `lint:rs` 用 `-D warnings` 运行。真正未决的事情写在 `docs/` 的"未决事项"里（[`../product/mvp.md`](../product/mvp.md) § 六、[`../architecture.md`](../architecture.md) § 6），而不是留在代码里。
- **不要修改 `~/dsh-x/deepseek-harness`。** 上游 DSH 是只读参考与集成对象，本仓库不是它的 fork。
- **不要试图绕过 DSH 的绑定限制或鉴权栅栏。** 见 ADR-0003 的被否决方案与 [`../security.md`](../security.md) § 2.4、§ 2.5。

## 相关文档

- [`../../AGENTS.md`](../../AGENTS.md) —— 仓库规约（五条硬规则的简版）
- [`../README.md`](../README.md) —— 文档索引
- [`../architecture.md`](../architecture.md) —— 动手前先读这个
- [`../protocol.md`](../protocol.md) —— 帧、握手、控制消息、兼容性
- [`../security.md`](../security.md) —— 保证与"不保证什么"
- [`../integration/dsh-surface.md`](../integration/dsh-surface.md) —— DSH 接口面与升级仪式
- [`../product/mvp.md`](../product/mvp.md) —— MVP 边界与里程碑
- [`../operations/self-hosting.md`](../operations/self-hosting.md) —— 自托管部署
- [`../operations/troubleshooting.md`](../operations/troubleshooting.md) —— 症状优先的排查指南
