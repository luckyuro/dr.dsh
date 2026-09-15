# dr.dsh 中继自托管指南

本文说明如何自己运行 `drdsh-relay`：它需要哪些配置、Docker 与 systemd 两种部署方式、反向代理必须做对的三件事、TLS 的边界在哪里、看什么指标、容量上限怎么估，以及为什么它没有任何值得备份的东西。

自托管不是省钱的选择，而是本项目安全叙事的一部分：中继提供远端页面所需的静态应用壳，因此它位于客户端的可信计算基里；由你自己的基础设施提供这个壳，中继运营者与用户就是同一个人（见 [`../security.md`](../security.md) § 5.1）。

中继已经实现 HTTP/WebSocket 路由、`/healthz` 与静态客户端服务。macOS / Linux 可以运行
`sh relay/install.sh --start` 独立构建、安装并启动中继与 PWA，随后使用 `drdsh-relayctl restart`、
`drdsh-relayctl status`、`drdsh-relayctl logs --follow`。完整入口见
[`../../relay/README.zh.md`](../../relay/README.zh.md)，旧安装迁移见 [`cli.md`](cli.md)。

## 中继是什么，不是什么

`drdsh-relay` 的完整设计只有一句话：daemon 主动拨出并在一个 room 上停靠，客户端拨入并请求同一个 room，中继把两者的帧互相拼接（`crates/dr-dsh-relay/src/main.rs` 的模块文档）。这种"贫瘠"正是它的安全论据。

| 中继是 | 中继不是 |
| :--- | :--- |
| 密文转发器：payload 在端点之间端到端加密，中继只解析 18 字节帧头 | 不是数据库：没有落盘的用户数据，也没有可查询的会话存储 |
| 只按 room id、stream id、frame type、payload 长度路由 | 不记录 payload：配置里没有"记录 payload"开关，也没有"关闭加密"开关 |
| daemon 与客户端之间的被动中继，一个进程持有内存中的 room 表 | 不是 TLS 终点：证书与 TLS 终止都在你自己的反向代理上 |
| 静态应用壳（PWA）的提供者：同一份字节、无用户数据、可为不同用户缓存 | 不是内容服务：它不为任何用户生成不同内容，也读不到会话内容 |
| 一个不依赖 `dr-dsh-crypto`、不依赖 `dr-dsh-proto::control`、也不依赖任何 DSH 包的二进制 | 不是 DSH 的组件：它无法"顺便"看一眼 harness 流量 |

中继能看到什么、看不到什么，以及这个声明如何被依赖图而不是被承诺保证，规范版本在 [`../security.md`](../security.md) § 2.1 与 [`../decisions/0002-zero-knowledge-relay.md`](../decisions/0002-zero-knowledge-relay.md)：

- **能看到（穷举）**：room id、连接与 room 的归属关系、帧头（类型、stream id、payload 长度）、以及流量与时序特征。
- **看不到**：payload 字节、生命周期指令、会话内容、设备名、文件路径、任何 DSH 数据。
- **做不到**：解密；伪造或注入内容（AEAD 会拒绝）；把 payload 搬到另一条流上（帧头作为附加认证数据被绑定进 AEAD）；重放一帧而不被发现（流内 nonce 是递增计数器）。

强制手段是构建期属性：`crates/dr-dsh-relay/Cargo.toml` 不声明任何密码学依赖，也不使用 `dr-dsh-proto` 的 `control` 模块。这两点在 `cargo test -p dr-dsh-relay` 里被静态强制（[`../../crates/dr-dsh-relay/tests/zero_knowledge.rs`](../../crates/dr-dsh-relay/tests/zero_knowledge.rs)）：它检查依赖表、扫描中继源码里是否出现 `dr_dsh_crypto` 或 `dr_dsh_proto::control`，并用一个"扫描确实看到了预期形状"的测试防止前两条静默通过。依赖改动时 `cargo tree -p dr-dsh-relay` 是评审材料；检查命令与细节见 [`../development/contributing.md`](../development/contributing.md) 的硬规则一节。

## 配置：环境变量

原始 `drdsh-relay` 的配置来自环境变量；统一 CLI 的 JSON 配置会被转换为服务环境（`crates/dr-dsh-relay/src/config.rs`）：

