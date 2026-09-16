# dr.dsh 故障排查

本文按症状组织：每条都给出「症状 → 可能原因 → 如何确认 → 如何修复」，目标是让你在提 issue 之前先拿到一个具名的原因。

## 先收集这些信息再提问

只写"连不上"的 issue 无法处理。请先把下面这些信息凑齐——它们覆盖了绝大多数情况，而且都取自不含密钥的位置：

| 需要的信息 | 怎么拿 | 为什么需要 |
| :--- | :--- | :--- |
| daemon 版本与协议版本 | `drdshd version`（输出形如 `drdshd <version> (wire protocol <major>.<minor>)`） | 两端 wire 版本不匹配会直接拒绝连接，而不是降级（[`../protocol.md`](../protocol.md) § 8） |
| 完整的 `drdshd doctor` 输出 | `drdshd doctor`；DSH 不在 `PATH` 上时加 `--dsh <path>`，端口不是 3080 时加 `--port <port>` | 这三行检查一次性回答"DSH 装了吗、端口是谁的、平台对不对" |
| DSH 自身版本 | `dsh --version` | 插件只对已声明的 DSH 版本做过验证（[`../integration/dsh-surface.md`](../integration/dsh-surface.md)） |
| relay 侧日志 | `journalctl -u drdsh-relay -f` 或 `docker compose logs -f relay` | 区分"客户端没连上"与"relay 拒绝了" |
| relay 的存活探针 | `curl -fsS https://relay.example.com/healthz`（M0 起） | 返回版本与 room 数，不含任何 room 标识（[`../protocol.md`](../protocol.md) § 5.1） |
| 反向代理的错误日志 | nginx 的 `error.log`，或 Caddy 的日志 | 超时与升级失败的证据只在这里 |
| 浏览器侧的事实 | DevTools → Network：`/api/...` 是否被改写成 `/__dr/dsh/api/...`；WS 面板里 `/api/remote.mux` 的状态；Application → Service Workers 是否 controlling | Service Worker 与 WebSocket 升级是两类完全不同的故障 |
| 拓扑 | relay 与 daemon 是否同机、代理链上还有哪些设备、前面是否有 CDN | 超时与升级问题经常出在链上的另一跳 |
| 复现的时间点与现象 | 断线时刻、界面上的原话、是否只在长任务时出现 | 空闲超时的特征是时间间隔固定 |

**可以公开贴出来的**：`drdshd` 的 config 文件（明文、不含密钥，见 `crates/dr-dsh-daemon/src/config.rs`）。
**绝对不要贴出来的**：daemon 的 state 文件（含 room 身份密钥与已配对设备注册表）、`$DSH_HOME` 下的凭据、任何 payload 抓包。审计与日志记录什么、不记录什么，见 [`../security.md`](../security.md) § 4。

## 本文的适用范围

当前阶段是骨架 + 设计文档，下一个里程碑是 **M0**（在另一台设备上通过中继看到一个真实的 DSH 会话，完成标准见 [`../product/mvp.md`](../product/mvp.md) § 五）。因此：

- 现在就能用的是 `drdshd --help`、`drdshd version`、`drdshd doctor`，以及 TypeScript 侧的协议与路由测试。
- `drdshd run` 与 `drdshd pair` 都已实现；`drdsh-relay` 需要 `DSH_RELAY_BIND`（默认 `127.0.0.1:8787`）。
- 下面的条目分两类：一类现在就能用命令输出直接验证；另一类描述 M0 之后的行为，用来在你准备环境时对照，或在 M0 之后排查。每条都注明了它依赖什么。

## 症状速查

