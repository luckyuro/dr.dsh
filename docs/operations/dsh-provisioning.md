# daemon 自动安装 DSH 与插件

以下行为从 v0.2.0 起可用；旧二进制需先更新。

首次执行 `drdsh daemon install`，未传 `--dsh` 时会通过本机 npm 从
`https://registry.npmjs.org` 安装固定版本 **DSH 0.2.2-alpha.2**。主机须已安装
Node **24.9 或更新版本**及 npm；安装器不安装 Node，也不修改全局 npm 包或上游源码仓库。
DSH 的 Cordis、loader、include、group、timer、cosmokit 与 schemastery 使用已验收的 alpha.1 版本组合。
这些是 npm 安装约束，不修改 DSH 源码。DSH 顶层版本固定但底层范围仍浮动时，
曾出现首次提示无法保存（`settings/rejected: next is not a function`）和会话创建失败。
安装器现在固定这一组合，并在复用私有目录时检查版本；已有外部 `--dsh` 安装由用户维护。

默认 daemon 归属的插件会一并安装；`--plugin-owner external` 继续由 DSH 包管理器维护插件。

解压当前版本的新 daemon 包后，用包内程序安装（替换包目录与 relay 地址）：

```sh
/absolute/path/to/unpacked-bundle/bin/drdsh daemon install \
  --source /absolute/path/to/unpacked-bundle \
  --relay wss://relay.example.com --start
```

该命令省略 `--dsh` 和 `--with-plugin`，并在安装完成后启动服务。要登录时自动启动可再加
`--enable`；仅准备文件则去掉 `--start`。

安装位置为 `<prefix>/lib/dr.dsh/daemon/dsh/0.2.2-alpha.2/`，内含 npm 的 `package-lock.json`、
依赖和固定 Node 绝对路径的启动脚本。`daemon.json` 保存 `dshManaged: true`、
`dshVersion` 与该启动脚本的绝对路径。npm 安装、版本检查与插件 ESM 产物准备均在停止现有服务前完成。
失败会报告发生在哪一阶段；不会改用旧 Release 或 PATH 上另一个 DSH。
自动下载隔离用户与全局 npm 配置，固定官方 registry 并保留 TLS 证书校验；可使用已有的网络代理。

使用 `--dsh /absolute/path/to/dsh` 时，安装器使用所选程序并保留其外部归属。重新安装时，
已有 DSH 路径、插件归属和已选择的插件组件继续沿用；旧安装未选择插件时可用 `--with-plugin`
补装。该默认行为不自动迁移 `DSH_HOME`、会话、账号状态、设备登记或配对密钥。

插件产物使用普通 JavaScript ESM，可直接安装进 DSH 的 `node_modules`。源码安装调用
与 Release 相同的 `scripts/package-plugin-source.mjs`，因此源码安装仍需仓库的 pnpm 依赖。
插件始终包含管理页的 HTML/CSS/JS 和当前匹配版本的原生 daemon，不依赖下载旧版程序补齐。

不带 `--start` / `--enable` 时只完成安装，不启动服务或启用登录自启动。
卸载 daemon 保留私有 DSH 版本目录、配置和会话数据，便于重新安装；不会卸载全局 DSH。
独立插件模式与常驻 daemon 的生命周期边界见 [ADR-0026](../decisions/0026-plugin-owned-tunnel.md)。

验收命令：`node scripts/dsh-provision-smoke.mjs`。该脚本在临时 prefix 和 `DSH_HOME`
中下载真实 DSH、安装真实插件，验证版本及重复安装保留，并检查实际 DSH profile 中的插件注册。


若安装器报告私有依赖不兼容：停止 daemon，将错误中指出的私有**程序版本目录**移到备份位置，
然后重新安装。不要移动或删除 `DSH_HOME` 和 daemon 状态目录：它们保存会话和配对。
这个检查在停止服务或写入新配置之前失败，不会悄悄替换一个正在运行的外部 DSH。

完整首次使用验收：`node scripts/dsh-provision-smoke.mjs --check-browser`。
设置 `PLAYWRIGHT_MODULE` / `CHROMIUM_BIN` 指定浏览器依赖后，它还会在真实 Chromium 中确认预览提示，
验证设置保存并在刷新后保留；再检查损坏的依赖组合不会改写已有配置和 lockfile。
