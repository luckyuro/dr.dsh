# Wire 协议规范

本文是 dr.dsh 两端（Rust daemon/relay 与 TypeScript 客户端）之间协议的**规范性描述**。规范来源是 `crates/dr-dsh-proto`；`packages/protocol` 是镜像；两者的分歧由共享向量文件 `packages/protocol/conformance/vectors.json` 在 CI 中强制暴露（ADR-0004）。

符号约定：`u16`/`u32`/`u64` 为无符号整数，**大端**编码。`b64u(x)` 表示 `x` 的无填充 base64url 文本。

---

## 1. 分层

```
┌──────────────────────────────────────────────────────────┐
│ Payload 平面：控制消息（JSON）+ 被代理的 DSH 流量（字节）  │  ← 端到端加密
│   仅端点可见；中继不链接解析它的代码                        │
├──────────────────────────────────────────────────────────┤
│ Carrier 平面：18 字节帧头 + 不透明 payload                 │  ← 明文（路由元数据）
│   中继解析这一层，用 stream_id 完成路由                     │
├──────────────────────────────────────────────────────────┤
│ 传输：WSS（TLS 1.2+）                                      │
└──────────────────────────────────────────────────────────┘
```

---

## 2. 帧格式

固定 18 字节帧头，随后是 `payload_len` 字节 payload：

```
 偏移  长度  字段          说明
 0     2     magic         固定 `DR`（0x44 0x52）
 2     2     ver_major     协议主版本；不等则拒绝连接
 4     2     ver_minor     协议次版本；可向下兼容
 6     2     frame_type    见 § 3
 8     2     flags         类型相关标志；未定义时为 0
 10    4     stream_id     流标识；0 为连接控制流
 14    4     payload_len   payload 字节数，上限 65536
```

**约束**：

- `payload_len > 65536` 时，**仅根据帧头即拒绝**（发送 `GoAway` 并关闭连接），不得先分配内存。两端都按此实现，并有拒绝向量覆盖。
- 收到不足一个完整帧的缓冲区时，返回"不完整"（读更多再试），不是错误。
- 未赋值的 `frame_type`、错误的 magic、主版本不等，都是协议错误 → `GoAway` + 关闭。

### 2.1 规范示例

| 名称 | 字节 |
| :--- | :--- |
| 控制流上的空 ping | `445200000001003000000000000000000000` |
| 客户端流 1 上的 fin | `445200000001001100000000000100000000` |
| 流 3 上携带 `c0ffee` 的 data | `445200000001001000000000000300000003c0ffee` |
| 流 5 上授予 1 KiB 窗口 | `44520000000100200000000000050000000400000400` |

这些向量（以及拒绝向量）在 `packages/protocol/conformance/vectors.json` 中，两端都必须逐字节通过。

---

## 3. 帧类型

| 值 | 名称 | 语义 |
| :--- | :--- | :--- |
| `0x0001` | `Open` | 打开一条流；payload 承载发起方的绑定信息（房间、设备、目标端点） |
| `0x0002` | `OpenAck` | 接受该流 |
| `0x0003` | `OpenReject` | 拒绝该流；payload 为原因码 |
| `0x0010` | `Data` | 流上的应用字节（端到端密文） |
| `0x0011` | `Fin` | 半关闭：该发送方在此流上不再发送数据 |
| `0x0012` | `Reset` | 中止该流；payload 为原因码 |
| `0x0020` | `WindowUpdate` | 允许对端在该流上多发送 N 字节 |
| `0x0030` | `Ping` | 存活探测 |
| `0x0031` | `Pong` | `Ping` 的应答 |
| `0x007f` | `GoAway` | 连接级错误；发送后必须关闭连接 |

**关于 `Ping` / `Pong`（`0x0030` / `0x0031`）：这两个帧类型已定义但无人发送，保活走的是 WebSocket 层的 ping。** 这不是遗漏，而是刻意的选择：carrier 是一条长期空闲的连接，而维护它的是路径上的代理，所以保活必须是**代理看得见的字节**。WebSocket 控制帧恰好满足这个条件——它由对端 WebSocket 实现自动应答，不需要任何一端跑我们的代码，中继也一如既往地不需要解析 payload（[`decisions/0002-zero-knowledge-relay.md`](./decisions/0002-zero-knowledge-relay.md)）。协议层的 `Ping` 反而要求两端都实现一套帧语义才能起到同样作用。两侧的发文间隔分别由 `DSH_RELAY_KEEPALIVE_SECS` 与 `DSHD_KEEPALIVE_SECS` 控制，默认 30 秒，`0` 关闭；实测见 [`operations/self-hosting.md`](./operations/self-hosting.md) 的「保活」一节。保留 `0x0030` / `0x0031` 的值是为了不在将来把这两个数字分配给别的语义。

