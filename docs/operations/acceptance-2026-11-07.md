# blade / ali 完整流程验收（2026-11-07）

本轮使用当前工作区构建，验证首次安装、真实项目创建、插件增删、后台接管、跨机配对与维护。
已修复并复测下述问题。先完成无需模型的验收，随后按用户授权，从 blade 的 `~/dskey`
读取凭据，补测真实模型、工具、审批、长会话和模型生成插件的流程。密钥只配置到隔离 profile，
收尾已恢复原凭据文件并检查临时副本。此次未发布新 Release，也未升级原有线上实例。

## 环境与隔离

- blade：Linux x86_64、真实 systemd 用户会话、Node 26.13.0、Rust 1.99.1；构建静态 musl 程序。
- ali：独立 prefix 安装 relay，经既有 Pingap 的临时 HTTPS/WSS 路由访问；使用正常证书验证。
- 浏览器：macOS 上真实 Chromium 149，远程页面经 ali 访问 blade；本机管理通过 SSH loopback 转发。
- DSH：官方 npm `latest=0.2.2-rc.1`；使用新的 DSH home、工作目录、插件存储和 daemon prefix。
  `alpha=0.2.2-alpha.3` 不在本轮兼容声明内。上游源码目录未修改。

临时测试域名通过测试浏览器解析规则和 blade 的临时 hosts 项指向 ali，没有修改公网 DNS。
浏览器关闭系统代理后进行测试；证书校验始终开启。

## 发现与修复

1. **最新版 DSH 被插件版本范围排除。** 在核对已发布运行时代码并完成实际安装、事件、界面和管理检查后，
   将基准更新到 `0.2.2-rc.1`。首次私有安装固定相应 Cordis `4.1.0` 家族；已有私有
   `0.2.2-alpha.2` 保留原版本和依赖锁，不随 daemon 更新强制升级。
2. **自定义实例在接管后丢失管理引用。** OS 服务没有继承手动宿主的 `DRDSH_MANAGER_PREFIX` /
   `DRDSH_MANAGER_STORAGE`，管理页因此读到了默认安装。复现时仅执行了读取；核对确认默认安装的
   配置、配对文件、PID 均未改变。私有启动器现在固定这两个值，原生服务也传递自身 prefix。
   新增真实执行接管后的浏览器断言，检查原 prefix、授权存储、profile 和作业恢复。
3. **持续 HTTP 响应被缓冲到结束。** 插件 `/plugins/events` 的首条事件无法交付，最终出现 503。
   daemon 与 PWA 改为流式转发，浏览器预检包含可转移 `ReadableStream`；跨机首批数据实测约 31 ms。
   同时修复 Worker 更换时的 SSE 永久关闭：正常退休返回 EOF 让浏览器重连，普通资源中断仍报错。
4. **长会话刷新后反复重连。** 真实模型会话的历史快照为 **141182 字节**，超过旧单块 65472 字节限制，
   旧实现丢弃了快照并把连接结束当作正常关闭。现在以 **PX v2** 分片并在浏览器按顺序重组，
   最大 8 MiB，carrier 仍为 64 KiB。Rust、TypeScript 和共享向量同步更新；超限或无效消息给出明确原因。
   原失败会话刷新后恢复全部 300 行输出，顺序完整，继续模型对话成功。

新增或扩展的复验入口为 `scripts/browser-management-smoke.mjs`、
`scripts/dsh-provision-smoke.mjs --previous-drdsh <旧程序>`、`scripts/browser-embedded-smoke.mjs`，
以及启动器真实子进程、流式响应和大型 WebSocket 快照测试。协议取舍见
[ADR-0028](../decisions/0028-streaming-and-large-snapshots.md)。

## 真实跨机界面流程

| 操作 | 观察结果 |
| :--- | :--- |
| 全新 profile 安装单包插件 | DSH 包管理器成功注册，管理页正常加载 |
| 独立本机授权、配置中继、安装 daemon | 系统作业完成，外部插件归属保留 |
| 接管手动 DSH | 原宿主退出，新宿主由 daemon 运行；修复后原实例和作业记录保留 |
| 一次性配对、刷新与留空重连 | 经 ali 建立加密连接；刷新后保留设备身份，无需重新输入配对码 |
| 首次预览设置 | 保存成功；刷新后保留确认结果 |
| 新建项目目录与工作区 | 浏览器创建 `projects/remote-e2e`；SSH 确认目录实际位于 blade，随后成为 DSH 工作区 |
| 插件停用、启用、卸载、重新安装 | 经远程 DSH 页面完成；安装来源为 blade 上的完整 tgz；profile 注册和运行状态符合操作结果 |
| 远程重启、停止、启动 DSH | PID 与状态正确变化，恢复后工作区与插件保留 |
| 强制终止测试 DSH | daemon PID 不变，DSH 自动以新 PID 恢复，relay 仍 connected |
| 诊断、筛选、复制报告 | 五项检查正常；运行中的端口显示需注意；报告复制成功；手机宽度可用 |
| 远端管理拒绝 | HTTP 返回带明确原因的 503；WebSocket 拒绝；正常隧道继续可用 |
| 撤销设备 | 现有连接关闭；旧身份重连明确提示配对失效，需要重新配对 |

