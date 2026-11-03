# ADR-0025：远端工作区沿用 DSH 的主机目录浏览器

- 状态：已接受
- 日期：2026-10-29
- 接续：[ADR-0003](0003-no-fork-integration.md)
- 决策影响：daemon 的 DSH 启动契约、远端 workspace 创建

## 背景

DSH `0.2.1-rc.2` 已提供目录选择的 Host backend 和浏览器界面。默认
`directory-picker-auto` 根据监听地址、SSH 与图形会话选择 native 或 browse。
dr.dsh 保持 DSH 的 loopback 绑定，因此在 macOS 等主机上会被判断为本机使用：选目录窗口
弹在 DSH 主机上，远端用户无法操作。目录内容应来自 DSH 所在机器，不能使用访问页面的
手机或电脑的文件选择 API。

## 决策

daemon 在启动受管 DSH 前通过官方 `web --dump-config` 读取合成配置，仅当启用的默认
`directory-picker` 行仍使用 `dsh-host-directory-picker-auto` 时，追加固定的临时 overlay：
停用该 auto 行，启用 DSH 自带的 `dsh-host-directory-picker-browse` 和
`dsh-client-ui-directory-picker-browse`。明确配置的 native、browse、自定义或停用状态保持不变。
配置导出不会展开用户 include，因此存在可能启用的 include、目录相关的动态启停条件、
动态 group 配置或 overlay ID 冲突时也保持原配置；无关插件的动态启停条件不阻止适配。

overlay 为本机私有临时文件，内容编译进 daemon，不接受远端路径、模块名或启动参数；随
DSH 子进程的生命周期清理。它通过 DSH 支持的 `--patch` 接入，不改用户的
`cordis.patch.yml` 或包依赖。官方配置导出和正常启动一样会更新 DSH 自己的生成入口
`cordis.yml`，这不是用户 override 文件。预检失败给出启动阶段和修复建议，不记录配置正文。

目录浏览、新建文件夹和 workspace 创建继续使用 DSH 自己的 UI、API、鉴权和文件系统权限，
经原有加密隧道传输。没有新的 relay/daemon 目录列举接口，也不改变绑定或 trusted hosts。
附着到现有 DSH 的模式不改变其 profile；该实例须自行配置 browse 组合。

## 被否决的方案

- 浏览器本地文件选择器：选到访问设备的目录，无法代表 DSH 主机路径。
- 自建目录 API 或修改 DSH 核心：复制已有能力，扩大权限面及上游兼容工作。
- 伪造 SSH 环境或放宽监听/信任配置：把交互选择混入进程事实或安全边界。
- 无条件写入用户 profile：覆盖用户选择，还会与已有 browse backend 或界面重复加载。

## 后果

默认受管 DSH 在远端页面里显示真实主机目录，可以浏览、输入绝对路径、新建子文件夹并打开
workspace。可读范围仍由 DSH 运行用户的文件权限决定。自定义 profile 保留原行为。

启动增加一次受限的配置导出，且明确依赖 `0.2.1-rc.2` 的 CLI、配置结构及目录组件；升级时
必须复验。验收应通过真实 DSH 页面选择临时主机目录，并核对创建后的 canonical workspace
路径，而不能仅断言配置里出现了插件名称。