---

## 4. 流与复用

一条 carrier 连接承载一个 daemon 与它的全部已配对客户端。流是最小的复用单位。

| 常量 | 值 | 说明 |
| :--- | :--- | :--- |
| `CONTROL_STREAM_ID` | 0 | 连接级控制（握手、ping） |
| `FIRST_CLIENT_STREAM_ID` | 1 | 客户端发起的流（奇数） |
| `FIRST_DAEMON_STREAM_ID` | 2 | daemon 发起的流（偶数，用于事件推送） |
| `INITIAL_WINDOW` | 262144 | 每条流的初始发送窗口（字节） |
| `MAX_WINDOW` | 16777216 | 允许通告的最大窗口 |
| `MAX_CONCURRENT_STREAMS` | 64 | 单连接并发流上限 |
| `MAX_DEVICES_PER_ROOM` | 16 | 单房间设备上限 |
| `MAX_PAYLOAD_LEN` | 65536 | 单帧 payload 上限 |

**流状态机**：`Opening → Open → HalfClosedLocal / HalfClosedRemote → Closed`。

**复用策略**：大响应必须被切成 ≤ `MAX_PAYLOAD_LEN` 的帧，并按窗口交错发送，避免一条大传输饿死交互流量。窗口耗尽时发送方必须等待 `WindowUpdate`，不得超窗发送（超窗是协议错误）。

**为什么用计数器而不是随机 nonce**：两端都预期同一个 nonce 序列，因此重排、重复、跳号都能被检测为协议错误——这很重要，因为中继不受信任去保序（`crates/dr-dsh-crypto/src/session.rs`）。

---

## 5. 端点的发现与注册

### 5.1 中继面

| 端点 | 方向 | 用途 |
| :--- | :--- | :--- |
| `GET /healthz` | 任意 | 存活探针；返回版本与房间数（不含任何房间标识） |
| `GET /ws/daemon` | daemon → 中继 | 注册房间并接收该房间的全部客户端流量 |
| `GET /ws/client` | 客户端 → 中继 | 加入房间；中继把它与房间内 daemon 的流对接 |
| `GET /` | 浏览器 | 静态应用壳（无用户数据、可缓存、带 CSP；M0 阶段只是一个说明页） |

**握手（两个 socket 端点的第一帧，文本 JSON）**：

```json
{ "role": "daemon" | "client", "room": "<b64u>", "proto": [<major>, <minor>] }
```

中继回答 `{"type":"ready"}` 或 `{"type":"reject","reason":"<固定短语>"}`。此后**全部**消息都是二进制 carrier 帧。

三条规则值得写进规范，因为它们都是安全属性而不是风格选择：

1. **房间 id 只在握手消息里，不在查询串里。** 查询串会进访问日志，而房间 id 是路由句柄；放在握手里让它不出现在运维能看到的地方。
2. **role 必须与端点一致。** 连到 `/ws/daemon` 却声明 `client` 会被拒绝；否则对端就能自行决定中继如何路由它，甚至可以顶掉一个房间真正的 daemon。
3. **拒绝原因是固定短语集合**，不包含房间 id、设备 id 或任何由对端提供的字符串。当前取值：`no daemon is serving this room`、`relay is at capacity`、`another daemon is serving this room`、`room holds too many clients`、`handshake is not valid JSON`、`the announced role does not match this endpoint`、`incompatible wire major version`、`handshake timed out`。

**中继对每一帧只做三件事**：校验它是合法 carrier 帧（magic、major 版本、帧类型已知、声明长度不超过上限、且实际长度与声明一致），按房间投递给对端，然后什么都不留。任何一项不通过就断开该连接，而不是转发——把畸形帧交给对端解析，等于让中继的正确性依赖对端的健壮性。