| 环境变量 | 默认值 | 含义 | 非法值的处理 |
| :--- | :--- | :--- | :--- |
| `DSH_RELAY_BIND` | `127.0.0.1:8787` | 监听地址。放在反向代理后面时保持回环；在容器里绑 `0.0.0.0:8787`，但只把端口发布到宿主机回环 | 解析失败即拒绝启动，并在错误信息里点名是哪个变量 |
| `DSH_RELAY_MAX_ROOMS` | `1024` | 同时停靠的 room 上限，用来给内存设边界 | 非数字或 `0` 即拒绝启动 |
| `DSH_RELAY_KEEPALIVE_SECS` | `30` | 对一个安静的对端发 WebSocket ping 的间隔，用来复位反向代理的空闲计时器（见下文「保活」） | `0` 关闭；非数字即拒绝启动 |
| `DSH_RELAY_CLIENT_DIR` | 无（只提供说明页） | 构建好的客户端模块目录 | 目录不存在时只影响资源，不影响隧道 |

设计上有意如此：这里没有任何能削弱安全属性的字段——没有"记录 payload"开关、没有"关闭加密"开关，也没有 TLS 私钥字段，因为 TLS 属于你的反向代理。默认绑回环也是同一个原则的延伸：把一个只装密文的中继暴露到网络上，仍然应当是一个显式动作。

可用的命令行姿势只有一种：直接运行 `drdsh-relay`（没有子命令）。启动时会打印版本号与 wire 协议版本。

### 想在局域网内低延迟？把中继放进局域网

[`../decisions/0010-lan-direct.md`](../decisions/0010-lan-direct.md) 决定了**不做**局域网直连（daemon 永远
只出站，DSH 永远只绑回环）。如果"同一 Wi-Fi 下绕公网一圈太慢"是问题，正确的做法是把中继跑在局域网内的
一台机器上（甚至同一台机器的另一个端口），daemon 与手机都连它——零代码改动：

```
手机 ──https──▶ 局域网内的反向代理 ──▶ 中继（绑局域网或回环）
电脑 ──wss───▶ （同一个入口，或直连中继）
```

**TLS 仍然必需，哪怕全程都在局域网内**：浏览器的 WebCrypto（隧道握手要用它）与 Service Worker（离线与
拦截要用它）都只在**安全上下文**里可用，而安全上下文是 https（或 localhost）。所以这一节的 nginx / Caddy
配置照抄即可，只把 `server_name` 换成局域网名字，证书用自签或内部 CA，并在手机上接受一次。中继本身照旧
绑回环、由代理转发：

```sh
DSH_RELAY_CLIENT_DIR=/usr/share/dr.dsh/client drdsh-relay    # 绑默认的 127.0.0.1:8787
```

两条必须知道的事：中继**自己不加密也不认证**——内容由隧道端到端保护，但"谁在连这个中继、有哪些房间 id"
对能访问它的人是可见的；以及如果中继直接绑了局域网地址（而不是回环 + 代理），它照常在启动时打印那条
非回环警告（见下文「部署检测」），提醒你同一网络里的其他设备——包括访客网络里的——都能访问它。

## 中继的 HTTP 面

协议规范 [`../protocol.md`](../protocol.md) § 5.1 定义了中继对外的全部端点。自托管时你会用到它们来验证部署：

| 端点 | 方向 | 用途 |
| :--- | :--- | :--- |
| `GET /healthz` | 任意 | 存活探针；返回版本与 room 数，**不含任何 room 标识** |
| `GET /ws/daemon?room=<id>` | daemon → 中继 | 注册 room 并接收该 room 的全部客户端流量 |
| `GET /ws/client?room=<id>` | 客户端 → 中继 | 加入 room；中继把它与房间内 daemon 的流对接 |
| `GET /` | 浏览器 | 静态应用壳（无用户数据，可缓存、可审计） |
| `/__dr/control/…`、`/__dr/dsh/…` | 浏览器 → 中继 | Service Worker 改写后的隧道路径：前者是应用自己的控制面，后者是要转发给 daemon 的 DSH 路径（[`../decisions/0005-pwa-and-service-worker.md`](../decisions/0005-pwa-and-service-worker.md)） |

