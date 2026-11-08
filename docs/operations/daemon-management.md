# 插件页面与 Daemon 本机管理

安装包含原生程序的 DSH 插件包后，可从本机 DSH 的 `/_drdsh/manage` 页面安装、配置和维护
daemon，创建配对码、撤销设备并查看诊断。已有 CLI 继续可用；Relay 仍独立安装和管理。
配置与运行时接口依据 [ADR-0022](../decisions/0022-plugin-managed-daemon-foundation.md)，
页面授权、单包发行、后台作业和首次接管见 [ADR-0023](../decisions/0023-plugin-local-management.md)。

## 从一个 DSH 插件包开始

当前兼容基准为 **DSH `0.2.2-rc.1`**，并回归 `0.2.1-rc.5`；历史验收保留在本文后半部分。
插件独立连接不要求安装 daemon 服务，见[独立模式](../integration/dsh-surface.md#42-不安装-daemon-服务的插件连接)。
插件仍保留历史版本的事件报告兼容清单，
但不能据此认为旧版本的管理服务契约也已验证。当前原生包支持 Linux x86_64 musl 和
macOS Apple Silicon；需要可用的 systemd 用户会话或 launchd 用户会话。

拿到匹配本机平台的完整插件 `.tgz` 后，在 DSH 所在电脑执行：

```sh
dsh plugin --profile web add /absolute/path/drdsh-plugin.tgz
dsh web
```

1. 打开 DSH 启动时给出的登录链接，在首页点击 **dr.dsh 管理**；也可在同一 DSH origin 下
   打开 `/_drdsh/manage`。页面加载仍须通过 DSH 自己的鉴权。
2. 在管理页选择打开本机浏览器完成授权。插件向本机 OS 浏览器交接一个 5 分钟内单次有效的
   链接；页面取得 15 分钟的管理会话。已有 DSH 登录状态本身不会解锁管理权限。
3. 填写 Relay 的 `ws://` 或 `wss://` 地址并检查 DSH 目录、工作目录和端口。首次安装默认
   来自当前 DSH profile；已有安装读取 `daemon.json`。保存或安装不会建立一个重复配置副本。
4. 当前 DSH 是手动启动时，先安装不启动的 daemon，再检查并确认首次接管计划。接管会关闭
   当前 DSH，再由 daemon 启动它，页面会短暂断开；恢复后重新授权并查询作业结果。
5. 运行后在页面创建配对码，到 Relay 的 PWA 完成配对。管理页授权与远端设备配对是两套权限。

没有图形桌面时，页面会提供私有 `local-unlock` / `local-launch.url` 文件的路径；通过你信任的
本机文件访问方式取得解锁内容，再在解锁框输入或选择文件。路径不是秘密，文件内容是秘密，
不要放进聊天、日志、截图或公开链接。SSH 转发只提供访问通道，仍须 DSH 登录与本机管理授权。

浏览器刷新、DSH 重启或插件重新加载后，按页面提示重新授权。停止 daemon 服务或 DSH 会
同时关闭由该 DSH 承载的管理页面；需要重新启动 DSH 才能再次打开页面。daemon 仍运行而仅
停止 DSH 时，可由已配对远端客户端启动 DSH；整个 daemon 已停时使用本机 CLI 或用户服务管理器。

### 页面分区与输入提示

| 分区 | 用途 |
| :--- | :--- |
| 运行概览 | 服务、宿主与设备数量，下一步指引、接管与后台作业 |
| 连接与配置 | 中继、端口与本机路径；字段旁提示原因，提交时汇总错误并聚焦首项 |
| 配对与设备 | 生成、复制与取消一次性配对码，查看和撤销设备 |
| 诊断中心 | 运行本机检查，按通过／需注意／失败筛选，查看建议、复制报告或展开原始输出 |
| 服务维护 | 启停、重启、自启动、应用插件附带版本与卸载 |

短格式授权码在本机表单中直接提示错误，不消耗服务端解锁尝试。格式正确也必须经过原有授权检查。
本机授权到期时间显示在页首；锁定会取消页面请求、丢弃迟到响应并清空配对码与诊断输出。
锁定不会取消已交给 OS 的作业。授权码仅在内存中使用，不写浏览器存储。

### 构建完整插件包

此入口生成可交给 DSH 包管理器的本地 `.tgz`，不代表已发布到 npm。构建机先执行 `pnpm install`
准备本地 TypeScript 编译器，并准备与当前源码版本一致、包含本机管理与作业接口的原生 `drdsh`，再执行：

```sh
node scripts/package-plugin.mjs \
  --native x86_64-unknown-linux-musl=/absolute/path/linux/drdsh \
  --native aarch64-apple-darwin=/absolute/path/macos/drdsh \
  --output /absolute/path/drdsh-plugin.tgz
```

`--native` 可重复，也可只包含目标电脑的平台；输出选择一个尚不存在的 `.tgz` 路径。
包包括编译后的插件 ESM JavaScript、Web 资源与 `native/<target>/bin/drdsh`、`bundle.json`。安装这个包不要求
用户另装 Rust 或执行 daemon 安装脚本；DSH 本身及其包管理器仍是前提。
打包器同时生成 `<output>.sha256`，供分发时核对完整性。新版 daemon Release 包内的插件也可
携带同平台的最小 native 载荷；它不把完整 Release 包递归放进插件。

仓库测试仍直接运行 `.ts`，但 Node 不会在 `node_modules` 内执行 TypeScript type-stripping。
因此两个发行入口共用 `scripts/package-plugin-source.mjs`，使用仓库本地 TypeScript API 生成
`src/*.js`，把相对 import 的 `.ts` 扩展名改为 `.js`，并将包的 exports 指向 `./src/index.js`。
发行包不含测试源码或安装脚本；安装时不编译插件，也不需要用户另装 TypeScript。
打包前仍须完成类型检查，`pnpm run test:cli` 会将两种实际归档放进临时 `node_modules` 并用 Node 导入验证。

DSH 的 pnpm 安装可以把包内文件硬链接到同用户的内容存储。bootstrap 允许这类可信包输入，
仍要求普通文件、当前用户所有、不可被组或其他用户写入，并核对大小、版本与目标平台；不跟随符号链接。
执行前会把输入复制到插件私有缓存，缓存中的程序、清单与完整性记录仍须只有一个硬链接，防止与包存储共用可变文件。

当前管理页只使用随包 native。缺少匹配平台、文件损坏或版本不符时明确失败，不回落到旧
Release。bootstrap 底层另支持受信任本机配置选择固定 Release 版本及 SHA-256；页面不能指定
下载地址、`latest`、原生包源或管理 prefix。校验不是签名或可复现构建保证。

## 页面状态、授权与文件

| 内容 | 默认位置或生命周期 |
| :--- | :--- |
| daemon 安装配置 | `<prefix>/etc/dr.dsh/daemon.json`；唯一配置来源，默认 prefix 为 `~/.local` |
| 插件私有目录 | `~/.local/share/dr.dsh/plugin-manager/<DSH-home-摘要>/`，`0700`，位于插件包以外 |
| `instance.json` | `0600`；只记录协议版本和 prefix 引用，不复制 daemon 配置 |
| `local-unlock` | `0600`；本机解锁 capability，不能公开或当作配对码 |
| `local-launch.url` | `0600`；最近一次本机启动链接，5 分钟、单次使用，重启失效 |
| 管理 Bearer | 仅保存在本次页面和插件内存中，15 分钟；重启、卸载或会话失效后需重新解锁 |
| 页面作业恢复提示 | `sessionStorage` 只保存版本、prefix 与 jobId，不保存凭据；重新授权后用于恢复当前实例的查询 |
| `packages/` | 平台与版本隔离的原生缓存，检查 SHA-256；不随 DSH 插件目录一起被覆盖 |
| 原生作业 | `<prefix>/var/lib/dr.dsh/jobs/`；跨页面或 DSH 退出保存状态，不能凭断线判断完成 |

特殊本机部署可在启动 DSH 前配置 `DRDSH_MANAGER_PREFIX` / `DRDSH_MANAGER_STORAGE`。
插件生成的私有 DSH 启动器会固定这两个值，保证接管、服务重启和崩溃恢复仍回到同一实例；
原生 daemon 服务也会向 DSH 传递自己的安装 prefix。不能依赖 OS 服务继承手动启动时的环境变量。
已保存的实例引用不能通过浏览器改写成另一个 prefix；迁移须由本机操作者显式处理。测试实例
应使用独立 DSH home、prefix、存储目录与端口，避免接管日常安装。

管理静态资源和 API 均经过 DSH 的鉴权与真实 loopback 对端检查。POST 还要求精确匹配
DSH origin 的 `Origin`、JSON 请求体，限制 64 KiB、读取 5 秒；最多 16 个并发请求。
响应不缓存、不开放 CORS，页面 CSP 限制为自身脚本且禁止被嵌入其他页面。

| HTTP 接口 | 额外权限与返回 |
| :--- | :--- |
| `GET /_drdsh/manage`、`manage.css`、`manage.js` | DSH 登录与 loopback；页面及固定静态资源 |
| `GET /_drdsh/api/access` | DSH 登录与 loopback；只返回授权文件路径及本机浏览器可用信息 |
| `POST /_drdsh/api/open-local` | DSH 登录、loopback、同源；显式请求 OS 打开本机授权链接，响应不含链接秘密 |
| `POST /_drdsh/api/unlock` | 同上，提交 `{capability}`；受限速保护，成功返回短期 token 与失效时间 |
| `GET /_drdsh/api/state` | 另需管理 Bearer；安装状态、当前 profile 与本机默认值 |
| `POST /_drdsh/api/execute` | 另需管理 Bearer；提交 `{operation, params}`，返回结构化原生结果 |

daemon 在连接 DSH 前统一拒绝远端 HTTP 和 WebSocket 对 `/_drdsh` 及子路径的访问。
点目录、嵌套编码不能绕过拒绝，query 中普通字符串不参与路径判断；错误不回显原始路径或秘密。
报告令牌、DSH cookie、远端配对身份均不能单独调用本机管理。

## 配置与插件归属

`<prefix>/etc/dr.dsh/daemon.json` 是安装配置的唯一来源。新增字段如下：

| 字段 | 默认和作用 |
| :--- | :--- |
| `pluginOwner` | 缺省为 `daemon`，兼容旧安装。`external` 表示插件由 DSH 包管理器或用户管理，daemon 安装、更新、卸载不再复制、注册或移除插件 |
| `pluginReportsEnabled` | 缺省沿用旧 `components` 中是否有 `plugin`；显式布尔值独立控制报告接收器 |
| `localAdminEnabled` | 缺省关闭；启用后在 daemon 下次启动时开放私有 Unix socket |

安装时可使用 `--plugin-owner daemon|external`、`--plugin-reports` / `--no-plugin-reports`、
`--local-admin` / `--no-local-admin`。外部归属与 `--with-plugin` 或 `install plugin` 冲突时明确拒绝，
不会偷偷接管插件。选择外部归属本身不会迁移现有包或改写 DSH 的注册信息；应由拥有它的安装器
完成包迁移。外部插件须自行安装到 DSH，再显式启用报告功能。

`config.set` 只保存配置，不启动服务、不重写正在使用的服务定义。返回 `restartRequired: true`
时，由页面提交重启作业，或在独立终端执行 `drdsh daemon restart --prefix <prefix>`；重启会影响受管 DSH。
prefix、状态目录和包路径迁移不能通过普通配置补丁完成。

## JSON 命令

入口为 `drdsh daemon manage [--prefix <prefix>]`。stdin 传一个 JSON 对象并结束输入，stdout
只返回一行 JSON，不含 Logo 或进度文字。退出码 `0` 表示成功，`1` 表示结构化失败。

```sh
printf '%s\n' '{"version":1,"requestId":"config-1","operation":"config.get","params":{}}' \
  | drdsh daemon manage

printf '%s\n' '{"version":1,"requestId":"config-2","operation":"config.set","params":{"localAdminEnabled":true}}' \
  | drdsh daemon manage

# 在独立终端应用配置；运行中的 DSH 会一起重启。
drdsh daemon restart

printf '%s\n' '{"version":1,"requestId":"runtime-1","operation":"runtime.status","params":{}}' \
  | drdsh daemon manage
```

协议版本为 `1`，独立于隧道 wire 版本。`requestId` 为 1–128 字节，只接受 ASCII 字母、数字和
`-_.:`；`params` 是对象，可省略为空对象。未知顶层字段、多个 JSON 对象、超大请求会拒绝。
请求和响应各限 64 KiB；日志类结果还有 `truncated` 标记，封装后超限则返回 `response_too_large`。

成功形状为 `{"version":1,"requestId":"…","ok":true,"result":{…}}`；失败形状为
`{"version":1,"requestId":"…","ok":false,"error":{"code":"…","message":"…","retryable":false}}`。
无法解析或标识符不合法时 `requestId` 为空。调用方使用 `code` 判定失败类型，不解析人类错误文案。
配对码仅由 `pair.begin` 返回一次；不要把整个响应写进日志。

`doctor` 检查未通过时仍返回 `ok: false`，CLI 退出码仍为 `1`，错误码为 `diagnostic_failed`；
该失败响应额外附带 `result: {text, truncated, exitCode: 1}`，保留诊断报告中的具体原因。
页面显示失败提示和报告。执行器无法启动、配置读取失败或操作超时仍返回相应执行错误，不伪装成
已完成的诊断。文本结果按 JSON 编码后的响应限额截断，并以 `truncated` 明示。

管理层现在调用 `doctor --json`：`result.text` 携带 `version: 1` 的结构化报告，外层响应格式不变。
页面保留旧版 `[ok  ]`、`[warn]`、`[FAIL]` 文本兼容；未知或截断输出不会显示为全部通过。
命令行可直接使用 `drdsh daemon doctor --json`；不加参数仍输出原文本。
检查不创建状态目录、不修改配置，也不会因端口被占用自动接管进程。报告字段与复验见
[校验和框架接入](../development/validation.md)。

| 操作 | 参数与结果 |
| :--- | :--- |
| `status` | `{}`；安装、保存配置、用户服务和运行时状态。未安装也可查询；运行接口不可用会在 `runtime` 中返回原因 |
| `config.get` | `{}`；`config` 为保存值，`effective` 为归属和开关的兼容解释 |
| `config.set` | 直接传字段补丁；返回保存值、`changed` 和 `restartRequired` |
| `runtime.status` / `lifecycle.status` | `{}`；运行实例标识、PID、状态目录、DSH 生命周期、设备元信息和配对状态 |
| `pair.begin` | 可选 `waitSeconds`（1–300）、`expectedRelay`；返回 `pairingId`、`code`、`room`、`relay`、`expiresAtMs` |
| `pair.status` / `pair.cancel` | `{"pairingId":"…"}`；状态为 `pending`、`complete`、`cancelled`、`expired` 或 `failed`，查询不重发配对码 |
| `devices.list` | `{}`；`paired`、`revision`、`devices` 元信息数组和可空的 `problem` 原因，不含密钥 |
| `devices.revoke` | `{"deviceId":"…"}`；撤销结果和登记版本；关闭该设备已有访问 |
| `lifecycle.start` / `lifecycle.stop` / `lifecycle.restart` | `{}`；操作受管 DSH，daemon 本身继续运行；attach 模式沿用原有拒绝规则 |
| `service.start` / `service.stop` / `service.restart` | `{}`；通过用户服务管理器操作整个 daemon 服务 |
| `service.enable` / `service.disable` | `{}`；只改变登录自启动 |
| `install` / `plugin.install` | 使用下述安装参数；同步调用原生安装器 |
| `update` | 可选 `version`；同步更新当前 daemon 安装 |
| `uninstall` / `plugin.uninstall` | `{}`；沿用原有保留配置与状态的卸载规则 |
| `logs.tail` / `doctor` / `audit.read` / `crashes.read` | `{}`；有界 `text`、`truncated`、`exitCode`，不提供持续跟随 |
| `audit.clear` / `crashes.clear` | `{}`；沿用原有清理语义 |
| `job.submit` | `{operation, params, idempotencyKey?}`；提交独立 OS 作业并返回 `jobId` |
| `job.status` / `job.list` | `{jobId}` / `{}`；读取持久作业状态与结果 |
| `handoff.plan` | `{port, dshHome}`；返回 `planId`、`pid`、`port`、`dshHome`、`expiresAtMs`、`requiresRestart`，计划 5 分钟内单次有效 |

`config.set` 接受 `relay`、`port`、`dsh`、`dshHome`、`workdir`、`caCert`、`tlsInsecure`、`dshTls`、
`pluginOwner`、`pluginReportsEnabled`、`localAdminEnabled`。只允许 `caCert` 为 `null`；其余字段
必须给明确类型和值。设置在组件操作锁内验证并原子保存，失败不覆盖旧配置。拥有旧插件注册时，
改变 `dshHome` 会拒绝，需先清理旧注册。

安装参数为 `source`、`buildProfile`、`pluginOwner`、`relay`、`dsh`、`dshHome`、`workdir`、
`stateDir`、`caCert`、`port`，以及布尔开关 `skipBuild`、`start`、`enable`、`withPlugin`、
`dshTls`、`tlsInsecure`、`pluginReportsEnabled`、`localAdminEnabled`。
它们仍接受原安装器的组合校验；prefix 只能由入口的 `--prefix` 指定。

独立 CLI 的直接操作仍同步完成。一般子命令限时 90 秒，安装、插件安装和更新限时 300 秒；
超时返回 `operation_timeout` 并清理该子进程组，重试前应检查实际状态和组件操作锁。

受管 DSH 带有非秘密的 `DRDSH_MANAGED_INSTANCE` 实例标记；从该环境调用可能停止宿主的
同步结构化命令仍返回 `requires_external_job`，应改用 `job.submit` 或独立终端。
标记只用于避免误停调用方，不是安全凭据，不能靠移除标记代替独立作业。

## 独立作业与首次接管

页面把 `install`、`update`、`uninstall`、`service.start|stop|restart|enable|disable`、
`lifecycle.stop|restart` 和 `handoff` 转为 `job.submit`。Linux 通过用户级 systemd、macOS
通过 launchd 执行，不以普通 detached 子进程冒充跨宿主退出保证。OS 管理器不可用时明确失败。
同一 prefix 的操作互斥；执行器与作业记录位于插件包、待更新程序之外，更新或卸载不会先删掉
仍在执行的作业。

作业状态包括 `queued`、`running`、`succeeded`、`failed`、`interrupted`，返回 `jobId`、
`operation`、`createdAtMs`、可空的 `startedAtMs` / `finishedAtMs` / `workerPid` / `exitCode` /
`result` / `error`。提交返回记录不表示执行成功，最终结果以 `job.status` 为准；调度失败也会
保存失败记录。直接 JSON
调用方重试同一次提交时复用 `idempotencyKey`；不要把新随机键当成重复提交保护。
关闭页面、失去授权或 DSH 退出不会取消已提交的 OS 作业；重新授权后可用 `job.list` 恢复观察。
列表最多返回最近 64 个作业。新提交会清理旧的已完成历史，但当前安装仍引用的包源保留；
作业中断不自动重放，先检查实际 daemon 状态，再决定是否提交新操作。

页面恢复提示与 prefix 绑定，避免在同一浏览器 origin 切换实例后继续查询旧作业。
收到明确不可重试的查询错误（例如作业记录已删除）时，页面停止轮询并清除旧提示，显示“状态尚未确认”，
应刷新作业列表检查实际结果；这不会把后台作业标成成功或取消它。短暂网络断开、服务端暂时错误或限速
保留恢复提示，并逐步延长重试间隔，最长 15 秒。`401` 会锁定页面并保留提示，重新授权后继续查询。
取得 `succeeded`、`failed` 或 `interrupted` 终态后清除恢复提示，持久作业仍可从列表查看。
查询缺失记录不会创建作业或其目录；旧版本查询遗留的私有空目录不阻止新作业，
但新作业提交遇到包含不完整记录的目录仍报错。

页面更新使用当前插件所带的可信 native 源，保留已保存配置。取得新 native 版本时先通过
DSH 包管理器更新完整插件包，再在页面执行 daemon 更新；页面不接受任意下载 URL 或 shell。
插件发起安装时固定 `pluginOwner=external`、`pluginReportsEnabled=true`、`localAdminEnabled=true`，
避免安装器反过来拥有调用它的插件。

首次接管按以下顺序进行：

1. 以当前 profile 的 DSH home、工作目录和端口准备 daemon 安装，暂不启动服务。
2. 调用 `handoff.plan`，由原生层识别实际祖先进程中的 DSH 宿主和开始身份，并核对本机配置。
3. 用户确认计划后提交 `job.submit`，其 operation 为 `handoff`、params 为 `{planId}`。
4. 独立作业重新验证同一个宿主身份，停止它，等待端口释放，再启动保存的 daemon 服务。
5. 页面恢复后重新授权，查询持久作业与实际服务状态。失败按具名原因处理，不猜测或强杀其他进程。

浏览器不能指定任意 PID。计划有效期为 5 分钟，单次消费；配置在计划生成后变化也会拒绝。
进程已退出、身份已变化或端口/目录不匹配时重新生成计划；
attach 模式的远程生命周期拒绝保持不变。接管会中断当前宿主，请在可接受重启时执行。
接管只请求正常终止，宿主未在 35 秒内退出时失败，不自动强杀；端口被其他进程占用时也不终止
那个进程，应先排除冲突，再明确启动 daemon。

## 运行时接口与访问边界

前台运行可用 `drdsh daemon run --local-admin` 或 `DSHD_ADMIN=1`。没有命令行开关时 `DSHD_ADMIN=0` 关闭，
显式 `--local-admin` 优先于环境变量；
已安装服务由 `localAdminEnabled` 生成环境变量。默认不创建管理监听器。

socket 位于规范化状态目录的 `.runtime/admin.sock`。Unix 路径过长时使用
`/tmp/drdsh-<uid>/<状态目录摘要>.sock`，该目录不保存配置或密钥。目录必须属于当前用户且为
`0700`，socket 为 `0600`，连接双方校验对端用户身份。macOS、Linux、WSL2 使用此接口；
不代表原生 Windows 服务已受支持。

每个连接只处理一行 JSON 请求和一行响应，单条消息限 64 KiB；最多 16 个并发连接，读取
限时 5 秒、运行操作限时 60 秒。直接 socket 只接受运行状态、配对、设备和 DSH 生命周期操作；
安装、配置和系统服务操作由 JSON CLI 执行。接口既不监听 TCP，也不注册到 DSH 的通用 RPC。

socket 信任本机同用户进程。报告接收器的临时 Bearer 令牌只允许事件上报，不能访问管理接口。
插件 Web 页面另做上述本机 capability 授权与隧道路由隔离；loopback、DSH cookie 或 `Origin`
本身都不赋予后台管理权限。本机同用户恶意代码不在这个授权边界的隔离目标内。

## 在线配对、撤销与单实例

同一规范化状态目录只能运行一个 daemon：进程持有 OS 文件锁，崩溃后自动释放，
不同状态目录仍可独立运行。设备登记的事务锁只覆盖读取最新内容、合并变更和原子保存，
不跨配对网络等待持有，因此配对不会用旧快照覆盖并发撤销。

`drdsh daemon pair` 与 `devices` 优先使用已启用的运行时接口。未启用时，旧入口仍通过短事务
修改文件，运行中 daemon 每 200 毫秒检查登记变化。新增配对、撤销不再要求重启 DSH。
首次成功配对会关闭旧的纯房间密钥会话；撤销会关闭被撤销设备的隧道及其 HTTP/WebSocket
代理和通知通道。已经启用设备登记后，登记文件丢失或损坏会拒绝访问，不能回退到只校验房间密钥。
状态目录中的 `devices-required` 是持久的设备鉴权标记，权限为 `0600`；已有登记在首次启动时
补建，首次配对先保存标记再提交登记。请连同 `devices.json`、房间密钥一起备份完整状态目录。
缺少登记时应恢复原文件，不能通过删除标记恢复纯房间密钥访问。
撤销使用既有 `GoAway` 帧终止会话，不增加 wire 字段。PWA 收到终止帧或发生载荷认证、帧序
失败时关闭 carrier，并保留首次失败原因；普通状态请求超时仍允许后续轮询恢复。
`GoAway` 只表示远端终止连接，页面提示重新连接确认权限，不据此断言设备一定被撤销。

同一状态目录同时只允许一个待完成配对，冲突返回 `pairing_busy`；配对提交重新读取最新登记，
已撤销设备不会被另一个配对任务恢复。配对结果只保存在本次 daemon 进程内；daemon 重启后
需要创建新配对码，已完成的设备登记仍从状态目录恢复。

管理页锁定或刷新后，重新授权会从运行时状态恢复仍为 `pending` 的配对及其取消入口，
绝不重新显示配对码。可使用先前取得的配对码完成配对，或取消后重新生成；已有配对待完成时，
页面不会重复提交 `pair.begin`。配对状态查询遇到临时网络错误时，页面立即清除已显示的码并
继续确认状态；恢复 `pending` 后显示正常等待说明。收到 `pairing_not_found` 时停止轮询并
移除取消入口，需刷新状态后重新生成。锁定前发出的旧查询响应不会覆盖随后创建的新配对。

取消与提交按同一锁排序：取消成功后不会登记；若提交已先完成，返回 `pairing_already_committed`，
应查询完成结果并按需撤销。取消后锁释放期间可能短暂返回可重试的 `pairing_busy`。

## 验证

```sh
cargo build --workspace
pnpm run verify
pnpm run smoke:daemon-management
pnpm run smoke:plugin-owner
node scripts/plugin-management-smoke.mjs
cargo test -p dr-dsh-daemon --test proxy
```

管理实测使用真实 relay、daemon、加密客户端与 DSH 替身，检查在线配对/撤销、活跃代理关闭、
配置校验与保存、默认关闭、锁与故障恢复。归属实测使用临时 prefix、DSH home 和真实用户服务，
需要已构建 PWA 与 macOS launchd 或 Linux systemd 用户会话，检查外部插件不被 daemon 接管、
旧配置兼容以及另一侧服务不受影响。无需模型/API key，不改用户日常 DSH profile。

`node scripts/plugin-management-smoke.mjs [--drdsh /absolute/path/drdsh]` 使用生产插件 HTTP handler、
manager、原生程序与真实 launchd / systemd 用户服务。默认程序为 `target/debug/drdsh`，只需先构建 CLI，
不需要 PWA、真实 DSH 或模型凭据。脚本自带 DSH 替身与中继，在独立 prefix、DSH home 和插件存储中
检查本机授权、一次性链接、Origin 和请求边界、安装/更新/卸载/重装、运行中幂等重试、失败作业落盘，
以及在作业仍运行时强制终止 HTTP 宿主后继续完成、重新授权读取结果。结束时清理临时服务；退出码
`0` 表示通过、`1` 表示失败、`2` 表示缺少运行前提。此脚本不替代真实 DSH 的页面与首次接管验收。

历史基础接口验收（2026-10-28）：macOS 上管理实测 16/16、真实 launchd 归属实测 7/7，通知回归 13/13、Release
安装器回归 13/13；`pnpm run verify` 通过。该次未执行 Linux systemd 验收。

插件管理验收记录（2026-10-29）：

| 环境与检查 | 已完成结果 |
| :--- | :--- |
| 完整静态检查与测试 | 最终 `pnpm run verify` 退出码 `0`，`git diff --check` 通过；`pnpm run test:cli` 9/9（含两项实际归档导入测试） |
| 本机 macOS launchd | `scripts/plugin-management-smoke.mjs` 7/7；真实 HTTP 与 OS 作业，DSH 使用替身 |
| blade Linux systemd 用户会话 | 同一插件管理实测 7/7；使用独立实验目录与服务 |
| 既有运行时与插件回归 | 本机管理 16/16、通知 13/13、插件归属 7/7 |
| 最终完整插件包 | 包含 Linux x86_64 musl 与 macOS Apple Silicon 原生程序的 `.tgz` 已通过 blade 的 DSH 包管理器安装 |
| blade 真实 DSH `0.2.1-rc.2` 与 Chromium | 通过私有授权、页面安装 daemon、首次接管、重启后重新授权并读取持久作业、保存配置、生成和取消配对码；页面应用插件附带版本后 DSH 重启成功 |
| 真实 PWA 与 DSH 隧道 | 管理页生成配对码后，PWA 完成配对和连接，并经隧道打开真实 DSH `0.2.1-rc.2` 界面 |
| 远端管理入口与设备撤销 | 从远端点击管理链接返回 HTTP `503`，原因明确为 `remote access to local daemon management is disabled`；管理页撤销设备后，PWA 实时断开 |
| 页面卸载 daemon | 从管理页提交卸载，OS 作业最终为 `succeeded`、`exitCode: 0`；保存配置的 `components` 变为 `[]`，配置文件保留 |
| 卸载后的页面恢复 | 手动启动真实 DSH，使用最终双平台包重新授权；页面显示“已卸载”和“配置已保留，重新安装会沿用这些设置”，恢复原 Relay 值，全部持久作业显示已完成 |
| 实验清理 | 两个实验 systemd 服务已停止，精确限定的临时实验根目录与插件管理私有目录已删除；只清理本轮实验实例 |

清理后核对原有 daemon：`ActiveState=active`、PID `741`，配置 SHA-256 仍为
`43ac1f02439ee7f477b5492e347c42993ba20b479b6d374a54b96f7a2cde438c`，与实验前记录一致。
本轮交付包含本地构建、插件安装与上述实测；未执行 npm registry 或 Release 发布。

### blade 常驻部署（2026-10-29）

上述临时验收之后，已将同一完整插件包部署到 blade 的正式 DSH profile，并保留原有工作目录、
DSH 数据和配对状态。daemon 使用 `~/.local` prefix，DSH home 为
`~/.local/share/dr.dsh/dsh-home`，工作目录为 `~/drdsh-workspace`，连接现有中继
`wss://drdsh.bigshi.cn`。插件由 DSH 包管理器安装，归属为 `external`，报告和本机管理已启用。
升级前的私有备份保存在 `~/drdsh-releases/plugin-managed-20261029-cb2b23eb/before-plugin-managed.tar.gz`。

正式 systemd 用户服务 `drdsh-daemon-3fb04488c6ce.service` 为 `active/running`、`enabled`，
用户 `Linger=yes`；DSH 只监听 `127.0.0.1:3080`。部署后检查中，daemon PID 为 `127411`、DSH PID
为 `127428`，`NRestarts=0`，中继状态为 `connected`。这些 PID 仅为本次验收快照。

Mac 浏览器已在 `https://drdsh.bigshi.cn` 完成配对、显示 DSH 正在运行，并经隧道打开真实 DSH
页面，完成预览提示后显示模型登录入口。当时关闭连接页会中断它承载的隧道；重开连接页、使用
已保存的配对连接并刷新 DSH 页面后恢复。这一双标签页操作现已由下述同页 Harness 改造替代。

用户选择稍后在网页中登录模型，因此本次常驻部署未验收真实模型任务、审批或长输出。
额外的独立设备并发诊断在加密握手阶段超时，未到达 HTTP/WS 代理层；临时诊断设备已撤销，
用户浏览器设备保留。该诊断不作为多客户端并发可用的证据，也不能据此归因 DSH mux 故障。
本次未更新公网中继及 PWA 静态资源。

### 追加验收与修复（2026-10-29）

用户要求补测后，追加了真实 macOS DSH 页面操作、Linux 跨版本迁移与故障恢复检查。
以下是这次补测的结果，不将早前替身测试算作真实模型任务通过。

| 检查 | 结果 |
| :--- | :--- |
| macOS、真实 DSH `0.2.1-rc.2` 与 Chromium | 本机浏览器授权调用、安装与首次接管、daemon/DSH 分别重启、DSH 停止后独立恢复、daemon 停止后独立恢复、自启动切换、更新、卸载后重装及再次接管通过；通过 PID 与持久作业核对实际结果 |
| 页面错误与恢复 | 未保存输入在刷新后保留；非法 Relay 被拒绝；诊断失败详情与恢复后的正常报告均可见；配对锁定/重授、刷新、两次模拟网络请求失败后恢复通过，恢复时不重显配对码 |
| 失效作业 | 不再无限轮询；未知 `jobId` 不生成空目录，随后页面安装成功；兼容跳过旧查询留下的私有空目录，保留半写记录和权限错误的拒绝 |
| 已发布 v0.1.1 → 当前实现 | 真实 Linux systemd 与 DSH 升级检查 10/10；配置、配对与插件归属保留，另一侧 relay 不受组件操作影响 |
| v0.1.0 → 当前实现 | 使用未修改的 v0.1.0 tag 源码构建旧程序，迁移检查 7/7；公开 Release 资产不可用，因此不声称验证了 v0.1.0 的发布二进制 |
| 600 秒低负载连续访问 | 55 次真实加密隧道探测、0 次非预期错误；中继重启后约 2.4 秒恢复，强制结束测试 daemon 后 systemd 拉起并在约 8.3 秒恢复同一配对访问 |
| 最终检查 | `pnpm run verify` 与 `git diff --check` 通过；插件测试 49 项、作业专项测试 5 项通过 |
| 模型与通知 | 真实失败回合的结束通知到达 PWA；成功两轮模型任务、工具调用和模型审批被 `API key is invalid` 阻塞，详见[模型测试记录](../development/plugin-model-test.md) |

本次修复了诊断失败报告丢失、配对中锁定或断网后无法恢复、失效作业持续轮询，以及未知作业查询
创建空目录进而阻碍后续作业提交的问题。最终双平台本地包为 `drdsh-plugin-0.1.1-tested.tgz`，
SHA-256 为 `cb2b23eb19f989a1565a8b6d4d9d96c35a03a5a14878218d09903cb3a6f29249`。
最后的作业查询修复分别补了单元测试、Linux 真实进程查询和 macOS 页面查询后重装验证；
未因此重复全部迁移与 600 秒连续访问测试。十分钟低负载观察不代表长期稳定性结论。

补测发生过隔离事故：两路测试分别因省略 `--prefix` 而读取默认安装配置，向 blade 原实例登记
了测试设备，其中一路还新增了临时工作区和空会话。测试设备已撤销，新增工作区与空会话已移除；
原 daemon/DSH 的 PID `741`/`761` 与配置校验值保持不变。审计、配对限速、安全标记、锁文件及
部分文件格式/修改时间变化仍保留，不能描述为全程未触及原实例。恢复范围见上述模型测试记录；
后续步骤均先核对保存配置和真实进程路径，再执行配对或任务。

macOS 和 Linux 的测试服务、进程、凭据、专属浏览器及临时目录均已清理。非凭据机器可读结果
保存在本地 `target/macos-management-acceptance.json`、`target/linux-upgrade-soak-summary.json`
及其引用的专项报告中；这些构建目录产物不随仓库提交。

### 同页 Harness 与 WebSocket 修复验收（2026-10-29）

用户报告连接后 WebSocket 异常关闭，并要求直接在同一页面使用 Harness。本次修复了并发
WebCrypto 发送乱序、HTTP/WS 流号重叠、同源多个页面共用广播与 Worker 端口，以及中继接受
第二客户端后混入已有加密会话的问题。当前每房间只允许一个活跃客户端，第二连接明确提示
占用；已登记设备仍可轮流使用。连接成功后自动显示 iframe，顶部提供连接管理、重新加载与断开。

Worker 更换时清理旧视图的长驻 HTTP，解决真实 DSH `/plugins/events` 阻止新版激活的问题；
后台线程被终止后按原 viewId 恢复。iframe 重载和隧道关闭均释放 socket，取消中的关闭帧发送
不会产生未处理的 Promise rejection。当前 HTTP/SSE 整段交付及上游取消边界见
[ADR-0024](../decisions/0024-embedded-harness-session-isolation.md)。

| 检查 | 本轮结果 |
| :--- | :--- |
| 最终静态与单元检查 | `pnpm run verify`、`cargo fmt --all --check`、`git diff --check` 通过 |
| macOS Chromium + 隔离真实 DSH `0.2.1-rc.2` | `browser-embedded-smoke.mjs` 11/11；自动同页打开、真实 mux、160 次并发 HTTP 拒绝、同源双房间、Worker 更新与强制冷启动、第二连接拒绝、iframe 重载、返回管理、同一 socket 保持 35 秒、桌面/移动布局及断开重连通过 |
| TLS 与背压回归 | `relay-transport-smoke.mjs` 22/22；`relay-backpressure-smoke.mjs` 7/7，含双向 32 MiB、其他房间通信及停滞连接回收 |
| ali 公网 → blade → Mac Chromium | 8/8；HTTPS 配对、同页真实 Harness 与 mux、160 次 HTTP 拒绝、Worker 冷启动、iframe 重载、同一 socket 保持 90 秒、桌面/移动布局、刷新后复用配对通过 |
| 原实例与清理 | blade daemon PID `131097` 与 DSH PID `131114` 保持不变，daemon 配置 SHA-256 不变、`NRestarts=0`；公网检查结束后撤销专用临时设备，全部原有设备保留；本机测试进程和临时目录已清理 |

ali 的中继与完整 PWA 已更新，Pingap 首页 CSP 增加 `frame-src 'self'`，离线缓存为 v9。
部署后的 relay 为 `active`、PID `166386`、`NRestarts=0`；本轮公开验证期间 blade 日志未出现
`out of order` 或会话认证失败。这些 PID 和观察窗口均为本次快照，90 秒不代表长期稳定性结论。

本地包为 `target/embedded-linux/drdsh-relay-0.1.1-embedded-v9.tar.gz`，SHA-256 为
`71888de6f676fd95976a58ad453981dff6aee94b6feae912161092a1aef1d03a`；Linux musl 程序的
SHA-256 为 `f42264daa74179f99c40d880cd443f4ac12c074551460284f7c27e5335f27306`。
ali 源目录为 `/var/lib/drdsh/releases/relay-embedded-v9-20261029-f42264da`，静态目录为
`/srv/dr.dsh-relay/releases/pwa-embedded-v9-20261029-71888de6`，旧部署与配置备份保留，可回滚。
这是已授权的自托管部署，没有新增公开 Release 或 npm 发布。

旧浏览器需强制刷新入口后重新连接，以切换旧脚本与缓存；原有配对保留。实际模型账户仍待
用户在 Harness 页面登录，本轮未发送模型任务。非凭据检查记录与截图分别保存在本地
`target/embedded-public-checks.json`、`target/embedded-ali-deployment.json` 和 `output/playwright/`，
不随仓库提交。

### 浮动控制与主机目录选择验收（2026-10-30）

首次连接保留完整引导页面；进入 Harness 后不再占用顶部空间，44 px 的 `dr` 浮钮可拖动、
左右吸附，也可用方向键移动。点击后打开连接管理对话框，关闭、Escape 和遮罩点击均保留
当前 Harness 文档和会话。默认受管 DSH 使用其内置目录浏览器，选择、新建的文件夹属于
DSH 主机；明确自定义的 picker 配置保留，详见 [ADR-0025](../decisions/0025-host-directory-browser.md)。
旧版独立 `/__dr/interface` 链接返回连接页，不能借用另一页面的隧道。

| 检查 | 本轮结果 |
| :--- | :--- |
| 完整检查 | `pnpm run verify` 通过；最终文档链接与 diff 格式检查通过 |
| macOS + 隔离真实 DSH + Chromium | `browser-embedded-smoke.mjs` 15/15；包括浮钮拖拽/键盘吸附、对话框与手机布局、选择含空格/中文的已有主机目录、新建文件夹，并通过 DSH workspace baseline 核对 canonical 路径；还覆盖旧书签、160 次 HTTP、双房间隔离、Worker 更换/冷启动、第二客户端拒绝、重载、35 秒持续连接、断开重连 |
| Mac → ali → blade 公网 | 10/10；使用中文 Harness UI，从目录浏览器读到在 blade 上创建的唯一测试目录并取消；浮钮拖拽/对话框、160 次 HTTP、Worker 冷启动、重载、35 秒持续连接、桌面/手机及刷新免重新配对通过 |
| 安装与数据保留 | blade daemon 与外部插件 native 摘要一致，运行中 DSH 使用 0600 临时目录 overlay；两侧配置仅 source 改变，用户 profile、账户、会话及原有配对保留；两侧均 active、`NRestarts=0` |
| 清理 | 每轮公网专用设备均撤销，临时主机目录及隔离测试进程清理；Linux 私有构建目录已删除，发布包和回滚备份保留 |

ali 使用 PWA 缓存 v10，35 项客户端资源均逐字节匹配发布包；Pingap 配置保持原字节。
首轮部署探针错误访问了按设计拒绝的 `/client/index.html`，触发自动回滚；修正为校验根 `/`
并验证允许的客户端资源后，r2 部署通过。公网首轮英文 UI selector 与中文实例不匹配，
专用设备已撤销，补齐双语 selector 后重新完整通过。这两项是验收脚本修正，不是安全规则放宽。
测试 profile 仅通过 DSH 官方 `credentialOnboarding: false` 关闭自动凭据引导；生产 profile
未改此设置，本轮没有登录模型账户或发送模型任务。

Linux musl 程序 SHA-256 为
`796ae60cf1dcd12bcc5de8427de03e821fc59bb0e71842561d6c0c9b014822bb`。
本地包位于 `target/directory-picker-linux/`：relay 包摘要为
`57cd1aa4d281fcc5ac8eb90a8d9cf40cbf72f66b898e0b453dc000fc88ffce1f`，插件包摘要为
`3cd9ac4fd8fada3787da227eb58330f7b68a1a551290444065881446ce3ddbde`。
ali source 为 `/var/lib/drdsh/releases/relay-floating-v10-20261030-796ae60c-r2`，静态目录为
`/srv/dr.dsh-relay/releases/pwa-floating-v10-20261030-57cd1aa4-r2`；blade source 为
`/home/luckyuro/drdsh-releases/directory-v10-20261030-3cd9ac4f/package/native/x86_64-unknown-linux-musl`。
旧 source、插件包及私有备份保留可回滚，没有创建新的公开 Release 或 npm 发布。

非凭据验收记录为本地 `target/floating-directory-public-checks.json`、
`target/floating-ali-deployment-r2.json`、`target/directory-blade-deployment.json` 和
`output/playwright/embedded-harness-checks.json`；截图保存在 `output/playwright/`，均不随仓库提交。
35 秒只表示本次观察窗口；旧浏览器需强制刷新入口以切换新版脚本，原有配对可继续使用。


### v0.2.0 配对体验

生成配对码后，可点击“复制配对码”，并按页面展示的 HTTP(S) 地址在另一台设备打开中继。
浏览器拒绝剪贴板访问时，会保留可见配对码并提示手动复制。锁定页面、取消、过期或配对完成后，
配对码与复制入口一起清除；不会将配对码写入浏览器存储。远端页面一次提交即可配对并连接。


### 2026-11-04 发布复验

v0.2.0 原生包在 macOS launchd 的 `plugin-management-smoke.mjs --check-browser` 通过 **8/8**，
在 Linux systemd 容器中通过 **7/7**。手机尺寸浏览器覆盖管理授权、复制与取消真实配对码、锁定和无横向溢出；
OS 作业覆盖宿主退出后继续执行与重授权恢复。此脚本的 DSH 宿主为替身。
真实 DSH 两个版本的本机独立授权、独立隧道与远端拒绝另由 `plugin-connect-smoke.mjs` 各 **11/11** 覆盖。
完整范围见[v0.2.0 发布验收](acceptance-2026-11-04.md)。

### 2026-11-06 校验与诊断重构验收

当前改动基于 v0.2.0。共享输入校验、分区管理页、结构化诊断与远端连接步骤见
[校验接入指南](../development/validation.md)。锁定管理页会取消正在读取响应正文的请求，
清除诊断和配对码；不会因迟到的响应恢复授权，也不会一直阻塞重新授权。

| 验收 | 本次结果与范围 |
| :--- | :--- |
| `pnpm run verify` | Rust、TypeScript、CLI 归档导入、DSH import 隔离与文档链接检查通过 |
| `service-smoke.mjs` | macOS launchd **41/41**，含旧源码入口、实际插件导入、两侧服务更新/卸载隔离与配对保留；DSH 为替身 |
| `plugin-management-smoke.mjs --check-browser` | macOS launchd **9/9**；真实原生服务、移动端字段错误与焦点、诊断筛选、配对复制和锁定、OS 作业跨宿主强退；DSH 为替身 |
| `browser-management-smoke.mjs` | DSH **0.2.2-alpha.2**，真实临时 profile 与完整插件包 **5/5**；独立本机授权、安装准备、首次接管身份检查及取消、诊断、锁定与清理。没有执行接管 |
| `browser-embedded-smoke.mjs --check-offline` | 同一真实 DSH 的 Chromium 回归 **17/17**；包括远端 HTTP/WS 管理路径拒绝、房间隔离、Worker 更换、重连与离线恢复 |
| `dsh-upgrade-smoke.mjs` | 真实 DSH **0.2.2-alpha.2** 插件安装/移除与事件契约 **6/6** |
| `doctor-smoke.mjs` | 原生进程 **3/3**；端口警告、程序缺失失败、JSON/文本和退出码、无状态目录写入 |
| `framework-validation-smoke.mjs` | 实际表单库和 Standard Schema 类型检查 **5/5**；库版本与未覆盖范围见接入指南 |

截图保存在本地 `output/playwright/validation-*.png`。此次未重复 Linux 用户服务或其他浏览器引擎验收，
不把以往发布验收自动视为本次改动的实测结果。
