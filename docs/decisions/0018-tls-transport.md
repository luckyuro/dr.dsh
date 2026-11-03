# ADR-0018：TLS 传输由 CLI 宿主与 daemon 承担

- 状态：已接受
- 日期：2026-09-19
- 决策影响：CLI、daemon、Docker、证书配置和健康检查

## 背景

用户要求所有网络访问支持 TLS。daemon 到中继已有 WSS，浏览器也会随 HTTPS 页面使用 WSS，
但原生 relay 入口只提供 HTTP/WS，DSH 代理客户端拒绝 HTTPS，服务健康探针只发送明文 HTTP。
[ADR-0002](0002-zero-knowledge-relay.md) 禁止 relay crate 依赖密码学库；
[ADR-0017](0017-multicall-release-packages.md) 已把 CLI 宿主与 relay crate 分开。

## 决策

1. 新增 `dr-dsh-tls`，仅由 CLI 和 daemon 使用，统一 Rust 客户端的 CA 加载和 TLS 服务端监听。
   依赖 rustls、tokio-rustls 和系统证书加载器，使用 ring，支持 TLS 1.2/1.3。
   daemon 使用 hyper-rustls 让现有 HTTP 客户端和 WebSocket upgrade 共用 HTTPS 连接。
2. `drdsh relay run` 在同时配置证书和私钥时直接提供 HTTPS/WSS，复用 relay 的原始 Router。
   证书不完整、格式错误或密钥不匹配即拒绝启动；不同时开放明文端口，也不自动降级。
   每次 TLS 握手最多等待 10 秒，同时最多保留 128 个握手，避免慢连接阻塞整个入口。
3. relay crate 不依赖 TLS 库，不读取私钥，不接触端到端密钥或控制消息。原始开发二进制
   仍可在反向代理后提供 HTTP；发现 TLS 环境变量时明确要求使用 CLI，避免误开明文。
   Docker 改为编译 CLI 的 relay feature，包含传输 TLS，但不包含 daemon 或 DSH 代码。
4. Rust 客户端默认使用系统 CA；`--ca-cert` / `DRDSH_CA_CERT` 增加私有 CA。
   保留 `SSL_CERT_FILE` / `SSL_CERT_DIR` 的信任库覆盖语义。没有跳过证书校验的选项。
   浏览器使用浏览器信任库，插件使用 Node 的信任库；不修改系统信任库。
5. DSH 代理仍限定回环 IP 和端口，托管模式沿用就绪行的 HTTP/HTTPS 协议，附着模式增加
   `--attach-tls`。Host、Cookie 和 WebSocket Origin 一致，不改 DSH、不绕过鉴权。
6. 安装保存证书文件路径、CA 路径及健康探针的服务器名；重装和更新保留这些字段。
   证书续期后重启 relay。健康探针连接本地监听地址，但校验证书对应的服务器名。
   插件只接受 HTTP/HTTPS 回环地址并拒绝重定向。Release 下载维持 HTTPS 和证书校验，最低 TLS 1.2。

## 被否决的方案

- 给 relay crate 直接增加 rustls：破坏现有可机械验证的依赖边界。
- 接受所有自签名证书或提供 insecure 开关：把 TLS 错误变成静默失去身份验证。
- HTTPS 失败后重试 HTTP：选择 TLS 就应保证失败时不会发送明文。
- 修改上游 DSH 使其提供 TLS：越过本仓库集成边界；使用已提供的 HTTPS 回环端点即可。

## 边界与验证

这次不改 wire 协议、共享向量、端到端密码学或权限。TLS 保护单跳传输，不能代替端到端加密。
daemon 的本地 `/report` 服务端仍未实现，本次只验证已有插件客户端向 HTTPS 替身的请求。
自动证书签发、续期、mTLS 和热加载不在本次范围内。

真实进程验证见 `scripts/relay-transport-smoke.mjs`，原生服务安装和更新验证见
`scripts/multicall-smoke.mjs`。使用说明与各入口覆盖表见 [TLS 配置](../operations/tls.md)。