room id 是 128 位随机数（`b64u`），它是**路由句柄而不是凭据**：知道它只能让你敲到门，进门需要完成端到端握手。room 在 daemon 重新注册时轮换，所以不要把 room id 当成需要长期记住的标识。

## 端口与暴露面

| 组件 | 默认端口 | 谁在监听 | 暴露面 |
| :--- | :--- | :--- | :--- |
| DSH Web UI | `3080` | DSH 进程自己 | 仅回环。daemon 只允许 DSH 绑 `127.0.0.1`（`crates/dr-dsh-daemon/src/config.rs` 里 `LOOPBACK_HOST` 是常量，没有可配置项） |
| daemon 本地面（规划，尚未监听） | `8790` | 待实现 | 协议规划的 `POST /report`、`GET /healthz`、`GET /status` 尚未由 daemon 提供；统一 CLI 使用系统服务状态和 DSH HTTP 探测 |
| relay | `8787` | `drdsh-relay` | 默认回环；由你的反向代理暴露到公网 |
| DSH 的 `/api/remote.mux` | 随 DSH 端口 | DSH 进程自己 | 仅回环。DSH 侧唯一的 WebSocket 多路复用路由，经隧道到达远端 |

daemon 没有任何对公网监听的套接字：隧道永远是它向外拨号建立的。上表的三个默认值同时记录在 [`../protocol.md`](../protocol.md) § 9 的常量速查里。

## Docker 部署

仓库**自带** `Dockerfile` 与 `compose.yaml`（M4 的交付项），一条命令即可起来：

```sh
docker compose up --build -d      # 中继 + 内置的客户端模块
curl http://127.0.0.1:8787/healthz
```

镜像里有什么，以及为什么：

| 阶段 | 基础镜像 | 做什么 |
| :--- | :--- | :--- |
| `client` | `node:24-bookworm-slim` | 按 `package.json` 里 pin 的 pnpm 装依赖、构建 PWA 产物（中继要提供它，所以**必须在镜像里**） |
| `relay` | `rust:1.97-bookworm` | `cargo build --release --locked -p dr-dsh-relay`，只编译中继与其协议依赖——daemon 与所有面向 DSH 的依赖**不在这个镜像里**，这是把"零知识"写成构建步骤 |
| `runtime` | `debian:bookworm-slim` | 拷入二进制与客户端产物，非 root 用户 `drdsh`，带 `curl` 只为健康检查 |

三个容易踩的点，都是这份 Dockerfile 本身踩过的：

1. **每个阶段都要有 `WORKDIR`。** 少了它，`COPY` 落在 `/`，而运行阶段的 `COPY --from=client /src/apps/pwa/dist` 找不到东西——报错点名的是目标路径，不是缺失的 `WORKDIR`。
2. **文件权限会跟着 `COPY` 走，而运行用户不是创建文件的那个人。** 如果某个源文件恰好是 `0600`（有些编辑器与工具默认如此），在容器里就是 404，而在宿主机上（中继以文件属主运行）一切正常。实测到的正是这个：`manifest.webmanifest` 404 而同一批用脚本生成的图标 200。两处 `COPY` 都加了 `--chmod`，这样镜像不再依赖宿主机的 umask。
3. **只构建中继的镜像会得到一个没有客户端的页面。** 早期版本的模板只编 `drdsh-relay`，于是访问中继看到的是"客户端未安装"那一页——它说的是实话，但不是用户想要的东西。

`read_only: true` 之所以可行，是因为中继不写任何文件：没有数据库、没有状态目录、没有需要持久化的 room 表。健康检查用 `curl /healthz`；若改用 distroless 基础镜像（更小），里面没有 shell 也没有 curl，健康检查就得放到代理或宿主机一侧。

## 部署检测

M4 的完成标准里有两条与此有关：**部署检测**，以及**反向代理超时能在启动期被发现并给出警告**。两者都实现为"说出问题 + 说出怎么办"，而不是拒绝启动。

### 中继：被暴露到非回环地址时出声

