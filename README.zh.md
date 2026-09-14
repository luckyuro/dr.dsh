# dr.dsh

[English](README.md) | 中文

**dr.dsh 把你自己的 DeepSeek Harness 装进口袋 —— 不把电脑暴露到公网，也不让链路中间的任何人读到你的会话。**

---

## 状态：可自托管，尚未发布

| | |
| :--- | :--- |
| 版本 | `0.0.0` —— 尚未发布任何东西（没有产物，也没有 npm 包） |
| 已经能用 | 一台设备输入一次配对码即可看到**真实的 DSH 界面**：daemon 监督本机的 DSH、保持它只绑回环，端到端加密的隧道经**自托管中继**（二进制或 Docker 镜像）转发，浏览器里可以远端启停/重启、也可以附着到你自己启动的 DSH。此外还有保活、本机审计日志（`drdshd audit`）与本机崩溃报告（`drdshd crashes`），都只落在你自己的机器上 |
| 还没做 | 发布流水线与可复现构建（[`docs/audit-scope.md`](docs/audit-scope.md) 列的第一项缺口）、第三方深度审计、新用户实测；推送按 [ADR-0006](docs/decisions/0006-notifications.md) 默认关闭且未实现。**逐条状态写在 [`docs/product/mvp.md`](docs/product/mvp.md)** |
| 上游依赖 | DeepSeek Harness `0.1.5-rc.2`，developer preview，官方声明会有破坏性变更 |

本项目的产品依据是《dr.dsh 项目定义文档》0.1 草案。定义文档留下未决的地方，本仓库记录的是**决策**而不是意图：见 [`docs/product/mvp.md`](docs/product/mvp.md) 与 [`docs/decisions/`](docs/decisions/)。

## 名字

**dr.dsh** = **d**aemon & **r**elay **of** **dsh**。名字同时也是各处前缀的来源，改动它要连着改这几处，否则会留下两套拼法：

| 位置 | 形式 | 说明 |
| :--- | :--- | :--- |
| 项目名、npm scope | `dr.dsh`、`@dr.dsh/*` | 点号形式；npm 允许包名里有 `.` |
| Rust crate | `dr-dsh-proto`、`dr-dsh-crypto`、`dr-dsh-daemon`、`dr-dsh-relay` | 连字符形式；crate 名里不能有 `.` |
| 可执行文件 | `drdshd`（daemon）、`drdsh-relay`（中继） | 连字符形式：二进制名既是文件名也是 crate 名，同样不能有 `.`，而且不能与所在包的库名相同 |
| 线上标签 | `dsh-remote/v1/...` | **刻意不改**：它们是 KDF 的 info 字符串与 AAD，改名等于换协议（房间 id、会话密钥、AAD、登记 MAC 全变），见下 |

**为什么标签不改。** `docs/protocol.md` § 9 里的标签是**线上标识符**，两端按它派生一切；`dsh-remote/v1/` 这个名字记录的是协议第一次定稿时的项目名，而协议名与项目名可以不同——换掉它属于 wire-breaking change，需要同时改两端、重新生成两份 conformance 语料、并提升协议版本号（`AGENTS.md` 规则 3）。没有任何功能收益，所以保留。

## 它做什么

DSH 跑在你自己的电脑上。dr.dsh 在它旁边加一个很小的守护进程，让你可以从手机或另一台电脑：

- **使用真实的 DSH 界面**，而不是一个功能被裁剪的远程控制面板；
- **启动、停止、重启 DSH**，并看到它是运行中、启动中、已停止还是失败；
- **在需要你时被告知** —— 一轮任务结束、有审批在等待、目标已完成；
- **在出问题时看到真相** —— 是哪一侧断了，以及为什么。

不需要端口转发、不需要公网 IP、不需要配置路由器：守护进程主动向外拨号，中间的中继只接触密文。

## 工作原理

```
┌──────────────┐          ┌─────────────────┐          ┌──────────────────┐
│  手机 /      │  静态壳  │                 │  不透明  │   你的电脑       │
│  笔记本      │◀────────▶│   中继          │◀────────▶│                  │
│  (PWA)       │  +密文   │  （零知识转发） │   帧     │  drdshd（守护进程）│
│              │          │                 │          │    │             │
│              │          │                 │          │    ▼             │
└──────────────┘          └─────────────────┘          │  dsh web         │
                                                       │  仅 127.0.0.1    │
                                                       └──────────────────┘
```

四个组件，每一个都有一条不跨越的边界：

| 组件 | 语言 | 是什么 | 做不到什么 |
| :--- | :--- | :--- | :--- |
| **`drdsh-relay`** | Rust | 在 daemon 与已配对客户端之间路由不透明帧 | 读取 payload、持有密钥、持久化任何东西 |
| **`drdshd`**（守护进程） | Rust | 监督 DSH、代理它、终结端到端加密 | 执行对端指定的命令、把 DSH 绑定到非回环地址 |
| **`@dr.dsh/dsh-plugin`** | TypeScript | 把进程内的 harness 事件报告给本地 daemon | 加密、代理、管理 DSH 生命周期 |
| **PWA** | TypeScript | 远程客户端：配对、隧道、以及真实的 DSH 界面 | 通过隧道以外的任何路径触达 DSH |

