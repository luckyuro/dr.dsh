# 2026-10-30 功能复核与部署验收

本记录区分部署前快照、隔离进程回归和最终公网浏览器验收。尚未完成的项目不因已有历史记录而
计为通过；服务正常与首页返回 200 也不等同于模型登录、任务或项目创建可用。

## 范围与版本

本轮目标为复核插件报告、可选 daemon、Relay 配置与转发、纯前端连接、DSH 登录、宿主目录
选择及原生 DSH 界面，并部署到 ali、blade 后从本机浏览器验证。用户选择 DSH
`0.2.2-alpha.2`；该版本已通过本轮真实插件、隔离浏览器与最终公网验收。

用户在本轮明确接受先保留 DeepSeek 账号登录限制、完成其余部署验收。因此不等待账号/API key，
也不把未发送模型请求的空会话当成模型任务成功。

部署前 blade 已运行 DSH `0.2.2-alpha.2`，但当时已安装插件的兼容常量仍为
`0.2.1-rc.2`。原插件仅通过 daemon 注入的 loopback 报告 URL 和短期令牌发送事件，未提供
插件独立配置 Relay 并建立隧道的路径，因此不能把这一快照描述为“daemon 可选”已经实现。

## 用户八项要求的验收口径

| 要求 | 本轮实现与验证范围 |
| :--- | :--- |
| 1. 插件转发状态到 Relay | 受管模式沿用 daemon 的本机鉴权报告通道；独立插件模式启动随 DSH 生命周期的原生连接进程，复用加密隧道转发状态和事件。两种模式的真实进程报告检查分别通过，Relay 不读取事件内容 |
| 2. daemon 可选，用于启动/重启 DSH | 独立插件连接不要求安装 daemon 用户服务，报告 `owned=false`，拒绝停止/重启宿主；选择受管 daemon 后才具有 DSH 监督生命周期。插件停止时连接进程结束，不能把它描述为独立常驻服务 |
| 3. 两端可配置 Relay，受管 DSH 自动安装配置 | 插件使用 `relayUrl`，daemon 使用 `--relay`；受管实例优先使用 daemon 注入设置，避免第二条连接。最终安装器不传 `--dsh` 时自动从官方 npm 安装固定 DSH `0.2.2-alpha.2` 并注册完整插件；macOS 与 Linux 的真实下载、注册、复装和卸载后重装均 4/4 通过。既有显式 DSH 路径继续保留 |
| 4. Relay 负责数据转发 | Rust 工作区测试与静态依赖约束通过；Relay crate 仍不依赖密码学 crate 或控制面。真实背压、双向大载荷及公网 WSS carrier 往返分别验证转发行为 |
| 5. 网页是纯前端，持续交换数据 | ali 的 PWA 独立静态托管，HTTP/WS 经加密隧道到 DSH；embedded、mux、Worker 恢复与离线检查保留，公网静态文件逐项校验 |
| 6. 网页正常登录 | dr.dsh 配对和连接登录与 DeepSeek 账号登录分别记录。**DeepSeek 账号的公网登录未通过验收**：当前上游登录使用 loopback HTTP 回调；blade 没有可用账号/API key，后续还需要用户本人授权，不能把配对成功算成账号登录成功 |
| 7. 新建项目选择 DSH 机器目录 | 隔离浏览器验证选择实际宿主目录及创建新目录；公网打开 blade 的 `drdsh-workspace` 并创建空会话，最终 v13 再核对宿主路径及会话保留。浏览器本机目录不作为宿主目录 |
| 8. 网页尽量保持 DSH 一致 | iframe 内使用真实 DSH 页面，dr.dsh 只提供浮动连接控制；不复制 Harness 业务界面。原生页面、移动布局与连接恢复由 embedded/浏览器检查验证 |

插件连接的生命周期与权限边界见 [ADR-0026](../decisions/0026-plugin-owned-tunnel.md)。

## 部署前快照

以下为 2026-10-30 的只读检查结果；PID 是当时的进程快照。

