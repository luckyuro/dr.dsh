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

构建机先运行 `pnpm install --frozen-lockfile`，再安装对应 Rust target。
`scripts/build-release.sh <target>` 编译并打包规定的组合；含 relay 的目标会先重新构建 PWA，
确保页面、Service Worker 和图标一起更新。`scripts/package-release.sh` 可以单独打包已有二进制，
此时需先运行 `pnpm --filter @dr.dsh/pwa build`。两个打包入口（含旧 `relay/package.sh`）都会
检查静态资源与源码一致、必要模块存在，拒绝漏图标、旧页面或混入测试文件的构建目录。
应先完成 verify 再构建发布 PWA，因为 typecheck 会向同一目录写入测试产物。
Linux 在 blade 上使用 `x86_64-unknown-linux-musl`，不启用 `target-cpu=native`。

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

若明确选择保持版本号并替换现有 Release，先备份该 Release 的所有附件与说明，再从同一份最终
源码重建四个压缩包。更新 `BUILDINFO.txt` 的源码提交和构建信息，重新生成覆盖它与四个压缩包的
`SHA256SUMS`，并让版本 tag 指向该提交。用 `gh release upload <tag> --clobber` 替换压缩包与
构建记录，**最后替换 `SHA256SUMS`**；随后重新下载并校验整套附件。逐个上传不是原子操作，
窗口内不匹配的下载会被安装脚本拒绝；重试即可，现有服务不会因此被停止。
原生 `update --version <tag>` 会重新下载同版本附件，无需改动版本号。

nginx 独立托管 PWA 时，从已校验的 relay 包取出 `client/`，放进新的发布目录，检查文件权限后
原子切换 nginx 根目录所用的 `current` 符号链接；保留旧目录供回滚。随后检查首页、图标、manifest、
Service Worker 与健康端点。仅切换静态目录不需要重启 relay，也不改变配对状态或 relay 配置。

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
