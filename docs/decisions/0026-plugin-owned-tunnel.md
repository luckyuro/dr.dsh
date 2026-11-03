# ADR-0026：插件独立连接与可选常驻 daemon

- 状态：已接受
- 日期：2026-10-30
- 决策影响：插件、原生隧道入口、运行模式与部署
- 接续：扩展 [ADR-0022](0022-plugin-managed-daemon-foundation.md) 的运行模式；保留 [ADR-0023](0023-plugin-local-management.md) 的本机管理授权与 OS 作业边界

## 背景

用户需要只安装 DSH 插件即可连接 relay；只有在需要远程启动、重启和崩溃恢复时，才安装常驻
daemon。原实现把隧道和监督都放在 daemon 中，插件没有 relay 配置，不能满足这一使用方式。
DSH 已提供生成本进程授权 URL 的接口，无需修改上游或放宽其鉴权。

## 决策

1. 插件显式配置 `relayUrl` 后启动随包原生连接进程；未配置时不连接公网。它复用原有
   Rust 加密、配对、代理、审计和重连实现，以 attach 模式访问当前 DSH，没有监督权。
2. `drdsh daemon plugin-connect` 只从私有 stdin 首行读取版本化 JSON，包含 relay、状态目录、
   当前 loopback 端口与 DSH capability。capability 不进入 argv、配置文件和日志。
   stdout 的 ready JSON 只交回父插件，提供临时回环报告权限和非秘密 room ID。
3. 插件生命周期持有 stdin；卸载时关闭并回收子进程。宿主异常退出导致 EOF，原生连接也退出。
   不使用 detached 子进程，不安装系统服务，不宣称 DSH 停止后还能通过该连接远程启动。
4. 常驻 daemon 模式仍支持启动、停止、重启和崩溃恢复。受管宿主优先使用 daemon 注入的报告
   权限，不能再启动一条插件连接。daemon 的 relay 配置决定该模式的远端地址。
5. 独立模式保存自己的私有状态目录，复用原有设备登记与本机 socket。目录不与受管 daemon
   默认混用。切换运行模式不自动覆盖设备或房间身份。
6. Relay 与 PWA 的 wire 协议不变。Relay 仍只转发密文；独立模式报告 `owned=false`，
   生命周期命令明确拒绝。本机 `/_drdsh` 管理隔离在两种模式下均有效。

## 被否决的方案

- 在 TypeScript 中复制整套加密服务端、配对和代理。会增加第三份协议实现与安全维护面。
- 插件直接向 relay 上报明文。会使 relay 感知 DSH 事件，并违反零知识边界。
- 为实现远程账号登录而伪造 DSH 接受的 callback origin。上游的 loopback 登录限制继续有效；
  用户可通过官方本机入口登录后复用主机账号状态，或配置 API key。

## 后果

常驻 daemon 成为可选能力；单包插件仍需要随包原生程序。独立模式随 DSH 停止而离线，
重新启动 DSH 后按原状态重连。DSH 服务接口新增 `connection.authenticatedUrl` 的兼容核查点；
插件与随包 native 必须一起发布。验证要同时覆盖正常卸载和宿主被强制终止。