| 检查 | 结果 |
| :--- | :--- |
| ali 公网入口 | `https://drdsh.bigshi.cn` 和 `https://drdsh.runzhi.xyz` 均返回 HTTP 200 |
| ali Relay 健康 | 版本 `0.1.1`、wire `[0,1]`、1 个 room；监听 `127.0.0.1:8787` |
| ali Relay 服务 | `drdsh` 用户的 `drdsh-relay-3d1d75e12787.service`，active/running、enabled、Linger=yes；PID 170148，NRestarts=0 |
| ali Relay prefix | `/var/lib/drdsh/.local`；原 source 为 `/var/lib/drdsh/releases/relay-floating-v10-20261030-796ae60c-r2` |
| ali 静态前端 | `/srv/dr.dsh-relay/current` 指向 `/srv/dr.dsh-relay/releases/pwa-floating-v10-20261030-57cd1aa4-r2` |
| Pingap | 版本 `0.14.3`，系统服务 active；配置 `/var/lib/pingap/conf`，启用 `--autoreload`，PID 14361，NRestarts=0 |
| 浏览器响应头 | 首页 CSP 包含 `frame-src 'self'`；Service Worker 有 `Service-Worker-Allowed: /`，首页及 Worker 均 `Cache-Control: no-cache` |
| blade daemon | `drdsh-daemon-3fb04488c6ce.service`，active/running、enabled、Linger=yes；PID 242882，NRestarts=0 |
| blade DSH | PID 242906；仅监听 `127.0.0.1:3080`；程序 `/home/luckyuro/.local/opt/dsh/0.2.2-alpha.2/node_modules/.bin/dsh` |
| blade 数据位置 | DSH home `/home/luckyuro/.local/share/dr.dsh/dsh-home`；工作目录 `/home/luckyuro/drdsh-workspace`；daemon 状态 `/home/luckyuro/.local/share/dr.dsh/daemon` |
| blade 插件归属 | web profile 已注册 `@dr.dsh/dsh-plugin`；`pluginOwner=external`，报告与本机管理均启用 |

部署前 daemon 配置 SHA-256 为
`f6531e55fc14d6dc6491650ec681c90044c317107bd7a60adec33227be6dad57`；原生程序 SHA-256 为
`796ae60cf1dcd12bcc5de8427de03e821fc59bb0e71842561d6c0c9b014822bb`。

## 回滚准备

在服务保持运行时建立私有备份，归档为 `0600`，其父目录为 `0700`。这是在线文件快照，
没有声称应用状态跨文件的事务一致性；若回滚发生在新增配对或会话之后，不应直接覆盖新状态。

| 主机 | 归档与内容 |
| :--- | :--- |
| ali | `/root/drdsh-backups/acceptance-20261030-optional-plugin/before.tar.gz`：Relay 程序、配置、服务定义、Pingap 配置与前端 current 符号链接；旧静态 release 目录保留 |
| blade | `/home/luckyuro/drdsh-backups/acceptance-20261030-optional-plugin/before.tar.gz`：daemon 程序、配置和状态，DSH home/profile、插件管理私有目录与服务定义；不复制运行时 socket |

ali 归档 SHA-256：`7e6204853a3c738338e5177b9ad74fe61abc3d84a23aee3164c93e368ae24e64`。
blade 归档 SHA-256：`6e3b78b743912dd851d9cb4e92e909e18288687a63c79036a8da215421db533d`。
归档包含私有数据，应留在所属机器的私有目录，不作为公开验收附件。

## 隔离回归

| 检查 | 实际结果与边界 |
| :--- | :--- |
| Relay 背压 | 本机既有 `target/debug/drdsh-relay` 运行 `relay-backpressure-smoke.mjs`，7/7 通过：双向 32 MiB 顺序与摘要一致、无关房间可继续转发、停滞连接回收 |
| TLS 传输 | 本机既有 `target/debug/drdsh` 运行 `relay-transport-smoke.mjs`，22/22 通过：WS/WSS、配对、证书拒绝、显式跳过校验、TLS 1.2/1.3、HTTPS DSH 代理和插件报告 |
| Linux 用户服务 | blade 的隔离 `systemd-smoke.mjs` 10/10 通过：特殊路径、首次启动、重复启动、自启动开关、停止与重启；使用真实替身进程，结束后清理临时服务与目录 |

以上两项是最终改动前的基线结果。最终构建与公网浏览器验收结果记录在后文，不能用基线
结果替代新功能验收。

