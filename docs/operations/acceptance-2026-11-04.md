# v0.2.0 发布验收（2026-11-04）

本次验证覆盖安装、配对、真实 DSH 界面、插件、本机管理、TLS、断线恢复与版本升级。
发现的问题已修复并复测；下表列出实际通过的范围。所有测试使用隔离目录和浏览器 profile，
没有使用用户模型凭据。历史部署记录见 [2026-10-30 验收](acceptance-2026-10-30.md)。

## 环境与产物

| 项目 | 本次使用 |
| :--- | :--- |
| macOS | Darwin 27.2.0，Apple Silicon，真实 launchd 用户会话 |
| Linux | Debian 12 x86_64 systemd 容器，在本机 OrbStack 中运行静态 musl 产物 |
| Node / 浏览器 | macOS Node 26.13.0、Chromium 151；Linux 管理测试 Node 24.22.2 |
| Rust | rustc 1.99.1；`--locked --release -p dr-dsh-cli`，默认 CPU 基线 |
| Linux 交叉构建 | cargo-zigbuild 0.24.0、Zig 0.17.0，`x86_64-unknown-linux-musl` |
| DSH | 官方 npm 包 `0.2.2-alpha.2`，并回归 `0.2.1-rc.5`；原上游源码目录未修改 |
| PWA | `dr.dsh-client-v14`，完成静态检查后重新构建 |
| 分发 | Linux mixed / relay / daemon 三包、macOS daemon 包、含双平台 native 的独立插件包 |

