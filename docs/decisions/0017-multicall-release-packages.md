# ADR-0017：统一原生 CLI 与分组件 Release

- 状态：已接受
- 日期：2026-09-17
- 决策影响：命令入口、分发、安装更新与本地管理

## 背景

用户要求混合包和两个独立包，统一使用 `drdsh relay ...` / `drdsh daemon ...`，允许按程序名字
选择组件，且独立包不能使用缺少的组件。Relay 服务器不应依赖 JS；两侧更新隔离仍遵循 ADR-0015。

## 决策

1. 新增 `dr-dsh-cli`。按用户要求，同平台所有包共用同一次构建产生的同一二进制。包清单指定
   relay、daemon 或两者；同包别名链接同一个 `drdsh`，argv[0] 选择默认组件。单组件包请求另一侧
   会明确报错，不需要单独的入口实现。源码仍保留可选 Cargo feature 供开发者裁剪。
2. 安装、服务、日志、更新、卸载都由 Rust CLI 管理。Shell 只做 HTTPS 下载、摘要校验、解包和
   启动程序。新路径两侧都不执行 Node 管理脚本；Node 留给 DSH、可选插件和构建/测试工具。
3. 每次 CLI 启动把 ASCII 鲸鱼 Logo 打到 stderr。内部 exec 不重复显示，stdout 保持命令输出。
4. 所有发布包的二进制都包含 daemon 密码学实现，不能宣称其密码学依赖闭包为空。包清单是
   本地分发约定，不是对抗本机文件所有者的权限边界。网络 relay crate 的依赖与 payload 边界
   不变，仍不依赖密码学 crate 或 control 模块。服务进程互相独立，relay 路径不调用 daemon。
5. 安装时给每侧自己的二进制副本、配置、锁和服务。统一名字在已安装组件之间分派，组件别名
   固定作用域。更新一侧不替换另一侧的副本，卸载后保留其配置和密钥。
6. 首次发布提供 macOS aarch64 daemon，以及 Linux x86_64 musl 的 mixed/relay/daemon 三包。
   PWA 随 relay，插件随 daemon。安装器从 GitHub Release 获取 tar.gz 与 SHA256SUMS，验证后安装；
   更新可固定版本。当前不承诺代码签名、第三方审计、自动 CI 发布或可复现构建。

## 兼容与取舍

ADR-0014/0015 的旧 Node CLI 与 ADR-0016 的旧 relay 管理入口保留为源码迁移和回归路径。
新独立配置继续使用相同 v1 字段与服务身份；旧统一 config.json 不隐式拆分。
同平台独立包和混合包二进制相同，压缩包由于清单与静态资源不同而大小不同。该选择减少构建
矩阵，但 relay 包比按 feature 裁剪的程序大，也包含不会在 relay 命令中执行的 daemon 实现。
CLI 管理层用 SHA-256 保持旧服务名兼容；这一依赖不进入网络 relay crate。

具体包矩阵、构建、安装与更新见 [二进制发布](../operations/releases.md)。
