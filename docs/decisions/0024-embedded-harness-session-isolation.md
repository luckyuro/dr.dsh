# ADR-0024：同页 Harness 与连接隔离

- 状态：已接受
- 日期：2026-10-29
- 接续：[ADR-0005](0005-pwa-and-service-worker.md)、[ADR-0007](0007-multiple-instances.md)

## 背景

原页面要求连接后另开 Harness 标签页，并保留连接页承载隧道。关闭连接页会让仍可见的 Harness
失去 HTTP 与 WebSocket 服务；同源多个页面还共用 BroadcastChannel、socket 编号与 Service
Worker 的最后一个端口，存在串线。HTTP 流从 1 分配、WS 流从 100 分配，也会在请求足够多时重叠。

生产中已观察到第二客户端的 counter 0 混入已有会话，daemon 报 `frame 0 arrived out of order`。
中继允许多个客户端进入同一房间，但当前 daemon carrier 只有一个由独立盐派生的加密会话，
简单扇出不提供多客户端隔离。客户端异步加密还可能让后分配的计数器先发送，回归测试已复现。

## 决定

1. shell 继续持有隧道；连接成功且 DSH 运行时在同页 iframe 自动显示 Harness。顶部提供返回
   连接管理、重新加载与断开。父页面 CSP 仅增加 `frame-src 'self'`，保留其他默认拒绝边界。
2. iframe 与父页经校验 origin 和 `event.source` 后建立专属 MessagePort，替代全局广播通道。
   文档重载时关闭其旧代理 socket。HTTP 与 WS 从同一隧道的分配器取得不重复流号。
3. 每次连接生成不含秘密的 viewId。Service Worker 把交接端口、所属 shell 和 iframe 文档绑定，
   HTTP 请求只进入其所属视图；没有绑定时明确失败，不回落到其他房间。Worker 更换时重新交接，
   收到确认后再宣布可用；旧端口待处理请求须结束，不能无限挂起。普通 Worker 空闲终止后再次
   启动不会触发 controllerchange，因此丢失路由时通知同源外壳各自恢复，并最多等待五秒重新绑定
   原文档。安装中的新 Worker 可让旧 Worker 结束包括 SSE 在内的长驻 HTTP 请求，释放激活阻塞；
   旧 Worker 退休后不再接受新路由。
4. 当前中继每房间只接受一个活跃客户端。第二连接在握手阶段明确拒绝，不能破坏原会话。
   daemon 重注册时关闭并移除属于旧会话的客户端；旧连接迟到的清理不影响新的 daemon。
   配对进程退出前已排队的回执仍允许交付。
5. WebCrypto 加密与写入共用顺序队列，严格按计数器次序发送。发送失败或主动关闭后不再发帧。

本次不改变帧格式、密钥派生、协议常量或共享向量；`MAX_DEVICES_PER_ROOM = 16` 仍是协议容量
常量，当前运行约束更窄。多台设备可登记并轮流使用；多房间仍分别连接各自 daemon。

## 被否决的方案

- 直接把连接页导航到 Harness：页面销毁即丢失隧道，Service Worker 不能独立持有它。
- 新连接自动踢掉健康旧连接：未完成设备鉴权的客户端也能反复驱逐使用者。
- 沿用广播与全局端口，靠随机 socket id 避碰：不能解决 HTTP 发往错误房间的问题。
- 把多客户端密文直接扇出当作并发支持：独立会话的盐与计数器不共享，必须另行设计路由和协议。

## 代价与边界

同一房间不能同时供两个浏览器使用，切换前必须断开原页面。浏览器需要支持 Service Worker
与同源 iframe；模型账户仍在 DSH 界面中登录。PWA 必须整包部署并更新离线缓存版本，旧页面
需要重新加载。iframe 只是传输与呈现容器，不改 DSH 核心，不绕过其登录或本机管理隔离。

当前 HTTP 代理仍等完整响应结束后交付，不新增 SSE 流式响应或 wire 取消消息。Worker 路由结束
时取消本机的响应收集器，迟到帧由不缓存正文的订阅丢弃，直到响应结束或 carrier 关闭；已经发往
daemon 的上游 HTTP 请求仍随该 carrier 结束清理。

验收必须覆盖真实 DSH 的 mux 往返、超过旧流号重叠点的并发 HTTP、文档重载、Worker 更换、
同浏览器多房间隔离和第二客户端被拒绝时第一会话持续可用。具体命令见
[贡献流程](../development/contributing.md)与[本机管理验收](../operations/daemon-management.md#验证)。
