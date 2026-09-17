# dr.dsh Logo

“鲸鱼隧道”：在双端口标记中融入侧身鲸鱼，蓝色的圆弧构成鲸首，青色后半身向上延伸为尾鳍，
腹部留有小鳍。眼睛使用透明镂空，鲸身中的两个相向端口与短线继续表达设备配对和加密隧道。
两侧的 D 形轮廓呼应项目名称，字标中的青色句点延续连接主题。
设计依据是项目的[组件边界与数据流](../../docs/architecture.md)：设备在两端配对，relay 只转发不透明帧。

## 文件

| 文件 | 用途 | 画布 |
| :--- | :--- | :--- |
| [banner.txt](banner.txt) | CLI 启动时输出到 stderr 的 ASCII 鲸鱼标识 | 纯文本 |
| [logo.svg](logo.svg) | 浅色背景上的完整 Logo，透明底 | 600 × 160 |
| [logo-dark.svg](logo-dark.svg) | 深色背景上的完整 Logo，透明底 | 600 × 160 |
| [mark.svg](mark.svg) | 独立双色符号，透明底 | 64 × 64 |
| [mark-mono.svg](mark-mono.svg) | 单色符号，使用 `currentColor`，透明底 | 64 × 64 |
| [app-icon.svg](app-icon.svg) | 带蓝色圆角底的应用图标或头像 | 512 × 512 |

所有字形均为手绘矢量路径；文件不依赖字体、脚本、外部资源或嵌入位图。
可以直接导入矢量编辑器、通过 `<img>` 使用，或按需导出 PNG。

## 色彩与尺寸

| 颜色 | 浅色背景 | 深色背景 |
| :--- | :--- | :--- |
| 蓝色鲸首与通道 | `#2563EB`，沿用现有 PWA 主题色 | `#60A5FA` |
| 青色鲸身、尾鳍与句点 | `#0891B2` | `#22D3EE` |
| 字标 | `#0F172A` | `#F8FAFC` |

完整 Logo 建议显示宽度至少 200 px；独立符号建议至少 24 px，16 px 以鲸鱼轮廓和中央通道辨识为主。
保持原始宽高比，图形外留出至少一个主要笔画宽度的空白。深色版本适合 `#0F172A` 一类深底。
单色版内联到 HTML 时可由 CSS `color` 控制颜色；通过 `<img>` 引入时不继承页面颜色。

## 产品中的使用

中英文 README 使用本目录的深浅色 SVG。PWA 页头按系统主题切换完整字标；
没有安装 PWA 的中继提示页直接嵌入同一份 `logo.svg`，无需额外图片请求。
CLI 通过 `banner.txt` 使用鲸鱼与中央通道的 ASCII 表达。

| 入口 | 分发素材 |
| :--- | :--- |
| 网页页头 | [logo.png](../../apps/pwa/static/logo.png)、[logo-dark.png](../../apps/pwa/static/logo-dark.png)，720 × 192 |
| 浏览器标签页 | [favicon-16.png](../../apps/pwa/static/favicon-16.png)、[favicon-32.png](../../apps/pwa/static/favicon-32.png) |
| iPhone / iPad 主屏幕 | [apple-touch-icon.png](../../apps/pwa/static/apple-touch-icon.png)，180 × 180，满底 |
| PWA 安装图标 | [icon-192.png](../../apps/pwa/static/icon-192.png)、[icon-512.png](../../apps/pwa/static/icon-512.png) |
| 支持裁切的启动器 | [icon-maskable-512.png](../../apps/pwa/static/icon-maskable-512.png)，满底，鲸鱼位于中心安全区域 |

这些 PNG 均由本目录 SVG 导出并提交，正常构建与安装不需要图像工具。
修改 SVG 后，在装有 librsvg（`rsvg-convert`）的开发机器上运行：

```sh
pnpm run brand:generate
pnpm --filter @dr.dsh/pwa build
```

导出脚本为 Apple 与 maskable 图标去掉圆角，并缩小鲸鱼以保留裁切安全留白；
网页与 PWA 素材随客户端一起打包，由中继的固定 PNG 白名单或 nginx 提供。
两个主题的字标和所有平台图标都进入离线预缓存。缓存版本升级为 `dr.dsh-client-v2`，
已有用户联网加载并刷新后使用新素材；已安装的桌面图标何时更新由浏览器或操作系统决定。