**房间 id** 是 128 位随机数（`b64u`）。它是**路由句柄而非凭据**：知道它只能让你敲到门，进门需要完成端到端握手（配对码或已登记设备密钥）。房间在 daemon 重新注册时轮换。

### 5.2 本地面（daemon）

| 端点 | 监听 | 用途 |
| :--- | :--- | :--- |
| `POST /report` | 仅回环 | DSH 插件上报事件（见 § 7） |
| `GET /healthz` | 仅回环 | 本地健康检查 |
| `GET /status` | 仅回环 | 本地状态查询（`drdshd` CLI 使用） |

本地面需要本地令牌，只接受固定几种请求，**不接受**任何会转发到 DSH 的任意请求（`docs/security.md` § 5.6）。

---

## 6. 握手与握手消息

握手在**控制流（stream 0）**上进行，使用加密前的小型 JSON 信封：

```json
{ "type": "<消息类型>", "id": <u32>, "args": { ... } }
```

`id` 用于把应答与请求配对；`args` 是消息类型相关的字段。

### 6.1 `hello` → `hello_ack`

```json
// 客户端 → daemon
{ "type": "hello", "id": 1,
  "args": { "major": 0, "minor": 1, "role": "client", "room": "<b64u>", "device_id": "<b64u|absent>" } }

// daemon → 客户端
{ "type": "hello_ack", "id": 1,
  "args": { "major": 0, "minor": 1, "daemon_version": "0.0.0", "paired": true } }
```

主版本不等时，daemon 应答 `{"type":"reject","args":{"reason":"version_mismatch"}}` 并关闭。

### 6.2 首次配对：SPAKE2 与登记回执

配对房间上的四条消息。前两条是**裸 SPAKE2 消息**（各 33 字节：一个侧别字节 + 一个压缩点），
后两条是 JSON 信封——它们不是会话控制面，因为此时还不存在会话：

```text
daemon → 客户端   <33 字节：0x42 || 压缩点 Y>
客户端 → daemon   <33 字节：0x41 || 压缩点 X>
客户端 → daemon   { "device_name": "李明的 iPhone",
                    "device_public_key": [.. 32 个整数 ..],
                    "confirm": [.. 32 个整数 ..] }
daemon → 客户端   { "type": "pair_accept", "device_id": "<b64u>",
                    "root_key": "<b64u: 密封的房间密钥>", "room": "<b64u>" }
任一端            { "type": "pair_reject", "reason": "pairing_failed" | "malformed" }
```

规则：

- 配对码**单次使用**：无论成功或失败，码在 SPAKE2 之前就被烧掉。
- 配对码 TTL 为 300 秒；过期后再用不会复活。
- daemon 对配对尝试做速率限制，并记录审计事件（`docs/security.md` § 3.1）。
- 配对码从不传输，也不参与任何可离线穷举的运算（`docs/security.md` § 2.2）。
- `device_public_key` 与 `confirm` 是 **JSON 数字数组**，不是 base64 字符串：Rust 侧它们是
  `Vec<u8>`，而 `serde_json` 把 `Vec<u8>` 写成序列。写成字符串的对端会得到
  `the peer's pair_finish message was not usable`，而那句话不会指出是哪个字段。

**回执里的房间密钥**（M1 修正，两条都值得记）：

1. 它是 **daemon 实际服务的那个房间密钥**，不是由 PAKE 派生的密钥。曾经发的是后者，于是
   **每一个刚配好的设备都拿着一把没人服务的房间钥匙**：daemon 按自己的 `--room-key` 停靠，
   而设备按 PAKE 派生的密钥推导房间，客户端得到的只有 `no daemon is serving this room`。
   现在 `drdshd pair` 必须显式给出 `--room-key`，与 `drdshd run` 用的是同一个值——配对的意义正是
   **把这把钥匙交到设备手里**。
2. 它**密封在 PAKE 派生的登记密钥之下**：`nonce(12) || AES-256-GCM 密文+tag`，AAD 为
   `"dsh-remote/v1/enrolment-seal" || 设备公钥`。配对房间的传输根是一个**公开常量**
   （§ 6.2.3），因此明文发送等于把 daemon 的长寿命密钥交给中继。AAD 绑定设备公钥，则一份
   回执不能被挪到另一次配对登记的身份上。

