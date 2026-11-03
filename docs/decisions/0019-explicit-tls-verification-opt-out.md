# ADR-0019：显式选择跳过客户端 TLS 证书验证

- 状态：已接受
- 日期：2026-09-20
- 决策影响：CLI、daemon、已安装服务与 Docker 健康检查
- 部分取代：[ADR-0018](0018-tls-transport.md) 中不提供 insecure 开关的决定

## 背景

用户要求增加参数，在使用 HTTPS 时允许忽略证书验证。该行为应当由调用者显式选择，
并能保存为当前组件的服务配置，也能明确恢复校验。默认行为继续保持验证证书。

## 决策

1. `drdsh daemon run/pair/pair-as-device` 与两个组件的 `install/status` 增加 `--insecure`
   和 `--no-insecure`。前者跳过证书信任链、有效期与服务器名检查，后者恢复默认验证。
   重复或冲突参数报错。
2. `install` 将选择保存为当前组件的 `tlsInsecure`，省略时保留旧值。其余命令仅临时覆盖。
   两侧配置仍独立，更新和卸载一侧不改变另一侧配置或进程。
3. Rust 客户端统一使用 `dr-dsh-tls`：命令行选择优先于保存配置，保存配置优先于
   `DRDSH_TLS_INSECURE`（只接受 `1` / `0`）；均未指定时验证证书。
   跳过验证时不加载信任库，但显式 `--ca-cert` 仍验证文件格式。
4. 该选择覆盖 daemon 的 relay WSS、DSH HTTPS/WSS、鉴权和健康轮询，以及 CLI 的 HTTPS
   健康检查。Docker 健康脚本同样接受上述环境变量。
5. TLS 握手签名仍由 rustls 验证，TLS 1.2/1.3 加密仍然启用，不提供明文自动回退。
   跳过证书检查意味着不验证服务器身份。端到端加密、配对验证和 DSH 鉴权保持原有规则。

## 边界与验证

浏览器和 Node 插件沿用各自信任库；不设置全局 Node TLS 开关。Release 下载沿用 curl 的
证书验证；安装入口的 `--insecure` 只转交给安装配置。服务端证书和私钥的完整性、格式与匹配
检查仍在启动前执行。relay crate 不引入 TLS 依赖，协议和共享向量无需变化。

真实进程覆盖见 `scripts/relay-transport-smoke.mjs` 与 `scripts/multicall-smoke.mjs`，包括
默认拒绝、不加载 CA 的显式跳过、恢复校验、命令覆盖和服务配置持久化。
操作说明见 [TLS 配置](../operations/tls.md)。