systemd 检查完成后，正式 daemon 仍为 PID `242882`、NRestarts=0，配置 SHA-256 与部署前
一致。该检查首次尝试发生在辅助文件传输尚未结束时，Node 因模块缺失退出、未创建测试服务；
传输完成后重新执行通过。

最终 Linux release 的 Relay 背压复测也为 7/7。额外的 Linux daemon 管理实测首次在第 4 项
之后遇到 `ECONNRESET`：诊断确认，超大 IPC 请求已经收到完整 166 字节 JSON 拒绝行，随后
Linux 因请求尾部仍未读取而重置连接。原生客户端按换行读取响应，测试辅助函数却等待 EOF，
因此把完整拒绝响应误判为失败。测试辅助函数改为在有界完整 JSON 行到达时完成，仍拒绝裸断连、
不完整行和超大响应；没有放宽 daemon 请求上限或加入无限制读取。Rust 回归用带有未读尾部的
超大输入验证结构化拒绝，并再次发送正常请求确认服务仍可用。

修正后 Linux 定点 Rust 协议回归通过，最终 release 的真实 daemon 管理实测 **16/16** 通过。
未改动 daemon 生产请求处理逻辑。第一次定点 Cargo 命令未限制为库测试，因独立构建目录缺少
集成测试生成的 `target/ws-vectors.json` 而停止；改为只运行目标库测试后通过。

主验收与其他并行检查的已完成结果如下；模型任务是否成功以最后的浏览器记录为准。

| 检查 | 实际结果 |
| :--- | :--- |
| Rust 全工作区 | `cargo test --workspace` 与 Clippy 均通过 |
| 本机运行时管理与插件回归 | daemon 管理 16/16、插件通知 13/13、插件管理 7/7、插件归属 7/7、独立服务安装更新卸载 41/41 |
| 真实 DSH `0.2.2-alpha.2` | 房间密钥 12/12、审计日志 16/16；实测脚本修正退出清理递归、使用规范绝对路径并移除密钥片段输出 |
| PWA | 单元测试 238 项通过；两个 DSH 版本的 embedded 实测各 15 项通过，多房间实测 14 项通过 |

## 首轮数据面构建与部署

独立 Linux 构建目录为 `/home/luckyuro/drdsh-builds/acceptance-20261030-optional-plugin`。
构建工具使用 stable Rust `1.99.1`、`rust-lld` 和 Zig `0.17.0`；C 编译器目标为
`x86_64-linux-musl -mcpu=baseline`，不使用本机 CPU 扩展。构建缓存复制到独立目录，
不覆盖已有源码或发布归档。

原生构建从当前工作区捕获 312 个源文件，包含未提交和未跟踪源码，未使用 Git HEAD 归档。
源归档 SHA-256 为 `ccf9f26b6a3000392c47fbc31d7a00420388f1b3d9baacb2399bdf841d227ada`；
逐文件路径、大小和 SHA-256 记录在本机构建产物
`target/acceptance-2026-10-30/linux-native-source-manifest.json`，传输后逐项核对。
插件与 PWA 后续按各自收尾版本独立打包，见后文；这一原生源码快照不代表最终全部产物。

Linux `x86_64-unknown-linux-musl` release 构建退出码 `0`；产物是 x86-64 ELF static PIE。
本机产物为 `target/acceptance-2026-10-30/linux/drdsh`，SHA-256
`fcada38bb9ad759b6c2df86e8f0358ae766acf474f41061688a70a72723c7eb9`，与 blade 增量构建输出一致。
初次构建的 `fb6a6043…` 在 IPC 测试修正后已被替换，不作为最终部署产物。测试修正的两文件
补充归档 SHA-256 为 `5bb1b863d2c31ae020979737106a6d16c9876c69dfd2b620d3efc6dc26ee3240`，
对应本机 `target/acceptance-2026-10-30/linux-native-ipc-overlay-manifest.json`。

最终 PWA 重新执行生产构建并通过 `check-pwa-build.sh`，共 36 个静态文件。Relay 包 SHA-256
为 `2e9c1b2038356255d6f068f632f16c7704e7a22339f3d231d85cd861b81efe2a`；首页 SHA-256 为
`ee3bad556ae6b766e7133c629767d949000d1d287530ddfc2491df0251dcd0bb`。全部静态文件清单记录在
`target/acceptance-2026-10-30/relay-pwa-manifest.json`。

