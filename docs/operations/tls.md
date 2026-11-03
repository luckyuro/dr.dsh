# TLS 配置

以下功能从 v0.2.0 起包含在 Release 中。已有安装先运行对应组件的 `update`，再配置证书。

TLS 支持是可选的；现有 HTTP/WS 配置继续可用。HTTPS/WSS 默认校验证书链、有效期和服务器名，
可显式使用 `--insecure` 跳过这些检查。Rust 原生端支持 TLS 1.2/1.3，失败时不会改用明文。

## 网络入口覆盖

| 网络路径 | TLS 用法 | 信任与限制 |
| :--- | :--- | :--- |
| 浏览器 → relay 页面、静态资源、健康端点 | `https://relay.example.com` | 浏览器信任库；HTTPS 页面自动拨 WSS |
| daemon / 配对双方 → relay | `--relay wss://relay.example.com` | 系统 CA，可加 `--ca-cert` 或显式 `--insecure` |
| relay 服务端 | `drdsh relay run --tls-cert … --tls-key …` | CLI 宿主终止 TLS；relay crate 依赖边界不变 |
| CLI / Docker 健康检查 → relay | 配置 TLS 后自动使用 HTTPS | 连接本地 IP，校验证书名；配置方法见下文 |
| CLI 健康检查 → DSH | 安装时 `--dsh-tls` | 使用回环 IP 和 daemon 保存的 CA；仍接受 DSH 的 401/403 鉴权栅栏 |
| daemon → DSH HTTP API 和 WebSocket | HTTPS 就绪行，或 `run --attach <port> --attach-tls` | 仅回环 IP，保留 DSH 的 Host/Cookie 鉴权；默认验证相应 IP SAN，可显式 `--insecure` |
| 插件 → 本地报告服务 | `daemonUrl: https://127.0.0.1:8790` | Node 信任库；拒绝重定向。daemon 的报告服务端尚未实现，此项验证使用替身 |
| Release 安装与更新下载 | 默认 HTTPS，最低 TLS 1.2 | curl 校验，可用 `CURL_CA_BUNDLE` 指定下载端的 CA |
| 旧源码 relay 二进制 / 旧管理入口 | 放在 HTTPS 反向代理后，或迁移到 `drdsh relay` | 原始 relay crate 不链接 TLS；不会把 TLS 环境变量静默当成 HTTP |

## relay 直接提供 HTTPS/WSS

准备 PEM 证书链（叶证书在前，中间证书随后）与匹配的未加密 PEM 私钥。私钥只允许服务用户读取。
前台运行：

```sh
drdsh relay run --bind 0.0.0.0:8787 \
  --client-dir /path/to/pwa/dist \
  --tls-cert /path/to/fullchain.pem --tls-key /path/to/privkey.pem
```

浏览器打开 `https://relay.example.com:8787`，daemon 使用 `wss://relay.example.com:8787`。
此端口只接受 TLS；不自动提供 HTTP 重定向。

安装为用户服务：

```sh
drdsh relay install --source /path/to/extracted-relay-bundle \
  --bind 0.0.0.0:8787 \
  --tls-cert /path/to/fullchain.pem --tls-key /path/to/privkey.pem \
  --tls-server-name relay.example.com --start
drdsh relay status
```

Release 下载入口也接受这些参数。`--tls-server-name` 是本机健康探针校验证书时使用的名称；
连接仍发到 `--bind` 对应的本地 IP，不依赖公网 DNS 回流。省略时验证监听 IP（通配地址转回环）。
私有 CA 部署再加 `--ca-cert /path/to/ca.pem`；公网受信任证书无需此项。

配置保存在该组件的 `relay.json`：`tlsCert`、`tlsKey`、`tlsServerName`、`caCert`，以及可选的
`tlsInsecure`。证书和私钥只保存绝对路径，不复制到安装目录。更新、重装时省略的参数保留。
续期替换文件后执行 `drdsh relay restart`。取消原生 TLS 时，移除配置中的 `tlsCert`、`tlsKey`、
`tlsServerName`，再重启；确保此时有 HTTPS 反向代理或只在回环使用。

前台和自管服务也可使用 `DSH_RELAY_TLS_CERT` / `DSH_RELAY_TLS_KEY`。两者必须同时设置；
证书和密钥不匹配、无法读取或格式不正确都在监听前拒绝。反向代理终止 TLS 的旧部署继续有效。

## daemon、配对与私有 CA

```sh
drdsh daemon run --relay wss://relay.example.com:8787 --ca-cert /path/to/ca.pem
drdsh daemon pair --relay wss://relay.example.com:8787 --ca-cert /path/to/ca.pem
drdsh daemon install --source /path/to/extracted-daemon-bundle \
  --relay wss://relay.example.com:8787 --ca-cert /path/to/ca.pem
```

`--ca-cert` 同样适用于 `pair-as-device`，安装后保存为 daemon 自己的 `caCert`，不影响 relay 配置。
原始 `drdshd` 开发入口使用 `DRDSH_CA_CERT=/path/to/ca.pem`，作用相同。
`DRDSH_CA_CERT` 在系统信任库上增加证书；`SSL_CERT_FILE` / `SSL_CERT_DIR` 则覆盖系统证书来源。
这些环境变量只作用于相应进程，不会安装系统证书。HTTP/WS 不加载 TLS 信任库。

浏览器设备要单独信任私有 CA。Node 插件使用 `NODE_EXTRA_CA_CERTS`，应在启动 DSH 前配置；
Rust 的 `--ca-cert` 不改变浏览器或 Node 的信任库。

