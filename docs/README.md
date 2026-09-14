# 文档索引

先读哪一篇，取决于你带着什么问题来。

## 我想知道这是什么

| 文档 | 内容 |
| :--- | :--- |
| [`../README.zh.md`](../README.zh.md) | 一分钟版本：它做什么、架构草图、原则 |
| [`product/mvp.md`](product/mvp.md) | MVP 包含什么、不包含什么、目标平台优先级、里程碑的完成标准 |
| [`product/overview.md`](product/overview.md) | 定义文档的每条承诺落在本仓库的哪个位置 |

## 我要把它跑起来

| 文档 | 内容 |
| :--- | :--- |
| [`operations/install.md`](operations/install.md) | 在 Linux / macOS / Windows 上安装 daemon，含 systemd、launchd、计划任务与附着模式 |
| [`operations/self-hosting.md`](operations/self-hosting.md) | 自托管中继：Docker、systemd、反向代理与超时陷阱 |
| [`operations/troubleshooting.md`](operations/troubleshooting.md) | 症状 → 原因 → 确认 → 修复 |
| [`integration/dsh-surface.md`](integration/dsh-surface.md) | 所依赖的确切 DSH 接口面，以及 `drdshd doctor` 能查出什么 |

## 我要判断它是否安全

| 文档 | 内容 |
| :--- | :--- |
| [`security.md`](security.md) | 威胁模型、保证、以及**不保证什么**（第 5 节最重要） |
| [`audit-scope.md`](audit-scope.md) | 给第三方审计者的范围、材料、已知高风险候选与"会失败的检查"清单 |
| [`protocol.md`](protocol.md) | 帧、握手、密钥派生 |
| [`decisions/0002-zero-knowledge-relay.md`](decisions/0002-zero-knowledge-relay.md) | 零知识如何被依赖图强制 |

## 我要改代码

| 文档 | 内容 |
| :--- | :--- |
| [`development/contributing.md`](development/contributing.md) | 验证命令、仓库结构、评审强制的硬规则 |
| [`architecture.md`](architecture.md) | 组件边界与数据流（改之前先读这个） |
| [`decisions/`](decisions/) | 每条 ADR 都记录了被否决的方案——先确认你的改动不是被否决过的那个 |
| [`integration/dsh-surface.md`](integration/dsh-surface.md) | DSH 升级仪式：改 DSH 版本时要跑的七件事 |

## 全部文档

```
README.md / README.zh.md          项目入口
docs/
  README.md                       本文件
  architecture.md                 组件、数据流、状态模型、失败与恢复
  protocol.md                     wire 协议规范（帧、握手、控制消息、兼容性）
  security.md                     威胁模型、保证、剩余风险、密码学清单
  audit-scope.md                  第三方审计的范围、材料与已知高风险候选
  product/
    overview.md                   定义文档到本仓库的映射
    mvp.md                        MVP 边界、平台优先级、自托管与托管、审计计划、里程碑
  decisions/
    0001-language-split.md        Rust 与 TypeScript 的分工
    0002-zero-knowledge-relay.md  零知识中继：用依赖图保证
    0003-no-fork-integration.md   不 fork DSH：监督 + 鉴权代理 + 薄插件
    0004-wire-protocol.md         二进制帧、单一规范来源、跨语言向量
    0005-pwa-and-service-worker.md 远程客户端形态与 authority 处理
    0006-notifications.md         通知分级、最小化、推送可选
    0007-multiple-instances.md    多实例：一个 daemon 一个 DSH
    0008-team-rooms.md            团队房间：明确不做，及将来的前置条件
    0009-push-boundary.md         推送：Web Push 的保证边界与措辞
    0010-lan-direct.md            局域网直连：不做，及零代码替代方案
    0011-hosting-rules.md         托管中继：不预埋数据收集
    0012-audit-log-retention.md   审计日志：本机、滚动、不上送
    0013-room-key-provisioning.md 房间密钥：生成并落盘
  integration/
    dsh-surface.md                依赖的 DSH 接口面、证据、失效表现、升级仪式
  operations/
    install.md                    daemon 的三平台安装
    self-hosting.md               自托管部署
    troubleshooting.md            故障排查
  development/
    contributing.md               贡献指南
```

## 文档的约定

- **决策写进 ADR，不写进散文。** 如果一处设计有争议（"为什么不用 X"），它属于 `decisions/`，且必须记录被否决的方案与理由。
- **未决定的事情要被显式列出**，而不是留白。见 [`product/mvp.md`](product/mvp.md) § 六与 [`architecture.md`](architecture.md) § 6。
- **不夸大安全性。** [`security.md`](security.md) § 5 列出的弱点与保证同样重要；任何"我们很安全"式的表述都应当被改成"我们保证 X，不保证 Y"。
- **交叉引用的链接必须可解析。** `pnpm run docs:check` 会检查相对链接是否指向存在的文件（见 [`development/contributing.md`](development/contributing.md)）。
