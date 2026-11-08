# 校验、诊断与前端框架接入

共享包位于 [`packages/validation`](../../packages/validation/src/index.js)，由管理页、插件服务端与
PWA 使用。它没有运行时依赖，导入时不读取 DOM、浏览器存储、环境变量或文件，适用于浏览器和 SSR。
当前为仓库内私有包，没有发布到 npm；本地执行 `pnpm install` 和 `pnpm --filter @dr.dsh/validation typecheck`
即可生成类型声明。架构依据见 [ADR-0027](../decisions/0027-validation-and-diagnostics.md)。

## 核心接口

```ts
import { createSchemas, fieldErrors, validateConfiguration } from '@dr.dsh/validation';

const result = validateConfiguration({ relay: 'wss://relay.example', port: '3080' }, 'zh-CN');
if (result.issues) {
  // 使用框架自己的错误状态；不要记录原始表单或连接码。
  const errors = fieldErrors(result); // 字段名 → 第一条提示；全局错误为 _form
} else {
  const config = result.value; // port 为 number，可用于后续已授权操作
}
const schema = createSchemas('zh-CN').configuration;
const checked = schema['~standard'].validate({ relay: 'wss://relay.example', port: '3080' });
```

| 接口 | 输入与输出 |
| :--- | :--- |
| `validateConfiguration` / `schemas.configuration` | 完整表单，返回全部字段问题或规范化配置；不是任意服务端配置补丁 |
| `validateRelay` / `schemas.relay` | WS/WSS origin；拒绝账号、路径、查询、片段、控制字符与模糊 URL 写法 |
| `validatePort` / `schemas.port` | 数字或十进制字符串，返回 1–65535 的整数；拒绝指数、十六进制、布尔强转 |
| `validateCapability` / `schemas.capability` | 43 位 base64url 本机授权码的格式；不验证权限是否有效 |
| `validateCredential` / `schemas.credential` | 现有配对码归一化或房间密钥分类；不执行配对与密码学 |
| `fieldErrors` | 将 `issues` 映射为字段提示，不含原始输入 |

`schemas` 默认英文，`createSchemas('zh-CN')` 返回中文 schema。错误路径指向表单字段，
`code` 可用来定制提示。成功与失败均为同步对象，也可直接 `await`。

## 框架接入范围