| 症状 | 去读 |
| :--- | :--- |
| 手机打开页面显示 401 / `dsh web authentication required` | 第 1 条 |
| 页面能打开，但 `/api` 调用失败、实时更新不动 | 第 2 条 |
| 长时间任务跑到一半断线 | 第 3 条 |
| 远程显示「计算机离线」，但本机 DSH 正常 | 第 4 条 |
| 配对码无效或已过期 | 第 5 条 |
| 远程端显示「已附加（attach）模式」，无法启动/停止 | 第 6 条 |
| 部分设置项灰掉或无法保存 | 第 7 条 |
| 看不懂 `drdshd doctor` 的输出 | 第 8 条 |
| 二进制在旧 CPU 上直接退出 | 第 9 条 |
| 隐私模式或旧浏览器里页面行为异常 | 第 10 条 |
| 新设备无法配对、提示房间已满 | 第 11 条 |
| daemon 报「DSH 已启动但没有打印就绪行」 | 第 12 条 |

## 1. 手机打开页面显示 401 / "dsh web authentication required"

**症状**：页面外壳能打开（静态资源正常），但内容区空白或报错；响应体是 DSH 自己的原文 `dsh web authentication required; reopen the URL printed by dsh web.`；或 `/api/...` 请求返回 401。

**可能原因**

1. 浏览器没有 DSH 的授权 cookie，或者它是为**另一个 authority** 签发的。cookie 的名字与签名 audience 都绑定请求的 Host authority，跨 authority 复用一律无效。
2. 请求根本没走隧道。页面自己的 `fetch('/api/...')` 会带着**中继 origin** 的 authority 到达 DSH，被 DSH 的 `/api` 信任围栏拒绝——这正是 ADR-0005 与 [`../integration/dsh-surface.md`](../integration/dsh-surface.md) § 3 描述的那道栅栏。
3. 会话引导（bootstrap）过期或已被用过：引导路径是短期、单次使用的，重放第二次一定失败（[`../architecture.md`](../architecture.md) § 2.2）。
4. 代理链上某一跳改写了 Host，导致 daemon 持有的 cookie authority 与它实际发出的请求 authority 不一致（cookie 由 daemon 持有并注入，远端浏览器从不持有 DSH 凭据）。

**如何确认**

- 看响应体是不是 DSH 的那句原文（是则说明请求确实到了 DSH，而不是被中继挡住）。
- DevTools → Application → Service Workers：是否有 active 的 worker，且它 controlling 当前页面。没有就是原因 2。
- DevTools → Network：请求路径是 `/api/...` 还是 `/__dr/dsh/api/...`。只有后者说明 Service Worker 的改写生效了（改写规则见 `apps/pwa/src/routing.ts`，有单元测试）。
- 检查反向代理是否改写了 Host；daemon 必须以 `127.0.0.1:<port>` 为 authority 访问 DSH，这条 authority 在整条链路上必须一致。
- 如果只是第一次打开就 401、刷新后正常，那就是最典型的原因 2：Service Worker 在 `install` 里 `skipWaiting()`、在 `activate` 里 `clients.claim()`，接管需要一个装载周期。

**如何修复**

- 重新装载一次页面，让 Service Worker 完成接管；确认它的 scope 覆盖整个站点。
- 让页面与隧道保持同一个 origin：Service Worker 只能拦截同源请求。
- 触发一次新的会话 bootstrap（重连）。若反复过期，检查 daemon 与设备的时钟偏差。
- 不要在代理链上重写 authority；也不要试图用 `dsh web --trusted-host` 绕过——那条路已在 ADR-0003 中被否决，它只会把一个 DNS-rebinding 防护打开一个洞。

## 2. 页面能打开但 `/api` 调用失败或实时更新不动

**症状**：页面外壳正常，会话列表一直转圈或为空，事件永远不刷新。DevTools 的 WS 面板里 `/api/remote.mux` 从未出现 `101`，或出现后立刻关闭。

**可能原因**

- 反向代理没有转发 WebSocket 升级：缺少 `Upgrade` / `Connection` 头，或 `proxy_http_version` 还是默认的 1.0。
- 需要升级的路径被某条 `location` 规则漏掉了。隧道是 `/ws/daemon` 与 `/ws/client`；而 DSH 自己的多路复用 `/api/remote.mux` 是经改写后的同源请求进入隧道的（ADR-0005），因此**任何路径都不应被拒绝升级**。
- 代理缓冲把升级响应吃掉，或某一跳设备（CDN、WAF）不支持协议升级。

**如何确认**