绑到非回环地址时，中继在启动横幅后打印一条警告，说明什么会跨过那张网络（密文、客户端包、room id，以及"你在跑这个"这件事本身），并指向代理的超时设置。**回环上不打印**——每次正常启动都提醒一次的提醒，就是没人读的提醒。

### daemon：认出"按固定间隔被掐断"的连接

carrier 是一条**长期空闲**的 WebSocket，而反向代理的默认值是给请求/响应写的：nginx 的 `proxy_read_timeout` 默认 60 秒，到点就关掉一条没东西可读的隧道。用户看到的是 daemon 每分钟重连一次、两边日志都只说"连接结束了"。

从 daemon 的角度，**代理超时与中继重启是同一件事**；能区分它们的是**形状**：代理按固定节拍关闭，且从不在有客户端会话时关闭。所以 daemon 记录每条 carrier 的存活时间与"这条连接上是否跑过会话"，当连续三次都满足「≥20 秒、彼此相差 ≤20%、且从未承载会话」时，打印**一次**警告，并把观察到的时长原样写进去：

```text
the carrier connection has been closed after about 21s of silence, 3 times in a row, and no client
session ever ran on those connections (observed lifetimes: 21s, 21s, 21s). This is what a reverse
proxy in front of the relay looks like when its read timeout is shorter than the tunnel needs —
nginx's `proxy_read_timeout` defaults to 60s … Raise it (nginx: `proxy_read_timeout 3600s;`), make
sure the upgrade is not buffered (`proxy_buffering off;`), and restart this daemon.
```

**实测**（`scripts/deploy-probe.mjs`）：脚本起一个真实中继，前面放一个**真的会转发、但空闲 21 秒就断开**的 TCP 代理，再让 daemon 连上去——这一组断言全部通过：
中继在非回环上警告、在回环上安静、daemon 认出节拍并点名 `proxy_read_timeout`、且这条警告只打印一次（不是每次重连都打印）。

### 保活：两端各自定期 ping

保活已经实现（M4 的收尾项），形式是 **WebSocket 层的 ping**，不是协议里的 `Ping` 帧——原因写在 [`../protocol.md`](../protocol.md) § 3：保活要骗过的是路径上的代理，所以它必须是代理能看见的字节，而 WebSocket 控制帧由对端的 WebSocket 实现自动应答，不需要任何一端跑我们的代码，中继也依然不用解析 payload。

两端各自独立，默认都开着，间隔 30 秒：

| 端 | 环境变量 | 默认 | 它保住的安静状态 |
| :--- | :--- | :--- | :--- |
| 中继 | `DSH_RELAY_KEEPALIVE_SECS` | `30` | room 已 park、客户端还没连上；以及会话建立后两端都没话说 |
| daemon | `DSHD_KEEPALIVE_SECS` | `30` | 同上，方向相反 |

`0` 关闭其中一端；非数字会让进程**启动失败**，而不是被读成"关闭"——两者在日志里长得一样，但后者会静默地拿掉这层保护。启动横幅会打印当前取值（中继是 `keepalive_secs`，daemon 是 `carrier keepalive: …`）。

两个设计细节值得记住，因为它们各自是被一次失败教出来的：

- **第一个 ping 在一个间隔之后，而不是连接建立时。** `tokio::time::interval` 的第一次 tick 会立即触发，于是每个对端刚 park 就收到一个 ping——在连接可证明存活的那一刻发的噪音。中继 `routing.rs` 里"刚 park 的 carrier 上没有流量"那条断言正是先报警的那个。
- **daemon 在 park 阶段就 ping，而不是等会话建立。** 等待第一个客户端的这段时间是 carrier 一生中最长的安静期，也正是代理超时真正掐断的那个阶段（daemon 的检测警告写的就是"从未承载会话"）。

**保活不等于不需要放宽超时**：任何短于保活间隔的超时仍然会掐断隧道，而且链路上可能有一跳你不知道（CDN 的 10 秒空闲限制、云负载均衡的默认值）。保活解决的是"照抄了 nginx 默认的 60 秒"这一类事故；检测负责在别的形状上出事时说出原因。

