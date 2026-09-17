# 仓库规约

本文写给在本仓库工作的贡献者与 AI 编码代理。它只讲**这个仓库特有的**规矩；通用工程常识不重复。

## 这是什么

dr.dsh：让用户从任意设备安全地访问运行在自己电脑上的 DeepSeek Harness。**它不是 DSH 的 fork**，也不修改 DSH 核心。上游 DSH 位于另一个目录（`~/dsh-x/deepseek-harness`），只作参考与集成对象。

当前阶段：**可自托管使用，提供 v0.1.0 二进制发布**。配对码 → 加密隧道 → 真实 DSH 界面这条链路已经在真实浏览器里跑通，
中继可以自托管（二进制或 Docker），daemon 侧还有审计日志、崩溃报告、保活与多房间客户端。
没有的东西同样重要，而且都写在文档里：**没有自动签名/可复现构建流水线**（已有手动构建脚本、Release tar 与 SHA-256；没有 npm 包，
见 [`docs/audit-scope.md`](docs/audit-scope.md) § 2.4）、**没有第三方审计**、**没有托管中继**。
逐条状态见 [`docs/product/mvp.md`](docs/product/mvp.md) 的进度行。

## 五条硬规则

违反其中任何一条的改动会被要求返工，理由写在括号里。

1. **`crates/dr-dsh-relay` 不得依赖任何密码学 crate，也不得依赖 `dr-dsh-proto::control`。**（零知识是构建期属性，见 ADR-0002。新增依赖前先读那条 ADR。）
2. **除 `plugins/dr.dsh/src/dsh-surface.ts` 外，任何模块不得 import `@deepseek-ai/*`。**（DSH 是 developer preview，会把破坏性变更打进来；影响面必须锁在一个文件里，见 ADR-0003。）
3. **协议改动必须同时更新两端与共享向量。**（`packages/protocol/conformance/vectors.json` 是规范性文件。改向量等同于 wire-breaking change，需要版本号提升。）
4. **TypeScript 必须能在 node 的 type-stripping 下直接运行。**（不用 `enum`、不用构造函数参数属性、不用装饰器。理由：测试与部分构建路径不经过转译，见 `packages/protocol/src/index.ts` 中冻结对象的注释。）
5. **行为变化必须带文档变化。**（文档是交付物的一部分；`pnpm run docs:check` 会检查链接。）

## 命令

安装使用 Release 下载入口 `relay/install.sh` / `daemon/install.sh`，运维统一为
`drdsh relay ...` / `drdsh daemon ...`；别名 `drdsh-relay` / `drdsh-daemon` 选择对应组件。各自的配置、程序、日志、服务与更新锁独立；
PWA 属于 relay，插件属于 daemon。根 `install.sh` 可安装混合包，旧统一源码入口保留为 `scripts/install-legacy.sh`。
修改管理逻辑时，保持更新和卸载一侧不改变另一侧 PID 或配置，见 ADR-0015。

```sh
pnpm install
pnpm run verify        # check:rs + lint:rs + test:rs + typecheck:ts + test:ts + lint:imports + docs:check
pnpm run docs:check    # 相对链接自检
pnpm run lint:imports  # 强制"只有 dsh-surface.ts 能 import DSH"
pnpm run fmt:rs        # cargo fmt --all
```