```bash
curl -i -N \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "https://relay.example.com/ws/client?room=ROOM_ID"
```

期望看到 `HTTP/1.1 101 Switching Protocols`。返回 400/401/404、或请求一直挂着不返回，都说明升级或路由没打通（M0 之后中继的 ingress 才会真正应答）。同时看 nginx 的 `error.log`，并确认 `proxy_http_version 1.1` 是否显式写出来了（M0 前 `/ws/client` 尚不存在，可用 `/` 先验证代理是否放行升级）。

**如何修复**：按 [`self-hosting.md`](./self-hosting.md) 的「反向代理」一节逐条对齐：`map $http_upgrade $connection_upgrade`、两个 `proxy_set_header`、`proxy_http_version 1.1`、整站代理（避免漏路径）、`proxy_buffering off`。Caddy 会自动处理升级，但要注意配置重载会强制关闭 WebSocket，用 `stream_close_delay` 缓解。

## 3. 长时间任务中途断线（反向代理空闲超时）

**症状**：回合进行到一半连接消失，界面回到"计算机离线"或重连中；但 daemon 那台机器上 DSH 仍在正常服务、任务其实还在继续。短任务一切正常，只有长任务或长时间等待（例如等人工批准）才出问题。

**可能原因**：反向代理的空闲超时。`proxy_read_timeout` / `proxy_send_timeout` 的语义是"两次读/写之间的最长等待"，nginx 默认 60 秒。一条安静等待中的隧道会被代理当成死连接掐掉。Caddy 的 `http` transport 默认没有空闲超时，但 `stream_timeout`、或 Caddy 前面的 CDN（例如 100 秒的 Cloudflare 空闲限制）会扮演同样的角色。

保活已经实现（M4），而且是 **WebSocket 层的 ping，不是协议里的 `Ping` 帧**（[`../protocol.md`](../protocol.md) § 3 解释了为什么）：中继对每个已 park 的对端、daemon 对自己的 carrier 各自定期发一个空 payload 的 ping，默认间隔 30 秒，代理的空闲计时器因此被复位——所以 60 秒这种常见默认值通常不再出问题。间隔用 `DSH_RELAY_KEEPALIVE_SECS`（中继侧）与 `DSHD_KEEPALIVE_SECS`（daemon 侧）按秒调整，`0` 关闭，两端互相独立。

但不要把保活当成本地事实：**短于保活间隔的超时仍然会掐断隧道**（例如某一层 CDN 只给 10 秒），而且整条链上任何一跳都可能比它更短。所以放宽超时依然是行为可预期的做法；保活让"忘了改默认值"不再必然出事，daemon 的节拍检测则负责在真的出事时说出原因。

**如何确认**

- 断线时刻与"最后一次有字节流动"的时间差是不是一个固定值（默认配置下约 60 秒）。
- nginx 错误日志里找 `upstream timed out (110: Connection timed out)`。
- 在代理上临时把超时调大，若断线时间随之推后，即可确认。

**如何修复**：把 `proxy_read_timeout` 与 `proxy_send_timeout` 都设成 `3600s` 起步；Caddy 侧对应 `transport http { read_timeout 1h write_timeout 1h }`，并确认 `stream_timeout` 不小于一次最长任务。取值与理由见 [`self-hosting.md`](./self-hosting.md) 的「超时陷阱」一节——**两处必须保持一致**。注意"整条链"：只放宽 nginx 而漏了前面的 CDN 是无效的。重连后 daemon 会用 `Status` 重新上报真实状态，不会因此丢失本机会话。

## 3.5 客户端说「no daemon is serving this room」

**症状**：配对或连接时中继回答 `no daemon is serving this room`。

**可能原因（按概率排序）**

1. **daemon 没在跑，或它连的不是同一个中继**。看 daemon 日志里 `relay:` 那几行。
2. **daemon 与设备用的不是同一把房间密钥**。这条以前很常见（两个命令各要一次 `--room-key`，给错一次就
   是这个现象），现在默认不可能了：两边都按 `$DSHD_STATE_DIR/room-key` 走（ADR-0013）。只有当你在
   某个命令上显式传了 `--room-key` 时才会不一致——启动横幅会直接打印一条 `NOTE`，说明命令行那把与
   文件里的不同、且文件没被改动。把两边的密钥对齐（或去掉 `--room-key`）即可。