### ali 正式更新

2026-10-30 22:42（Asia/Shanghai），使用最终包更新原 Relay prefix，并将独立静态 PWA 的
`current` 符号链接原子切换到新 release。旧发布目录和上述私有备份保留。
这里的“最终包”指当时已完成的数据面改动；后续澄清增加的 DSH 自动安装能力需要新的原生构建，
本节的摘要仅描述已实际上线的版本，不提前算入后续改动。

| 检查 | 结果 |
| :--- | :--- |
| Relay 新源目录 | `/var/lib/drdsh/releases/relay-acceptance-20261030-2e9c1b20` |
| PWA 新目录 | `/srv/dr.dsh-relay/releases/pwa-acceptance-20261030-ee3bad55` |
| 安装后配置 | 仅 `relay.json` 的 `source` 字段变化；其余保存设置与备份逐字段一致 |
| 运行程序 | 安装后程序 SHA-256 与最终 `fcada38b…` 产物一致 |
| 服务 | `drdsh-relay-3d1d75e12787.service` active/running、enabled；PID 171292，NRestarts=0 |
| 健康 | 公网和回环 `/healthz` 返回版本 `0.1.1`、wire `[0,1]`；已有 blade 房间重新连上，rooms=1 |
| Pingap | 不需改配置或重启；配置文件 SHA-256 全部保持，PID 14361、NRestarts=0 |
| 两个公网域名 | 本机直接访问 `drdsh.bigshi.cn`、`drdsh.runzhi.xyz`，首页及 35 个模块/图标等静态文件逐字节匹配发布清单 |
| 浏览器相关边界 | 主页 CSP、SW 根作用域与 no-cache 正确；直接访问隐藏首页、未被 Worker 接管的隧道路径和本机管理路径均为 404 |
| 公网 WSS | 两域都完成独立临时 room 的两侧握手、双向各 8 KiB 不透明 carrier 摘要比对，结束后关闭测试连接 |

静态和 WSS 检查是本机真实网络进程检查，尚不等同于浏览器中的 DSH 登录或项目创建。
本轮首次重新构建的 36 个 PWA 文件与上一版 `pwa-floating-v10-r2` 逐字节一致，均使用离线缓存
版本 v10。随后浏览器出现两次状态超时、完整重载后恢复，因此追加缓存版本一致性修复与实测；
磁盘上这两个发布目录相同，不足以证明浏览器中更早的历史缓存也相同。
机器可读结果为本机 `target/acceptance-2026-10-30/ali-public-verification.json`，部署快照为
同目录的 `ali-deployment-after.json` 和 `ali-deployment-staging.json`。

### blade 正式更新与本机浏览器

首轮公网浏览器检查已经观察到：

| 检查 | 结果与边界 |
| :--- | :--- |
| 复用已保存配对 | 两次连接后的状态请求超时；第三次完整重载后进入同页真实 Harness，缓存一致性修复仍在继续 |
| DeepSeek 账号登录 | 公网页面实际点击 Sign in 后显示 `Could not sign in`；当前上游 loopback HTTP 回调约束尚未解除，不记为通过 |
| 宿主目录选择器 | 已正常显示 blade 的主机目录条目，并选择打开 `drdsh-workspace`；新建空 `New Session` 成功，未发送模型请求。最终 v13 的重连、宿主路径与会话保留复验见后文 |

登录失败截图在本机 `output/playwright/acceptance-public-login-failure.jpg`。最终插件部署和缓存
修复记录见下节；最终公网连接、宿主路径及会话保留结果见文末。
工作目录与空会话截图在本机 `output/playwright/acceptance-public-workspace.jpg`。

## 最终自动安装、PWA v11 与两端部署

