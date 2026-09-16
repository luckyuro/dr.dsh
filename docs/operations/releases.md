# 二进制发布与安装

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

仓库中的 `install.sh` 默认在 Linux 选择混合包、macOS 选择 daemon；`relay/install.sh` 和
`daemon/install.sh` 固定选择各自组件。下载、校验 SHA-256、解包后调用 Rust 安装器。
服务器不需要 Rust、pnpm 或管理用 Node；daemon 启动的 DSH 仍需用户预先安装 Node 与 DSH。

```sh
sh relay/install.sh --prefix "$HOME/.local" --bind 127.0.0.1:8787 --start --enable
sh daemon/install.sh --relay ws://127.0.0.1:8787 --dsh /absolute/path/to/dsh --start
sh install.sh --component mixed --dsh /absolute/path/to/dsh
# 固定版本，避免跟随 latest：
sh relay/install.sh --version v0.1.0
```

也可以只下载 GitHub 对应 tag 下的一个安装脚本到本地，再用 `sh` 运行；三个入口均为自包含 Shell
文件。安装下载失败或摘要不符时不会停止现有服务。`--start` 与 `--enable` 才会启动服务与开启
登录自启动；默认仅安装。Linux 使用 systemd 用户服务；macOS 使用 launchd 用户服务。

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
drdsh daemon update --version v0.1.0
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

构建机先运行 `pnpm install --frozen-lockfile`、`pnpm --filter @dr.dsh/pwa build`，再安装对应 Rust
target。`scripts/build-release.sh <target>` 编译并打包规定的组合；`scripts/package-release.sh`
可以单独打包已有二进制。Linux 在 blade 上使用 `x86_64-unknown-linux-musl`，不启用 `target-cpu=native`。

```sh
sh scripts/build-release.sh aarch64-apple-darwin
sh scripts/build-release.sh x86_64-unknown-linux-musl
```

开发机源码安装新 CLI：先 `cargo build -p dr-dsh-cli`，构建 PWA 后运行
`target/debug/drdsh relay install --source "$PWD" --skip-build --build-profile debug`。
旧管理路径的回归测试仍使用 `relay/install-source.sh`、`daemon/install-source.sh`。

发布前运行仓库 verify、包清单与名称分派检查及二进制同一性校验，以及真实进程的安装隔离和下载摘要失败测试；
再把四个压缩包与 `SHA256SUMS` 上传同一个源码 tag 的 Release。构建记录应列出源码、Rust 版本、
目标与摘要。当前是脚本辅助的人工发布流程，尚无自动签名、托管 CI 发布或可复现构建认证。

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