3. **配对时的会合房间错了**：`drdshd pair` 打印的 `room:` 是**会合房间**（由配对码派生），不是服务房间；
   两个值不同是正常的。

## 4. 远程显示「计算机离线」但本机 DSH 正常

**症状**：PWA 顶部显示离线或不可达；在本机浏览器打开 `127.0.0.1:3080` 一切正常。

**可能原因（按概率排序）**

1. `drdshd` 根本没在运行，或已经崩溃、没有被 systemd 拉起来。
2. daemon 在跑但连不上中继：DNS、TLS 证书、代理路径或防火墙。
3. 中继明确拒绝了这台 daemon：device 被撤销、room 不存在或已轮换，或该 room 已经被另一个 daemon 占着。
4. 设备被撤销（设备管理列表里已经没有它）。
5. daemon 与中继都正常，是客户端自己离线（手机网络切换、浏览器把后台标签冻结）。

**如何确认**：daemon 的 `Status.relay` 字段就是为了把这几类原因分开而存在的（[`../architecture.md`](../architecture.md) § 3 的 `RelayHealth`），PWA 应当直接显示这四个值之一，不要只显示一个转圈：

| `RelayHealth` | 含义 | 下一步 |
| :--- | :--- | :--- |
| `connected` | 隧道已建立并完成认证 | 问题在客户端或页面侧，回到第 1、2 条 |
| `reconnecting` | 正在按退避重连 | 中继重启或网络抖动，通常会自愈；持续不恢复就当中继不可达来查 |
| `rejected` | 中继明确拒绝了这个 daemon / 设备 | room 不存在或已轮换、设备被撤销，或 room 已被占用（见下） |
| `unreachable` | 连不上中继 | DNS、TLS、代理、防火墙 |

其他确认手段：`systemctl status drdshd` 与 `journalctl -u drdshd -f`；中继日志里该 room 是否有停靠记录，以及 `/healthz` 的 room 数（M0 起）；在 daemon 机器上直接 `curl -i https://relay.example.com/healthz`（证书错误会在这里暴露）；设备列表里这台设备是否还在。握手阶段的拒绝原因码是刻意粗粒度的：`unknown_room`、`device_revoked`、`too_many_devices`、`rate_limited`（[`../protocol.md`](../protocol.md) § 6.4）。

有一个容易误判的情况：**同一个 room 只允许一个 daemon**。daemon 被 `kill -9` 之后，中继可能还认为旧连接占着 room，此时新起来的 daemon 会被明确拒绝（日志里是 `room <id> already has a daemon`），表现就是"服务明明起来了，但远程一直显示离线"。旧连接的回收策略由 M0 的 ingress 确定；在它落地前，重启中继是清掉占位连接的办法。

**如何修复**：按上面的表分开处理——进程没起就修 systemd 单元或启动命令；`unreachable` 修网络与证书；`rejected` 先确认是不是被撤销的设备或占位的 room，必要时重新配对该设备。设备注册表在 daemon 上，中继换掉不会丢它（[`../architecture.md`](../architecture.md) § 4 列出了每种故障的 daemon 行为与远端表现）。

## 5. 配对码无效或已过期

**症状**：在手机上输入配对码后提示无效或已过期。

**可能原因**