验收这一条的证据是 `crates/dr-dsh-daemon/tests/pairing.rs` 的
`the_relay_cannot_read_the_room_key_out_of_the_receipt`：它用一个只持有公开值的客户端读取
daemon 发出的每一帧，断言房间密钥（原文与 base64）都不在其中，并且验证过的设备仍然能打开
回执拿到它。把实现改回"明文发送"时该测试会红（验证过）。

### 6.2.1 会话盐（salt）交换

握手完成后、任何内容帧之前，**由客户端发起**一次盐交换：客户端生成 32 字节随机盐，用它派生真正的会话密钥，并把盐**用临时密钥（全零盐派生的会话）密封**后作为控制流（stream 0）上的第一个帧发出。daemon 用同一套临时密钥打开它，然后派生同一个会话，并在派生完成后回一帧密封的 `k`（`SESSION_ACK`）——**那是握手的最后一帧**。

两条规则都是踩过坑才定下来的：

1. **盐必须由客户端发。** daemon 先停靠房间然后等待，可能等很久；由 daemon 发出的盐只会被"那一刻已停靠"的客户端收到，之后到达的客户端永远等不到那一帧——表现就是一个卡住的握手。谁第二个说话谁一定有听众，所以客户端说第二句。
2. **盐帧必须用临时密钥密封，不能用它派生出的新密钥。** 对端此时还没有盐，不可能持有由它派生的密钥；用新密钥密封会在对端表现为一个纯粹的认证失败，没有任何线索指向"哪一端派生了什么"。

临时密钥只用于这一帧：它证明双方都知道 root key，此外没有别的用途，也不承载任何内容。

**客户端不再回一帧 `k`（M2 修正）。** 这里曾经写着"握手是三次发言"，并且浏览器客户端确实会在盐之后补发一个字节 `k`。那个字节**没有任何一端在读**：daemon 的握手在自己发出 `k` 之后就结束了，它接下来读的第一帧是设备挑战的应答（已登记设备）或对端的第一条协议消息（配对房间）。于是那一帧变成了别人的输入：

- 在**已登记设备**的连接上，它被当作设备挑战的应答读走，解析失败 → `bad_proof` 拒绝。也就是说，浏览器客户端**从来无法连上一个登记过设备的 daemon**——这条路径一直没有在真实栈上跑过，而四个替身 daemon 都老老实实地"先跳过一帧确认"，于是它们和客户端共享了同一个错误假设。
- 在**配对房间**上，它被当作客户端的 SPAKE2 消息读走：真实的 `drdshd pair` 报
  `the peer's pair_begin message was not usable: a SPAKE2 message is 33 bytes, got 1`。

修法是删掉那一帧，并把替身 daemon 里"跳过确认"的那一步改成**先发挑战、再读应答**，与真实 daemon 一致；`apps/pwa/src/tunnel.test.ts` 现在断言的正是"盐之后线上什么都没有"，这条性质代替了原来那条错误的断言。

**已修复的交接缺陷（M0）**：浏览器侧隧道模块连续运行时曾出现"建立成功但代理请求无应答"与"帧认证失败"。根因有两处，且都是真实缺陷：

1. **盐交换的计数器没有跨派生结转**。盐用临时会话写出（消耗计数 0），而由盐定义的会话从 0 重新开始。两端都必须**各结转一个数**，而且是不同的数：发送方结转"已写"，接收方结转"已打开"。漏掉任一侧，握手之后的每个请求都会以 `frame 0 arrived out of order; expected 1` 失败——这条消息既不指出原因，也不指出是哪一侧错了。`crates/dr-dsh-crypto` 的 `handover_tests` 直接固定了这套算术。
2. **daemon 按 stream id 而不是按消息魔数区分两个平面**。浏览器客户端把代理请求放在 stream 1 上，于是它被当作控制消息解析、解析失败、被**静默丢弃**——从等待者的角度看，这与"daemon 卡死"完全一样。现在由 `PX` 魔数决定归属。

### 6.3 重连：设备密钥挑战—应答

```json
// daemon → 客户端（在 hello 之后，当 device_id 已登记）
{ "type": "resume_challenge", "id": 4, "args": { "nonce": "<b64u: 32 bytes>" } }

// 客户端 → daemon：用设备私钥签名（Ed25519）
{ "type": "resume_response", "id": 4,
  "args": { "signature": "<b64u: Ed25519(nonce || room)>" } }

// daemon → 客户端
{ "type": "resume_accept", "id": 4,
  "args": { "session_salt": "<b64u: 32 bytes>" } }
```

