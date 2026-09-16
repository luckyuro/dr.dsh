# dr.dsh

[English](README.md) | 中文

**在手机或另一台电脑的浏览器里，继续使用自己电脑上的 DeepSeek Harness。**

dr.dsh 提供真实 DSH 界面的远程访问、进程管理与设备配对。
DSH 在你的电脑上运行，会话流量在浏览器与 daemon 之间端到端加密，经自托管的 relay 转发。

## 两个独立组件

| | Relay：中继服务器 | Daemon：DSH 所在电脑 |
| :--- | :--- | :--- |
| 功能 | 提供浏览器客户端（PWA）、转发加密流量、连接保活与健康检查 | 管理本机 DSH、设备配对、加密隧道、审计与崩溃记录 |
| 安装位置 | 你的服务器，也可与 daemon 同机 | 已安装 DSH 的电脑 |
| 一键安装 | `sh relay/install.sh --start` | `sh daemon/install.sh --start` |
| 管理命令 | `drdsh relay` | `drdsh daemon` |
| 独立说明 | **[Relay 安装与使用](relay/README.zh.md)** | **[Daemon 安装与使用](daemon/README.zh.md)** |

两侧各自拥有配置、程序目录、日志、系统服务和更新锁。更新或卸载一侧，不会重启或卸载另一侧。
中继重启会中断连接，需要重新连接；DSH 的进程继续运行。

```text
手机 / 浏览器 ⇄ Relay（中继 + PWA） ⇄ Daemon（你的电脑） → DSH
```

**当前版本 `0.1.0`，提供 GitHub Release 二进制包。** Linux x86_64 musl 提供混合包、relay 包与 daemon 包；
macOS Apple Silicon 提供 daemon 包。三个包使用同一套原生 CLI，同平台各包共用逐字节相同的二进制，包清单决定可用组件。
`drdsh-relay` / `drdsh-daemon` 是按名字选择组件的别名，详见[发布与安装](docs/operations/releases.md)。
没有 npm 发布包、官方托管中继或第三方安全审计。

## 快速开始

可以先在一台电脑上跑通，也可以分开部署。以下命令在各自机器的源码目录执行：

```sh
git clone https://github.com/luckyuro/dr.dsh.git
cd dr.dsh
```

Release 安装不需要 Rust、pnpm 或管理用 Node。Daemon 所在机器仍需 Node 和已配置好模型的 DSH。
Linux 使用 `systemctl --user`，macOS 使用图形登录会话。下面 relay 安装在 Linux x86_64 服务器；
daemon 可安装在该服务器或 Apple Silicon Mac。Linux 同机安装可用 `sh install.sh --component mixed --start`。

### 1. 安装 Relay

安装器从 Release 下载 relay 和已经构建好的 PWA，并核对 SHA-256：

```sh
sh relay/install.sh --start
export PATH="$HOME/.local/bin:$PATH"
drdsh relay status
```

看到 `relay health: responding` 后，中继已就绪。默认监听 `127.0.0.1:8787`。
手机或其他电脑访问时，需要配置[可访问的 HTTPS 入口](relay/README.zh.md#对外提供访问)。

### 2. 安装 Daemon

在 DSH 电脑上执行。以下地址适用于**同机中继**；中继位于服务器时，先按
[远端中继连接说明](daemon/README.zh.md#连接远端中继)建立安全转接，再使用转接后的本机地址。
将项目路径替换为已有目录：

```sh
sh daemon/install.sh --relay ws://127.0.0.1:8787 --workdir /path/to/your/project --start
export PATH="$HOME/.local/bin:$PATH"
drdsh daemon status
```

DSH 不在 PATH 中时添加 `--dsh /绝对路径/dsh`；已有 DSH 占用 `3080` 时可加 `--port 3081`。
安装器不安装或配置上游 DSH。集成核对基准为 DSH `0.1.5-rc.2`，升级上游后需重新核对兼容性。

两套命令默认安装在 `~/.local/bin`。`export` 只影响当前终端，可加入 shell 配置以便以后使用。

### 3. 配对并打开 DSH

在 DSH 电脑上运行，并保持命令等待：

```sh
drdsh daemon pair
```

1. 浏览器打开中继的 HTTPS 地址；同机试用可打开 [本机中继](http://127.0.0.1:8787)。
2. 在 **Pairing code or room key** 中输入终端显示的配对码，点击 **Connect**。
3. 显示 **Paired** 后，再点一次 **Connect** 建立隧道。
4. 点击 **Open the DeepSeek Harness interface**，在新标签页使用 DSH。

**保留原来的 dr.dsh 标签页**，它维持连接。配对码约 5 分钟有效，一次使用；失败或过期后重新生成。
浏览器会记住配对，下次选择已保存的电脑连接即可，也可以添加多台电脑。

## 日常管理

| 操作 | Relay | Daemon |
| :--- | :--- | :--- |
| 启动 | `drdsh relay start` | `drdsh daemon start` |
| 停止 | `drdsh relay stop` | `drdsh daemon stop` |
| 重启 | `drdsh relay restart` | `drdsh daemon restart` |
| 状态 | `drdsh relay status` | `drdsh daemon status` |
| 跟随日志 | `drdsh relay logs --follow` | `drdsh daemon logs --follow` |
| 登录自启动 | `drdsh relay enable` | `drdsh daemon enable` |
| 从 Release 更新 | `drdsh relay update` | `drdsh daemon update` |
| 卸载 | `drdsh relay uninstall` | `drdsh daemon uninstall` |

`disable` 取消登录自启动，`stop` 停止当前服务。卸载保留各自配置、日志及 daemon 的配对数据。
PWA 随 Relay 安装；可选插件在安装时加 `--with-plugin`，或从解压包运行 `drdsh daemon install plugin --source <bundle>`。

旧统一安装使用 `scripts/install-legacy.sh` 和已有旧命令；新 `install.sh` 使用 Release。
已有用户请按[迁移说明](docs/operations/cli.md#从旧版安装迁移)保留配对状态。

## 使用前了解

- DSH 电脑需要保持开机、联网且不休眠。
- 远程浏览器需要 HTTPS。当前 daemon 尚不能直连 WSS；分开部署时可使用 SSH 转接，详见 Daemon 文档。
- 目前没有后台推送，插件补充通知接收端也尚未实现；审批与提问在保持连接的真实 DSH 界面中处理。
- 中继同时分发浏览器客户端，其基础设施需要可信。当前尚无第三方安全审计，见[安全模型](docs/security.md)。

## 文档与开发

- **[Relay 文档](relay/README.zh.md)**：独立安装、命令、配置与 Docker 部署。
- **[Daemon 文档](daemon/README.zh.md)**：独立安装、远程连接、配对、插件与状态备份。
- [完整 CLI 与迁移](docs/operations/cli.md)、[故障排查](docs/operations/troubleshooting.md)、[MVP 进度](docs/product/mvp.md)。
- [架构](docs/architecture.md)、[设计决策](docs/decisions/README.md)、[贡献指南](docs/development/contributing.md)、[仓库规约](AGENTS.md)。

```sh
pnpm install
pnpm run verify
```

## 许可证

MIT。