根目录 `pnpm run verify` 全部通过后重新执行唯一的 PWA 生产构建和 `check-pwa-build.sh`，
最终取包的 `dist` 包含 36 个静态文件。PWA 单元测试增至 239 项；真实 Chromium 的
v10→v11 缓存升级检查 8/8、DSH `0.2.2-alpha.2` embedded 检查 16/16、离线检查 6/6 通过。
v11 在安装成功前完整预缓存模块图；预缓存失败时保留旧 Worker，命中当前版本缓存时不再由
后台网络请求覆盖单个模块。已经打开的旧文档须完整重载，不能承诺热替换其模块图。

最终原生源码从工作区捕获 315 个文件，归档 SHA-256 为
`fb460f4f2fd3156bdc1e7f398ba8edf575f63d36062c13214cd5f066f44d8434`；
之后补入卸载后重装默认插件的单文件修正，补充归档 SHA-256 为
`d209779e25aff9aa1779f1a76c98df376eaeea85ec85330cc8d95d59a713f20a`。
两份归档均传输后逐文件核对，最终构建前确认所有 Rust 源码和 Cargo 文件与当前工作区一致。
补充归档首次解压保留了旧时间戳，Cargo 未重编译；刷新该源文件时间戳后确认出现真实
`Compiling dr-dsh-cli` 和 14.36 秒编译记录，最终摘要因此不同于中间的 `218f830f…`。

Linux 最终构建退出码为 0，仍为 baseline x86-64 musl static PIE。产物及包的 SHA-256 为：

| 产物 | SHA-256 |
| :--- | :--- |
| 最终原生程序 | `6d3f55415aa6a1f29f1566539829a3695bed29c3615c115d60b3549fcc428ae2` |
| Relay 包 | `d9db0cd79dca3defa64d85797e6611ce4c64ce5206d6ffc6a8b1b3d9782e8b5f` |
| daemon 包 | `873cf22bf64f3067768286387d8e01348f259e33aff7417bf97bbe7d5df678e1` |
| DSH 可安装插件包（含 Linux 原生程序） | `aae2a6b98959d2a38f4fc18a67b469719db03b2a2c86b871b285480904f52e46` |
| v11 Service Worker | `e078ed3a94edc44bdde9de7c46f792757e6a0e8fabc47f16368780d594a088cf` |

本机 `target/acceptance-2026-10-30/final-deployment-manifest.json` 保存上述摘要和全部 PWA 文件
摘要。首页本身仍与首轮相同，静态 release 目录因此使用 v11 和 Worker 摘要命名，避免与旧目录混淆。

最终 Linux 程序在隔离临时目录运行真实 npm/DSH 自动安装检查 **4/4**：省略 `--dsh` 和
`--with-plugin` 自动安装固定版本及插件；真实 web profile 注册编译后的 ESM、管理静态文件和
匹配原生载荷；重复安装保留私有 DSH 与 lockfile；卸载后再次安装恢复默认插件。
测试专门设置了无效的用户级 `@deepseek-ai` registry，验证自动安装不继承该覆盖设置。
中间二进制的首次检查在最终单文件修正到来后中止并清理，只有最终二进制完整 4/4 计为验收。

正式切换前追加私有在线快照，仍保留原始备份和所有旧 release 目录：

| 主机 | 最终切换前备份 SHA-256 |
| :--- | :--- |
| ali | `dcea012ac38db24bd151c4f13ea72c16357c6f3b95852b5bd431b541a6274dd0` |
| blade | `b719d1891da8b9ade1e45061f5b3323264d22523e86972bd308d66d76bf1bcd9` |

备份位于前述两台机器原备份目录下的 `final-deploy-before/before.tar.gz`，权限仍为 0600，
父目录为 0700。它们不是公开交付附件，也不是跨文件事务快照。

2026-10-30 23:11–23:13（各主机时钟，Asia/Shanghai）完成切换并核对：