会话密钥派生（两端一致）：

```
shared      = X25519(ephemeral_private, peer_ephemeral_public)      // 每次连接新生成
c2d         = HKDF-SHA256(ikm = shared || resume_secret, salt = session_salt,
                          info = "dsh-remote/v1/session/c2d", len = 32)
d2c         = HKDF-SHA256(ikm = shared || resume_secret, salt = session_salt,
                          info = "dsh-remote/v1/session/d2c", len = 32)
```

方向性密钥防止反射攻击。握手完成后 **所有流**的 payload 都用 AES-256-GCM 加密，AAD 为 `"dsh-remote/v1/frame" || stream_id`（大端 u32），nonce 为 4 字节零 + 该流该方向的 64 位计数器（大端）。

标签字符串集中在 `crates/dr-dsh-crypto/src/lib.rs` 的 `labels` 模块与 `packages/crypto/src/index.ts` 的 `LABELS` 中；改动任一标签等同于 wire-breaking change。

### 6.3.1 设备认证在 carrier 握手里（M1 已实现）

§ 6.3 描述的消息，实际是在**盐交换之后、会话被声明可用之前**完成的第四步握手。顺序是：

```
client → daemon   salt（临时密钥密封，§ 6.2.1）
daemon → client   SESSION_ACK（'k'）
client → daemon   SESSION_ACK 的确认（'k'）
daemon → client   resume_challenge { nonce }
client → daemon   resume_response  { device_id, signature }
daemon → client   resume_accept | resume_reject { reason }
```

全部在**控制流（stream 0）**上，会话内密封。三条规则：

- **nonce 每次连接新生成，且在会话内传输。** 中继既读不到它、也换不掉它；新鲜性让「签名」成为**这一次连接**的证明，因此一段被录下的响应在下一个 nonce 面前毫无用处。
- **签名覆盖 `nonce || room`**，不是只覆盖 nonce：一个房间上录到的响应不能挪到另一个房间重放。
- **未绑定即失败。** daemon 侧 `established` 只在验签通过后才置位——调用方看不到一个「可用但没认证」的连接；客户端侧 `Tunnel.open` 在未绑定时**抛错**，而不是交出一个自称已建立的隧道。

**策略是二选一，不混合。** `DevicePolicy::RoomKeyOnly`（登记表为空，房间密钥即凭证——未配对部署的回退路径）或 `DevicePolicy::Enrolled`（只要登记了哪怕一个设备，**每个**客户端都必须证明自己）。混用会让配对变成装饰。

**已修复的两个真实缺陷（M1 会话绑定）**：

1. **未配对的客户端拿到一个假隧道。** 客户端的设备认证步骤最初只在「持有身份」时才等待 daemon 开口，于是未配对的客户端直接跳过这一步，`Tunnel.open` 成功返回，而 daemon 其实已经拒绝了它——调用方拿到一个自称已建立、却永远不会被放行的隧道（实测表现为挂起）。现在这一步对**每个**连接都执行，由 daemon 是否开口来结算，静默期结束即视为「daemon 不要求设备」。
2. **拒绝之后客户端仍然 resolve。** daemon 的拒绝最初既没有关闭 carrier 也没有让客户端失败，两端各自等一个不会来的帧。现在 daemon 的拒绝会**具名发送并关闭 carrier**，客户端的 socket 关闭也会结算设备认证步骤，未绑定一律抛错。

### 6.4 拒绝原因

```json
{ "type": "reject", "id": 5, "args": { "reason": "device_revoked" } }
```

| 原因 | 含义 |
| :--- | :--- |
| `version_mismatch` | 主版本不等 |
| `expired` | 配对码已过期 |
| `consumed` | 配对码已被使用 |
| `unknown_room` | 房间不存在或已轮换 |
| `device_revoked` | 该设备已被 daemon 移除 |
| `too_many_devices` | 房间设备数达上限 |
| `rate_limited` | 短时间内尝试过多 |

原因码刻意保持粗粒度：细节属于本地日志，不属于对端。

---

### 6.5 生命周期控制的往返语义