接口符合 [Standard Schema V1](https://standardschema.dev/)。框架负责输入事件、错误展示和提交，
共享包负责数据校验。下面区分实际运行过的库适配和可复用方式，不把协议兼容等同于整套框架浏览器验收。

| 环境／框架 | 接入方式 | 本次验证范围 |
| :--- | :--- | :--- |
| 原生 HTML / Web Components | 输入事件调用纯函数，`aria-invalid` 与字段提示 | dr.dsh 两端真实 Chromium 页面 |
| React / React Hook Form | `standardSchemaResolver(schema)` | RHF `7.91.0`、resolvers `7.0.3`：字段错误、成功输出、端口转换 |
| Vue / VeeValidate | 函数规则返回首条问题或 `true` | VeeValidate `4.15.1`：失败与修正后的通过；不是假定其原生支持 Standard Schema |
| Angular | `ValidatorFn` 将问题映射为错误对象 | Angular Forms / Compiler `22.2.4`：真实 `FormControl` 错误与恢复 |
| TanStack Form 的 React / Vue / Angular / Solid / Svelte 绑定 | 将 schema 传给 validators | 公共 Form Core `1.33.5`：挂载字段、拒绝错误提交、修正后提交；未逐一渲染五种框架组件 |
| Preact、Qwik、其他前端框架 | 事件处理器直接调用纯函数 | 无框架专用 API；未声称完成这些框架的运行验收 |
| Next.js、Nuxt、SvelteKit、Astro 的服务器逻辑 | 服务端直接调用同一纯函数 | Node 下测试无 DOM 导入；未逐一构建宿主项目 |

这些版本于 **2026-11-06** 从 npm 核对并安装到隔离目录；生产程序不依赖这些框架。
“框架接入”指表单与校验的复用，不表示 daemon 新增了其他 AI Harness 或 Windows 管理支持。

### React Hook Form

```ts
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { createSchemas } from '@dr.dsh/validation';

const resolver = standardSchemaResolver(createSchemas('zh-CN').configuration);
// useForm({ resolver, defaultValues: { relay: '', port: 3080 } })
```

Resolver 返回转换后的 `values`，错误保留字段路径。
参见 [React Hook Form resolver 文档](https://github.com/react-hook-form/resolvers#standard-schema)。

### TanStack Form

```ts
import { createSchemas } from '@dr.dsh/validation';
const schema = createSchemas('zh-CN').configuration;
const options = {
  defaultValues: { relay: '', port: '3080' },
  validators: { onChange: schema, onSubmit: schema },
};
```

TanStack 验证 schema，但不会把转换结果自动写回表单值；提交时再次调用 `schema['~standard'].validate(value)`，
使用成功结果的 `value`。其[验证文档](https://tanstack.com/form/latest/docs/framework/react/guides/validation)
说明了触发时机和 Standard Schema 接口。各框架绑定共享的核心由实测脚本覆盖。

### Vue 与 Angular

```ts
import { schemas } from '@dr.dsh/validation';

// VeeValidate 的函数规则
const relayRule = (value: unknown) =>
  schemas.relay['~standard'].validate(value).issues?.[0]?.message ?? true;

// Angular ValidatorFn；使用本项目以外的 Angular 类型时按其标准接口声明
const portRule = (control: { value: unknown }) => {
  const result = schemas.port['~standard'].validate(control.value);
  return result.issues ? { drdsh: result.issues } : null;
};
```

参考 [VeeValidate 函数规则](https://vee-validate.logaretm.com/v4/guide/global-validators/)
和 [Angular 自定义校验器](https://angular.dev/guide/forms/form-validation)。
Svelte、Solid、Preact 等也可在自己的事件处理器中调用纯函数，再把 `fieldErrors(result)` 放入响应式状态。

## 结构化本机诊断

```sh
drdsh daemon doctor --json
```

输出 `version: 1`，`level` 为 `pass/warn/fail`，`checks` 的每项含 `id/title/level/message`，
警告和失败另有 `remedy`。失败退出 `1`；通过和警告退出 `0`。不指定 `--json` 保留原文本格式。
诊断不启动 DSH、不创建状态目录或修改配置；端口被占用只给警告，不会自动启用 attach。
报告只覆盖系统、CPU、审计、端口和 DSH 程序，网络与任务链路需另跑实测。

插件管理外层响应继续携带 `{text,truncated,exitCode}`，其中 `text` 为 JSON 报告。
旧程序的具名文本结果仍可展示；无法识别、截断或失败的报告不能显示为全部通过。

## 复验

```sh
pnpm run verify
cargo build --workspace
pnpm --filter @dr.dsh/pwa build
pnpm run smoke:doctor
node scripts/plugin-management-smoke.mjs --check-browser
node scripts/browser-management-smoke.mjs /absolute/path/dsh
```

浏览器脚本需要 `PLAYWRIGHT_MODULE` 与 `CHROMIUM_BIN`，或可直接导入的 Playwright/Chromium。
脚本会在临时 prefix 运行真实原生服务，检查字段错误、本机授权、诊断筛选、移动端布局、配对和 OS 作业。
真实 DSH 回归另用 `scripts/browser-embedded-smoke.mjs --dsh /absolute/path/dsh --check-offline`。
`browser-management-smoke` 使用真实临时 DSH profile 和完整插件包，验证独立本机授权、安装准备、
首次接管身份检查及取消确认、原生诊断、实际接管后的实例与作业恢复和清理。远端 HTTP/WS 管理路径拒绝由 embedded 脚本覆盖，
作业跨宿主强退由 plugin-management 脚本覆盖。

框架库只安装到忽略目录，脚本本身不会联网安装：

```sh
npm install --prefix target/validation-frameworks --ignore-scripts --no-audit --no-fund \
  @tanstack/form-core@1.33.5 @hookform/resolvers@7.0.3 react-hook-form@7.91.0 \
  vee-validate@4.15.1 @angular/forms@22.2.4 @angular/compiler@22.2.4 @standard-schema/spec@1.1.0
pnpm --filter @dr.dsh/validation typecheck
node scripts/framework-validation-smoke.mjs target/validation-frameworks
```

脚本还用 `@standard-schema/spec` 的正式声明编译消费者，验证输入、输出类型的兼容。
共享模块通过两端打包和预缓存进入产物；不会在运行时从 CDN 加载框架或校验库。