1. 超过有效期：300 秒（`PAIRING_CODE_TTL_SECS`），拒绝原因是 `expired`。
2. 已经被用过。配对码是单次使用的，而且**失败也会被烧掉**（拒绝原因是 `consumed`；[`../protocol.md`](../protocol.md) § 6.2、[`../security.md`](../security.md) § 3）。
3. 短时间尝试过多，被速率限制（`rate_limited`）。这是防在线穷举的主要手段之一。
4. 字符看错了。显示用的字母表是 Crockford 风格 base32，且不含 `I`、`L`、`O`、`U`（`crates/dr-dsh-crypto/src/lib.rs` 的 `pairing_display`）——码里**不可能**出现这四个字母，把它们"脑补"进去一定失败。分组用的 `-` 只是显示，不参与密钥派生。
5. daemon 压根没生成过码：`drdshd pair` 需要 `--relay`（漏掉会报 `pairing needs --relay`）；房间密钥不需要你给——它默认读 `$DSHD_STATE_DIR/room-key`，不存在就生成一把（ADR-0013）。另外近期失败次数达到上限时它会**在生成码之前**拒绝（`too many pairing attempts; wait Ns`），状态在 `$DSHD_STATE_DIR/pairing-throttle.json`。
6. 时钟偏差：配对码的有效期由 daemon 侧计时，但涉及 Unix 毫秒时间戳的环节（例如 bootstrap 的 `expires_at_ms`）会受设备时钟影响；手机时间偏差过大时会看到"刚生成就过期"。

**如何确认**：看 daemon 侧是否打印过码、距今多久；确认这个码是否已经被尝试过（失败也算用过）；逐字符核对，特别是一次都没出现过的 `I/L/O/U`；检查是否在短时间内反复尝试过；用 `date` 对比手机与 daemon 机器的时间。

**如何修复**：重新生成一个码（`drdshd pair`），并且一次配对只用一个码——失败就重新生成，不要反复重试同一个。核对字符集，不要做字母替换。手机开启自动对时。等一会儿再试，让速率限制窗口过去。

## 6. 远程端看到「已附加（attach）模式」，无法启动/停止

**症状**：状态显示 `attached`；启动 / 停止 / 重启按钮不可用，或操作返回拒绝。

**可能原因**：DSH 是你自己手工启动的，daemon 只是代理它（`DshMode::Attached`，状态里是 `LifecycleState::Attached`）。daemon 不知道手工启动时用了哪些参数，因此无法诚实地承诺"用同样的方式重启"，于是拒绝所有生命周期命令（`crates/dr-dsh-daemon/src/config.rs` 的 `DshMode::Attached`；[`../integration/dsh-surface.md`](../integration/dsh-surface.md) § 5）。配置里还有 `allow_lifecycle` 这个开关，关掉时同样会拒绝。

**如何确认**：`drdshd doctor` 的回环端口检查会给出 `warn`，文本是 `loopback 127.0.0.1:3080 is already in use: a DSH instance may already be running (the daemon will attach to it in proxy-only mode), or another program holds the port`；本机上能看到那个 DSH 进程占着端口；daemon 上报的状态里 `owned` 为 `false`。

**如何修复**：想让远程能启停，就停掉手工启动的实例，让 daemon 以 `dsh web --no-open --port <p>` 自己托管（managed 模式）。或者接受 attach 模式——远程仍然可以完整使用会话，只是不能控制进程生命周期。**没有任何"收养"一个已运行进程的路径**，因为 daemon 无从得知它是怎么被启动的；上游也还没有提供附着模式的官方接口。

## 7. 远程界面里部分设置项灰掉或无法保存

**症状**：设置面板里某些项只读，或改了当时生效、刷新后回到原值。

**可能原因**：这是 DSH 自己的既有设计，不是 dr.dsh 的缺陷，也不是要修的 bug。DSH 的客户端把"页面是否来自本机"算成一个布尔值 `ctx.remote.$host.isLoopback`，而它的取值来自页面自身的 hostname（DSH 源码 `packages/client/connection/src/client/index.ts`）。设置面板据此选择持久化方式：`const persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'`（DSH 源码 `packages/client/ui-settings/src/client/index.ts`）；需要宿主写盘的设置文档控制器也只在本机页面下注册（`packages/client/ui-settings-general/src/client/index.ts`）。

远程访问时页面来自中继的 origin，hostname 不可能是回环地址，所以持久化退化成内存：设置在当前页面会话内有效，刷新即丢。这条限制在 [`../security.md`](../security.md) § 5.5、[`../decisions/0003-no-fork-integration.md`](../decisions/0003-no-fork-integration.md) 与 [`../decisions/0005-pwa-and-service-worker.md`](../decisions/0005-pwa-and-service-worker.md) 中都被显式记录为已知且接受的代价。