DSH `0.2.2-alpha.2` 使用本次固定并验证的 Cordis alpha.1 依赖组合，具体版本见
[兼容记录](../integration/dsh-surface.md#2026-11-04v020-发布兼容性)。
发布的 `BUILDINFO.txt` 记录源码提交、构建工具与二进制摘要，`SHA256SUMS` 覆盖全部附件。
同平台组件包中的原生程序及插件内的原生程序逐字节一致；PWA 逐文件匹配最终构建，
归档不携带测试文件或构建主机的扩展文件属性。

## 检查结果

| 检查 | 结果与范围 |
| :--- | :--- |
| `pnpm run verify` | Rust 322 项、TypeScript 349 项、CLI/打包脚本 9 项通过；clippy、类型、DSH 导入隔离与文档链接通过 |
| `browser-pairing-smoke.mjs` | **15/15**：回车一次提交，配对后自动连接真实 DSH；约 1.5 秒打开界面；保留 daemon PID、刷新免输入、崩溃报告落盘 |
| `browser-rooms-smoke.mjs` | **14/14**：v1 数据迁移、第二台电脑追加、一身份多房间、正确机器的审计记录、遗忘单台与切换无浏览器错误 |
| `browser-embedded-smoke.mjs` | `0.2.2-alpha.2` **19/19**，另含离线脚本 **6/6**；真实 mux、主机目录与新建目录、160 个并发 HTTP 拒绝、多房间隔离、Worker 更换与冷启动、第二客户端拒绝、重载与断开重连 |
| 慢传输与账号边界 | 上述 19 项内：11 MiB DSH 资源约 11.9 秒完成，不误报状态失败；断流后提示并恢复；账号状态可读，公网登录 callback 被 DSH 拒绝 |
| `0.2.1-rc.5` 界面回归 | 同页浏览器 **16/16**，包含独立离线 **6/6**；未重复慢传输项 |
| `browser-cache-upgrade-smoke.mjs` | **7/7**：v13→v14；缺模块时拒绝升级、旧缓存离线可用、配对保留、新缓存完整 SHA-256、不被后台逐文件替换 |
| `dsh-upgrade-smoke.mjs` | 两个 DSH 版本各 **6/6**：真实包安装/移除、审批与提问处理器保留、会话/目标/子代理事件元数据 |
| `plugin-connect-smoke.mjs --check-browser` | 两个 DSH 版本各 **11/11**：插件独立隧道、本机独立授权、设置重组前后目录选择、远端管理与生命周期拒绝、通知、重连和宿主退出清理 |
| `dsh-provision-smoke.mjs --check-browser` | **6/6**：默认私有安装、完整插件、首次设置保存与刷新、重装保留 lock、错误依赖在更改安装前拒绝 |
| `daemon-management-smoke.mjs` | **16/16**：本机接口、单实例、在线配对/撤销、运行中代理关闭、重启后的状态与设备策略 |
| `plugin-management-smoke.mjs` | macOS Release + `--check-browser` **8/8**；Linux Release **7/7**。含真实 HTTP 授权、持久 OS 作业、宿主强杀后完成、重授权恢复、更新/卸载/重装与状态保留 |
| 管理页手机布局 | 上述 macOS 8 项内：390×844 Chromium 中授权、真实剪贴板复制配对码、取消后清除、锁定页面，无横向溢出；DSH 宿主为脚本替身 |
| `plugin-owner-smoke.mjs` | **7/7**：外部插件归属、报告开关、一侧更新/卸载不改变另一侧 PID/配置 |
| `plugin-notification-smoke.mjs` | **13/13**：插件→鉴权接收→加密隧道→通知订阅，含拒绝、重连、DSH 重启与无离线积压 |
| `relay-transport-smoke.mjs` | **22/22**：WS/WSS 配对与控制、原生 TLS、HTTPS DSH、私有 CA、证书拒绝、显式 insecure 与报告重定向拒绝 |
| `relay-backpressure-smoke.mjs` | **7/7**：双向大载荷摘要一致、慢接收方不阻塞其他房间、无进展连接关闭并回收 |
| 服务与安装器 | macOS 旧服务入口 **41/41**、原生 multicall **22/22**、Release 下载入口 **13/13**；含参数、摘要失败、截断脚本与独立更新 |
| 审计、密钥、崩溃报告 | `audit-smoke.mjs` **16/16**、`room-key-smoke.mjs` **12/12**、`pwa-crash-smoke.mjs` **9/9** |
| Linux 服务 | `systemd-smoke.mjs` **10/10**；无语言运行时的 Relay bundle **7/7**。随后加入 Node 运行插件作业测试；最终 Relay 归档再次安装，健康端点为 `0.2.0`，实际提供的 `shell.js` 与包内一致 |

浏览器验收还检查了桌面与手机尺寸的截图。离线脚本同时验证未缓存网络请求确实失败；
Chromium 导航后重置 `navigator.onLine` 的模拟问题通过 DevTools 恢复网络指示状态处理，
没有关闭断网断言或把页面错误计为通过。

## 本次修复与体验改动

- **首次安装能保存设置。** 新下载的 DSH 曾被浮动 Cordis 依赖破坏，在直连页面也能复现。
  私有安装固定已验收组合并保留 lock；发现不匹配时先报错，不停止现有服务或改写已有配置。
- **输入一次即可进入 DSH。** 支持回车提交，配对后直接使用新身份连接。
  daemon 应用权限时的短暂重新注册只对明确的空房间拒绝重试约 5 秒；占用、认证或加密错误仍显式失败。
- **切换电脑先结束旧页面。** 先销毁旧 iframe 文档再关闭传输，避免旧页面的请求在主动切换时继续运行并产生错误。
- **配对码可复制。** 本机管理页展示浏览器可打开的 HTTP(S) 地址；复制失败时给出手动复制提示，取消、过期与锁定时清除码。
- **文档按使用场景重排。** 双语入口区分常驻 daemon 与随 DSH 运行的插件；补齐下载选包、自动安装、校验、升级与故障排查。

## 复验入口

```sh
pnpm run verify
pnpm --filter @dr.dsh/pwa build
cargo build --workspace

# 浏览器脚本需要 PLAYWRIGHT_MODULE 与 CHROMIUM_BIN，或环境中已有 Playwright。
node scripts/browser-embedded-smoke.mjs --dsh /absolute/path/dsh \
  --check-slow-transfer --check-offline --check-account-origin
node scripts/plugin-connect-smoke.mjs --dsh /absolute/path/dsh --check-browser
node scripts/plugin-management-smoke.mjs --check-browser
node scripts/browser-cache-upgrade-smoke.mjs --previous /absolute/path/previous-client
```

本次本机详细日志位于忽略目录 `target/acceptance-2026-11-04/`，截图位于 `output/playwright/`。
可分享的发布元数据与摘要放在 Release 附件中；测试身份、配对密钥和浏览器 profile 不进入仓库或 Release。

## 本次未覆盖的范围

- 没有运行新的付费模型任务或全量长输出/工具调用验收。审批、提问与通知采用真实 DSH 服务和构造事件，
  不等同于真实模型任务端到端验收；历史结果见[模型测试记录](../development/plugin-model-test.md)。
- 手机验收使用 Chromium 的手机尺寸，未新增 iOS Safari、Android 实机或 Windows 原生服务验收。
- 原 Linux 构建主机不可达，本次 Linux 结论来自明确列出的 systemd 容器；未更新现有公网部署。
- 未新增 QEMU 旧 CPU、长时间 soak 或滚动性能测试，不以默认 CPU 基线替代实测。
- 未做第三方审计、独立代码签名或可复现构建认证。DSH 原有鉴权与公网登录回调限制仍保留。