单项：

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p dr-dsh-daemon -- doctor
pnpm run typecheck:ts
pnpm run test:ts
```

## 实测脚本（单元测试看不见的东西）

`pnpm run verify` 只跑静态检查与单元测试。**行为类声明必须在真实进程上实测**，这些脚本就是那些实测，
每个都以退出码表示结果（0 通过、1 失败、2 跑不起来）：

| 脚本 | 它实测什么 | 需要什么 |
| :--- | :--- | :--- |
| `scripts/service-smoke.mjs` | 两侧独立安装/更新/卸载、另一侧 PID 与配置不变、旧入口兼容、配对状态保留 | 已构建的二进制与 PWA；macOS launchd 或 Linux systemd 用户会话；DSH 使用替身 |
| `scripts/systemd-smoke.mjs` | Linux 用户服务的特殊路径、首次启动、自启动开关、停止与重启 | systemd 用户会话 + Node；使用真实替身进程，不需要 Rust/DSH |
| `scripts/browser-pairing-smoke.mjs <relay-url>` | 真实浏览器里用配对码走通、刷新后免输入、崩溃上报落盘 | 已构建的客户端 + 运行中的中继 + Playwright Chromium |
| `scripts/browser-task-smoke.mjs <relay-url> [--full]` | 浏览器里跑真实任务；`--full` 含审批与长输出 | 同上（`--full` 需要一个会触发审批的提示词） |
| `scripts/browser-offline-smoke.mjs` / `-soak-` / `-perf-` | 离线外壳、崩溃率（rule of three）、滚动性能 | 同上 |
| `scripts/pwa-tunnel-smoke.mjs <relay-url> <room-key>` | Node 侧客户端经隧道取回真实 DSH 界面 | 运行中的中继 + 真实 daemon |
| `scripts/pwa-control-smoke.mjs` / `pwa-crash-smoke.mjs` | 控制面（含 attach 拒绝）、崩溃上报全链路 | 后者自带中继与 daemon |
| `scripts/room-key-smoke.mjs` | 房间密钥：生成落盘、配对与运行共用一把、损坏即失败 | 已构建的二进制（自带中继与 daemon） |
| `scripts/audit-smoke.mjs` | 审计日志：配对 / 会话 / 生命周期 / 撤销各留一行，且不含密钥 | 已构建的二进制（自带中继与 daemon） |
| `scripts/browser-rooms-smoke.mjs` | 多房间：v1 存储迁移、第二次配对新增、切换连到被选中的机器 | 已构建的客户端与二进制 + Chromium |
| `scripts/deploy-probe.mjs` | 中继的非回环警告、daemon 认出代理超时、保活救活 carrier | 已构建的两个二进制；可选 `qemu` |
| `scripts/relay-transport-smoke.mjs` | daemon 按 WS/WSS 地址连接、WSS 配对、加密控制往返与证书拒绝 | 已构建的 `drdsh` + Node + OpenSSL；自带中继、TLS 代理与临时 CA，不需要 DSH |
| `scripts/cpu-baseline-smoke.mjs` | 发布二进制与密码学在 2006/2008/2010 级 CPU 上可运行 | `qemu-user-static` + release 构建 |

先 `cargo build --workspace`，再 `PATH=$PWD/target/test-bin:$PATH` 让 daemon 找到 `dsh` 包装脚本；
浏览器脚本还需要 `pnpm --filter @dr.dsh/pwa build` 与一个带 `DSH_RELAY_CLIENT_DIR=apps/pwa/dist` 的中继。
长跑（soak、探针、浏览器）请放到后台任务里跑，前台会被打断。

## 布局与"改动应该放哪"

| 你要改的东西 | 位置 |
| :--- | :--- |
| 帧格式、流控、控制消息 | `crates/dr-dsh-proto`（规范）+ `packages/protocol`（镜像）+ 向量文件 |
| 配对、密钥派生、AEAD | `crates/dr-dsh-crypto`（规范）+ `packages/crypto`（镜像） |
| DSH 监督、代理、加密端点 | `crates/dr-dsh-daemon` |
| 中继路由、房间、限制 | `crates/dr-dsh-relay` |
| DSH 事件订阅与上报 | `plugins/dr.dsh`（只碰 `dsh-surface.ts` 里的契约假设） |
| 远端页面、隧道改写 | `apps/pwa`（`routing.ts` 是纯函数，改它必须带测试） |
| 统一 CLI、Release 安装与本机管理 | `crates/dr-dsh-cli` + `scripts/*release*.sh` |
| 决策依据 | `docs/decisions/`（新增 ADR，而不是改旧 ADR 的结论） |

## 写代码时的取向

- **注释解释"为什么"，不解释"是什么"。** 一个 `// increment i` 会被删掉；一段解释"为什么这里不能用随机 nonce"的注释会被保留。
- **拒绝要带原因。** 任何 `return Err`/`throw` 的用户可见路径都要说清楚是哪一侧失败、为什么、怎么办。失败透明是产品要求。
- **不要在日志、`Debug`、错误信息里打印密钥或 payload。** `dr-dsh-crypto` 的类型已经这样做了，新增类型请照做。
- **默认拒绝。** 新的端点、新的帧类型、新的配置项：默认关闭、默认最小权限。
- **不要为了"以后可能用到"加抽象。** 本仓库的骨架已经刻意留白，没有实现的东西写在文档的"未决事项"里，而不是提前抽象出来。

## 不要做的事

- 不要修改 `~/dsh-x/deepseek-harness` 下的任何文件。它是只读参考。
- 不要试图绕过 DSH 的绑定限制或鉴权栅栏（见 ADR-0003 的被否决方案）。
- 不要在 `crates/dr-dsh-relay` 里加"顺手"的功能；中继的贫瘠是它的安全属性。
- 不要把 `todo!()` 或 `TODO` 留在会编译进产物的代码里（clippy 已配置为警告）。

## 相关文档

- [`docs/README.md`](docs/README.md) —— 文档索引，按"你带着什么问题来"组织
- [`docs/development/contributing.md`](docs/development/contributing.md) —— 完整的贡献流程
- [`docs/architecture.md`](docs/architecture.md) —— 动手前先读这个
- [`docs/integration/dsh-surface.md`](docs/integration/dsh-surface.md) —— DSH 升级仪式