| 检查 | 最终结果 |
| :--- | :--- |
| ali Relay | `/var/lib/drdsh/releases/relay-final-20261030-d9db0cd7`；PID 171982，active/running、enabled，NRestarts=0 |
| ali 静态 PWA | `current` 原子切换至 `/srv/dr.dsh-relay/releases/pwa-final-v11-20261030-e078ed3a` |
| ali 配置 | 仅 Relay `source` 字段变化；Pingap 全部配置摘要不变，PID 14361、NRestarts=0 |
| 两域公网文件 | `drdsh.bigshi.cn` 与 `drdsh.runzhi.xyz` 各自首页及 35 个模块/资源逐字节匹配最终清单；CSP、SW 根作用域、no-cache 和隐藏路径 404 均通过 |
| 两域公网转发 | 两域均以临时房间完成 WSS 握手与双向各 8 KiB 不透明 carrier 摘要核对，测试后关闭连接 |
| blade 安装 | 短暂停旧 daemon，用既有 DSH 和同一 `DSH_HOME` 执行官方 `dsh plugin --profile web add` 安装完整 tgz，再安装新 native 到原 prefix 并启动 |
| blade 程序与插件 | 安装程序、插件内原生程序均匹配最终 `6d3f5541…`；插件 14 个文件逐项匹配 tgz，实际安装的兼容基准为 `0.2.2-alpha.2` |
| blade 服务 | daemon PID 257853，active/running、enabled，NRestarts=0；本机 DSH 响应，直接无鉴权访问返回预期 401 |
| blade 配置与数据 | 仅 daemon `source` 字段变化；`pluginOwner=external`、DSH 程序路径、DSH home、工作目录和状态目录全部保留；8 个状态文件仅审计日志追加，其余文件（含配对状态）摘要不变 |

机器可读结果保存在本机 `target/acceptance-2026-10-30/` 的
`ali-final-public-verification.json`、`ali-final-deployment-after.json` 和
`blade-final-deployment-after.json`。原有 DSH 为显式外部安装，本轮没有把它迁移为私有受管 DSH；
自动下载能力由前述隔离真实安装测试验证。

最终 Linux 程序另在隔离目录通过真实 DSH 独立插件检查 **9/9**：不安装 daemon 服务、
`owned=false`、独立本机授权、配对及加密状态往返、真实 DSH 页面、远程管理/生命周期拒绝、
真实会话和目标事件通知、Relay 重连、宿主强制退出后回收连接进程。
初次装配把 multicall 别名当作无需参数的旧 Relay 程序，修正为显式 `relay run` 后进入测试；
随后发现 smoke 的 `daemon pair` 会继承机器已有默认 prefix 配置，改为直接访问临时 companion
的私有 IPC，并对异步建立的测试房间作 5 秒有界就绪等待。只有修正后的完整 9/9 计为验收。
这些是测试装配与隔离问题，未修改产品原生代码，正式配对文件在测试后仍保持原摘要。

同一最终 Linux 程序的真实 systemd 插件管理检查 **7/7** 通过，覆盖本机授权、OS 作业、
宿主退出后继续重启、更新、卸载/重装与私有结果。测试使用临时 prefix/profile，未改变正式
daemon PID 或自启动设置。日志为本机 `target/acceptance-2026-10-30/` 下的
`linux-plugin-connect-final.log` 与 `linux-plugin-management-final.log`。

### v12 前端热更新

v11 部署后的公网浏览器曾再次出现状态超时，后来恢复了 Harness。诊断时观察到实际状态请求
每 3 秒发送，回复为 22–106 ms，浏览器接收编号匹配；该次设备认证约 91 ms。
因此不能把后续找到的 250 ms 认证窗口问题直接认定为这次现场超时的唯一原因。

继续检查并修正了两个独立时序问题：已配对设备必须等到明确接受后才返回可用隧道，挑战、
签名及接受共用 10 秒上限，迟到拒绝不能被当作成功；重叠状态探测按连接代次和已完成顺序处理，
旧结果不能覆盖较新的结果。单次状态超时保留进行中的代理传输与后续探测，后续成功可恢复连接
显示和通知，实际断连仍结束旧会话。

两项改动与缓存版本 v12 一起冻结，PWA 单元测试 **247/247**、TypeScript 检查、文档检查、
生产构建检查均通过。真实 Chromium 的 v11→v12 缓存升级 **7/7**、DSH
`0.2.2-alpha.2` embedded **16/16**（含离线 **6/6**）通过。该次没有重新运行 v10 缺陷复现；
v10→v11 的历史 8/8 与本次 v11→v12 的 7/7 分别保留。

2026-10-30 23:31 完成只涉及前端资源的热更新：