三条决策解释了大部分设计：

1. **中继无法解密，因为它无法链接到解密库。** 这由依赖图强制，而不是靠纪律 —— 见 [ADR-0002](docs/decisions/0002-zero-knowledge-relay.md)。
2. **DSH 永不被暴露，也永不被 fork。** 它按上游意图保持在回环地址上；守护进程执行 DSH 自己的鉴权并代理它，同时保持 DSH 会话 cookie 所绑定的 authority —— 见 [ADR-0003](docs/decisions/0003-no-fork-integration.md)。
3. **协议存在两份，并且被机械化地比对。** Rust 拥有规范定义，TypeScript 是镜像，两者都必须通过同一份 conformance 向量 —— 见 [ADR-0004](docs/decisions/0004-wire-protocol.md)。

## 快速开始

在一台跑着 DSH 的电脑上（中继可以在同一台，也可以在别处）：

```sh
cargo build --workspace
pnpm install && pnpm --filter @dr.dsh/pwa build

# 中继：绑回环，只把构建好的客户端交给浏览器；放在反向代理后面见自托管文档
DSH_RELAY_BIND=127.0.0.1:8787 DSH_RELAY_CLIENT_DIR=apps/pwa/dist ./target/debug/drdsh-relay

drdshd doctor                                          # 动手之前先检查这台机器
drdshd run --relay ws://<主机>:8787                    # 监督 DSH 并拨号到中继（房间密钥自动生成并落盘）
drdshd pair --relay ws://<主机>:8787                   # 打印一次性配对码
```

然后在浏览器里打开中继的地址，把那串码输入一次，界面就在一次点击之后。房间密钥不需要你接触：
`drdshd run` 与 `drdshd pair` 默认读同一个文件（首次运行生成，0600）。中继也可以直接用
[`compose.yaml`](compose.yaml) 跑起来；systemd / launchd / 计划任务与 Docker 的完整版本见
[`docs/operations/install.md`](docs/operations/install.md) 与 [`docs/operations/self-hosting.md`](docs/operations/self-hosting.md)。

每次改动都要让这条保持全绿：

```sh
pnpm run verify                  # cargo check/clippy/test + tsc + node --test + 导入隔离 + 文档链接
pnpm run fmt:rs
```

行为类声明（隧道、配对、保活、崩溃上报、多房间、旧 CPU…）由 [`scripts/`](scripts/) 里的实测脚本覆盖，
清单见 [`AGENTS.md`](AGENTS.md)。

## 仓库结构

```
crates/
  dr-dsh-proto/        wire 协议：帧、多路复用、控制消息（规范来源）
  dr-dsh-crypto/       配对与会话加密（Rust 侧）
  dr-dsh-daemon/       drdshd —— 监督、代理、加密端点
  dr-dsh-relay/        drdsh-relay —— 零知识转发
packages/
  protocol/        TypeScript 镜像 + 共享 conformance 向量
  crypto/          浏览器侧 WebCrypto 实现
plugins/
  dr.dsh/          DSH bundle 插件，也是唯一感知 DSH 的 TypeScript
apps/
  pwa/             远程客户端
docs/
  product/         范围、MVP、里程碑
  architecture.md  组件、数据流、会话引导
  security.md      威胁模型、保证、以及不保证的东西
  protocol.md      规范性的 wire 描述
  decisions/       ADR —— 为什么，以及否决了什么
  operations/      自托管、故障排查
  development/     贡献指南、DSH 升级仪式
  integration/     所依赖的确切 DSH 接口面，以及如何验证
```

## 原则

- **本地优先。** dr.dsh 是本地工具的放大器，永远不是替代品。失去中继绝不能让你丢掉本地会话。
- **零知识是构造出来的。** 中继读不到你的会话，是它所构建材料的性质。
- **不 fork、不打补丁、不做削弱 DSH 的插件。** 我们使用上游文档化的缝隙；需要新的缝隙时向上游提，而不是绕过去。
- **最小权限、闭集白名单。** 四个生命周期操作，没有通用命令执行，没有文件传输，没有远程 shell。
- **失败透明。** 每一个"没成功"都要说明是哪一侧失败、为什么。无声的转圈是 bug。
- **安全默认、配置可审计。** 任何削弱保证的东西都不是默认值，且每个此类选项都被记录为它的代价。

## 贡献

从 [`docs/development/contributing.md`](docs/development/contributing.md) 开始。它列出了验证命令、仓库结构、评审会强制执行的五条硬规则，以及每条规则存在的原因。PR 进入评审前必须 `pnpm run verify` 全绿。

如果你是来报告问题而不是修问题的，[`docs/operations/troubleshooting.md`](docs/operations/troubleshooting.md) 开头就写了该收集什么信息，让报告可被回答。

## 安全

在信任本项目处理任何东西之前，请先读 [`docs/security.md`](docs/security.md)。它说明保证什么、不保证什么、以及剩余风险在哪里 —— 包括诚实的弱点，例如中继在客户端可信计算基中的位置，以及字节转发中继不可避免会观察到的流量分析元数据。

## 许可证

MIT。
