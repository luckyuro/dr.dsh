# 真实模型与插件通知验收记录

本记录覆盖 2026-10-29（UTC）在 Linux x86_64 主机上执行的真实 DSH 模型与通知测试，
浏览器由 macOS 上的 Playwright Chromium 操作。使用本轮构建的 `drdsh-plugin-0.1.1.tgz`、
对应 Linux 原生程序和 DSH `0.2.1-rc.2`。

插件安装与管理流程见[本机管理说明](../operations/daemon-management.md)，
DSH 事件契约与升级测试范围见[集成面说明](../integration/dsh-surface.md)，
通知的鉴权和投递边界见 [ADR-0020](../decisions/0020-plugin-realtime-notifications.md)。

## 验收结果

| 项目 | 结果与证据边界 |
| :--- | :--- |
| 最终插件包安装与加载 | 通过。临时 profile 中的插件 manifest 为 `0.1.1`，入口为 `./src/index.js`；真实 DSH 页面出现 dr.dsh 管理链接，受监督 DSH 具备报告鉴权环境 |
| 隔离实例配对、加密隧道和真实界面 | 修正隔离后通过。新设备仅出现在临时 registry，生产 registry 保持为空；通过 PWA 取回真实 DSH 界面 |
| 真实失败回合的结束通知 | 通过。真实 DSH 结束事件经最终包插件、本机鉴权接收器及加密隧道进入 PWA，面板显示一条 `Turn completed` |
| 成功完成两轮模型任务 | 阻塞。模型端返回 `AUTH / API key is invalid`，没有模型回答 |
| 真实模型工具调用、审批卡和远端许可 | 阻塞。认证失败发生在模型响应与工具执行之前，尚无相应实测结论 |

本轮只使用用户现有 DSH 配置中的 API key 字段，临时凭据文件权限为 `0600`。
DSH 默认 provider 为 `https://api.deepseek.com/anthropic`；实际请求被该 provider 拒绝。
没有尝试其他应用的凭据，也没有继续重试模型请求。`Turn completed` 证明结束事件的投递链路工作，
不能据此认定模型任务成功或审批流程通过。

## 隔离事故与修正

首次启动原生 CLI 时省略了 `--prefix`。CLI 读取默认安装配置，覆盖调用者设置的
`DSHD_STATE_DIR` 和 `DSH_HOME`，导致该测试实例误用了生产状态目录和 DSH home，
并发生一次测试设备误登记。

后续测试先在独立 prefix 安装，再为每条原生命令显式指定该 prefix；同时核对保存配置、
daemon 与 DSH 的实际进程环境、父子进程关系，以及该 prefix 的 `runtime.status`。
修正后的配对只向临时 registry 新增设备。

另外，DSH 新 profile 可能选择默认工作区；启动进程的 cwd 和 `DSH_HOME` 不能证明当前会话
使用测试工作区。本轮发现工作目录不符时，初版 shell 的失败断言没有阻止后续发送，仍提交了一次
仅指向测试自有文件的请求。该请求在认证阶段失败，没有执行工具动作。

随后补充了遇错立即退出的 Python 守卫：读取浏览器实际选中会话的 `data-row-key`，
核对该会话持久化的 `identity.cwd`，并在发送前再次确认选中会话未变化。
在工作区仍不匹配的状态下，守卫的 `--verify-only` 实测退出码为 `1`，没有填入或发送请求。
这项证据确认了阻断行为；成功模型任务仍待有效配置下补测。

本轮整体协作中还报告了另一路升级测试的误登记事件。该事件由总验收报告单独汇总；
下述恢复记录只覆盖本文这轮模型测试，不能用于推断另一路事件的细节或恢复状态。

## 恢复范围与保留残留

在获准恢复后，仅撤销本轮误登记的设备，保留审计记录；删除本轮唯一测试工作区行及一个空测试会话。
删除前检查该会话 journal，确认只有四个初始化事件，回合、步骤和消息数均为零；四个原有会话文件保留。
点击预览版继续按钮写入的 `welcomeNoticeVersion` 配置也已恢复，patch 回到空数组。
恢复使用精确内容核对和原子替换，没有用旧快照整体覆盖生产文件。

生产 daemon 及其 DSH 子进程在本轮期间未重启，`daemon.json` 的 SHA-256 持续一致；
生产 room-key 的已知修改时间和长度未变。清理后生产 registry 中设备数为零。

以下变化仍保留，因此不能声称生产磁盘内容已完全回到测试前：

- 新的 `devices-required` 安全标记与未持有的 `.runtime/runtime.lock`、`registry.lock`、`pairing.lock` 文件。
- `devices.json`、配对限速和审计记录。
- 恢复后配置、工作区文件的修改时间及格式变化。

临时管理 socket 随测试实例关闭消失。默认工作区目录为空，但其创建时间早于本轮测试，未删除。

## 清理与证据产物

临时 daemon、DSH 和 relay 均已退出；临时 daemon 与 relay 的显式 prefix 卸载均成功。
远端测试目录已删除，包含临时模型凭据、浏览器会话凭据、配对材料和日志。
本机私有脚本与配对材料目录、临时 PWA 归档、SSH 转发和专属浏览器会话也已清理。

本机保留的非凭据证据产物位于被 Git 忽略的 `output/playwright/`，不随仓库交付：

- `modeltest-auth-failure.png`：真实模型认证失败。
- `modeltest-failed-turn-notification.png`：PWA 收到真实失败回合的结束通知。
- `modeltest-preflight.py`、`modeltest-guarded-send.py`：本轮工作区和会话身份守卫。

这些文件仅列出名称，不建立依赖本机产物的文档链接。守卫包含本轮环境假设，不能原样作为通用测试命令；
重新执行时需建立新的隔离环境并复核选中会话、工作区和配置归属。