| 检查 | 结果 |
| :--- | :--- |
| v12 静态目录 | `/srv/dr.dsh-relay/releases/pwa-final-v12-20261030-e850fa0e` |
| 对应 Relay 包目录 | `/var/lib/drdsh/releases/relay-final-v12-20261030-e2373535` |
| Relay 包 SHA-256 | `e2373535fdfe7a8fac500e4d33d73fde69eb9e174bedf9b3c9a3f817c0ac13dd` |
| v12 `offline.js` SHA-256 | `e850fa0eddb4940ea59de4af8df34c2fb7c2906ab9944dec9158904c57e78a51` |
| 程序与进程 | 原生程序仍为 `6d3f5541…`；Relay PID 171982、Pingap PID 14361、blade daemon PID 257853 均不变，NRestarts 均为 0 |
| 安装目录一致性 | 在组件操作锁内交换已安装 Relay 的 `client` 目录，并同步配置中的 `source`；未调用安装器或重启服务。Relay 回环返回的 `offline.js`、`panel.js`、`tunnel.js` 与清单匹配 |
| 公网两域 | 各自 36 个静态文件、CSP/SW/cache 响应头、隐藏路径 404、双向 WSS 8 KiB 检查再次通过 |

Service Worker 主文件没有变化；v12 更新由其导入的 `offline.js` 变化触发，因此新目录不能只用
未变化的 Worker 主文件摘要区分。首页也与 native 内嵌首页保持同一摘要。
旧 v11 release、已安装静态文件与配置备份均保留。最终机器可读证据为本机
`target/acceptance-2026-10-30/pwa-v12-deployment-manifest.json`、
`ali-v12-deployment-after.json` 与 `ali-v12-public-verification.json`。

v12 后继续发现了首屏大页面传输时的状态误报；下文记录其复现、修复和最终公网浏览器验收。

v12 稳定连接后另完成一次公网真实生命周期操作：在浏览器点击重启 DSH，DSH 进程从
PID 257877 变为 261179，daemon 仍为 PID 257853、NRestarts=0。浏览器内原生 Harness
短暂显示 Reconnecting 后自行恢复，无需页面重载，既有 workspace 和空 `New Session`
保持，未发送模型请求。日志记录新 DSH 于 15:38:23Z 就绪；证据为本机
`target/acceptance-2026-10-30/public-restart-verification.json` 和
`output/playwright/acceptance-public-restart.jpg`。这验证的是受管 daemon 的实际远程重启能力，
不代替下一轮对首次加载状态超时的验收。

### v13 大页面传输期间的状态等待

完整保留的 v12 公网帧时间线确定了本轮一次误报的原因：约 11.08 MB 的首屏流量与控制消息
共用有序 carrier。首个状态请求在 99 ms 发出、120 ms 收到；3.1–24.1 秒间后续 8 个请求的回复
（counter 190–197）在约 25.162 秒一起到达，之后往返恢复到几十毫秒。原固定 5 秒期限把
仍持续传输中的排队误判为状态失败。证据为
`target/acceptance-2026-10-30/public-status-queue-evidence.json`，只记录帧元数据，没有明文
payload 或密钥。这证实的是这次捕获的排队问题，不泛化为所有历史超时的原因。

v13 只调整状态探测：以 **5 秒没有经过认证的入站活动**作为空闲超时，同时保留 **60 秒总上限**。
生命周期命令、崩溃报告和设备认证各自期限不变；无关流量也不能无限延长未答复状态请求。
缓存升级到 v13，以免新页面继续使用旧控制模块。

真实浏览器慢传输回归先在 v12 复现误报，再在 v13 通过 **17/17**：以 1 MiB/s 传输
11,024,580 字节的真实 DSH bundle 耗时 11.865 秒，其间状态答复等待 7.779 秒，没有错误掉线；
停止全部下行字节后，8.014 秒内观察到有界状态失败，恢复传输后 6 ms 内恢复，原 Harness
会话和 mux 继续可用。该次脚本设置普通 idle 检查为 0 秒，不能据此替代此前单独的长期 idle
检查。红绿证据分别为 `slow-transfer-v12-before.json` 和 `slow-transfer-v13-after.json`，
均在本机 `target/acceptance-2026-10-30/` 下。

