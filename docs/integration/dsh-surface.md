# 与 DSH 的集成面

本项目**不修改、不 fork** DSH。它只依赖上游已经提供的东西，本文列出这些依赖的**确切清单、上游证据、以及每一条失效时的表现**。

DSH 的 README 明确写道："Developer preview … **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**" 因此本文的目的不是"确认依赖稳定"，而是"把不稳定性关进一个可以被检查的笼子里"。

核对基准（2026-11-07）：**DSH `0.2.2-rc.1`**，上游提交
[`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db)。
官方 npm 的 `latest` 与 `next` 指向此版本；`alpha` 为 `0.2.2-alpha.3`，本轮未扩大到该 alpha。
版本列表由 `npm view @deepseek-ai/dsh dist-tags --registry=https://registry.npmjs.org` 在线取得。

插件本机管理面与独立连接面以 **`0.2.2-rc.1`** 的 Web 服务和启动生命周期契约为基准。
`0.2.2-alpha.2`、`0.2.1-rc.5` 的既有兼容记录保留在下方；更新 daemon 不会自动替换已有 DSH。
下方历史版本的事件报告验收不扩大管理面兼容范围；旧版本缺少管理契约时只停用管理子树，
报告能力按原有契约继续工作。

> 引用约定：本文只引用**文件路径与符号名**，不引用行号——行号会随上游提交漂移，符号名可以被 `grep` 重新定位。

---

## 1. 依赖清单总览

| # | 依赖 | 上游位置（符号） | 我们怎么用它 | 失效表现 | 严重度 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 启动与就绪行 | `packages/bundle/web-app/src/index.ts` → `announceReady`、模板字符串 `dsh web: ${authenticatedUrl}`；`packages/bundle/web-app/src/startup.ts` → Web 启动参数 | daemon spawn `dsh web`，从 stdout 解析端口与进程令牌 | 无法启动或无法取得令牌 | **致命**（M0 阻塞） |
| 2 | 浏览器信任栅栏 | `packages/client/connection/src/browser-auth.ts` → `TOKEN_QUERY`、`COOKIE_PREFIX`、`authenticatedUrl`、`authorizeIndex`、`isAuthenticated`；`packages/client/connection/src/api-request-trust.ts` → `isTrustedApiRequest` | daemon 用令牌换 cookie，并以 loopback authority 代理 | 页面或 `/api` 全 401 | **致命** |
| 3 | 跨进程事件通道 | `packages/api/gateway/src/stream-protocol.ts` → `REMOTE_STREAM_MUX_PATH`（`/api/remote.mux`）；`packages/api/remotes/src/remote-events.ts` → `API_REMOTE_FORWARDED_EVENTS` | 审批与提问通知不需要插件即可到达远端 | 关键通知失效 | 高 |
| 4 | Cordis 插件与 bundle 清单 | `docs/user/develop/basic/publish.md`（bundle / profile 两种 manifest）；`packages/util/package-manifest/src/types.ts` → `DshManifest`、`DshBundleManifest` | 以 bundle 形式安装事件上报插件 | 插件无法安装或加载 | 中（插件可选） |
| 5 | 进程内事件名及参数 | `packages/core/session/src/index.ts` → `'session/event'`；`packages/interaction/user-approval/src/types.ts` → `'approval/request'`；`packages/interaction/user-questions/src/types.ts` → `'user-questions/request'`；`packages/subagent/subagent/src/index.ts` → `'subagent/end'`；`packages/goal/goal/src/domain.ts` → `'goal/changed'` | 插件提取不含内容的事件元数据并上报 | 部分通知缺失，需真实升级测试发现 | 中（插件可选） |
| 6 | 优雅停止 | `apps/cli/src/process-shutdown.ts`；`apps/cli/reference/README.md` | daemon 用 SIGTERM 停止 DSH，等待其自行关闭 | 停止变成强杀，可能中断会话 | 中 |
| 7 | 本地数据布局 | `packages/util/home-paths/src/index.ts`（`$DSH_HOME`，默认 `~/.dsh`） | `doctor` 与排障文档引用路径 | 文档指引失准 | 低 |
| 8 | 可选本机管理服务 | 已发布 `dsh-host-webserver` 的 `WebServer`、`dsh-client-connection` 的 `HostConnectionHandle`、`dsh-app-boot` 的 `ProfileContext`、`dsh-cmdline` 的 `AppReady` / `AppExit` | 注册本机页面、沿用 DSH 鉴权、读取实际 profile 与就绪状态 | 管理页面不可用并报告原因；不取消事件报告或宿主启动 | 中（管理可选） |
| 9 | 主机目录浏览与 profile overlay | `apps/cli` 的 `--dump-config` / `--patch`；`dsh-host-directory-picker-auto` 的默认行；Host 与 client 的 `directory-picker-browse` 组件 | 对默认 auto 配置追加临时 browse 组合，让远端 workspace 选择 DSH 主机目录 | 配置预检或 DSH 启动失败；显式自定义配置保持原行为 | 高 |

**明确不依赖**（曾经考虑过、并已否决，见 ADR-0003）：

- DSH SDK（`packages/sdk/*`）：stdio JSON-RPC，无法附着到运行中的 `dsh web`，只提供 4 类通知且无审批流。
- `--trusted-host`、`--public-url`：它们支持上游自行配置的公开部署；本项目的 daemon 只连 DSH 的 loopback 监听器，不使用这些参数。
- Session 日志文件（`$DSH_HOME/sessions/**`）：默认 zstd 压缩，外部按行读取不可用；且让用户改 `compression: none` 会改变他们 DSH 的写入行为。我们宁可通过插件取事件，也不解析持久化格式。
- `dsh-hooks-claude-code`：它的 `Notification` 与 `PermissionRequest` 明确不支持，且不在 base bundle 内。

---

## 2. 依赖 1：启动与就绪行（唯一的"非正式契约"）

**上游行为**：`dsh web` 在 Loader settle 之后向 stdout 打印一行：

```
dsh web: http://127.0.0.1:3080/?token=<launchToken>
```

`0.2.1-rc.2` 默认打印绑定地址的 URL；显式设置 `--public-url` 时改为公告该 URL，不再自动追加 LAN URL。该行的触发条件是 `printUrl` 或 `handoffBrowser` 之一；二者都不会在 `/api` 路由等兄弟行挂载完成之前运行。本项目不设置 `--public-url`，仍取得 loopback URL。

**上游源码里关于监督的承诺**（`packages/bundle/web-app/src/index.ts` 中 `announceReady` 上方的注释）写明：URL 行与浏览器打开都是就绪信号，"supervisors RPC as soon as they observe the line"。

**我们怎么用**：

1. daemon 以 `dsh web --no-open --port <p>` 启动子进程。**端口由 daemon 指定**（不需要猜），`--no-open` 只关掉浏览器交接，不关掉就绪行（`printUrl` 默认 `true`，且是独立开关）。
2. 逐行读取 stdout，匹配前缀 `dsh web: `。
3. 从该行的 URL 取出 `token` 查询参数（到第一个空格为止，也兼容历史版本的 LAN 追加部分）。
4. 用它执行一次 `GET /?token=…`，取得 DSH 的授权 cookie。

当前受管启动还会先执行 `dsh web --dump-config`，仅对默认 auto 目录选择行追加私有的
`--patch <临时文件>`，参数位于 `--no-open` 之前。该行为以 `0.2.1-rc.2` 为验收基准，
见 [ADR-0025](../decisions/0025-host-directory-browser.md)。官方预检会与正常启动一样更新
DSH 生成的 `cordis.yml`，但 dr.dsh 不写用户 `cordis.patch.yml` 和包清单。

**实测记录（2026-09-11，DSH 0.1.5-rc.2，本仓库 M0）**：

- 就绪行格式与本文描述一致，且**带 `--no-open` 时仍然打印**：`dsh web: http://127.0.0.1:46120/?token=<43 字符 base64url>`；`--port` 生效，`(LAN: …)` 追加部分在本机未出现。
- 由 daemon 以 `dsh web --no-open --port <p>` 启动、解析该行、完成令牌换 cookie、再以 `Host: 127.0.0.1:<p>` 请求首页，返回 `200`（27923 字节，含 `__DSH_BOOT__`）。见 `crates/dr-dsh-daemon/tests/supervise.rs` 与 `docs/architecture.md` § 2.1。

**已知约束**：

- 如果用户在自己的 profile 里把 `web-app` 行的 `printUrl` 关掉，就绪行不会出现。这不是我们可以绕过的（绕过意味着改用户的 DSH 配置），因此表现为一个可诊断的失败：daemon 在超时后报"DSH 已启动但没有打印就绪行"，并提示检查 `web-app` 行的 `printUrl` 配置。
- 该契约有源码注释背书，但没有版本化的稳定性承诺。因此：解析逻辑集中在 `crates/dr-dsh-daemon` 一处；解析失败要给出可读原因而不是静默等待；`drdshd doctor` 可以单独验证这一环。

**为什么要解析 stdout 而不是用 `--port 0` + 端口探测**：令牌只能从这一行拿到。端口可以猜，令牌不能。

---

## 3. 依赖 2：浏览器信任栅栏（最容易被低估的一条）

**上游行为**（三件事，缺一不可）：

1. **索引与静态前端需要授权**（`packages/host/frontend-static/src/index.ts`）：未授权时返回 `401`，正文是 `dsh web authentication required; reopen the URL printed by dsh web.`
2. **授权令牌换取 cookie**（`browser-auth.ts` → `authorizeIndex`）：`GET /?token=<launchToken>` 返回 `303` + `Set-Cookie`；同一进程内令牌可以重复使用。cookie 名为 `dsh-auth-<base64url(sha256(audience))>`，值为 `v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`，属性包含 `Path=/; HttpOnly; SameSite=Strict`，有效期由 `cookieMaxAgeDays` 决定（默认 **30 天**，还带 `Expires`）。HTTPS 监听器签发的 cookie 额外带 `Secure`，其 audience 包含 `https://`；本项目的 DSH 监听器使用 HTTP loopback，daemon 将 cookie 值视作不透明数据。
   `0.2.1-rc.2` 另有 `/connect` 与 v2 API cookie；浏览器的令牌换取 v1 cookie 流程继续有效，本项目沿用该流程。
3. **cookie 绑定 authority**：HTTP 下 cookie 名与签名 audience 都是请求的 Host authority；`isAuthenticated` 会校验它与当前请求一致。`/api` 另有一道 Host 栅栏（`api-request-trust.ts` → `isTrustedApiRequest`）：Host 必须是 loopback、监听器绑定的 IP 或 `trustedHosts` 之一，且若存在 `Origin` 必须与 Host 同源，`Sec-Fetch-Site: cross-site` 直接拒绝。

**实测记录（2026-09-11，DSH 0.1.5-rc.2）**：

- 未授权访问 `/` 得到 `401` 与 `dsh web authentication required; reopen the URL printed by dsh web.`
- `GET /?token=<T>` 得到 `303`、`location: /`、`set-cookie: dsh-auth-<hash>=v1.<payload>.<sig>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`（**默认 30 天**，来自 `cookieMaxAgeDays` 的默认值）。
- 带该 cookie、`Host: 127.0.0.1:<p>` 请求 `/` → `200`；把 Host 改成 `relay.example` 后**同一 cookie 立即变为 401**。这正是"裸反向代理必然失败"的实证。
- 令牌在**同一进程内可重复换取**（第二次仍然 `303`），所以它不是严格的一次性凭据。这不影响安全模型：令牌只出现在启动进程的 stdout 与本地浏览器 URL 里，从不经过中继。
- **authority 相等是精确的，端口也算在内**：同一个 cookie，`Host: 127.0.0.1:<port>` 得到 `200`，而 `Host: 127.0.0.1`（丢掉端口）得到 `401`。这是代理实现最容易踩的坑——传输层很容易"顺手"把端口丢掉，而失败表现是一个看起来像"cookie 过期"的 401。该用例已被 `crates/dr-dsh-daemon/tests/real_dsh.rs` 固定为回归测试。
- `/api` 的 RPC 端点形如 `/api/<service>/<method>`（例如 `/api/session/list`），信封为 `{"type":"client-request","rpcId":…,"method":…,"payload":{"args":[…]}}`；未知端点返回纯文本 `404 not found`（DSH 自己的 404，不是我们代理产生的）。注意 `sessionController` 是服务的**键名**，路径里用的是 `session`。

**这对我们的含义**：

- **未配置的裸反向代理会失败。** 把远端 Host 原样转给仅监听 loopback 的 DSH，会得到 401 或 403。上游现支持显式 `--public-url` 与 `--trusted-host` 的公开部署；本项目仍由 daemon 保持 loopback authority 并注入 cookie。
- 因此 daemon 的行为被固定为：**自己换取 cookie → 以 `127.0.0.1:<p>` 为 authority 代理全部请求**（包括 WebSocket 升级 `/api/remote.mux`）。
- `SameSite=Strict` 与 `HttpOnly` 对我们没有冲突：cookie 由 daemon 持有并注入，浏览器从不持有 DSH 的 cookie 参与跨站请求。
- 我们**不使用** `--trusted-host`：daemon 只代理本机 loopback 监听器，不需要扩展 DSH 接受的外部 authority。

**副作用（已知且接受）**：远端页面的 hostname 不是 loopback，因此 DSH 客户端会判定"非本机"，导致部分依赖 `isLoopback` 的设置面板降级（例如设置持久化退回内存）。这是 DSH 把 loopback 当作"操作者本机"的既有设计，我们不试图欺骗它。相关表现写在 [`../operations/troubleshooting.md`](../operations/troubleshooting.md)。

---

## 4. 依赖 3 与 5：事件通道

**跨进程（无需事件报告插件）**：Gateway 的 WebSocket 多路复用位于 `REMOTE_STREAM_MUX_PATH`（`/api/remote.mux`），它转发的事件是**编译期硬编码的常量列表** `API_REMOTE_FORWARDED_EVENTS`（`0.2.2-alpha.2` 核对为 30 项），其中包含 `approval/request`、`user-questions/request`、`api-session/*`、`goal/activation-changed`，以及 `plugin-market/changed`、`plugin-manager/changed`、`plugin-manager/install-log`、`plugin-manager/install-state`、`settings/document-updated`。这些事件本身就是 DSH 界面的流量，被我们原样代理即可到达远端，因此**审批与提问通知在 M0 就可用**。新版插件管理与设置页也使用这条通道，无需复制它们的业务实现或增加 dr.dsh wire 消息。

2026-09-26 的 `0.1.7-rc.2` 验收确认了这条通道经加密隧道建立并返回 `$events` 就绪项；未在该版本单独注入审批或提问事件验证浏览器端到端交付。

该列表由 `registerRemoteEvents` 注册，且是单例：第三方插件**无法扩展**它。这解释了我们为什么不去尝试"用插件把 session/event 加进转发列表"。

**进程内（需要插件）**：`session/event`、`subagent/start`、`subagent/end`、`goal/changed`、`agent/status` 不跨进程。要拿到它们只能在 web profile 内挂一个 bundle 插件。

**插件的安装契约**（`docs/user/develop/basic/publish.md` 与 `packages/util/package-manifest/src/types.ts`）：

- 包声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`；
- patch 里 `insert` 一行按**包名**引用插件；
- `dsh plugin --profile web add <pkg>` 会转发给 pnpm，并把该 bundle 追加进 `dsh.profile.bundles`；
- 层序为：各 bundle patch → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`，且**后层整行覆盖 `config`，不做深合并**。

我们的 patch 因此只有一行（`plugins/dr.dsh/cordis.patch.yml`），这是一个需要保持的特性：patch 越薄，DSH 升级能打破它的方式越少。

**事件适配**集中在 `plugins/dr.dsh/src/dsh-surface.ts`，`reporter.ts` 只接收事件种类和会话标识：

| 上游事件 | 已核对的形状与处理 |
| :--- | :--- |
| `approval/request`、`user-questions/request` | `(request, next)`；会话标识来自 `request.agent.session.id`，没有 agent 时为 `null`。观察者提前注册，发送通知后必须原样返回 `next()`，保留回答者的结果与异常 |
| `session/event` | `(session, event)`；仅 `event.type === 'turn/end'` 上报，使用 `session.id` |
| `goal/changed` | 单个 `{ agent, change }` 参数；仅 `change.operation === 'complete'` 上报，不能把其他操作误当完成 |
| `subagent/end` | 单个 `info` 参数；`info.id` 是子会话标识，丢弃 `lastAssistantMessage` 等内容 |

**版本守卫**：`engines.dsh` 精确列出 dr.dsh 实际验收过的版本。`0.2.1-rc.2` 在安装及
profile 加载时会校验此字段（`packages/boot/app-boot/src/plugin-compatibility.ts` →
`evaluatePluginCompatibility`，`profile.ts` → `loadProfileDirectory`），以
`semver.satisfies(..., { includePrerelease: true })` 比较；没有豁免的不兼容 bundle 会被拒绝安装或跳过加载。
dr.dsh 插件自身启动时另检查 `ctx.on`/`ctx.effect` 是否存在。
Cordis 接受任意事件名，静态集合无法探测运行中的 DSH 是否仍产生这些事件；真实服务的升级测试才是验收依据。
观察者的发送异常被隔离，不能改变 DSH 的任务或审批结果；未知 payload 不作内容猜测。

### 4.1 本机管理的附加契约

这些假设也集中在 `dsh-surface.ts`，其他插件文件不直接访问上游服务：

| 服务或事件 | 管理用途与约束 |
| :--- | :--- |
| Cordis `ctx.inject(['webServer', 'connection'], …)` | 独立可选子树；缺少服务、挂载失败或热重载时释放管理资源，保留父插件的报告观察者 |
| `webServer.getOrigin()`、`port`、`register()` | 读取已监听 origin，注册仅限 `/_drdsh` 的 exact/prefix 路由，保留异步处理器的响应生命周期 |
| `connection.requestRejection(req)` | 先执行上游 Host/Origin 和浏览器/API 鉴权；插件仍另检查真实 loopback 对端与本机管理 capability |
| `connection.authenticatedUrl(baseUrl)` | 独立连接模式在成功就绪后为 `http://127.0.0.1:<port>/` 取得上游自己的启动令牌，仅经私有 stdin 交给随插件运行的原生隧道；不下发给远端、不生成替代 cookie |
| `profileContext` | 从当前宿主读取 `name`、`home`、`dir`、`cwd`、`installAnchor`，不靠浏览器猜测或 argv 拼接 profile |
| `appReady.onReady()` | 只在 DSH 成功提交启动后触发回调；管理子树退出时撤销等待 |
| `appExit(0)` | 使用 DSH 的受限优雅退出流程；不是按浏览器给出的 PID 发送信号 |
| `webserver/index-inject` | 在已鉴权首页增加固定 `./_drdsh/manage` 链接，不注入 capability、Bearer 或一次性启动链接 |

`watchManagementSurface` 返回的资源释放器必须在插件卸载时运行；异步挂载晚于卸载完成时也
必须立即释放，不能留下重复路由或旧授权。管理设置失败不让可选 Cordis fiber 留在 FAILED 状态，
否则会被上游启动失败检查计入宿主结果。

`WebServer` 按 WHATWG `URL.pathname` 选择路由，点目录会在匹配前归一；当前契约没有
`decodeURIComponent` 路由解码。daemon 对管理命名空间仍做额外、有界的多层解码拒绝，覆盖
未来路由实现变化，不能把这些保守拒绝全部描述为当前 DSH 的已证实绕过。
完整授权、单包和作业边界见 [ADR-0023](../decisions/0023-plugin-local-management.md)。

### 4.2 不安装 daemon 服务的插件连接

DSH profile 中为插件设置 `relayUrl` 即可启用；默认未配置时不建立独立连接。
`relayUrl` 只接受 HTTP(S) 或 WS(S) 根 origin，拒绝 URL 凭据、路径、query 与 fragment：

```yaml
- id: dr.dsh
  config:
    relayUrl: 'wss://relay.example'
    report: [turn_complete, approval_requested, goal_complete, subagent_complete]
```

单包中匹配平台的 native 被验证后复制到私有缓存，再由插件启动
`drdsh daemon plugin-connect`。该进程负责既有端到端加密、配对、DSH 鉴权与 HTTP/WS 代理，
没有安装 OS daemon 服务，不启动或重启 DSH；远端状态为 `state=running, owned=false`，
生命周期操作明确拒绝。插件仍通过带临时 Bearer 的 loopback 报告接收器发送最小事件元数据，
再经密文隧道通过 relay 转发。relay 不新增明文事件接口，也不持有凭据。

DSH 的 `appReady.onReady()` 之后才启动；`connection.authenticatedUrl()` 返回值必须保留
指定的 HTTP loopback origin、端口与唯一的 43 字符启动 token。token 不放 argv、环境变量或
插件日志，原生 ready 响应中的报告凭据也不转抄到日志。插件卸载主动关闭子进程；DSH 被强杀时
stdin EOF 关闭隧道，避免留下可访问旧宿主的孤儿。relay 断线只触发原生重连，不停止 DSH。

状态目录默认是 `$DSH_HOME/dr.dsh/<profile-dir 的 SHA-256 前 16 位>/state`，权限 `0700`。
启动日志只公布 room id 与该状态目录，不公布密钥。独立模式的配对在 DSH 主机运行，复用同一个
状态目录和本次插件包的匹配 native（`<native>` 是该包缓存内的 `bin/drdsh`）：

```sh
DSHD_STATE_DIR='<启动日志中的 state 目录>' '<native>' daemon pair --relay 'wss://relay.example'
```

将输出的短时配对码填入远端网页，配对成功后浏览器使用已登记设备身份连接。
独立模式的设备与 room 不自动和已安装 daemon 合并；不要把另一实例的 state 目录替换到这里。
需要远端启动或重启 DSH 时，安装 daemon 并使用其受管模式。daemon 注入的报告凭据或
`DRDSH_MANAGED_INSTANCE` 标记会抑制插件再启动第二条隧道，daemon 的 relay 配置优先；
该标记仅作本机调度提示，不授予管理或远端鉴权权限。

独立连接需要完整的原生插件包和 HTTP loopback DSH 监听器；仅安装源码目录没有 native 时，
会明确记录连接不可用，本机 DSH 与管理页面不因此停止。独立模式保留整个目录选择器配置，
由 DSH 的 auto 或用户显式配置决定 native/browse；插件不修改运行中的 Loader。
桌面主机需要 browse 时使用 DSH 启动 patch，见
[目录选择说明](../operations/troubleshooting.md#控制面板与工作区目录选择)。daemon 受管模式
对默认 auto 行的启动 overlay 仍按 [ADR-0025](../decisions/0025-host-directory-browser.md) 执行。

---

## 5. 生命周期控制

**上游没有任何 daemon 化能力**：没有 systemd/launchd 集成、没有 `--detach`、没有后台模式。因此进程监督完全由 daemon 负责：

| 动作 | 做法 | 依据 |
| :--- | :--- | :--- |
| 启动 | `spawn dsh web --port <p>` | Web profile 简写与 `packages/bundle/web-app/src/startup.ts` 的 flag 家族 |
| 就绪 | 解析 stdout 的就绪行 | § 2 |
| 停止 | 发送 SIGTERM，等待 DSH 自行 dispose 整棵树 | `apps/cli/src/process-shutdown.ts` |
| 超时 | DSH 自身有受限宽限期后强杀；daemon 另设一个更外层的上限，避免无限等待 | 同上 |
| 健康 | HTTP 探测 + 进程存活 | 我们自己的逻辑 |

**attach 不管理**用户手动启动的实例：显式附着模式（`LifecycleState::Attached`）只做代理，
拒绝生命周期指令并说明原因；普通托管启动遇到占用端口仍拒绝。理由写在定义文档 § 8 与 § 9.2，
也写在 `crates/dr-dsh-daemon/src/config.rs` 的 `DshMode::Attached` 上：未知手动启动方式不能
被当成可重建的托管配置。

插件页面的首次接管是独立、本机授权的操作：先准备保存配置，再由原生层识别当前调用链中的
DSH 宿主，用户确认计划后由 OS 作业重新检查进程身份、停止该宿主并启动 daemon。
它不放宽 attach 的远端拒绝规则，不猜测或强杀其他占端口进程。见
[首次接管](../operations/daemon-management.md#独立作业与首次接管)。

---

## 6. 状态观测

| 来源 | 可用性 | 我们是否使用 |
| :--- | :--- | :--- |
| daemon 自己监督的进程状态 | 完全可用 | **是**：`Status` 的唯一来源 |
| HTTP 探测 `127.0.0.1:<p>` | 完全可用 | 是（健康检查） |
| 插件上报的事件 | 需要插件、受管 daemon 与已配对连接 | daemon 鉴权接收 `/report`，经加密隧道送达页面；离线 Web Push 未实现 |
| `$DSH_HOME/sessions/**` 会话日志 | 默认 zstd 校验帧压缩，外部按行读不可用 | **否**：解析持久化格式会让上游的格式变更直接打断我们，且要求用户改压缩配置 |
| DSH 的 credentials 文件 | 存在，但是内部格式与用户私有数据 | **否**：不读 |
| DSH 的日志文件 | 不存在（日志即 stdout/stderr） | 由 daemon 捕获子进程 stdout/stderr 并写入自己的日志 |

---

## 7. 升级仪式（改动 DSH 版本时执行）

DSH 每次版本变更后，按顺序做这八件事，并把结果更新到本文：

1. **跑一遍 `drdsh daemon doctor`**，确认能发现 DSH、能绑定 loopback 端口。
2. **启动一次 `dsh web --no-open`，人工确认就绪行格式**（前缀 `dsh web: `、`?token=` 存在；历史版本的 LAN 追加部分仍以空格分隔）。若格式变化，更新解析逻辑与本文 § 2。
3. **确认令牌换 cookie 仍可用**：`GET /?token=…` 仍返回 `303` + `Set-Cookie`，cookie 名仍以 `dsh-auth-` 开头。若变化，更新本文 § 3。
4. **确认 `/api` 的 Host 栅栏未放宽**：用非 loopback Host 请求 `/api/...`，必须仍被拒绝。若被放宽，需要在 `docs/security.md` 中重新评估"鉴权不被绕过"这一保证。
5. **确认跨进程事件列表**：`API_REMOTE_FORWARDED_EVENTS` 是否仍包含 `approval/request` 与 `user-questions/request`。若移出，关键通知将依赖插件，需要重新评估插件的必需性。
6. **跑插件的升级测试**：执行 `pnpm run smoke:dsh-upgrade /absolute/path/to/dsh`；安装真实 bundle，通过服务产生审批、提问、会话结束和目标完成，验证 `dsh-surface.ts` 的适配保留回答且不泄露内容，然后卸载。脚本使用临时 `DSH_HOME`，不改用户的 profile；插件安装需要可用的包管理器与网络。
7. **跑浏览器与旧版回归**，更新本文的版本、上游提交、插件 `engines.dsh` 及 smoke 的版本清单，并记录实际结果。新增页面应在真实隧道内检查，不能仅凭 HTTP 200 宣称可用。
8. **单独验收本机管理面**：在隔离的真实 profile 中检查路由与资源清理、DSH 鉴权/Origin 拒绝、固定非秘密入口、实际 profile 元信息、管理挂载失败不损坏报告、成功启动回调和优雅退出；再检查本机解锁、OS 作业跨宿主重启、首次接管，以及远端 HTTP/WS 不能访问管理命名空间。事件报告通过不能替代此项。

**如果没有时间做全套**：2、3、5 是远程访问基础的最低检查，不代表完整兼容验收。
没有完成第 8 项时，不扩大管理页面兼容清单，也不宣称新版本可进行首次接管。

### 2026-09-20 兼容验收（历史记录）

两版均以官方 npm 包在独立目录安装；用临时 `DSH_HOME` 执行测试。源码分别对照官方 tag
[`dsh-v0.1.5-rc.2`（`fb2c4b9e698e30edb738bca4cf0618587db7d203`）](https://github.com/deepseek-ai/deepseek-harness/tree/fb2c4b9e698e30edb738bca4cf0618587db7d203)
与 [`dsh-v0.1.6-alpha.2`（`ddefc45fbc7f8e46dd73185e68295696d1297887`）](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887)。

```sh
# DSH_BIN 指向待验收版本；DSH_HOME 使用一个独立的测试目录。
DSH_BIN=/absolute/path/to/dsh DSH_HOME=/tmp/drdsh-dsh-test \
  cargo test -p dr-dsh-daemon --test real_dsh -- --ignored --test-threads=1
DSH_BIN=/absolute/path/to/dsh DSH_HOME=/tmp/drdsh-dsh-test \
  cargo test -p dr-dsh-daemon --test acceptance -- --ignored --test-threads=1
pnpm run smoke:dsh-upgrade /absolute/path/to/dsh
```

| 检查 | `0.1.5-rc.2` | `0.1.6-alpha.2` |
| :--- | :--- | :--- |
| `drdsh daemon doctor --dsh <path>`（程序版本、loopback 端口） | 通过 | 通过 |
| 就绪行、令牌换 cookie、JSON RPC、Host/端口绑定、优雅退出（`real_dsh`，3 项） | 通过 | 通过 |
| 真实 DSH 首页经中继加密隧道返回、直连 DSH 的实时 mux 升级成功（当时的 `acceptance`，2 项） | 通过 | 通过 |
| bundle 安装/移除、审批与提问回答保留、报告元数据（`dsh-upgrade-smoke`，6 项） | 通过 | 通过 |
| 真实 Chrome：配对、独立界面页、插件管理与设置读取、隧道内 `$events` 就绪 | 本次未单独跑浏览器 | 通过，控制台无错误 |

插件 smoke 暂时关闭该测试 profile 的 `api-remotes`，让本地测试回答者处理请求，避免等待未连接的浏览器。
子代理完成仅以符合上游类型的构造消息走真实事件总线；没有运行模型或真实子代理任务。
`/report` 使用本地测试接收器；daemon 的通知接收与推送仍未交付，不能把插件通过等同于推送端到端通过。
浏览器验证未配置模型凭据，因此不覆盖模型回复、长任务或真实工具审批；这类验收仍使用 `scripts/browser-task-smoke.mjs --full`。
这些是当时环境中的结果；2026-09-26 临时重新安装 `0.1.5-rc.2` 时，上游插件树在启动阶段加载失败，未进入 dr.dsh 隧道断言，因此本次没有重新确认该旧版。旧版的 npm 传递依赖解析结果可能与历史验收时不同。

这次发现并修复了 daemon `post_json` 缺少 `Content-Type: application/json` 的问题：新版 RPC 网关会拒绝没有媒体类型的请求。
审批/提问监听器补齐 `next()`，目标完成改读 `change.operation`，会话标识改从各事件的真实结构提取。

### 2026-09-26 兼容验收（DSH 0.1.7-rc.2）

以官方 npm 包在独立目录安装，`DSH_HOME` 指向临时目录；源码对照提交
[`477b4f420553e8a52c2fbccc464d7561b239c443`](https://github.com/deepseek-ai/deepseek-harness/tree/477b4f420553e8a52c2fbccc464d7561b239c443)。

```sh
cargo run -p dr-dsh-cli -- daemon doctor --dsh /absolute/path/to/dsh
DSH_BIN=/absolute/path/to/dsh DSH_HOME=/tmp/drdsh-dsh-test \
  cargo test -p dr-dsh-daemon --test real_dsh -- --ignored --test-threads=1
DSH_BIN=/absolute/path/to/dsh DSH_HOME=/tmp/drdsh-dsh-test \
  cargo test -p dr-dsh-daemon --test acceptance -- --ignored --test-threads=1
pnpm run smoke:dsh-upgrade /absolute/path/to/dsh
```

| 检查 | 结果 |
| :--- | :--- |
| `drdsh daemon doctor`（版本识别、loopback 端口） | 通过；识别 `0.1.7-rc.2`，端口可用 |
| 真实 DSH 契约（`real_dsh`，3 项） | 通过；就绪行、令牌换 cookie、JSON RPC、Host/端口绑定、优雅退出；带有效 cookie 的非 loopback Host 请求 `/api/session/list` 返回 403 |
| 真实 DSH 接入（`acceptance`，2 项） | 通过；经 relay 加密隧道的首页返回 34240 字节，`/api/remote.mux` 升级及 `$events` 就绪项双向穿过隧道；另有直连 DSH 的 mux 契约检查 |
| 插件安装与事件适配（`dsh-upgrade-smoke`，6 项） | 通过；bundle 安装/移除、审批与提问回答保留、仅上报内容无关元数据 |
| 真实浏览器渲染 | 未运行；本机未安装 smoke 脚本所需 `playwright-core`，且脚本预期的 Chromium 二进制不存在。隧道内 HTTP 与 WebSocket 往返已由 `acceptance` 验证 |

插件 smoke 关闭测试 profile 的 `api-remotes`，由本地测试回答者处理审批与提问；`/report` 指向临时接收器，不代表 daemon 通知推送已交付。
真实浏览器渲染、模型回复与真实工具审批尚未在这个版本单独验收。
`acceptance` 另有一条非致命的测试审计目录提示（`target/audit-unused` 不存在）；本次隧道断言通过，但该用例未验证审计文件落盘。

### 2026-10-11 兼容验收（DSH 0.2.0-rc.2 与 0.2.1-alpha.2）

两版均以官方 npm 包安装在独立临时目录，`DSH_HOME` 指向各自的临时目录；源码分别对照
[`0.2.0-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84)
与 [`0.2.1-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)。
新版仍以 `dsh web: http://127.0.0.1:<port>/?token=…` 宣告就绪，HTTP loopback 的 cookie 与 Host 栅栏仍有效；
`API_REMOTE_FORWARDED_EVENTS` 仍有 27 项，包括审批与提问。上游新增公开 URL、非 loopback 绑定及 TLS 选项，
本项目的启动参数没有启用它们。

| 检查 | `0.2.0-rc.2` | `0.2.1-alpha.2` |
| :--- | :--- | :--- |
| `drdsh daemon doctor`（版本、loopback 端口） | 通过 | 通过 |
| `real_dsh`（就绪、cookie、RPC、Host 栅栏、退出） | 3/3 通过 | 3/3 通过 |
| `acceptance`（真实首页与 `$events` 经加密中继往返） | 2/2 通过 | 2/2 通过 |
| `dsh-upgrade-smoke`（bundle、审批/提问回答、元数据） | 6/6 通过 | 6/6 通过 |
| 真实 Chrome 配对与界面（`browser-pairing-smoke`） | 13/13；界面 362 个节点，控制台无错误 | 13/13；界面 383 个节点，控制台无错误 |

真实浏览器首次检查发现了本项目的路由缺陷：DSH 首页在 `/__dr/interface` 下的相对资源变为
`/__dr/assets/...` 与 `/__dr/plugins/...`，原有 Service Worker 把整个 `/__dr` 前缀排除，页面只有空壳且资源返回 404。
现在只排除 worker 自己的 `/__dr/control` 和 `/__dr/dsh` 端点，资源请求经隧道还原成 DSH 的 `/assets`、`/plugins`。
浏览器 smoke 同时更新到客户端的 v2 IndexedDB 布局，并要求界面有可见文本、检查新标签页的控制台错误，避免把空壳算作成功。

上一次验收的 `0.1.7-rc.2` 也重新安装并回归：doctor、`real_dsh` 3/3、`acceptance` 2/2、
插件 smoke 6/6、真实 Chrome 13/13 均通过；`0.1.5-rc.2` 与 `0.1.6-alpha.2` 本次未重跑。
浏览器检查确认配对、界面渲染和刷新后的隧道重连；`acceptance` 另行验证实时 mux。
没有运行模型任务或浏览器里的真实工具审批；插件 smoke 的回答者由测试 profile 提供。

### 2026-10-22 兼容验收（DSH 0.2.1-rc.2）

以官方 npm 包在独立目录安装，使用临时 `DSH_HOME`；上游提交为本文开头的 `687f282e…`。
就绪行、HTTP loopback 的 v1 cookie、Host 栅栏与 mux 帧保持兼容，远端事件列表新增
`plugin-market/changed`（共 28 项）。插件声明加入新版本，以通过上游现在执行的 `engines.dsh` 校验。

| 检查 | 结果 |
| :--- | :--- |
| `drdsh daemon doctor` | 通过；识别 `0.2.1-rc.2`、loopback 端口可用 |
| `real_dsh`（就绪、cookie、JSON RPC、Host 栅栏、优雅退出） | 3/3 通过 |
| `acceptance`（真实首页及 mux 经加密隧道往返） | 2/2 通过 |
| `dsh-upgrade-smoke`（bundle 安装/移除、审批/提问结果、事件元数据） | 6/6 通过 |
| 真实 Chrome 配对与页面（`browser-pairing-smoke`） | 14/14 通过；含按 DSH 文档地址解析的实时 mux、刷新重连、崩溃上报 |
| 已部署 HTTPS 中继 | 两个公网域名分别 14/14；已安装浏览器的缓存从 v3 升级到 v4 后重新加载成功 |
| 全仓库 `pnpm run verify` | 通过 |

浏览器复查发现此前的“已渲染”断言可能停在加载页，也没有覆盖 DSH 实际使用的相对 mux 地址。
HTTP 路径转换已支持 `/__dr/...`，但 WebSocket 仍把 `/__dr/api/remote.mux` 原样交给 DSH，
界面因此停在“重连中”。`shell.js` 现在复用 `toDshPath` 转换 WebSocket 目标并保留查询参数。
新增浏览器断言从 `document.baseURI` 解析 mux URL，必须收到 `$events` 的 `ready` 项，并等待
“New Session”按钮可见；修复前为 13/14，修复后为 14/14。任务 smoke 同样改用相对 mux 地址，
避免以根绝对路径探针掩盖真实页面问题。
离线缓存提升到 v4，并预缓存 `routing.js`，使已安装客户端的 shell 与路径转换模块一起更新。
旧缓存首次刷新可能仍返回旧 shell；新 worker 激活后再刷新即可取得新版，配对资料保留在 IndexedDB。
浏览器 smoke 同时改用 `BrowserContext.weberror` 捕获所有标签页异常，等待 DSH 与中继两端就绪，
并在失败时也停止测试 daemon，避免测试抢跑或孤儿进程占用端口影响后续检查。

此前的 `0.2.1-alpha.2` 回归通过：`real_dsh` 3/3、`acceptance` 2/2、插件 6/6、
更新后的真实 Chrome 配对与实时 mux 检查 14/14。

本次没有配置模型凭据，未验收模型回复、长输出或浏览器里的真实工具审批。
插件 smoke 的审批/提问由测试 profile 回答，子代理结束使用构造事件；其 `/report` 为临时接收器。

---

### 2026-10-26 跨机通知验收（DSH 0.2.1-rc.2）

blade 的 DSH 从源码安装的 `0.1.6-alpha.2` 切换到官方 npm `latest` 指向的
`0.2.1-rc.2`，使用独立版本目录，保留原源码目录。新版本完成本机原生模块检查，
`dsh-upgrade-smoke.mjs` 的真实插件安装、移除和事件契约检查 6 项通过。

ali 部署 relay 与 PWA，blade 部署带报告接收器的 daemon 和插件。通过 HTTPS/WSS 的
真实浏览器验证配对、DSH 页面加载、轮次结束、目标完成和子代理结束通知，以及已读、
中英文、390px 布局；刷新保留配对身份与语言偏好，重新连接不补发旧通知。

本次通知使用临时测试插件
[`live-notification-probe.mjs`](../../scripts/fixtures/live-notification-probe.mjs)：
轮次结束和目标完成经真实 DSH 服务产生，子代理结束使用构造事件发到真实事件总线。
测试没有调用模型，不代表完成了模型输出、真实工具审批或真实子代理任务验收。
测试插件仅在专用 DSH_HOME 中临时启用，不属于安装包或日常运行配置。

重启 daemon 时，relay 可能保留浏览器的 WebSocket，但原加密会话已失效。PWA 在状态请求
超时时清空并暂停通知，保留失败原因供用户重新连接；明确断连时才关闭旧隧道并停止轮询。
大文件传输也可能使状态回复排队超过 5 秒，因此超时保留现有传输并继续轮询，后续状态回复
成功时恢复通知订阅。来自 daemon 的明确拒绝或格式错误不会误判为断连，关闭后的旧请求
也不会覆盖原失败说明。离线外壳缓存提升到 v8 以同步更新。

以上为 v8 的历史行为。2026-10-30 后状态探测在持续收到已认证数据时继续等待，采用
5 秒入站空闲预算与 60 秒单次上限，避免大资源排队导致误报；现场证据和限速复验见
[本轮部署验收](../operations/acceptance-2026-10-30.md)。

完整页面加载还发现旧中继的满队列丢帧：最大的插件组合资源为 9,198,843 字节，DSH 本机
12 ms 返回 200，但跨机浏览器收到 counter 227、预期 215，随后关闭加密会话。
中继保留固定 64 帧队列，等待容量时将背压传回读取侧，关闭信号独立于数据队列，避免大资源被静默截断；
实现和代价见 [ADR-0021](../decisions/0021-bounded-relay-backpressure.md)。
2026-10-27 以通过 7 项背压实测的 Linux musl 发布构建更新 ali 后，浏览器经跨机隧道
完整取回该 9,198,843 字节资源（约 30 秒）并显示 `New Session` 界面，控制台错误为 0；
累计接收约 13 MB 数据期间没有新增隧道错误或连接关闭，控制状态从超时自动恢复。
恢复后重新触发临时测试插件，三类通知均到达，未读计数与 alert 提示一致。
移除临时插件并重启后，列表、角标和 alert 清空且断线原因保留；正常配置重连后仍可
打开 DSH 界面，没有旧通知回放。最终已遗忘并撤销测试设备，重启使撤销生效。

---

### 2026-10-30 兼容验收（DSH 0.2.2-alpha.2 与 0.2.1-rc.5）

官方 npm 通道在线核对后，按用户选择以 `alpha=0.2.2-alpha.2` 为主要版本；
`latest/next=0.2.1-rc.5` 另作回归。两版均从官方 npm 安装在独立临时目录，使用新建 DSH_HOME，
未修改上游 checkout 或已有 profile。`dsh-upgrade-smoke.mjs` 两版均通过 **6/6**：真实 bundle
安装与移除、审批和提问回答保留、会话/目标/子代理事件最小元数据、SIGTERM 优雅停止。

两版的 [`plugin-connect-smoke.mjs`](../../scripts/plugin-connect-smoke.mjs) 均通过 **9/9**：

- 生产插件 tgz 内携带本机 native，由真实 DSH 包管理器安装。
- plugin 的 `relayUrl` 启动独立隧道，`owned=false`，未安装 daemon 服务。
- 真实 DSH 本机管理页保留自身登录；仅 DSH cookie 不授予管理权，独立 capability 解锁后可读状态。
- 同状态目录 CLI 配对、设备鉴权和状态消息通过加密 relay 隧道往返。
- 远端通过正常 DSH 鉴权取得原生界面，`/_drdsh` 代理与生命周期控制仍拒绝。
- 真实会话结束、目标完成，以及真实事件总线上的构造子代理事件到达通知订阅。
- relay 停止不影响 DSH，恢复后原配对身份重新连接。
- SIGKILL DSH 宿主后，native 的 stdin EOF 使其退出，无遗留 companion。

随后两版均追加 `--check-browser` 通过 **11/11**：真实 Chromium 确认预览提示
触发 `settings/mutate` 与 profile 重组，并在刷新前后通过 DSH browse 界面选择临时主机目录，
最终 workspace 的 canonical path 均一致。独立模式使用显式启动 patch；试验性的运行时
Loader 修改已撤回，因为设置重组会恢复 auto，导致重复 provider。受管 daemon 的启动
overlay 不受此次撤回影响。

上述检查没有调用模型；不等同于真实模型回复、工具审批任务或 DeepSeek 账号 OAuth 登录。
插件不修改上游登录栅栏。DSH `0.2.2-alpha.2` 的 DeepSeek Web 账号登录回调仍要求 HTTP loopback；
HTTPS relay 页的新账号登录约束与可用的上游 API key 配置入口应分别验收，不能把 dr.dsh 配对成功
或 DSH 页面加载成功表述为账号登录成功。

---

## 8. 上游缝隙的缺失清单（我们希望 DSH 未来提供的）

按价值排序。这些不是抱怨，而是本项目愿意向上游提交的最小请求：

1. **一个稳定的就绪信号**（JSON 行、状态文件、或 `--ready-file <path>`），把 § 2 从"有注释背书的约定"变成契约。
2. **跨进程事件列表可扩展**（或在 web profile 下可注册更多事件），让插件在"只需通知"的场景下变得可选。
3. **官方的进程监督接口**（例如 `dsh web --supervised`，明确 stdout 契约与退出语义）。
4. **进程外附着发现**：插件进程内已有 `connection.authenticatedUrl()`，独立模式使用这一正式接口；
   外部进程仍缺少可查询已运行实例状态与令牌的发现协议，不应靠扫描日志或文件猜测。
5. **一个 `--trusted-host` 之外的"本机反向代理"授权方式**：让反向代理可以声明"我代表 loopback 本机"，而不必自行实现令牌换 cookie。

在拿到其中任何一项之前，本项目的实现方式就是本文所描述的这些。

## DSH 的两条实测行为（第 29 轮补记）

两条都是被真实 DSH 拒绝之后才写下来的，也都是"看起来像 DSH 的毛病、实际是我们的"这一类：

### `Content-Length` 只能有一个

DSH 的 HTTP 层是 Node 的 `node:http`，它的解析器在**任何应用代码之前**拒绝带两个 `Content-Length`
的请求，响应是 `400` 且**响应体为空**：

```text
POST /api/session/list，一个 Content-Length  -> 200
POST /api/session/list，两个                 -> 400（空）
```

空体的 400 很容易被读成"DSH 的 RPC 面不接受调用"。**daemon 因此不转发客户端的 `content-length`**
（`crates/dr-dsh-daemon/src/dsh/client.rs` 的 `is_body_owned`）：它重新分帧，长度由它按实际发送的 body 设定。
回归测试用裸 TCP 服务器数头，因为 hyper/axum 的测试服务器会把重复头合并，看不见这件事。

另外，DSH 出现**任何未捕获的处理器异常**时也是 `400` + 空体（`packages/host/webserver` 的兜底 catch 写
`res.writeHead(400)`）。也就是说：空体 400 有两种成因——帧层被解析器拒绝，或处理器抛异常——而两者在
客户端看起来完全一样。排查时先在**不经过本项目**的路径上重放同一个请求，这一步能立刻把两者分开。

### mux socket 用的是 `addEventListener`

`/api/remote.mux` 的客户端（`packages/api/gateway/src/client/stream-client.ts`）用
`socket.addEventListener('open' | 'message', …)`，不是 `onopen`/`onmessage` 属性。任何替换
`window.WebSocket` 的注入代码必须支持两种写法，否则 socket 永远停在 `CONNECTING`：界面的工作区列表、
会话列表与一轮对话的输出都会无限等待，而页面不会报任何错。

流协议的形状（实测）：客户端发 `{"type":"open","streamId":…,"endpoint":"workspace/follow"|"session/control"|"$events"|"session/follow","payload":{"args":{}}}`，
服务端回 `{"type":"item","streamId":…,"value":…}`；`$events` 的第一项是 `{"type":"ready",…}`。
冒烟脚本用 `$events` 的这一项作为"mux 真的能用"的判据。


## 2026-11-04：v0.2.0 发布兼容性

DSH `0.2.2-alpha.2` 使用 Cordis `4.0.6-alpha.1`、group `1.0.6-alpha.1`、
include `1.0.11-alpha.1`、loader `1.0.7-alpha.1`、timer `1.1.8-alpha.1`、
cosmokit `1.8.7-alpha.1`、schemastery `3.18.6-alpha.1` 进行验收。
自动安装器通过 npm overrides 固定该组合，保留 package-lock，未修改上游源码。

2026-11-04 的全新 npm 安装原先解析到了 Cordis alpha.2 家族；直连本机 DSH 与经过隧道均可复现
设置保存 `next is not a function` 和会话创建失败。固定上述组合后，真实浏览器的首次设置保存、
主机目录选择与工作区创建通过；单独升级 Cordis 不能视为 DSH 兼容升级。
外部 DSH 请核对依赖组合，或使用 [daemon 私有安装](../operations/dsh-provisioning.md)。

DSH `0.2.1-rc.5` 保留回归覆盖。具体命令、操作系统与未覆盖范围见
[v0.2.0 发布验收](../operations/acceptance-2026-11-04.md)。
