# 与 DSH 的集成面

本项目**不修改、不 fork** DSH。它只依赖上游已经提供的东西，本文列出这些依赖的**确切清单、上游证据、以及每一条失效时的表现**。

DSH 的 README 明确写道："Developer preview … **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**" 因此本文的目的不是"确认依赖稳定"，而是"把不稳定性关进一个可以被检查的笼子里"。

核对基准（2026-09-26）：**DSH `0.1.7-rc.2`**，上游提交
[`477b4f420553e8a52c2fbccc464d7561b239c443`](https://github.com/deepseek-ai/deepseek-harness/tree/477b4f420553e8a52c2fbccc464d7561b239c443)。
同时保留对 **`0.1.5-rc.2`** 与 **`0.1.6-alpha.2`** 的回归记录。截至核对日，官方 npm 的 `latest` 为 `0.1.5-rc.3`、
`alpha` 为 `0.1.7-alpha.2`、`next` 为 `0.1.7-rc.2`；本次按 `next` 通道的最新预发布版验收。
版本列表由 `npm view @deepseek-ai/dsh dist-tags --registry=https://registry.npmjs.org` 取得。

> 引用约定：本文只引用**文件路径与符号名**，不引用行号——行号会随上游提交漂移，符号名可以被 `grep` 重新定位。

---

## 1. 依赖清单总览

| # | 依赖 | 上游位置（符号） | 我们怎么用它 | 失效表现 | 严重度 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 启动与就绪行 | `packages/bundle/web-app/src/index.ts` → `announceReady`、模板字符串 `dsh web: ${authenticatedUrl}`；`apps/cli/src/args.ts` → `program.command('web')` | daemon spawn `dsh web`，从 stdout 解析端口与进程令牌 | 无法启动或无法取得令牌 | **致命**（M0 阻塞） |
| 2 | 浏览器信任栅栏 | `packages/client/connection/src/browser-auth.ts` → `TOKEN_QUERY`、`COOKIE_PREFIX`、`authenticatedUrl`、`authorizeIndex`、`isAuthenticated`；`packages/client/connection/src/api-request-trust.ts` → `isTrustedApiRequest` | daemon 用令牌换 cookie，并以 loopback authority 代理 | 页面或 `/api` 全 401 | **致命** |
| 3 | 跨进程事件通道 | `packages/api/gateway/src/stream-protocol.ts` → `REMOTE_STREAM_MUX_PATH`（`/api/remote.mux`）；`packages/api/remotes/src/remote-events.ts` → `API_REMOTE_FORWARDED_EVENTS` | 审批与提问通知不需要插件即可到达远端 | 关键通知失效 | 高 |
| 4 | Cordis 插件与 bundle 清单 | `docs/user/develop/basic/publish.md`（bundle / profile 两种 manifest）；`packages/util/package-manifest/src/types.ts` → `DshManifest`、`DshBundleManifest` | 以 bundle 形式安装事件上报插件 | 插件无法安装或加载 | 中（插件可选） |
| 5 | 进程内事件名及参数 | `packages/core/session/src/index.ts` → `'session/event'`；`packages/interaction/user-approval/src/types.ts` → `'approval/request'`；`packages/interaction/user-questions/src/types.ts` → `'user-questions/request'`；`packages/subagent/subagent/src/index.ts` → `'subagent/end'`；`packages/goal/goal/src/domain.ts` → `'goal/changed'` | 插件提取不含内容的事件元数据并上报 | 部分通知缺失，需真实升级测试发现 | 中（插件可选） |
| 6 | 优雅停止 | `apps/cli/src/process-shutdown.ts`；`apps/cli/reference/README.md` | daemon 用 SIGTERM 停止 DSH，等待其自行关闭 | 停止变成强杀，可能中断会话 | 中 |
| 7 | 本地数据布局 | `packages/util/home-paths/src/index.ts`（`$DSH_HOME`，默认 `~/.dsh`） | `doctor` 与排障文档引用路径 | 文档指引失准 | 低 |

**明确不依赖**（曾经考虑过、并已否决，见 ADR-0003）：

- DSH SDK（`packages/sdk/*`）：stdio JSON-RPC，无法附着到运行中的 `dsh web`，只提供 4 类通知且无审批流。
- `--trusted-host`：它是给"服务非 loopback authority 的部署"用的，我们不用它来放宽栅栏。
- Session 日志文件（`$DSH_HOME/sessions/**`）：默认 zstd 压缩，外部按行读取不可用；且让用户改 `compression: none` 会改变他们 DSH 的写入行为。我们宁可通过插件取事件，也不解析持久化格式。
- `dsh-hooks-claude-code`：它的 `Notification` 与 `PermissionRequest` 明确不支持，且不在 base bundle 内。

---

## 2. 依赖 1：启动与就绪行（唯一的"非正式契约"）

**上游行为**：`dsh web` 在 Loader settle 之后向 stdout 打印一行：

```
dsh web: http://127.0.0.1:3080/?token=<launchToken>
```

若同时推导出 LAN 地址，同一行后面会追加 ` (LAN: http://<ip>:<port>/?token=<launchToken>)`。该行的触发条件是 `printUrl` 或 `handoffBrowser` 之一；二者都不会在 `/api` 路由等兄弟行挂载完成之前运行。

**上游源码里关于监督的承诺**（`packages/bundle/web-app/src/index.ts` 中 `announceReady` 上方的注释）写明：URL 行与浏览器打开都是就绪信号，"supervisors RPC as soon as they observe the line"。

**我们怎么用**：

1. daemon 以 `dsh web --no-open --port <p>` 启动子进程。**端口由 daemon 指定**（不需要猜），`--no-open` 只关掉浏览器交接，不关掉就绪行（`printUrl` 默认 `true`，且是独立开关）。
2. 逐行读取 stdout，匹配前缀 `dsh web: `。
3. 从该行的 URL 取出 `token` 查询参数（到第一个空格为止，避免把 LAN 追加部分吃进来）。
4. 用它执行一次 `GET /?token=…`，取得 DSH 的授权 cookie。

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
2. **授权令牌换取 cookie**（`browser-auth.ts` → `authorizeIndex`）：`GET /?token=<launchToken>` 返回 `303` + `Set-Cookie`；同一进程内令牌可以重复使用。cookie 名为 `dsh-auth-<base64url(sha256(authority))>`，值为 `v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`，属性包含 `Path=/; HttpOnly; SameSite=Strict`，有效期由 `cookieMaxAgeDays` 决定（默认 **30 天**；新版还带 `Expires`）。daemon 将 cookie 值视作不透明数据。
3. **cookie 绑定 authority**：cookie 名与签名 audience 都是请求的 Host authority；`isAuthenticated` 会同时校验 cookie 的 authority 与当前请求的 Host authority 是否一致。`/api` 另有一道 Host 栅栏（`api-request-trust.ts` → `isTrustedApiRequest`）：Host 必须是 loopback 或 `trustedHosts` 之一，且若存在 `Origin` 必须与 Host 同源，`Sec-Fetch-Site: cross-site` 直接拒绝。

**实测记录（2026-09-11，DSH 0.1.5-rc.2）**：

- 未授权访问 `/` 得到 `401` 与 `dsh web authentication required; reopen the URL printed by dsh web.`
- `GET /?token=<T>` 得到 `303`、`location: /`、`set-cookie: dsh-auth-<hash>=v1.<payload>.<sig>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`（**默认 30 天**，来自 `cookieMaxAgeDays` 的默认值）。
- 带该 cookie、`Host: 127.0.0.1:<p>` 请求 `/` → `200`；把 Host 改成 `relay.example` 后**同一 cookie 立即变为 401**。这正是"裸反向代理必然失败"的实证。
- 令牌在**同一进程内可重复换取**（第二次仍然 `303`），所以它不是严格的一次性凭据。这不影响安全模型：令牌只出现在启动进程的 stdout 与本地浏览器 URL 里，从不经过中继。
- **authority 相等是精确的，端口也算在内**：同一个 cookie，`Host: 127.0.0.1:<port>` 得到 `200`，而 `Host: 127.0.0.1`（丢掉端口）得到 `401`。这是代理实现最容易踩的坑——传输层很容易"顺手"把端口丢掉，而失败表现是一个看起来像"cookie 过期"的 401。该用例已被 `crates/dr-dsh-daemon/tests/real_dsh.rs` 固定为回归测试。
- `/api` 的 RPC 端点形如 `/api/<service>/<method>`（例如 `/api/session/list`），信封为 `{"type":"client-request","rpcId":…,"method":…,"payload":{"args":[…]}}`；未知端点返回纯文本 `404 not found`（DSH 自己的 404，不是我们代理产生的）。注意 `sessionController` 是服务的**键名**，路径里用的是 `session`。

**这对我们的含义**：

- **"裸反向代理"必然失败。** 把远端 Host 原样转给 DSH，会得到 401 或 403。cookie 注入不是优化项，而是实现前置条件。
- 因此 daemon 的行为被固定为：**自己换取 cookie → 以 `127.0.0.1:<p>` 为 authority 代理全部请求**（包括 WebSocket 升级 `/api/remote.mux`）。
- `SameSite=Strict` 与 `HttpOnly` 对我们没有冲突：cookie 由 daemon 持有并注入，浏览器从不持有 DSH 的 cookie 参与跨站请求。
- 我们**不使用** `--trusted-host`：它是给"服务非 loopback authority 的部署"用的，用它去放宽栅栏只会把一个 DNS-rebinding 防护打开一个洞，而且并不解决 authority 绑定的根本问题。

**副作用（已知且接受）**：远端页面的 hostname 不是 loopback，因此 DSH 客户端会判定"非本机"，导致部分依赖 `isLoopback` 的设置面板降级（例如设置持久化退回内存）。这是 DSH 把 loopback 当作"操作者本机"的既有设计，我们不试图欺骗它。相关表现写在 [`../operations/troubleshooting.md`](../operations/troubleshooting.md)。

---

## 4. 依赖 3 与 5：事件通道

**跨进程（无需插件）**：Gateway 的 WebSocket 多路复用位于 `REMOTE_STREAM_MUX_PATH`（`/api/remote.mux`），它转发的事件是**编译期硬编码的常量列表** `API_REMOTE_FORWARDED_EVENTS`（本次核对为 27 项），其中包含 `approval/request`、`user-questions/request`、`api-session/*`、`goal/activation-changed`，以及 `plugin-manager/changed`、`plugin-manager/install-log`、`plugin-manager/install-state`、`settings/document-updated`。这些事件本身就是 DSH 界面的流量，被我们原样代理即可到达远端，因此**审批与提问通知在 M0 就可用**。新版插件管理与设置页也使用这条通道，无需复制它们的业务实现或增加 dr.dsh wire 消息。

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

**版本守卫**：`engines.dsh` 精确列出已验证的三个预发布版本（普通 `>=0.1.5 <0.2` 不包含它们），
但上游目前**不校验**此字段。插件启动只检查 `ctx.on`/`ctx.effect` 是否存在。
Cordis 接受任意事件名，静态集合无法探测运行中的 DSH 是否仍产生这些事件；真实服务的升级测试才是验收依据。
观察者的发送异常被隔离，不能改变 DSH 的任务或审批结果；未知 payload 不作内容猜测。

---

## 5. 生命周期控制

**上游没有任何 daemon 化能力**：没有 systemd/launchd 集成、没有 `--detach`、没有后台模式。因此进程监督完全由 daemon 负责：

| 动作 | 做法 | 依据 |
| :--- | :--- | :--- |
| 启动 | `spawn dsh web --port <p>` | `program.command('web')` 与 web startup 的 flag 家族 |
| 就绪 | 解析 stdout 的就绪行 | § 2 |
| 停止 | 发送 SIGTERM，等待 DSH 自行 dispose 整棵树 | `apps/cli/src/process-shutdown.ts` |
| 超时 | DSH 自身有受限宽限期后强杀；daemon 另设一个更外层的上限，避免无限等待 | 同上 |
| 健康 | HTTP 探测 + 进程存活 | 我们自己的逻辑 |

**不管理**用户手动启动的实例：daemon 检测到端口已被占用时进入 **attach 模式**（`LifecycleState::Attached`），只做代理，拒绝生命周期指令并说明原因。理由写在定义文档 § 8 与 § 9.2，也写在 `crates/dr-dsh-daemon/src/config.rs` 的 `DshMode::Attached` 上：手动实例的启动方式我们不知道，因此无法诚实地声称能按同样方式重启它。

---

## 6. 状态观测

| 来源 | 可用性 | 我们是否使用 |
| :--- | :--- | :--- |
| daemon 自己监督的进程状态 | 完全可用 | **是**：`Status` 的唯一来源 |
| HTTP 探测 `127.0.0.1:<p>` | 完全可用 | 是（健康检查） |
| 插件上报的事件 | 需要插件及报告接收器 | 插件已适配；daemon `/report` 接收与通知推送尚未交付 |
| `$DSH_HOME/sessions/**` 会话日志 | 默认 zstd 校验帧压缩，外部按行读不可用 | **否**：解析持久化格式会让上游的格式变更直接打断我们，且要求用户改压缩配置 |
| DSH 的 credentials 文件 | 存在，但是内部格式与用户私有数据 | **否**：不读 |
| DSH 的日志文件 | 不存在（日志即 stdout/stderr） | 由 daemon 捕获子进程 stdout/stderr 并写入自己的日志 |

---

## 7. 升级仪式（改动 DSH 版本时执行）

DSH 每次版本变更后，按顺序做这七件事，并把结果更新到本文：

1. **跑一遍 `drdsh daemon doctor`**，确认能发现 DSH、能绑定 loopback 端口。
2. **启动一次 `dsh web --no-open`，人工确认就绪行格式**（前缀 `dsh web: `、`?token=` 存在、LAN 追加部分仍以空格分隔）。若格式变化，更新解析逻辑与本文 § 2。
3. **确认令牌换 cookie 仍可用**：`GET /?token=…` 仍返回 `303` + `Set-Cookie`，cookie 名仍以 `dsh-auth-` 开头。若变化，更新本文 § 3。
4. **确认 `/api` 的 Host 栅栏未放宽**：用非 loopback Host 请求 `/api/...`，必须仍被拒绝。若被放宽，需要在 `docs/security.md` 中重新评估"鉴权不被绕过"这一保证。
5. **确认跨进程事件列表**：`API_REMOTE_FORWARDED_EVENTS` 是否仍包含 `approval/request` 与 `user-questions/request`。若移出，关键通知将依赖插件，需要重新评估插件的必需性。
6. **跑插件的升级测试**：执行 `pnpm run smoke:dsh-upgrade /absolute/path/to/dsh`；安装真实 bundle，通过服务产生审批、提问、会话结束和目标完成，验证 `dsh-surface.ts` 的适配保留回答且不泄露内容，然后卸载。脚本使用临时 `DSH_HOME`，不改用户的 profile；插件安装需要可用的包管理器与网络。
7. **跑浏览器与旧版回归**，更新本文的版本、上游提交、插件 `engines.dsh` 及 smoke 的版本清单，并记录实际结果。新增页面应在真实隧道内检查，不能仅凭 HTTP 200 宣称可用。

**如果没有时间做全套**：至少做 2、3、5——这三条失效会让产品完全不可用，而它们的检查各只需一条命令。

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

---

## 8. 上游缝隙的缺失清单（我们希望 DSH 未来提供的）

按价值排序。这些不是抱怨，而是本项目愿意向上游提交的最小请求：

1. **一个稳定的就绪信号**（JSON 行、状态文件、或 `--ready-file <path>`），把 § 2 从"有注释背书的约定"变成契约。
2. **跨进程事件列表可扩展**（或在 web profile 下可注册更多事件），让插件在"只需通知"的场景下变得可选。
3. **官方的进程监督接口**（例如 `dsh web --supervised`，明确 stdout 契约与退出语义）。
4. **附着模式的官方支持**：让外部进程能查询一个已运行实例的状态与令牌，而不是解析 stdout 的复制品。
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