停机、重启和拒绝测试会产生预期网络错误；正常项目创建和插件安装阶段未观察到未捕获的浏览器异常。

## 真实模型补测

使用 DSH `0.2.2-rc.1` 页面中选择的 **DeepSeek-V4.1-Flash / High**。每次发送前都核对浏览器
实际选中会话、持久化 `identity.cwd`、daemon prefix、DSH 进程环境和原服务配置摘要；
工作区为 blade 的隔离 `projects/remote-e2e`，不以进程 cwd 代替会话工作区检查。

| 操作 | 观察结果 |
| :--- | :--- |
| 真实模型回复与多轮上下文 | 指定短标记准确返回；刷新修复后继续对话，保留先前 Maple 答案 |
| 创建代码、运行工具与测试 | 模型创建 Python 实现和 unittest；页面显示执行成功，SSH 独立重跑 **5/5** 通过 |
| 一次性允许审批 | 先确认目标文件不存在，浏览器允许后才出现预期内容；会话仍为「工作区内修改」 |
| 拒绝审批 | 浏览器拒绝后模型停止该操作，没有创建目标文件，也没有改变常驻权限 |
| 提问回答 | 真实提问卡选择 Maple，模型返回对应答案 |
| 长输出与会话刷新 | `ROW-001..ROW-300` 完整且有序；大快照修复后刷新恢复，再发送任务成功 |
| 文件改动查看 | 打开本次模型生成 `model-plugin/index.js` 的差异，显示实际 12 行新增内容 |
| 模型生成插件 | 模型编写 DSH bundle、检查格式并产出 tgz；安装前独立检查包内容，确认激活标记不存在 |
| 远端安装、启用与卸载生成插件 | DSH 页面安装 tgz 并启用，组件显示运行中；SSH 验证 `apply` 写入唯一预期标记，随后页面卸载并确认 profile 已移除 |
| 停止生成与继续对话 | 点击「停止生成」后显示「已停止」；下一回合返回预期恢复标记 |
| 实际插件通知 | 真实回合完成与审批通知进入 PWA 通知面板 |

模型打包时第一次 npm 命令因工作区外日志路径被限制而失败，模型将缓存与日志放入测试工作区后成功，
没有放宽会话权限。历史回合在 DSH 重启后不再可用的变更摘要返回 404（上游接口的既定行为），
当前运行期的新回合差异已实测可用；浏览器另记录宿主文件管理器图标 404，未作为关键流程通过的依据。

## 自动化与真实进程检查

| 检查 | 本轮结果 |
| :--- | :--- |
| `pnpm run verify` | 最终修复后 Rust、clippy、TypeScript、CLI/打包、导入隔离和文档检查通过 |
| `browser-management-smoke.mjs` | macOS / 真实 DSH **6/6**，包含实际接管与恢复 |
| `browser-embedded-smoke.mjs --check-account-origin --check-offline --check-slow-transfer` | 最终真实 DSH **22/22**；含 11 MiB 资源限速传输、断流恢复、项目目录、多房间、持续 SSE 与 Worker 更换后的重新订阅、HTTP/WS 拒绝；独立离线 **6/6** |
| PX v2 共享向量与大型 WS 测试 | 两种语言读取同一成功/拒绝语料；真实加密隧道携带 200000 字节 UTF-8 文本，后续短消息仍正常；浏览器侧完整重组跨片字符 |
| `dsh-provision-smoke.mjs --previous-drdsh ...` | blade **6/6**：下载、插件注册、重装、卸载重装、错误依赖拒绝、旧 alpha 版本与 lock 保留 |
| `service-smoke.mjs` | blade **41/41**：安装、更新、卸载与两侧 PID/配置/配对状态隔离 |
| `systemd-smoke.mjs` | blade **10/10** |
| `plugin-management-smoke.mjs` | blade **7/7**：授权、持久作业、幂等、错误与宿主退出 |
| `daemon-management-smoke.mjs` / `plugin-owner-smoke.mjs` | blade **16/16** / **7/7** |
| `dsh-upgrade-smoke.mjs` | DSH `0.2.2-rc.1` **6/6**，本机与 blade 均通过 |
| `plugin-connect-smoke.mjs` | blade **9/9**：无 daemon 服务的插件隧道、配对、真实页面、权限拒绝、事件、重连、退出清理 |
| `relay-transport-smoke.mjs` / `relay-backpressure-smoke.mjs` | blade **22/22** / **7/7** |
| `plugin-notification-smoke.mjs` | blade **13/13** |
| `room-key-smoke.mjs` / `audit-smoke.mjs` | blade **12/12** / **16/16** |
| `pwa-crash-smoke.mjs` / `doctor-smoke.mjs` | blade **9/9** / **3/3** |
| ali 临时 relay 维护 | restart、enable/disable、stop/start、复装及卸载均通过；每次运行状态均检查 `/healthz` |