`lifecycle_command`（§ 7）是**唯一**能让远端启动、停止、重启 DSH 的路径。它的语义有三条，都是踩过坑才定下来的：

- **答复必须在操作之后，不能是回执。** 第一版对 `start/stop/restart` 一律答复 `accepted: true` 并把**当时**的状态原样回显，而操作根本没有交给驱动——
  远端因此被告知「已接受停止」而 DSH 仍在运行。这比明确拒绝更糟：拒绝会让用户去查原因，虚假的成功会让他以为已经生效。
  现在被接受的操作由生命周期驱动在 spawned 任务里执行，答复带**执行之后**的状态；拒绝（attach 模式、非法 op）仍然即时内联返回，因为它不需要进程。
- **`accepted` 与 `ok` 是两件事。** `accepted: false` 是**最终拒绝**（attach 模式、不在白名单里的 op），重试永远不会成功；
  `accepted: true, ok: false` 是**尝试失败**（DSH 没起来），这才是「再试一次」有意义的情况。把两者渲染成同一句话，就是在让用户重试一件不可能成功的事。
- **操作是闭集，线上没有放参数的地方。** `op` 是 `start | stop | restart` 的枚举，请求体里没有第二个字段；daemon 也没有任何按名字执行命令的代码路径（项目定义 § 9.6）。
  客户端**也**校验一次：不是为了纵深防御，而是让「能表达出来的能力」与「类型允许的能力」完全相同。

**状态请求不排队在这个操作后面。** 状态是同步读的、内联答复的，否则用户最需要看到进度的时刻——重启过程中——恰恰看不到。

## 7. 控制消息

握手完成后，控制消息通过一条**已加密的流**传输，格式为 `control` envelope：

```json
{ "kind": "<control_kind>", "id": <u32>, "body": { ... } }
```

`body` 的形状由 `dr-dsh-proto::control` 定义（TypeScript 镜像见 `packages/protocol/src/control.ts`）。**字段名在 wire 上一律是 `snake_case`**（`local_url`、`uptime_secs`、`expires_at_ms`）：daemon 就是这么写的（serde 的默认行为），浏览器客户端也一直是这么读的（`apps/pwa/src/control.ts` 按这些键解析，再在自己的边界上重命名成 camelCase 给调用方）。多词字段名因此不许改——改一个就是 wire-breaking change，而两端用不同语言写，各自的序列化默认值对对方不可见。

**这里原先写的是「一律 `camelCase`」**，并把 TypeScript 镜像当作证据；镜像当时也确实是 camelCase。但**没有任何一端用过那套名字**：daemon 写的是 `local_url`，浏览器读的也是 `local_url`，所以那段文字描述的是一个不存在的协议。发现它是因为要新增一个控制消息（崩溃上报），去核对"新字段该叫什么"时才对上。现在 `crates/dr-dsh-proto/src/control.rs` 末尾有一组测试把每个 body 与每个 `kind` 的名字逐字钉住——分叉之所以能活下来，正是因为此前没有任何测试提到过一个多词字段。

| `kind` | 方向 | body |
| :--- | :--- | :--- |
| `status_request` | 客户端 → daemon | 空 |
| `status_response` | daemon → 客户端 | `Status` |
| `lifecycle_command` | 客户端 → daemon | `LifecycleCommand` |
| `lifecycle_result` | daemon → 客户端 | `LifecycleResult` |
| `session_bootstrap_request` | 客户端 → daemon | 空 |
| `session_bootstrap` | daemon → 客户端 | `SessionBootstrap` |
| `device_request` | 客户端 → daemon | 列出/重命名/撤销 |
| `device_list` | daemon → 客户端 | `DeviceSummary[]` |
| `notification` | daemon → 客户端 | `Notification` |
| `crash_report` | 客户端 → daemon | `CrashReport`：客户端自己这次运行的失败摘要 |
| `crash_report_result` | daemon → 客户端 | `CrashReportResult`：是否收下、现在存了几份、没收下的原因 |
| `problem` | 双向 | 可读的问题描述（展示给用户） |

**生命周期白名单**：`LifecycleOp` 只有 `start`、`stop`、`restart`。协议里**不存在**承载启动参数的字段，因此远程无法向 DSH 传递任何标志、路径或端口（`docs/security.md` § 2.3）。