**实测**（`scripts/deploy-probe.mjs`，第 3 组断言）：同一个"空闲 12 秒就断开"的真实转发代理，两次运行里各只让**一端**发保活——3a 是 daemon 发（中继 `DSH_RELAY_KEEPALIVE_SECS=0`），3b 是中继发（daemon `DSHD_KEEPALIVE_SECS=0`，且挂着一个真实客户端会话）。两次都观察到 carrier 在 26 秒的安静窗口之后依然完好（0 次掐断、daemon 日志里没有重连），而且**代理的字节计数器确实在动**：保活是日志里看不见的东西，唯一的证据就是一条本无话可说的 socket 上跨过的字节。

## 裸二进制与 systemd

```bash
# 根 Cargo.toml 的 default-members 不含 dr-dsh-relay，所以要显式 -p。
cargo build --release --locked -p dr-dsh-relay
sudo install -m 0755 target/release/drdsh-relay /usr/local/bin/drdsh-relay
```

专用的非特权用户：

```bash
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin drdsh-relay
```

把下面的内容保存为 `/etc/systemd/system/drdsh-relay.service`，然后 `systemctl daemon-reload && systemctl enable --now drdsh-relay`（仓库目前没有随附打包目录，单元文件请自行落盘）：

```ini
[Unit]
Description=dr.dsh relay (drdsh-relay)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=drdsh-relay
Group=drdsh-relay
# 默认只监听回环；反向代理与中继同机时保持默认即可。
Environment=DSH_RELAY_BIND=127.0.0.1:8787
Environment=DSH_RELAY_MAX_ROOMS=1024
# 反向代理的空闲超时短于它时，这里可以调小；`0` 关闭。
Environment=DSH_RELAY_KEEPALIVE_SECS=30
ExecStart=/usr/local/bin/drdsh-relay
Restart=on-failure
RestartSec=2s

# 中继不写任何文件、不需要任何特权。
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
```

在 M0 落地前，这个单元会进入重启循环：进程打印版本行后以失败退出。要暂时避免刷日志，把 `Restart` 改成 `no`，等 M0 后再改回 `on-failure`。

## 反向代理

这一节是自托管最容易出错的地方，因为它有三个彼此独立的坑：WebSocket 升级、空闲超时、以及"你以为只有一条 WebSocket"。

### 需要升级的连接不止一条

按 [`../protocol.md`](../protocol.md) § 5.1 与 [`../decisions/0005-pwa-and-service-worker.md`](../decisions/0005-pwa-and-service-worker.md)，反向代理至少要正确处理这些长连接：

- `GET /ws/daemon` 与 `GET /ws/client`：隧道本身，一条 carrier 连接承载该 room 的全部客户端。
- DSH 自己的 WebSocket 多路复用 `/api/remote.mux`：它是 DSH 界面的流量，经 Service Worker 改写进隧道后由 daemon 代理；升级请求天然作为被改写的同源请求通过，因此代理层**不能对任何路径拒绝升级**。

**保活默认开着**：中继与 daemon 各自每 30 秒发一个 WebSocket ping（见下文「保活」一节），所以 60 秒这种默认空闲超时通常不会再掐断一条安静隧道。但**放宽超时仍然是正解**——保活只覆盖它自己那条 carrier，一条短于保活间隔的超时、或链路上你不知道的某一跳（CDN、云负载均衡）照样会掐；daemon 会认出"按固定节拍被掐断"的形状并警告，但那只是告诉你原因，不是修好它。代理侧该怎么配：整站允许升级，并把空闲超时放宽。下面两个示例都按整站代理编写，这样将来 DSH 新增流式端点时不需要再改代理配置。

### nginx

```nginx
# WebSocket 升级需要的 Connection 头。用 map 而不是写死 "upgrade"：
# 写死会在普通请求上关掉 keep-alive，SSE 与长轮询都会变慢。
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        # 升级的本体：这两行缺任何一行，握手都会停在 101 之前。
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 关键：nginx 默认 60s 的空闲超时会切断长连接，见下一小节。
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # 不要把长连接上的字节攒在 nginx 的响应缓冲里。
        proxy_buffering off;

        # 隧道是长连接，失败就让它失败、由客户端重连，换一台上游没有意义。
        proxy_next_upstream off;
    }
}
```

