# 二进制发布与安装

当前版本为 **v0.2.0**，提供原生 TLS、插件本机管理与独立隧道、同页 Harness，以及自动安装 DSH。
先按下表选包；第一次使用可直接看[项目快速开始](../../README.zh.md#快速开始)。
本次功能和环境范围见[发布验收记录](acceptance-2026-11-04.md)。

## 未发布的源码更新

以下改动已在当前源码实现，尚未包含在上述 v0.2.0 Release 附件中；下载入口仍提供原发布包。

- 兼容 DSH `0.2.2-rc.1`，首次私有安装固定该版本与 Cordis `4.1.0` 依赖组合；
  更新 daemon 时保留已有私有 DSH `0.2.2-alpha.2` 的版本和依赖锁。
- 管理页与 PWA 共用字段校验，提供浏览器预检、分区管理界面和 `doctor --json` 结构化诊断；
  诊断失败、未知或截断输出不会显示为全部通过。
- 修复 OS 服务接管后丢失自定义管理 prefix 和授权存储的问题，保留原实例、profile 与作业记录。
- HTTP 持续响应逐段传递；Worker 正常更换后 SSE 可以重新订阅。
- DSH 输出的大型 WebSocket 文本使用 PX v2 分片，最大 8 MiB，修复长会话刷新后反复重连。
  carrier 仍为 64 KiB；输入和二进制消息仍受 PX v1 的单块限制。

使用大快照修复时，需要同时更新 daemon 和 Relay 提供的 PWA；插件自持隧道则更新插件附带的
native 程序。nginx 独立托管时也要更新 `client/`。旧客户端不能解码 PX v2，不能只更新一端。
当前源码 PWA 缓存为 `dr.dsh-client-v17`，更新后完整重载浏览器页面，已有配对保留。

完整跨机、真实模型及服务隔离验证见 [2026-11-07 验收记录](acceptance-2026-11-07.md)，
协议范围见 [ADR-0028](../decisions/0028-streaming-and-large-snapshots.md)。

## 已发布的平台与包

从 `v0.1.0` 起，GitHub [Releases](https://github.com/luckyuro/dr.dsh/releases) 提供下列 `.tar.gz`。
版本尚处早期自托管阶段；没有第三方审计、代码签名或可复现构建保证。`SHA256SUMS` 用于校验下载内容，
与压缩包通过同一 GitHub HTTPS 来源取得，不等同于独立签名。

| 平台 | 混合包 | Relay 包 | Daemon 包 |
| :--- | :--- | :--- | :--- |
| Linux x86_64，静态 musl | `drdsh-mixed-x86_64-unknown-linux-musl.tar.gz` | `drdsh-relay-x86_64-unknown-linux-musl.tar.gz` | `drdsh-daemon-x86_64-unknown-linux-musl.tar.gz` |
| macOS Apple Silicon | — | — | `drdsh-daemon-aarch64-apple-darwin.tar.gz` |

**同一平台三个包里的 `bin/drdsh` 逐字节相同**，由同一次编译产生。混合包清单启用 relay 和 daemon，
独立包清单只启用对应组件，并且只携带相关资源。`bin/drdsh-relay` / `bin/drdsh-daemon` 是同一
可执行文件的符号链接，argv[0] 决定默认子命令；显式请求包中禁用的组件会报错。
包清单是本地分发约定，可由拥有文件权限的用户修改，不作为对抗本机用户的安全边界。
混合包运行两个独立服务进程。所有包的二进制都包含 daemon 密码学实现；零知识依赖约束仍针对
网络 relay crate，不能说整个 CLI 二进制没有密码学能力。

```sh
drdsh relay run --bind 127.0.0.1:8787
drdsh daemon run --relay ws://127.0.0.1:8787
drdsh-relay status             # 等价于 drdsh relay status
drdsh-daemon pair              # 等价于 drdsh daemon pair
```

CLI 启动先把鲸鱼 Logo 的 ASCII 版本打印到 stderr，stdout 保留给命令结果。调用包中禁用的组件会得到
说明缺少哪一个包的错误，而不会创建安装目录或服务。`drdsh-relay daemon ...` 也会明确拒绝。

## 从 Release 安装

在目标机器直接运行一条 curl 命令，脚本自动识别系统与 CPU，从 GitHub Release 下载对应包，
校验 SHA-256、解包后调用 Rust 安装器。无需克隆仓库；下载需要 Shell、curl、tar，以及
sha256sum 或 shasum。服务器不需要 Rust、pnpm 或管理用 Node；daemon 主机需要 Node 24.9+ 与 npm。首次省略 `--dsh` 会安装固定的 DSH 和插件；已有 DSH 可显式指定。

```sh
# Linux x86_64：只安装 Relay 与 PWA
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/relay/install.sh | sh -s -- --start

# Linux x86_64 / macOS Apple Silicon：只安装 Daemon
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --dsh /absolute/path/to/dsh --relay ws://127.0.0.1:8787 --start

# 自动选择：Linux 为混合包，macOS 为 daemon；只安装，不启动
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/install.sh | sh

# 固定二进制版本，并选择安装目录
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/install.sh | sh -s -- \
  --component relay --version v0.2.0 --prefix "$HOME/.local"
```

根 `install.sh` 默认在 Linux 选择混合包、macOS 选择 daemon；`relay/install.sh` 和
`daemon/install.sh` 默认选择各自组件。所有安装参数放在 `sh -s --` 后面，例如
`--bind 127.0.0.1:8787`、`--dsh /absolute/path/to/dsh`、`--with-plugin`、`--enable`。

`--dsh` 指定已安装的 DeepSeek Harness **可执行文件**，可用 `command -v dsh` 查找；
`--workdir /path/to/your/project` 只指定可选的启动工作目录。首次省略 `--dsh` 会[私有安装 DSH](dsh-provisioning.md)，省略 `--workdir` 使用当前目录；后续安装沿用已保存值。模型凭据需在 DSH 中配置，详见 [Daemon 参数说明](../../daemon/README.zh.md#一键安装并启动)。
`--relay` 仅用于 daemon，按端点实际协议填写 `ws://` 或 `wss://`，例如 `wss://relay.example.com`。
Relay 服务端用 `--bind` 配置监听 IP 和端口，不接受 `--relay`。
浏览器可通过 `https://relay.example.com` 访问，DNS、证书和反向代理步骤见 [Relay 域名配置](../../relay/README.zh.md#使用域名)。

也可使用环境变量，放在管道的 **`sh` 一侧**；显式命令行参数优先：

| 环境变量 | 可用值 | 默认值 |
| :--- | :--- | :--- |
| `DRDSH_COMPONENT` | `relay`、`daemon`、`mixed`、`auto` | 根入口 `auto`；组件入口使用对应组件 |
| `DRDSH_VERSION` | `latest` 或 Release tag，如 `v0.2.0` | `latest` |
| `DRDSH_PREFIX` | 安装目录 | `~/.local` |

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/install.sh | \
  DRDSH_COMPONENT=relay DRDSH_VERSION=v0.2.0 DRDSH_PREFIX="$HOME/.local" sh
```

三个入口都是自包含 Shell 文件，也可以先下载为本地文件再运行：

```sh
curl -fL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/install.sh -o drdsh-install.sh
sh drdsh-install.sh --component relay --start
```

安装器完整函数接收完后才执行，下载中断的半截脚本不会开始安装；程序包下载失败或摘要不符时
不会停止现有服务。`--start` 与 `--enable` 才会启动服务与开启登录自启动；默认仅安装。
Linux 使用 systemd 用户服务；macOS 使用 launchd 用户服务。安装完成后将 `<prefix>/bin` 加入 PATH。

离线使用时，下载压缩包与摘要并校验，解压后运行包内 `sh install.sh`，或指定某一侧：

```sh
./bin/drdsh relay install --source "$PWD" --prefix "$HOME/.local"
./bin/drdsh daemon install --source "$PWD" --dsh /absolute/path/to/dsh
```

Relay 包带静态 `client/` 和 nginx 示例，daemon 包带可选 `plugin/`，混合包带两者。插件通过
`drdsh daemon install --source <bundle> --with-plugin` 注册到 DSH web profile；PWA 可由 nginx
直接托管，具体路径、TLS、CSP 与 WebSocket 配置见 `nginx.conf.example`。

## 更新与独立管理

```sh
drdsh relay update                    # 最新 Release 中的 relay 独立包
drdsh daemon update --version v0.2.0
drdsh relay status
drdsh daemon logs --follow
drdsh relay uninstall
```

两侧各自安装到 `<prefix>/lib/dr.dsh/relay`、`<prefix>/lib/dr.dsh/daemon`，保留独立的 JSON 配置、
服务名、日志和操作锁。即使最初使用混合包，一侧更新只替换自己的程序副本；另一侧的 PID、配置与
密钥不受影响。公开的 `drdsh` 链接按组件转到各自安装的副本；卸载它指向的一侧后自动改指向剩下
的一侧。组件别名始终固定作用域，兼容的 `drdsh-relayctl` / `drdsh-daemonctl` 名字也保留。

更新继承已有设置并恢复原本运行的服务；不自动开启自启动。卸载保留配置、配对密钥与日志。
包内数据先暂存，再停止相关服务；不声称整个安装是事务式升级。旧独立安装可用同 prefix 迁移；
旧 `config.json` 统一安装需继续通过 `scripts/install-legacy.sh` / 旧命令管理，或另选 prefix。
新入口不会覆盖旧统一命令，避免意外接管旧服务。

## 开发与发布步骤

构建机先运行 `pnpm install --frozen-lockfile`，再安装对应 Rust target。
Daemon 的 TLS 后端 ring 需要目标平台的 C 编译工具链；预编译包的安装和管理仍不需要编译工具。
`scripts/build-release.sh <target>` 编译并打包规定的组合；含 relay 的目标会先重新构建 PWA，
确保页面、Service Worker 和图标一起更新。`scripts/package-release.sh` 可以单独打包已有二进制，
此时需先运行 `pnpm --filter @dr.dsh/pwa build`。两个打包入口（含旧 `relay/package.sh`）都会
检查静态资源与源码一致、必要模块存在，拒绝漏图标、旧页面或混入测试文件的构建目录。
应先完成 verify 再构建发布 PWA，因为 typecheck 会向同一目录写入测试产物。
Linux 使用 `x86_64-unknown-linux-musl`，不启用 `target-cpu=native`；v0.2.0 在 macOS 上通过
cargo-zigbuild 交叉构建，并在 Linux systemd 容器中运行产物。组件与插件包均排除构建主机的扩展文件属性。

```sh
sh scripts/build-release.sh aarch64-apple-darwin
sh scripts/build-release.sh x86_64-unknown-linux-musl
```

开发机源码安装新 CLI：先 `cargo build -p dr-dsh-cli`，构建 PWA 后运行
`target/debug/drdsh relay install --source "$PWD" --skip-build --build-profile debug`。
旧管理路径的回归测试仍使用 `relay/install-source.sh`、`daemon/install-source.sh`。

开发者也可从源码安装 daemon：

```sh
cargo build -p dr-dsh-cli
target/debug/drdsh daemon install --source "$PWD" --skip-build --build-profile debug \
  --dsh /absolute/path/to/dsh --relay wss://relay.example.com --start
```

发布前运行仓库 verify、包清单与名称分派检查及二进制同一性校验，以及真实进程的安装隔离和下载摘要失败测试；
再把四个组件压缩包、包含两个平台 native 的独立插件包、`BUILDINFO.txt` 与 `SHA256SUMS` 上传同一个源码 tag 的 Release。构建记录应列出源码、Rust 版本、
目标与摘要。当前是脚本辅助的人工发布流程，尚无自动签名、托管 CI 发布或可复现构建认证。

修改下载入口时编辑 `scripts/release-install.sh`，再运行 `sh scripts/release-entrypoints.sh`
同步三个独立入口。`node scripts/release-installer-smoke.mjs` 会用真实 curl → sh 管道与原生安装器，
检查下载校验、参数和环境变量、指定版本、更新及中断脚本；测试运行在独立临时 prefix 中。

若明确选择保持版本号并替换现有 Release，先备份该 Release 的所有附件与说明，再从同一份最终
源码重建四个压缩包。更新 `BUILDINFO.txt` 的源码提交和构建信息，重新生成覆盖它与四个压缩包的
`SHA256SUMS`，并让版本 tag 指向该提交。用 `gh release upload <tag> --clobber` 替换压缩包与
构建记录，**最后替换 `SHA256SUMS`**；随后重新下载并校验整套附件。逐个上传不是原子操作，
窗口内不匹配的下载会被安装脚本拒绝；重试即可，现有服务不会因此被停止。
原生 `update --version <tag>` 会重新下载同版本附件，无需改动版本号。

nginx 独立托管 PWA 时，从已校验的 relay 包取出 `client/`，放进新的发布目录，检查文件权限后
原子切换 nginx 根目录所用的 `current` 符号链接；保留旧目录供回滚。随后检查首页、图标、manifest、
Service Worker 与健康端点。仅切换静态目录不需要重启 relay，也不改变配对状态或 relay 配置。

## v0.2.0 升级说明

- 常驻 daemon 与独立插件隧道都可用。插件配置 `relayUrl` 后随 DSH 启停；需要远程恢复时启用 daemon。
- 新安装可自动下载 DSH `0.2.2-alpha.2`；Cordis 相关依赖固定为通过本次浏览器验收的 alpha.1 组合，避免浮动依赖破坏设置保存与会话创建。已有外部 DSH 不会被修改。
- 本机管理页支持独立授权、持久 OS 作业、接管和在线配对撤销；管理权限不能通过远端隧道取得。
- 配对后直接连接 Harness，支持回车提交；管理页可复制配对码。进入 Harness 后使用可拖动的 **dr** 浮钮打开控制。
- TLS、私有 CA、HTTPS DSH、通知订阅、慢客户端背压和多房间隔离均已纳入实测。
- PWA 离线缓存为 `dr.dsh-client-v14`。更新 relay 或 nginx 静态目录后，完整重载浏览器页面以使用新客户端；配对会保留。

两个组件分别更新。已有外部 DSH 路径、配对和插件归属会沿用。独立插件用户下载下方新包，通过 DSH 更新插件；要更新已安装 daemon，再到本机管理页应用插件附带版本。

### 独立插件包

Release 的 `drdsh-plugin-0.2.0.tgz` 同时包含 Linux x86_64 与 macOS Apple Silicon 的原生程序。
下载它和 `drdsh-plugin-0.2.0.tgz.sha256`，在同一目录校验后安装：

```sh
# macOS；Linux 可改用 sha256sum -c
shasum -a 256 -c drdsh-plugin-0.2.0.tgz.sha256
dsh plugin --profile web add /absolute/path/drdsh-plugin-0.2.0.tgz
```

打开本机 DSH 的 **dr.dsh 管理** 页面，按[插件指南](../../daemon/README.zh.md#从-dsh-插件管理-daemon)授权。
该包不含中继，Relay 需单独部署。插件原生缺包或版本不匹配时明确失败，不下载旧 Release 替代。

## v0.1.0 验证记录

- `pnpm run verify`：Rust、TS、CLI 单元测试、clippy、DSH 导入隔离和文档链接通过。
- `scripts/multicall-smoke.mjs`：15 项真实进程检查；覆盖同一二进制的三个包、禁用组件报错、
  带空格/引号/目录符号链接的 prefix、两侧 PID/配置隔离、插件、旧 Node 安装迁移与状态保留。
- `scripts/service-smoke.mjs`：旧入口 41 项真实进程回归检查通过。
- `scripts/release-installer-smoke.mjs`：5 项下载/摘要/固定版本/更新测试通过；显式 loopback
  镜像用于可控失败注入，安装器和原生程序都实际执行。
- Linux x86_64 musl 的实际产物在无 Node、pnpm、Cargo、Python、jq 的 Debian 12 systemd
  容器中通过 `scripts/relay-bundle-smoke.sh` 的 7 项安装、更新与生命周期检查。
- `scripts/nginx-static-smoke.mjs` 使用 release 优化构建的统一 CLI，通过 11 项 nginx、
  Chromium 配对、Service Worker、加密隧道、页面刷新与离线检查。DSH 使用鉴权进程替身；
  这不是一次新的真实上游 DSH 全量验收。

## v0.1.1 补丁

修复版本选项的名称分派：`drdsh-daemon --version` 与 `drdsh daemon --version`（relay 同理）
现在输出相同内容，`version` 与 `--help` 也经过同一分派。`multicall-smoke.mjs` 新增真实命令
输出对比，共 16 项通过。平台矩阵和同平台二进制同一性保持不变；默认安装/更新获取最新 Release。

同版本资源更新：README、网页标识、favicon、Apple Touch Icon、PWA 普通及 maskable 图标统一为
鲸鱼设计；浅色和深色页面使用对应的字标。离线缓存使用 `dr.dsh-client-v2` 获取新资源。
已安装到主屏幕的图标刷新时机由浏览器和操作系统决定。