**崩溃上报**（M5）是客户端 → **它自己那台 daemon** 的一跳，落点是 `$DSHD_STATE_DIR/crash-reports.jsonl`（0600），
由 `drdshd crashes` 读取、`drdshd crashes --clear` 删除。协议里没有"上传地址"这类字段：它不是一个可以被
指向别处的功能。字段清单与边界写在 `docs/security.md` § 5.10，实测见 `scripts/pwa-crash-smoke.mjs`。

### 7.0.1 代理消息（Proxy 平面）

被代理的 DSH 流量走**独立的流**，其载荷是 `PX` 魔数开头的二进制消息（版本 1）：

```text
client ─ RequestStart  ─▶ daemon   id、method、origin-form target、headers、body
daemon ─ ResponseStart ◀─ client   id、status、headers
daemon ─ ResponseBody* ◀─ client   body 分块（每块 ≤ 载体上限）
daemon ─ ResponseEnd   ◀─ client
daemon ─ Failure       ◀─ client   固定短语原因
```

WebSocket 升级（`/api/remote.mux`）在同一条流上继续：

```text
client ─ WsOpen   ─▶ daemon   id、target、headers
daemon ─ WsOpened ◀─ client   101（或 Failure）
client ─ WsData*  ─▶ daemon   客户端 → DSH 的帧
daemon ─ WsData*  ◀─ client   DSH → 客户端的帧
either ─ WsData{Close} ─▶ other
```

三条规则：

1. **target 必须是 origin-form**（以 `/` 开头，且不含 `..`、反斜杠、空白，也不以 `//` 开头）。绝对 URL 被**拒绝而不是改写**：主机由 daemon 决定，客户端说"要什么"，不说"去哪里"。
2. **`Host`、`Cookie`、`Origin`、`Referer` 由 daemon 替换**，客户端送来的同名头被丢弃（`dsh::client` 的 `is_authority_owned`）。这四个头正是 DSH 栅栏所读的。
3. **每个 codec 错误都是致命的**：长度前缀分帧没有重新同步点，猜测边界会破坏流。客户端可修复的错误（坏 target、畸形 body、DSH 不可达）通过 `Failure` 回告，**连接保持**。

### 7.1 插件上报（本地面）

DSH 插件向 daemon 的 `POST /report` 发送：

```json
{ "event": "approval_requested", "severity": "alert",
  "atMs": 1790000000000, "sessionRef": "<opaque>" }
```

允许的 `event` 值见 `dr-dsh-proto::control::NotificationEvent`。**载荷中没有承载会话正文、代码或路径的字段**（ADR-0006）。

---

## 8. 兼容性

| 变更 | 需要 |
| :--- | :--- |
| 新增帧类型、新增控制消息 `kind`、新增 `NotificationEvent` | minor 版本 +1 |
| 修改帧头布局、修改 `payload_len` 上限、修改 HKDF 标签、修改 AAD 构造、修改握手消息字段语义 | major 版本 +1，且需要 ADR |
| 修改共享向量文件中的任一向量的期望值 | 同上（因为向量是规范的一部分） |

**协商规则**：major 不等即拒绝；minor 向下兼容，且**不得发送未协商的帧类型或消息**。

---

## 9. 常量速查

| 名称 | 值 | 位置 |
| :--- | :--- | :--- |
| `WIRE_MAJOR.MINOR` | 0.1 | `crates/dr-dsh-proto/src/lib.rs` |
| `FRAME_HEADER_LEN` | 18 | 同上 |
| `MAX_PAYLOAD_LEN` | 65536 | 同上 |
| `INITIAL_WINDOW` | 262144 | 同上 |
| `MAX_WINDOW` | 16777216 | 同上 |
| `MAX_CONCURRENT_STREAMS` | 64 | 同上 |
| `MAX_DEVICES_PER_ROOM` | 16 | 同上 |
| `PAIRING_CODE_TTL_SECS` | 300 | 同上 |
| `PAIRING_CODE_ENTROPY_BITS` | 40 | 同上 |
| 中继默认监听 | `127.0.0.1:8787` | `crates/dr-dsh-relay/src/config.rs` |
| daemon 本地面 | `127.0.0.1:8790` | `plugins/dr.dsh/cordis.patch.yml` |
| DSH 默认端口 | `127.0.0.1:3080` | DSH 自身默认值 |