不要为了"优化静态资源"再写一条只匹配 `\.(js|css)$` 的 `location` 而漏掉 `/__dr/` 或 `/ws/`；如果确实要拆分，务必确认每一条需要升级的路径都落在带升级头的那条 `location` 里。`/healthz` 与 `/ws/*` 也不要加缓存。

### Caddy

Caddy 的 `reverse_proxy` 会自动完成 WebSocket 升级（把升级请求转成双向隧道），不需要手写 `Upgrade` / `Connection` 头，证书也会自动申请和续期：

```caddyfile
relay.example.com {
	reverse_proxy 127.0.0.1:8787 {
		# Caddy 的 http transport 默认没有空闲超时（read_timeout / write_timeout
		# 默认都是 no timeout）。显式写出来是为了让这份配置可审计，
		# 也为了避免以后有人顺手把它调小。
		transport http {
			read_timeout  1h
			write_timeout 1h
		}

		# 低延迟模式：不做响应缓冲，长连接上的字节立刻下发。
		flush_interval -1

		# 配置重载时 Caddy 默认会强制关闭所有 WebSocket（并向两端发 Close），
		# 那会让所有人的隧道同时断掉。加一个延迟，让连接自然结束。
		stream_close_delay 5m
	}
}
```

Caddy 这一侧还有两个与超时有关的事实值得记住：`stream_timeout` 是"流式连接最多活多久"的硬上限（默认无上限），不要把它设得比一次最长任务还短；如果 Caddy 前面还有 CDN 或云负载均衡，真正会掐断空闲连接的是那一层（例如 Cloudflare 的 100 秒空闲限制），在 Caddy 里无论怎么调都修不好，只能靠保活或换入口。

### 超时陷阱：症状与取值

`proxy_read_timeout` / `proxy_send_timeout` 的语义是"两次读/写之间的最长等待"，不是整个连接的总时长。所以一条长时间没有字节流动的隧道或一次长时间没有输出的 agent 回合，会被默认值（60s）当成死连接掐掉。

症状很好认：

- 回合进行到一半连接消失，客户端界面回到"计算机离线"或重连中，而 daemon 侧的 DSH 进程仍在正常跑、任务其实还在继续。
- 断线时刻与"最后一次收到字节"的时间差是一个固定值（默认配置下约 60 秒），而不是随机的。
- nginx 错误日志出现 `upstream timed out (110: Connection timed out) while reading response header from upstream` 或 `while reading upstream`。
- 单次短任务一切正常，只有长任务或安静等待期（例如等待人工审批）才断。

**建议值：`proxy_read_timeout` 与 `proxy_send_timeout` 都设成 `3600s`（1 小时）起步，Caddy 侧对应 `read_timeout 1h` / `write_timeout 1h`。** 宁可更长：中继侧没有任何东西会因此变慢。默认开启的保活（30 秒）已经把"忘了改 60 秒默认值"这一类事故挡掉了，但它只保证一条 carrier 上每 30 秒有字节，**短于 30 秒的超时照样会掐断**，而且一次长回合里的流式输出、等待人工批准这些安静期都可能比保活间隔更依赖代理的耐心。如果代理链上还有别的设备，整条链都要放宽。

按症状排查的版本（含确认命令）见 [`troubleshooting.md`](./troubleshooting.md) 第 3 条「长时间任务中途断线（反向代理空闲超时）」；两处给出的建议值必须保持一致，改一处就改另一处。

### 证书与 TLS

- **中继自己不终止 TLS。** 它的配置里没有 TLS 私钥字段（`crates/dr-dsh-relay/src/config.rs` 明确说明这是有意为之），`cargo tree -p dr-dsh-relay` 里也没有任何 TLS 实现，所以它既不读证书文件也不做 ACME。
- **证书在反向代理上。** Caddy 自动 HTTPS 就够了；nginx 用 certbot 或你现有的签发流程。传输层要求是 WSS（TLS 1.2+，[`../protocol.md`](../protocol.md) § 1）。
- **不需要客户端证书。** 设备身份是在端到端握手层用密钥证明的（配对时的 SPAKE2 与登记后的设备密钥挑战—应答，[`../protocol.md`](../protocol.md) § 6），不是靠 TLS 客户端证书。daemon 侧的 TLS 客户端依赖随 M0 的 uplink 落地：当前 `dr-dsh-daemon` 的依赖里还没有任何 TLS 实现，所以它现在还不能真的拨 `wss://`。
- **仍然必须用 TLS。** 中继只装密文，但 room id、帧长与时序是明文的路由元数据；TLS 保护的是这些元数据以及"你连的确实是那台中继"这件事。
- **需要的可以让中继只监听回环**，反向代理与它同机；容器部署则绑 `0.0.0.0` 但只把端口发布到 `127.0.0.1`。
- 证书过期在这套结构里的表现是"客户端连不上、代理返回 502 或证书错误"，而中继日志一切正常——这是排查时最容易走错方向的一类故障。