最终 v13 的 PWA 单元测试 **252/252**、TypeScript 检查、文档检查、生产构建检查与真实
Chromium 的 v12→v13 缓存升级 **7/7** 全部通过。2026-10-30 23:47 再次仅热更新前端资源：

| 检查 | v13 最终结果 |
| :--- | :--- |
| 公网静态目录 | `/srv/dr.dsh-relay/releases/pwa-final-v13-20261030-af554cc6` |
| Relay source | `/var/lib/drdsh/releases/relay-final-v13-20261030-c5b3c3ab` |
| Relay 包 SHA-256 | `c5b3c3ab645c6698902f42f387cc647af84a8ca611addeb322e0ab60a7ff80ad` |
| v13 `offline.js` SHA-256 | `af554cc6e1b7f571c055b6ad3555de0797f624fe1e913f825118bdd2ddb239b6` |
| 运行程序与服务 | 原生程序仍为 `6d3f5541…`；Relay 171982、Pingap 14361、blade daemon 257853 均保持运行，NRestarts=0 |
| 静态一致性 | 公网两域各 36 文件、响应头、隐藏路径 404 和双向 WSS 检查全部通过；已安装 Relay 的 `control.js`、`panel.js`、`tunnel.js`、`offline.js` 回环摘要匹配 |

v13 继续使用组件操作锁、目录交换、配置原子写入和公网符号链接切换，保存旧版本与备份，
没有重装原生程序或重启服务。最终清单与部署结果为
`pwa-v13-deployment-manifest.json`、`ali-v13-deployment-after.json` 和
`ali-v13-public-verification.json`，保存在本机 `target/acceptance-2026-10-30/`。

## 最终公网浏览器验收与交付边界

2026-10-30 23:52，从本机 Mac 的 Codex 内置浏览器访问 `https://drdsh.bigshi.cn`，
完整重载 v13 后完成两次真实连接。第二次明确先断开，再使用原保存配对重连，没有重新输入配对码。

| 检查 | 实际结果 |
| :--- | :--- |
| 实际加载版本 | 浏览器实际加载的 `offline.js`、`tunnel.js`、`panel.js`、`control.js`、`i18n.js` 五个摘要全部匹配最终 v13 清单 |
| 首次完整加载 | `connecting → ready`、面板初期 `busy → ok`；约 25 秒的大 bundle 排队期间没有 `failed/error`，随后连续 8 个状态回复均为 `ok` |
| 显式断开后重连 | 原保存配对可复用；第二次连接全程没有错误状态，原生 Harness 正常显示 |
| 宿主目录与会话 | 原 workspace 和空 `New Session` 保留；目录选择器实际显示 `/home/luckyuro/drdsh-workspace/`。此前公网已从该宿主目录创建空会话；本次复验没有发送模型请求 |
| 浏览器诊断 | v13 验收时段 console warning/error 为 0；此前 3 条 warning 来自 15:38Z 主动重启 DSH，已单独区分，未混入该时段结果 |
| 管理边界 | 公网点击管理链接只在新页显示 interface route 无法恢复，没有获得管理页面或授权；该导航只验证独立页面路由拒绝。直接 HTTP/WS 管理路径拒绝由隔离真实进程检查覆盖，不把这个页面结果写成已直测 native 403 |

机器可读记录为本机 `target/acceptance-2026-10-30/browser-final-verification.json`，保留五个
模块摘要和两次状态时间线。截图在本机：

- `output/playwright/acceptance-public-v13-final.jpg`
- `output/playwright/acceptance-public-v13-host-path.jpg`
- `output/playwright/acceptance-public-v13-management-denied.jpg`

本次完整公网 UI 验收使用 `drdsh.bigshi.cn`；`drdsh.runzhi.xyz` 完成同一最终版本的逐文件、
响应头、边界路径和 WSS 往返验证，没有将它记为另一次完整 UI 验收。

最终交付为 ali 的 v13 前端和 Relay、blade 的最新原生程序与 DSH `0.2.2-alpha.2` 完整插件，
旧版本及私有回滚材料保留。**DeepSeek 账号的公网登录仍是用户本轮接受保留的限制，未发送
模型请求，也未验收真实模型任务成功。** 其余已授权部署、独立插件连接、自动安装、宿主目录、
原生界面和远程重启检查的实际结果如上。