这里有一个常见误解值得写清楚：DSH 的 `dsh web --trusted-host <authority>` 放宽的是 `/api` 的 Host 信任围栏（让请求不被 401 拒绝），它**不会**改变页面是否被判定为本机，因此不会恢复设置持久化。两件事互不相干，而且 ADR-0003 已经否决了用 `--trusted-host` 来适配隧道的做法。

**如何确认**：在远程页面的控制台执行 `location.hostname`，它不是 `127.0.0.1`、`localhost` 或 `[::1]`；把同一个设置拿到 daemon 那台机器的 `127.0.0.1:3080` 页面上改，可以正常保存。

**如何修复 / 可行的替代**

- 需要长期生效的设置，在 daemon 那台机器的本机页面上改一次，它会写进宿主的设置文档；远程只读并不影响使用。
- 或者直接编辑 daemon 机器上 DSH 的设置文档（在 `$DSH_HOME` 下，默认 `~/.dsh`），然后重启或重载 DSH。
- 我们已知并接受这个行为。绕过它意味着向 DSH 谎报页面来源，从而破坏 DSH 自己的安全判定；我们不会那么做，也不会为了"设置能存"而伪造 loopback。

## 8. `drdshd doctor` 的每类输出分别意味着什么

用法：`drdshd doctor [--dsh <path>] [--port <port>]`。它从不启动 DSH、从不写配置，DSH 正在服务时也可以安全运行。骨架里现在只有三项检查，每一项都是"一行、可 grep、失败时点名修法"。

**三个级别**

| 标记 | 含义 | 退出码 |
| :--- | :--- | :--- |
| `ok  ` | 通过 | 0 |
| `warn` | 需要人看一眼，但不阻塞启动 | 0 |
| `FAIL` | 必须先修 | 1 |

结尾的摘要也是三选一：`All checks passed. \`drdshd run\` should be able to start DSH.` / `Checks passed with warnings. Review them before pairing a device.` / `At least one check failed; fix it before running the daemon.`

**逐项解读**

| 输出 | 含义 | 你要做什么 |
| :--- | :--- | :--- |
| `[ok  ] platform <os> <arch> (<family>)` | 纯信息，永远通过；目的是让 bug 报告自带平台信息 | 贴 issue 时保留这一行 |
| `[ok  ] loopback 127.0.0.1:3080 is free; the daemon can own DSH's port` | 端口空闲，daemon 可以托管 DSH | 无需操作 |
| `[warn] loopback 127.0.0.1:3080 is already in use: ...` | 端口被占。**最常见的原因是 DSH 已经在跑**，也就是 attach 模式；也可能只是别的程序占了这个端口 | 如果这就是你手工启动的 DSH，见第 6 条；否则换一个端口再查 |
| `[FAIL] cannot bind loopback 127.0.0.1:3080: <error>` | 不是"被占用"，而是根本无法绑定（权限、地址不可用等） | 按错误文本修；这类问题必须处理 |
| `[ok  ] found dsh (<version>)` | DSH 可执行文件存在且 `--version` 正常返回 | 无需操作 |
| `[warn] dsh answered --version with exit code <code>; check the installation` | 能执行但退出码非零，安装可能不完整 | 重装 DSH，或确认 `--dsh` 指对了文件 |
| `[FAIL] cannot run dsh: <error>; install DSH (npx @deepseek-ai/dsh) or pass --dsh <path>` | 找不到或跑不起来 DSH | 安装 DSH，或用 `--dsh` 指定绝对路径 |

**两个容易误读的点**

- 端口被占**不是**错误。它最常见的含义是好消息：DSH 正在运行，daemon 会以仅代理的方式接入。
- `doctor` 全绿**不代表**远程可用。它不检查网络、不检查中继可达性、不检查反向代理，也还不检查 DSH 的就绪行契约——就绪行是 daemon 与 DSH 之间唯一的非正式契约，[`../integration/dsh-surface.md`](../integration/dsh-surface.md) § 2 把它列为 `doctor` 应当能单独验证的一环，该检查尚未实现。远程侧的问题要看 `RelayHealth`（第 4 条）。

