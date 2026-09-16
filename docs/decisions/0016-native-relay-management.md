# ADR-0016：Relay 原生管理与静态客户端分发

- 状态：已接受
- 日期：2026-09-17
- 决策影响：relay 安装管理、离线打包、PWA 静态产物与 nginx 部署

## 背景

ADR-0014/0015 的安装管理采用共享 Node CLI，便于两侧复用 JSON 配置和跨平台服务逻辑。
Daemon 所在机器本来就需要 Node 运行 DSH；独立 relay 服务器没有这一前提。
用户要求减少服务器的 JS 依赖，并确认 PWA 能否由 nginx 直接托管。

## 决策

1. `drdsh-relayctl` 改由独立的 `crates/dr-dsh-relayctl` 编译。`relay/install.sh` 只使用 Shell
   启动这个程序；安装、状态检查、日志、启停、自启动、更新与卸载不调用 Node、pnpm、Python 或 jq。
   管理逻辑不放入中继进程，不增加网络接口。Daemon 与旧统一入口继续使用已有 Node CLI。
2. `relay/package.sh` 在构建机生成本地压缩包，包含两个原生程序、PWA、安装入口与 nginx 示例。
   构建机使用 Rust、Node 和 pnpm；目标服务器使用与其 OS/CPU 匹配的产物，无需这些构建工具。
   这不等于已经建立官方发布、下载、签名或可复现构建流水线。
3. Relay 源码安装只调用 Cargo，并要求预先构建的 PWA，可通过 `--client-dir` 从构建机复制。
   缺少产物在停止现有服务前明确失败，不在服务器悄悄安装 JS 工具或下载未发布的二进制。
4. 原生 CLI 沿用独立安装的 `relay.json`、prefix、服务名、日志、更新锁与端口配置。
   服务名仍取安装路径 SHA-256 的前 12 位；`sha2` 仅属于本地管理 crate，用于兼容已有服务身份，
   `dr-dsh-relay` 的依赖没有变化。旧的独立 relay 可以通过同 prefix 重装替换 JS 管理文件；
   旧统一 `config.json` 安装继续由旧命令管理，不自动迁移或改动 daemon 状态。
5. 首页源文件移至 `apps/pwa/static/index.html`。Rust 通过 `include_str!` 使用它，PWA 构建也复制
   同一文件。构建后的首页、JS、图标和 manifest 都是静态文件，无服务器端 JS 执行。
6. nginx 可以直接服务 `/` 和 `/client/*`，只代理 `/ws/*` 与 `/healthz`。保持同源 HTTPS、正确
   Content-Type、CSP、缓存头，以及 worker 的 `Service-Worker-Allowed: /`。DSH 的页面请求由浏览器
   Service Worker 经隧道取得；未被控制的路径返回 404，不用静态首页兜底。
   nginx 读取单独的公开资源副本，安装目录与配置目录仍保持私有权限。

## 取舍

管理程序多出一个小二进制，且两种语言各有系统服务实现；这是独立 relay 无 JS 运行时的代价。
保留相同服务身份与配置，用真实进程检查防止迁移、路径转义和跨组件操作出现差异。
没有为减少部署依赖而改写浏览器客户端，也没有在 relay 里增加安装、证书或 DSH 管理功能。

Shell 仅作入口，不承担 JSON 解析或跨平台服务状态解析；把这些逻辑写成大型 Shell 脚本会增加
路径转义和配置迁移的风险。依赖 Python/jq 只会把额外运行时换一种名字，故不采用。

## 验证

- `cargo test -p dr-dsh-relayctl`：参数隔离、旧配置兼容、服务格式和特殊路径。
- `scripts/service-smoke.mjs`：真实 launchd/systemd 服务生命周期；relay 调用使用不含开发工具的
  PATH，覆盖本地离线包、完整和 PWA 更新、失败保活、锁、另一侧 PID/配置不变与旧统一入口。
- `scripts/nginx-static-smoke.mjs`：真实 nginx 读取静态文件，relay 没有客户端目录；Chromium 完成
  配对、Service Worker 接管、加密隧道、经鉴权的 DSH 替身页面与离线外壳。
  DSH 使用替身，这项测试不替代上游 DSH 集成验收。
- `scripts/relay-bundle-smoke.sh <bundle> <全新测试目录>`：在没有 Node、pnpm、Cargo、Python、jq 的
  Linux 服务器或容器中，以真实 systemd 用户服务验证安装、启停、自启动、更新、日志与卸载重装。
  curl 仅供测试断言，不是原生管理器的运行依赖。

使用说明见 [Relay 入口](../../relay/README.zh.md) 与 [安装管理](../operations/cli.md)。
