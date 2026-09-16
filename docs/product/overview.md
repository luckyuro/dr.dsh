# 产品概览

本文件是《dr.dsh 项目定义文档》0.1 草案在本仓库中的落地摘要。它**不替代**那份定义文档，而是记录"定义文档里的哪些话已经变成了可执行的决策"。

| 定义文档章节 | 在本仓库的落点 |
| :--- | :--- |
| § 1 一句话定义、§ 3 愿景 | [`../README.zh.md`](../../README.zh.md) |
| § 4 目标 | 逐条对应到架构决策：[ADR-0002](../decisions/0002-zero-knowledge-relay.md)（零知识）、[ADR-0003](../decisions/0003-no-fork-integration.md)（不 fork、不暴露）、[ADR-0005](../decisions/0005-pwa-and-service-worker.md)（跨平台远程端） |
| § 5 非目标 | [`mvp.md`](mvp.md) § 一 的"不包含"表；以及 [`../security.md`](../security.md) 中明确列出的"不防谁" |
| § 8 核心概念 | [`../architecture.md`](../architecture.md) § 1 的组件边界表 |
| § 9 功能需求 | [`mvp.md`](mvp.md) § 一 的八条验收标准 |
| § 10 非功能需求 | [`../security.md`](../security.md)（安全）、[`../architecture.md`](../architecture.md) § 4（可靠性）、[`mvp.md`](mvp.md) § 二（兼容性） |
| § 11 设计原则 | [`../README.zh.md`](../../README.zh.md) 的"原则"一节 |
| § 12 参考 Happier 的改进承诺 | 见下方"对 Happier 教训的逐条回应" |
| § 13 成功指标 | [`mvp.md`](mvp.md) § 五 的里程碑完成标准（指标被绑定到可机械验证的验收项，而不是口号） |
| § 14 里程碑 | [`mvp.md`](mvp.md) § 五 |
| § 15 风险与缓解 | [`../security.md`](../security.md) § 5（剩余风险）与 [`mvp.md`](mvp.md) § 六（未决事项） |
| § 16 开放问题 | [`mvp.md`](mvp.md) § 六 逐条列出"哪些已决定、哪些还没决定、由什么来决定" |
| § 18 下一步 | [`mvp.md`](mvp.md) 全文即是对 § 18 的回答 |

---

## 对 Happier 教训的逐条回应

定义文档 § 12 列了八条"参考 Happier 的改进承诺"。它们是本项目的差异化来源，因此每一条都要落到一个具体的机制上，而不是一句态度：