## 9. 旧 CPU / 缺少指令集导致二进制无法启动

**症状**：`drdshd` 或 `drdsh-relay` 一运行就立刻退出，报 `Illegal instruction (core dumped)`；或者内核日志里出现 `invalid opcode`；或者动态链接器报 `GLIBC_2.xx not found`。老 NAS、老 ARM 板子上尤其常见。

**可能原因**：你拿到的预编译二进制是用更高的 CPU 目标构建的（例如要求 AVX2），或者它链接的 glibc 比目标机器上的新。旧 CPU 的替代安装路径是 **M5** 的交付项（[`../product/mvp.md`](../product/mvp.md) § 一与 § 五），当前 Release 提供 x86_64 musl；排查时核对目标与 SHA256SUMS，见[发布说明](releases.md)。

**如何确认**

```bash
file ./drdshd
ldd ./drdshd || true
ldd --version | head -1
dmesg | tail -20            # 找 invalid opcode / general protection fault
journalctl -k | tail -20    # systemd 机器上等价的写法
```

看到 `invalid opcode` 或 `Illegal instruction` 就是指令集问题；看到 `GLIBC_2.xx not found` 是 C 运行库版本问题。

**如何修复（替代安装思路）**

1. **在那台机器上自己构建。** 工具链的默认 CPU 基线最保守：
   ```bash
   cargo build --release --locked -p dr-dsh-daemon
   ```
   仓库里没有 `.cargo/config.toml`，也没有任何 `target-cpu` 或 `RUSTFLAGS` 设置，所以从源码 `cargo build --release` 得到的就是工具链默认基线。也就是说：SIGILL 只可能来自别处拿到的预编译二进制，而不是这套构建配置。
2. **老 glibc 用 musl 静态目标。** `rust-toolchain.toml` 已经把 `aarch64-unknown-linux-musl` 声明为"旧 CPU / NAS 回退"（roadmap M5）。x86_64 的 musl 目标目前不在那份列表里，需要你自己 `rustup target add x86_64-unknown-linux-musl` 再加 `--target`。
3. **32 位 ARM** 同理：`armv7-unknown-linux-gnueabihf` 已在目标列表里。
4. **不需要 C 交叉工具链。** 加密栈选的是纯 Rust 的 RustCrypto 实现（`crates/dr-dsh-crypto/Cargo.toml`），这正是为了让它能在没有 C 工具链的目标上构建。
5. **把中继挪走。** 中继只是个密文转发器，可以让它跑在一台新机器或小 VPS 上，daemon 留在老机器上——必须在本机跑的只有 daemon（[`self-hosting.md`](./self-hosting.md)）。如果两者都必须留在老机器上，那就两个二进制都得能在该机器上启动。

补充一点：如果连 DSH 本身（Node 运行时）在那台机器上跑不起来，`drdshd doctor` 的第三项会先失败；那属于运行时兼容问题，不是 dr.dsh 能修的范围。

## 10. 隐私模式或旧浏览器里页面行为异常

**症状**：页面能打开但请求没有经过隧道、控制台报 Service Worker 注册失败，或在隐私窗口里 401。

**可能原因**：Service Worker 是浏览器特性，在部分隐私模式或旧浏览器上不可用。ADR-0005 把这一条列为已知代价，并要求降级为**明确的错误提示**而不是静默失败。

**如何确认**：DevTools → Application → Service Workers 面板为空或显示注册失败；控制台有 `SecurityError` / `NotSupportedError`；同一个 URL 在普通窗口里正常。

**如何修复**：换用普通窗口或受支持的浏览器。如果失败时页面没有给出可读提示，那是一个应当上报的缺陷——失败透明是产品要求（[`../product/mvp.md`](../product/mvp.md) § 一第 6 条）。

## 11. 新设备无法配对、提示房间已满

**症状**：已有若干设备配对成功后，新设备配对失败；中继日志出现 `room <id> already holds 16 clients`，或配对被拒绝。