### 关于应用壳的缓存

中继提供的 `/` 是静态、无用户数据的同一份字节，可以被缓存、被 CDN 分发（ADR-0005）。但 [`../security.md`](../security.md) § 5.1 的缓解手段之一是"客户端包的哈希固定与变更提示"：如果你在代理层给 `/` 或前端资源加了长缓存，请确保版本变化时客户端能看到新字节（按内容哈希命名资源，而不是给入口 HTML 加长 `max-age`）。

## 健康与可观测性

**存活探针是 `GET /healthz`**，返回版本与 room 数，不包含 room 标识。中继已初始化
`tracing` subscriber，默认级别为 `info`，可通过 `RUST_LOG` 调整。

健康检查：

```bash
curl -fsS http://127.0.0.1:8787/healthz     # 存活 + 版本 + room 数
systemctl status drdsh-relay                  # 或: docker compose ps relay
ss -ltnp | grep 8787                        # 端口是否真的在听
journalctl -u drdsh-relay -f                  # 或: docker compose logs -f relay
```

应当关注的内容：

| 观察对象 | 为什么 | 异常时的样子 |
| :--- | :--- | :--- |
| `/healthz` 的 room 数 | 它是容量的直接读数，也是"有没有人真的连上"的第一个证据 | 数字长期为 0 而 daemon 说已连接；或持续贴着 `DSH_RELAY_MAX_ROOMS` |
| 连接与 room 生命周期日志 | 判断"是隧道断了"还是"客户端自己退了" | 只有断开没有重连，或同一 room 反复建/拆 |
| 拒绝停靠的原因 | 同一个 room 出现第二个 daemon 会被明确拒绝 | `room <id> already has a daemon`——通常是旧的 daemon 连接还没被回收，或有人配错了两台机器 |
| 协议错误 | 版本不匹配与畸形帧应产生 `GoAway` 而不是静默丢弃 | 大量 `incompatible wire major version` 说明有旧版本客户端 |
| 反向代理的 502/504 与证书到期 | 中继"日志正常但没人连得上"的头号原因 | 代理错误日志里出现上游连接失败 |
| 文件描述符与连接数 | 每条隧道占一个套接字 | `Too many open files` |
| 日志内容本身 | 中继只应记录连接与 room 生命周期，绝不记录 payload（ADR-0002） | 日志里出现任何 payload 字节都应当当作安全缺陷上报 |

中继重启的代价很小：room 表在内存里，重启后 daemon 会按抖动指数退避重连（`crates/dr-dsh-daemon/src/uplink.rs`：`base` 500ms、倍增、上限 30s），所以不会形成惊群。daemon 在隧道断开期间继续监管本地 DSH，本机会话不受影响（[`../architecture.md`](../architecture.md) § 4）。

部署检测与保活已经实现，见本文「部署检测」；仍需按整条代理链核对超时。

## 容量与上限