| 承诺 | 本项目的机制 |
| :--- | :--- |
| Daemon 自愈与状态感知，避免 always-on 脆弱假设 | daemon 把"监督 DSH"与"连中继"当作两件互不阻塞的事；`Status` 暴露 `state` 与 `relay` 两维状态，远端能区分"电脑不在线"与"电脑在线但 DSH 挂了"（[`../architecture.md`](../architecture.md) § 3、§ 4） |
| Relay 启动时检测反向代理超时并给出警告 | 三层：中继绑非回环时警告（回环安静）；daemon 认出"按固定节拍被掐断且从未承载会话"的 carrier 并**点名** `proxy_read_timeout`（只打印一次）；两端默认每 30 秒各发一个 WebSocket 保活让 60 秒这类默认超时不再必然掐断。实测 `scripts/deploy-probe.mjs` **8/8**（含"只让一端 ping"的归因实验）。症状与取值见 [`../operations/self-hosting.md`](../operations/self-hosting.md) 与 [`../operations/troubleshooting.md`](../operations/troubleshooting.md) |
| 推送通道可选，支持去中心化推送，减少对第三方依赖 | 默认路径完全不依赖第三方（隧道内通知）；Web Push 必须显式开启，且在文档中如实说明它比隧道内通知更弱（[ADR-0006](../decisions/0006-notifications.md)） |
| 主动进行第三方深度安全审计 | 审计分三段；前两段（内部威胁模型评审 `../security.md` § 5.7、实现评审 § 5.9）已完成，第三段的范围、材料清单与"声明 → 改坏就红的检查"表写在 [`../audit-scope.md`](../audit-scope.md)。**第三方审计本身尚未进行**，因此"审计无高危"是未达成项，不是已完成项 |
| 简化开发工作流，提供单 stack 快速启动 | `pnpm run verify` 一条命令覆盖 Rust 与 TypeScript 的全部检查；仓库内没有需要手工编排的构建步骤（[`../development/contributing.md`](../development/contributing.md)） |
| 移动端崩溃监控、性能优化、稳定性优先 | 崩溃率按 rule of three 报数（`scripts/browser-soak-smoke.mjs`，600 次运行支持 0.5% 的结论）；滚动性能由 `scripts/browser-perf-smoke.mjs` 量；**崩溃上报**是 M5 加的：一跳、无服务器——客户端 → 自己那台 daemon → `$DSHD_STATE_DIR/crash-reports.jsonl`（0600），`drdshd crashes` 读取（[`../security.md`](../security.md) § 5.10）。离线与失败状态是 M0 起就必须可读的（[`mvp.md`](mvp.md) § 五） |
| 旧 CPU 兼容检测，提供 npm 等替代安装 | 支持下限是各架构 baseline（x86-64 = SSE2，aarch64 = armv8-a），无 `target-cpu=native`；`drdshd doctor` 打印 CPU 与扩展的 present/absent；旧 CPU 上的可运行性由 qemu 模拟 Core 2 / Nehalem / Westmere **实测 13/13**（[`../operations/install.md`](../operations/install.md)）。**npm 等替代安装尚未提供**（见下"偏差记录"第 4 条） |
| 区分通知噪音与关键状态反馈 | 三档严重度被写进协议类型，映射表在 [ADR-0006](../decisions/0006-notifications.md) 中逐行定义，并由插件的单元测试固定 |

---

## 与定义文档的偏差记录

如实记录我们**偏离或收窄**了定义文档的地方，以及原因：

1. **远程客户端的形态**：定义文档 § 8 把远程客户端描述为"PWA 或应用"。本项目先做 PWA；原生 App 推迟到 M3 之后评估，且理由不是性能——而是"把中继从客户端可信计算基里移除"（[`../security.md`](../security.md) § 5.1）。
2. **通知的完整性**：定义文档 § 9.5 期望任务完成、权限请求、状态变化等通知。"权限请求"在 M0 就可用（DSH 自己跨进程转发它）；"任务完成"与"子代理完成"需要安装插件。这个分期是刻意的：先让关键路径零依赖可用（[ADR-0006](../decisions/0006-notifications.md)）。
3. **"中继服务可自托管，也可使用托管服务"**（§ 9.8）：MVP 只支持自托管。托管被推迟到 M4，因为它需要先回答运营与合规问题，而不是技术问题（[`mvp.md`](mvp.md) § 三）。第 37 轮的 [ADR-0011](../decisions/0011-hosting-rules.md) 把这件事定成"运营问题而非代码缺口"，并明确禁止在中继里为将来的托管预埋数据收集。
4. **"提供 npm 等替代安装"**（§ 12）：v0.1.0 新增原生 Release tar，提供 Linux x86_64 musl 混合/独立包与 macOS arm64 daemon，并附 SHA256SUMS。npm、独立签名、自动 CI 发布与可复现构建尚未提供；见[发布说明](../operations/releases.md)和[审计范围](../audit-scope.md) § 2.4。旧 CPU 的既有 qemu 验证见安装文档。
5. **"团队房间、多用户共享"**（§ 16 的开放问题，M6 目标里提到）：第 37 轮的 [ADR-0008](../decisions/0008-team-rooms.md) 决定**不做**。理由不是工程量，而是当前代理层的授权粒度只到"这条隧道能不能连"：`may_control` 只管生命周期命令，任何连上的客户端都能在 DSH 界面里做任何事，因此今天无法诚实实现"只读成员"。