测试工具本身的准备问题（缺开发二进制、使用包装脚本冒充 raw relay、传入打包器拒绝的软链接）
已修正后重跑；表格只计最终成功结果。

## 收尾与证据

临时 daemon 服务、relay 服务、SSH 转发和浏览器均已停止，临时 hosts 项和 Pingap 路由已移除。
前一轮因 SSH 中断遗留的早期测试进程已经不在；补测结束后两台主机按测试路径扫描均没有残留进程。
模型补测开始与结束之间，两台原服务 PID、重启次数、配置 SHA-256、blade 配对文件及 ali PWA 目录一致。
blade 在补测开始时的原服务 PID 已不同于前一轮最初快照，因此这里明确采用**补测前**快照，
不把两轮之间未观察的时段描述为 PID 不变。

临时 `.credentials.yaml` 已恢复；检查隔离 profile、日志及私有产物共 82 个文件，未发现该 API key 的副本。
用户原有 `~/dskey` 未修改。一次性配对文件已删除，专属浏览器会话与其数据已清除。
测试产物、隔离 profile 和日志保留在两台主机各自的 `acceptance/20261107` 目录，未成为常驻服务；
模型生成代码和 tgz 保留作为测试产物，生成插件已从隔离 profile 卸载。

本地未入库证据位于 `target/acceptance-2026-11-07/`；界面截图位于 `output/playwright/acceptance-*.png`
和 `model-20261107-*.png`，包含审批、通知、长输出恢复、插件激活、文件差异和停止状态。
这是一轮有界功能验收，不代表第三方安全审计、长期稳定性或所有 DSH 插件的兼容认证。
PX v2 大文本当前覆盖 DSH → 浏览器方向；输入与二进制消息仍受旧单块限制。第三方账号登录、
语音依赖、每一种模型提供方与所有实验性插件没有逐一启用测试。

## 2026-11-08 提交前复验

在本机 macOS、真实 DSH `0.2.2-rc.1` 和 Chromium 上重新构建并检查本次提交。
此轮不重复跨机模型任务，使用隔离 profile、临时 prefix 和本机 launchd 作业；未更新已有线上实例或 Release 附件。

| 检查 | 结果 |
| :--- | :--- |
| `pnpm run verify` | Rust（含 doc tests）326、TypeScript/共享 JavaScript 373、CLI/打包 9 项通过；5 项真实 DSH Rust 测试按默认设置忽略，未计入通过数；其余静态检查通过 |
| `cargo fmt --all -- --check`、原生/PWA 构建、`check-pwa-build.sh` | 通过 |
| `doctor-smoke.mjs` / `framework-validation-smoke.mjs` | **3/3** / **5/5** |
| `plugin-management-smoke.mjs --check-browser` | **9/9**，含页面校验、手机布局与持久 OS 作业 |
| `browser-management-smoke.mjs` | **6/6**，含实际接管后的原实例、授权存储和作业恢复 |
| `browser-embedded-smoke.mjs --check-account-origin --check-offline --check-slow-transfer` | **22/22**，另含独立离线 **6/6** |
| `browser-cache-upgrade-smoke.mjs` | **7/7**，从保留的 v13 客户端升级到 v17，配对摘要及整套缓存 SHA-256 保持预期 |

缓存升级复验发现测试探针会短暂全局绕过 Worker，误伤离线重载时尚未完成的动态模块加载，
使配对仍在存储中而设备列表没有显示。探针改用明确放行且不缓存的专用路径验证网络断开，
并等待设备列表完成异步读取后断言；保留失败时的客户端请求诊断。修复后上述缓存升级通过，
另以 `browser-embedded-smoke.mjs --check-offline --idle-ms 1000` 复验 **19/19**（含独立离线 **6/6**）。
短等待复验只检查探针修复，35 秒连接保持和慢传输结论仍以上表完整运行结果为准。
