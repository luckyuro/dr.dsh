# dr.dsh 故障排查

本文适用于 **v0.2.0**。先找到页面或日志中的原话，再检查对应的一侧。
安装入口是 `drdsh relay ...` 和 `drdsh daemon ...`；插件独立连接随 DSH 启停。
版本与环境范围见[发布验收](acceptance-2026-11-04.md)，部署步骤见[快速开始](../../README.zh.md#快速开始)。

## 先收集这些信息再提问

在 DSH 电脑与中继服务器分别执行：

```sh
# DSH 电脑
drdsh daemon version
drdsh daemon status
drdsh daemon doctor
drdsh daemon logs

# 中继服务器
drdsh relay version
drdsh relay status
drdsh relay logs
```

记录故障发生时间、浏览器提示、DSH 版本和是否使用插件独立连接。`doctor` 只检查本机环境，
通过不代表中继、证书或浏览器连接已经可用。自己的中继可用 `curl -fsS https://relay.example.com/healthz` 检查。

提 issue 时保留错误文字，去掉配对码、房间密钥、管理授权码、DSH 登录 URL 中的 token 和凭据。
不要上传 daemon 状态目录或整个 `$DSH_HOME`。审计日志的内容边界见[安全说明](../security.md)。

## 症状速查

| 看到什么 | 先检查什么 |
| :--- | :--- |
| 401 / `dsh web authentication required` | 第 1 条：DSH 鉴权 |
| 页面空白、实时内容不动 | 第 2 条：隧道与浏览器 Worker |
| 固定间隔断线 | 第 3 条：代理超时与保活 |
| `no daemon is serving this room` | 第 3.5 条：daemon 或插件隧道在线状态 |
| DSH 本机正常，远端显示离线 | 第 4 条：中继地址、TLS 和进程 |
| 配对失败或配对码过期 | 第 5 条：重新生成；已保存的配对通常不必删除 |
| 远端启停按钮不可用 | 第 6 条：是否为附着或插件独立模式 |
| `next is not a function` / 设置无法保存 | 第 7 条：DSH 依赖组合与本机权限 |
| 二进制无法启动 | 第 9 条：平台、摘要与 CPU |
| `room is already in use` | 第 11 条：关闭另一条活跃连接 |

## 1. 手机打开页面显示 401 / "dsh web authentication required"

先区分入口：`/_drdsh/manage` 只允许本机 DSH 页面，远端请求被拒绝是预期行为；
正常 Harness 界面则由 daemon 或插件使用 DSH 自己提供的登录凭据访问。

1. 在 DSH 电脑打开 DSH 打印的本机登录 URL，确认 DSH 本身能使用；不要把含 token 的 URL 发给别人。
2. 检查 daemon 日志中的 DSH 启动与鉴权错误。DSH 重启后，daemon 应重新取得启动凭据。
3. 确认浏览器打开的是中继网页，配对后由页面内嵌入 Harness，而不是手工拼接 DSH 的 `/api` URL。
4. 若仅外部账号登录的回调失败，先在 DSH 本机完成登录。DSH 的公网 callback 限制不会被隧道解除。

不要以关闭鉴权、开放 DSH 监听地址或伪造 loopback 来修复；支持范围见[DSH 集成面](../integration/dsh-surface.md)。

## 2. 页面能打开但 `/api` 调用失败或实时更新不动

静态网页能打开，只证明 Relay 能提供 PWA。连接还需要浏览器的 Service Worker、
到 Relay 的 `/ws/client` WebSocket，以及 daemon 到 Relay 的连接。

先完整刷新 dr.dsh 页面，再选择已保存的电脑连接。打开开发者工具查看 Service Worker 是否控制当前页，
`/ws/client` 是否成功建立。页面内的 `/__dr/interface` 是 Harness；HTTP 由 Worker 按页面身份转发，
WebSocket 由父页的专属通道转发，不能只凭地址栏中的 `/api` 路径判断是否走了隧道。

反向代理必须允许 WebSocket 升级；nginx 单独托管 PWA 时，必须部署同一版本的完整 `client/`。
使用[部署示例](self-hosting.md)，不要单独替换几个 JavaScript 文件。

## 3. 长时间任务中途断线（反向代理空闲超时）

若每次都在接近固定间隔时断开，检查 nginx、CDN 或负载均衡器的 WebSocket idle timeout。
让代理超时长于保活间隔；daemon 默认每 30 秒发送 WebSocket ping，`DSHD_KEEPALIVE_SECS=0` 会禁用它。

分别查看 `drdsh daemon logs --follow` 与代理错误日志。daemon 会重连中继；浏览器仍未恢复时，
在 **dr** 控制面板中断开后重新连接。短暂状态探测超时不表示 DSH 已停止，
大资源传输时的等待规则见本文后面的“前端更新后仍显示旧界面或连接超时”。

## 3.5 客户端说「no daemon is serving this room」

中继可达，但所选房间没有 daemon 或插件隧道在线。刚配对时，daemon 更新权限会短暂重新注册；
v0.2.0 会在这一个明确的拒绝原因下重试最多约 5 秒。

持续出现时，在 DSH 电脑检查 `drdsh daemon status` 和日志。插件独立模式则检查 DSH 是否仍在运行，
以及插件是否打印了 tunnel ready。核对两端使用同一中继地址，并选择对应的电脑。
如果页面显示“配对已保存”，恢复连接后将输入栏留空再点连接，无需新配对码。

## 4. 远程显示「计算机离线」但本机 DSH 正常

DSH、本机隧道和中继是三个不同进程。DSH 正常不保证后两者在线。

| 日志或状态 | 处理 |
| :--- | :--- |
| daemon 未运行 | `drdsh daemon start`；检查启动日志 |
| 插件独立隧道未启动 | 检查 `relayUrl`、完整原生插件包和 DSH 兼容版本 |
| TLS / certificate 错误 | 核对 `ws://` / `wss://`、主机名、证书链和私有 CA |
| 正在重连 | 检查中继服务、网络和代理日志 |
| 设备已撤销或未登记 | 确认撤销意图后重新配对 |

证书配置见 [TLS 指南](tls.md)。浏览器和隧道使用的协议应与服务器实际监听一致，
不要把 `--bind 127.0.0.1:8787` 当作 daemon 的中继地址。

## 5. 配对码无效或已过期

配对码约 5 分钟有效，单次尝试后即消耗。失败后重新运行 `drdsh daemon pair`，
或在本机管理页取消并生成新码；输入时可点击连接或按回车。短时间多次失败会触发速率限制，按提示等待。

配对成功会保存浏览器身份和电脑记录，然后自动连接。若只是在后续连接阶段失败，
先恢复 DSH 和隧道，再留空重连。删除网站数据、切换中继域名或遗忘电脑后才需要重新配对。
插件独立模式的命令和状态目录见[独立连接步骤](../integration/dsh-surface.md#42-不安装-daemon-服务的插件连接)。

## 6. 远程端看到「已附加（attach）模式」，无法启动/停止

附着模式只代理已经运行的 DSH；插件独立隧道同样不拥有宿主进程。两者都不能在远端启动、停止或重启 DSH。

需要远程进程管理时，使用常驻 daemon。已有手动运行的 DSH 可在**本机插件管理页**安装 daemon，
完成身份检查后选择接管：它会停止当前 DSH，再以已保存配置重新启动，并非原地收养未知进程。
先保存正在进行的工作，具体步骤见[首次接管](daemon-management.md#独立作业与首次接管)。

## 7. 远程界面里部分设置项灰掉或无法保存

如果新装 DSH 连本机页面都报 `next is not a function`，或关闭首次预览提示时保存失败，
先检查依赖组合。DSH `0.2.2-alpha.2` 的浮动依赖可能解析到不兼容的 Cordis alpha.2 家族。
v0.2.0 的[私有 DSH 安装](dsh-provisioning.md)固定了通过实测的 alpha.1 组合，并保留 lockfile。
已有外部 DSH 不会被自动改写，兼容版本见[集成记录](../integration/dsh-surface.md#2026-11-04v020-发布兼容性)。

若只有远端的某个设置或登录动作不可用，在 DSH 本机页面完成操作，再重连远端。
DSH 对设置持久化、宿主操作和账号 callback 的限制随版本变化；dr.dsh 保留这些限制，
不通过改写页面身份恢复权限。请在报告中附上具体设置名称、DSH 版本和本机对比结果。

## 8. `drdshd doctor` 的每类输出分别意味着什么

当前入口为 `drdsh daemon doctor`；也可传 `--dsh /absolute/path/dsh` 与 `--port <port>` 检查指定安装。
它不启动 DSH，也不修改配置。

| 输出 | 含义与下一步 |
| :--- | :--- |
| `ok` | 该项通过 |
| `warn` | 需要检查，例如端口已被正在运行的 DSH 占用 |
| `FAIL` | 修复指出的问题，例如找不到 DSH、无法绑定端口或程序不能运行 |

端口已被占用时先确认占用者，避免误以为是本次 daemon 启动的 DSH。
本机检查通过后仍需执行真实配对和远端连接；doctor 不代替网络或浏览器验收。

## 9. 旧 CPU / 缺少指令集导致二进制无法启动

先核对操作系统与架构，并校验 Release 的 `SHA256SUMS`。当前包支持 Linux x86_64 musl 和 macOS Apple Silicon；
Linux 包静态链接，不依赖目标主机的 glibc。错误包或不支持的平台不能靠改文件名修复。

`Illegal instruction` 需要结合 CPU 型号与系统日志排查。发布构建使用默认 CPU 基线，
但这不保证每条执行路径都支持所有旧 CPU；实测范围以对应[发布验收](acceptance-2026-11-04.md)为准。
自行构建时，TLS 的 ring 后端仍需要目标平台的 C 编译工具链，步骤见[发布与构建](releases.md#开发与发布步骤)。
DSH 还要求可运行 Node 24.9+；dr.dsh 二进制能启动不代表该主机一定能运行 Node 和 DSH。

## 10. 隐私模式或旧浏览器里页面行为异常

远程页面需要 HTTPS，以及 Service Worker、WebCrypto 和 IndexedDB。localhost HTTP 仅适合同机测试。
使用最新普通浏览器窗口对比；部分隐私模式会限制 Worker 或持久存储。
隐私窗口关闭后可能不保留配对，不能据此判断 daemon 丢失了设备。

不要先清除网站数据：这会删除当前浏览器保存的配对。先完整刷新，再检查浏览器控制台中具体的能力错误。

## 11. 连接提示房间已被占用

`room is already in use` 表示这台电脑已有一个活跃浏览器连接。当前可以登记多个设备，
但同时只接受一条加密会话；协议容量常量不代表多客户端共享已经实现。

在原页面打开 **dr** 面板点击“断开”，或关闭原标签页，然后从新设备连接。
无需删除配对。还在运行旧中继时，先更新 Relay 和完整 PWA，见[升级说明](releases.md#v020-升级说明)。

## 12. daemon 报「DSH 已启动但未打印就绪行」

检查 daemon 日志、DSH 版本和 profile 的 `printUrl` 配置。daemon 需要 DSH 的就绪行来取得本机端口与启动凭据；
`--no-open` 只关闭自动打开浏览器，不应关闭该行。不要公开粘贴包含 token 的完整就绪 URL。

在隔离端口上直接运行 DSH 对比，恢复 `printUrl` 或使用已验收版本。如果上游格式确实改变，
按[DSH 升级仪式](../integration/dsh-surface.md)更新适配与回归，不能跳过鉴权直接代理。

## 远端偶尔连上了却没有任何响应

检查是否复制了同一套 daemon 状态给多个进程或机器。相同房间密钥代表同一个房间，
多个 daemon 会交替注册并关闭旧会话。保留一个实例，或为不同机器使用各自的状态目录和配对；
不要以反复重启中继来掩盖实例冲突。

## 控制面板与工作区目录选择

首次连接时管理界面铺满页面；进入 Harness 后，拖动 `dr` 浮钮可以在左右边缘吸附，点击它
打开控制对话框。方向键也可以移动浮钮。关闭按钮、Escape 或点击遮罩都只收起面板，
不会重载 Harness；「重新加载」与「断开」位于面板顶部。

添加 workspace 时点击 Harness 的「添加工作区」，在目录浏览器中选中 DSH 主机上的文件夹
并点击「打开」。点击「编辑路径」可以输入该主机的绝对路径，「新建文件夹」也会在该主机
上创建目录。目录不是访问页面的手机或另一台电脑上的文件夹，可访问范围由 DSH 进程的
文件权限决定。

默认受管 DSH 使用内置 browse 组合，避免选目录窗口弹在远端主机桌面上。若附着到既有
DSH，或已明确自定义 native/browse 配置，dr.dsh 保持其原设置；这时应在 DSH profile 中按
上游支持的方式选择 browse backend 与 client surface。实现和兼容边界见
[ADR-0025](../decisions/0025-host-directory-browser.md)。

独立插件连接同样保留 DSH 的目录选择器配置。无桌面的 Linux 主机通常由 DSH 的 auto
选择 browse；macOS 等有桌面的主机可能选择 native。需要固定为远端目录浏览时，可把下面
内容保存为本机的 `drdsh-directory-browser.yml`，并以
`dsh web --patch /absolute/path/drdsh-directory-browser.yml` 启动。此示例用于仍采用默认
`directory-picker` auto 行的 profile；已有自定义选择器时，应调整其原配置，避免同时启用两组。

```yaml
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true
- insert:
    - id: drdsh-directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: drdsh-directory-picker-ui
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

使用 DSH 支持的启动 patch，使设置保存后的 profile 重组仍只有一组选择器。插件不在运行中
停用 auto 或另挂 browse；那种临时修改会在 profile 重组后丢失，可能导致重复 provider。

旧版单独打开的 `/__dr/interface` 书签会返回连接页。若仍有旧连接页占用同一房间，先在旧页
断开或关闭它，再从新连接页进入；新页不会接管其他页面正在使用的连接。

## 前端更新后仍显示旧界面或连接超时

部署新版 PWA 后，完整重新加载 dr.dsh 页面，再选择已保存的电脑连接。仅在控制面板里断开、
重连，或只重载 Harness，不会替换外层页面已经加载的 JavaScript 模块。

当前客户端把外壳和连接所需的全部模块按版本一起缓存；模块缓存命中后不会在后台逐个替换。
若新版本有文件下载失败，新 Worker 不接管，旧版缓存仍可使用，配对记录也会保留。
新 Worker 准备完成不代表正在打开的旧文档已经换版；完整重载后才会使用新版模块。
这条恢复步骤不需要清除网站数据或重新配对。

状态回复与 Harness 资源共享加密连接，大资源下载时可能在同一连接里排队。状态探测会在
持续收到已认证、顺序有效的入站帧时延长等待；连续 **5 秒**没有这类进展，或单次状态请求
总计超过 **60 秒**，才报告“暂时无法确认 DSH 状态”。连接关闭仍立即报告断线；生命周期
命令的 30 秒和崩溃报告的 5 秒期限不变。仅 WebSocket 保持打开或收到无效密文不会延长等待，
持续的其他流量也不能绕过 60 秒上限。这个提示表示本次状态未确认，不等于 DSH 进程已经停止；
页面保留连接并继续探测，后续状态回复可恢复显示。

## 已保存设备的连接在认证阶段超时

已配对设备必须收到 daemon 明确的 `resume_accept` 才能进入 Harness。PWA 从会话 ACK 起等待
最多 10 秒，包含挑战传输、签名和接受回执；超时会关闭本次连接并显示原因。先重连并检查 daemon
与 Relay 的连接和日志，不要因为这条超时就清除网站数据；明确提示设备已撤销或未登记时再重新配对。

仅手动房间密钥、没有设备身份的旧 `RoomKeyOnly` 路径保留 250ms 静默兼容窗口，因为该模式
没有设备接受消息。这个兼容窗口不证明设备已获接受，迟到的挑战或拒绝仍会关闭连接；已保存身份
不会走这条回退路径。SPAKE2 首次配对使用独立步骤，不受此等待策略影响。

## 相关文档

- [`self-hosting.md`](./self-hosting.md) —— 部署、反向代理与超时取值、健康检查、容量与备份
- [`../security.md`](../security.md) —— 威胁模型与"不保证什么"（§ 5.5 是第 7 条的规范依据）
- [`../architecture.md`](../architecture.md) —— 组件、数据流、失败与恢复
- [`../protocol.md`](../protocol.md) —— 端点、握手、拒绝原因与常量
- [`../integration/dsh-surface.md`](../integration/dsh-surface.md) —— 所依赖的确切 DSH 接口面，以及每一条失效时的表现