## 显式跳过证书验证

前台运行和两种配对命令接受 `--insecure`：

```sh
drdsh daemon run --relay wss://relay.example.com:8787 --insecure
drdsh daemon pair --relay wss://relay.example.com:8787 --insecure
drdsh daemon pair-as-device --relay wss://relay.example.com:8787 --code '<配对码>' --insecure
```

该参数作用于本进程访问 relay 的 WSS，以及访问 DSH 的 HTTPS/WSS，包括鉴权、健康轮询和
WebSocket upgrade。它跳过证书信任链、有效期和服务器名检查，不需要加载 CA 文件；仍使用
TLS 加密并验证握手签名，但不再验证服务器身份。不会自动重试明文，也不改变端到端配对或 DSH 鉴权。
同时提供 `--ca-cert` 时仍检查该文件的格式，以免保存损坏的 CA 配置。

安装时可持久保存，也可恢复默认校验：

```sh
drdsh daemon install --insecure
drdsh daemon install --no-insecure
drdsh relay install --insecure
drdsh relay status --no-insecure
```

`install` 保存当前组件的 `tlsInsecure: true/false`，重装和更新时省略参数会保留原值。
relay 的设置仅影响其 HTTPS 健康检查；daemon 的设置同时影响运行、配对和 HTTPS 健康检查。
`run` / `pair` / `pair-as-device` / `status` 上的参数只覆盖当次命令，不修改保存的配置。
`--insecure` 和 `--no-insecure` 不能同时使用，也不能重复。

自管进程、原始 `drdshd` 开发入口及 Docker 健康检查可使用 `DRDSH_TLS_INSECURE=1`；
设为 `0` 表示校验，其余值报错。优先级为命令行参数 → 当前组件保存的 `tlsInsecure` → 环境变量 →
默认校验。环境变量不会因运行安装命令而自动写入配置。

这个开关不改变浏览器或 Node 插件的证书验证，也不影响 Release 下载的 curl 校验。
浏览器仍需信任 relay 的证书，插件仍使用 Node 的信任库。服务端仍必须提供格式正确且匹配的
证书和私钥。决策依据见 [ADR-0019](../decisions/0019-explicit-tls-verification-opt-out.md)。

## 访问 HTTPS DSH

上游 DSH 默认仍提供回环 HTTP；本仓库不会修改它的启动参数或上游文件。如果已有 HTTPS
回环 DSH 端点，可附着：

```sh
drdsh daemon run --attach 3443 --attach-tls --attach-token '<DSH 打印的令牌>' \
  --relay wss://relay.example.com --ca-cert /path/to/ca.pem
```

该命令连接 `https://127.0.0.1:3443`，默认要求证书包含 `IP:127.0.0.1` 的 SAN；仅有 `DNS:localhost`
不匹配。需要跳过证书校验时加 `--insecure`。托管模式也能读取 HTTPS 就绪行并沿用它的协议，
仍将地址限定在回环 IP。鉴权、请求、健康轮询、WebSocket upgrade 共用同一 HTTPS 客户端；不允许代理到外网主机。
附着模式沿用原来的生命周期拒绝规则。

已配置为输出 HTTPS 就绪行的托管 DSH，可用 `drdsh daemon install … --dsh-tls --ca-cert …`
保存 `dshTls: true`；daemon 要求 DSH 就绪行使用 HTTPS，`status` 同样用 HTTPS 探测。
该选项不会让上游 DSH 自动开启 TLS。自管进程使用 `DSHD_DSH_TLS=1` 表达同一要求。

## Docker

镜像编译 `dr-dsh-cli --no-default-features --features relay`，在 CLI 宿主处理 TLS，排除 daemon。
可在 Compose override 中增加：

```yaml
services:
  relay:
    environment:
      DSH_RELAY_TLS_CERT: /certs/fullchain.pem
      DSH_RELAY_TLS_KEY: /certs/privkey.pem
      DSH_RELAY_TLS_SERVER_NAME: relay.example.com
      # 仅私有 CA 需要：
      DRDSH_CA_CERT: /certs/ca.pem
    volumes:
      - ./certs:/certs:ro
```

挂载文件必须对容器 UID 10001 可读。按部署需要显式发布 TLS 端口；默认 Compose 仍只发布到
宿主机回环。健康脚本自动选择 HTTPS，默认用证书名验证本地连接。
可显式设置 `DRDSH_TLS_INSECURE: "1"` 跳过容器健康检查的证书校验；`"0"` 恢复校验。

## 验证与排障

```sh
cargo build --workspace
pnpm --filter @dr.dsh/pwa build
pnpm run smoke:transport
pnpm run smoke:multicall
```

传输测试生成临时 CA，自带原生 TLS relay、反向代理与 DSH 替身，覆盖 TLS 1.2/1.3、静态资源、
双向 WSS 加密控制、配对、HTTPS 鉴权和 WSS 升级、默认拒绝证书、显式跳过及恢复校验、插件 HTTPS 及禁止降级。
跳过验证场景包含私有 CA、自签名、过期及服务器名不匹配的证书，并验证 TLS 1.2/1.3。
测试不修改系统信任库，不代表已验证上游 DSH 自己能启动 HTTPS 服务。
服务测试需要 macOS launchd 或 Linux systemd 用户会话。

连接失败时先确认 URL 协议和端口、CA 信任、证书 SAN 与有效期、链中是否包含中间证书。
`status` 的 HTTPS 失败会输出 CA/服务器名的排查提示；无需改变业务隧道或配对密钥。