**可能原因**：一个 room 最多允许 `MAX_DEVICES_PER_ROOM` = 16 个客户端（[`../protocol.md`](../protocol.md) § 4）。达到上限后，中继会拒绝新的客户端停靠，握手侧的原因码是 `too_many_devices`。

**如何确认**：数一下设备管理界面里的设备数；看中继日志里是否有该 room 的拒绝记录；`/healthz` 的 room 数正常但某个 room 无法再进新设备。

**如何修复**：撤销不再使用的设备（设备注册表在 daemon 上，撤销即时生效，[`../security.md`](../security.md) § 5.3），然后再配对。如果确实需要更多设备，那是一个产品决策而不是配置项：上限写在协议常量里，改它需要按 [`../protocol.md`](../protocol.md) § 8 走版本流程。

## 12. daemon 报「DSH 已启动但未打印就绪行」

**症状**：daemon 启动后超时失败，状态是 `failed`，错误信息指向"没有观察到就绪行"，并提示检查 `printUrl`；本机上 `dsh web` 其实跑起来了。

**可能原因**：`dsh web` 的就绪行是 daemon 取得端口与进程令牌的唯一来源，而它由 `printUrl`（或浏览器交接）触发。如果用户在自己的 profile 里把 `web-app` 那一行的 `printUrl` 关掉，这一行就不会出现；另一种原因是 DSH 版本变更导致行的格式变了（前缀、`?token=`、LAN 追加部分的空格分隔）。这是本项目唯一依赖的非版本化上游契约（[`../integration/dsh-surface.md`](../integration/dsh-surface.md) § 2）。

**如何确认**：手工执行 `dsh web --no-open --port 3080`，看 stdout 是否出现形如 `dsh web: http://127.0.0.1:3080/?token=…` 的行；检查用户 profile 里 `web-app` 行的 `printUrl` 配置；把看到的实际那一行与集成文档 § 2 记录的格式对照。

**如何修复**：把 `printUrl` 恢复（绕过它意味着去改用户的 DSH 配置，这不是本项目会做的事）。如果确实是上游格式变化，走 [`../integration/dsh-surface.md`](../integration/dsh-surface.md) § 7 的升级仪式、更新解析逻辑与该文档的核对基准，并在 PR 描述里写出实际观察到的行。

## 远端偶尔连上了却没有任何响应

**症状**：远端显示已连接（隧道建立成功），但请求一直没有回应；daemon 日志里没有对应的错误。

**原因**：**同一把房间密钥配了不止一个 daemon**。中继的房间只能有一个 daemon 服务，
后注册的会顶替先注册的，被顶替的那个会立刻重新注册——两个 daemon 于是轮流持有房间，
而客户端偶尔会接到一个正在被接替的连接上：握手在旧连接上完成，后续请求却没人处理。

**确认**：

```sh
# 同一台机器上数一数
pgrep -af 'drdshd run'
# 或者看中继日志，出现下面这行就说明有两个 daemon 在抢同一个房间
grep 'a daemon re-registered' <中继日志>
```

**修复**：只保留一个 daemon，或给它们**不同的房间密钥**。
房间密钥相同就意味着同一个房间，而一个房间只服务一个 daemon。

**代价**（如果放着不管）：两个 daemon 互相顶替会稳定产生约每秒 3 次重注册请求，
退避最终停到 30 秒上限。它不会损坏数据，但会持续消耗中继，并且如上所述偶尔让客户端拿到一次坏连接。

## 相关文档

- [`self-hosting.md`](./self-hosting.md) —— 部署、反向代理与超时取值、健康检查、容量与备份
- [`../security.md`](../security.md) —— 威胁模型与"不保证什么"（§ 5.5 是第 7 条的规范依据）
- [`../architecture.md`](../architecture.md) —— 组件、数据流、失败与恢复
- [`../protocol.md`](../protocol.md) —— 端点、握手、拒绝原因与常量
- [`../integration/dsh-surface.md`](../integration/dsh-surface.md) —— 所依赖的确切 DSH 接口面，以及每一条失效时的表现