| 项目 | 值 | 来源 |
| :--- | :--- | :--- |
| 每个 room 的 daemon | 恰好 1 个；第二个会被明确拒绝 | `crates/dr-dsh-relay/src/rooms.rs` 的 `park` |
| 每个 room 的设备（客户端）数 | `MAX_DEVICES_PER_ROOM` = 16 | [`../protocol.md`](../protocol.md) § 9 |
| 单帧 payload 上限 | `MAX_PAYLOAD_LEN` = 65536（64 KiB） | 同上；中继侧的 `MAX_FORWARDED_PAYLOAD` 与它相等，并有单元测试钉住 |
| 同时停靠的 room 数 | `DSH_RELAY_MAX_ROOMS`，默认 1024 | `crates/dr-dsh-relay/src/config.rs` |
| 单连接的并发 stream 数 | `MAX_CONCURRENT_STREAMS` = 64 | [`../protocol.md`](../protocol.md) § 4 |
| 单 stream 流控窗口 | 初始 `INITIAL_WINDOW` = 262144（256 KiB），最大 `MAX_WINDOW` = 16777216（16 MiB） | 同上 |
| 配对码有效期 | 300 秒（`PAIRING_CODE_TTL_SECS`），单次使用 | [`../protocol.md`](../protocol.md) § 9 |

粗算内存的方法：把 `DSH_RELAY_MAX_ROOMS`（room 数）× 每 room 的连接数（1 个 daemon + 最多 16 个客户端）× 每连接的缓冲上限（由流控窗口决定，单流初始 256 KiB、最多 16 MiB、最多 64 条并发流）当成上界，再按你机器的实际内存把这个乘积压到可接受范围。中继对帧长有硬上限，正是为了让"一个恶意客户端让中继无限缓冲"这件事不可能发生。

每个 daemon 只占一个 room，这是设计的一部分而不是限制：room 是路由单位，同一个用户的多台设备通过同一个 room 与同一个 daemon 通信，而不是各自开一条隧道。

## 备份

**中继没有值得备份的东西。** 它没有数据库，不往磁盘写任何 payload，room 表只存在于内存里，重启后由 daemon 重连重建；room id 本身在 daemon 重新注册时轮换。把中继的容器卷或数据目录塞进备份任务是纯粹的浪费，而且会误导下一个人以为那里有数据（ADR-0002 第 4 条）。

真正需要备份的是 daemon 那台机器上的两份状态：

| 位置 | 内容 | 敏感性 |
| :--- | :--- | :--- |
| `$DSH_HOME`（默认 `~/.dsh`） | DSH 自己的 home：凭据、会话与各存储域。你的任务历史在这里，不在中继上。路径依据见 [`../integration/dsh-surface.md`](../integration/dsh-surface.md) § 1 第 7 项 | 高：含模型凭据，按密钥对待 |
| daemon 的 config 文件 | 明文配置：relay URL、DSH 的端口与可执行文件、是否托管。**不含任何密钥**，所以"把你的配置贴进 issue"是安全的支持请求 | 低：可以公开 |
| daemon 的 state 文件 | room 身份密钥与房间 id、已配对设备公钥与元信息。必须 `0600` 创建，**永远不要进日志、不要进公开仓库**。开发机上的位置是 `.dr.dsh/`（见 `.gitignore`），生产上默认在平台配置目录，可用 `drdshd run --config <path>` 指定 | 高：这是信任锚 |

daemon 状态的完整清单见 [`../architecture.md`](../architecture.md) § 1.2。备份顺序应当是：先备份 `$DSH_HOME` 与 daemon 的 state，再备份 config；中继的地址（`drdshd run --relay <url>`）只是一个可替换的配置项。换掉一台中继不会丢失设备注册表（它在 daemon 上），但客户端如何重新绑定到新中继上的 room 属于 M0/M1 的绑定流程，尚未确定，因此不要把它当成"改个 URL 就完事"的操作。

## 相关文档

- [`../security.md`](../security.md) —— 威胁模型与保证（§ 2.1 中继零知识，§ 5.1 中继在客户端 TCB 内，§ 5.2 元数据泄漏）
- [`../decisions/0002-zero-knowledge-relay.md`](../decisions/0002-zero-knowledge-relay.md) —— 为什么中继不碰加密
- [`../decisions/0005-pwa-and-service-worker.md`](../decisions/0005-pwa-and-service-worker.md) —— 静态应用壳与隧道改写
- [`../architecture.md`](../architecture.md) —— 组件、数据流与失败恢复
- [`../protocol.md`](../protocol.md) —— 端点、帧与常量的规范描述
- [`../product/mvp.md`](../product/mvp.md) —— 里程碑与 M4 的部署检测
- [`troubleshooting.md`](./troubleshooting.md) —— 症状优先的排查指南
