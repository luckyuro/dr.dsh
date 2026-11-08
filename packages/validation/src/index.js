/**
 * Shared by the local authority, management page and remote pairing form.
 * No DOM, framework or transport dependency: SSR and browser consumers use the same rules.
 * Errors contain field paths and codes, never rejected input or credentials.
 */
/** @typedef {'en' | 'zh-CN'} Locale */
/** @typedef {{code: string, message: string, path: readonly string[]}} Issue */
/** @template T @typedef {{value: T, issues?: undefined} | {issues: readonly Issue[]}} Result */
/** @template Input, Output @typedef {{'~standard': {version: 1, vendor: string, validate: (value: unknown) => Result<Output>, types?: {input: Input, output: Output}}}} Schema */
/** @typedef {{kind: 'code', code: string} | {kind: 'roomKey', roomKey: string}} Credential */
/** @typedef {{relay: string, port: number, dsh?: string, dshHome?: string, workdir?: string, caCert?: string | null, dshTls?: boolean, tlsInsecure?: boolean}} Configuration */
/** @typedef {Omit<Configuration, 'port'> & {port: string | number}} ConfigurationInput */

const messages = {
  required: ['This field is required.', '请填写此项。'],
  object: ['Provide a configuration object.', '请提供配置对象。'],
  unknown: ['This field is not supported.', '不支持此配置项。'],
  relay: ['Use a ws:// or wss:// origin, without credentials, path, query or fragment.', '请输入 ws:// 或 wss:// 中继地址，不要包含账号、路径、查询参数或片段。'],
  port: ['Enter a whole port number from 1 to 65535.', '请输入 1–65535 之间的整数端口号。'],
  path: ['Use an absolute path on the DSH computer, without control characters.', '请输入 DSH 电脑上的绝对路径，不要包含控制字符。'],
  boolean: ['Choose true or false.', '请选择开启或关闭。'],
  capability: ['Use the 43-character code from the local authorization file.', '请使用本机授权文件中的 43 位授权码。配对码不能用于本机授权。'],
  credential: ['Enter the complete pairing code (XXXX-XXXX-XX) or a 43-character room key.', '请输入完整配对码（XXXX-XXXX-XX）或 43 位房间密钥。'],
};
/** @param {keyof typeof messages} code @param {string} field @param {Locale} locale @returns {Issue} */
function issue(code, field, locale) {
  return { code, path: field ? [field] : [], message: messages[code][locale === 'zh-CN' ? 1 : 0] ?? 'Invalid input.' };
}
/** @template Input, Output @param {(input: unknown) => Result<Output>} validate @returns {Schema<Input, Output>} */
function schema(validate) { return { '~standard': { version: 1, vendor: 'dr.dsh', validate } }; }

/** @param {unknown} input @param {Locale} [locale] @returns {Result<string>} */
export function validateRelay(input, locale = 'en') {
  if (typeof input !== 'string' || !input.trim()) return { issues: [issue('required', 'relay', locale)] };
  const value = input.trim();
  try {
    const url = new URL(value);
    if (value.length > 4096 || /[\s\u0000-\u001f\u007f\\]/u.test(value)
      || !/^wss?:\/\/[^/?#\\\s]+\/?$/iu.test(value) || !['ws:', 'wss:'].includes(url.protocol)
      || !url.hostname || url.username || url.password || url.search || url.hash
      || /[?#]/u.test(value) || url.pathname !== '/') throw new Error();
    return { value };
  } catch { return { issues: [issue('relay', 'relay', locale)] }; }
}

/** @param {unknown} input @param {Locale} [locale] @returns {Result<number>} */
export function validatePort(input, locale = 'en') {
  const value = typeof input === 'string' && /^\d+$/u.test(input.trim()) ? Number(input.trim()) : input;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) return { issues: [issue('port', 'port', locale)] };
  return { value };
}

/** Local management currently runs on macOS and Linux, so paths use their native absolute form.
 * @param {unknown} input @returns {boolean} */
export function isLocalPath(input) {
  return typeof input === 'string' && input.startsWith('/') && input.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(input);
}

/** @param {unknown} input @param {Locale} [locale] @returns {Result<string>} */
export function validateCapability(input, locale = 'en') {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(input.trim())) return { issues: [issue('capability', 'capability', locale)] };
  return { value: input.trim() };
}

/** Mirrors the existing pairing alphabet; this classifies format, never authenticates a device.
 * @param {unknown} input @param {Locale} [locale] @returns {Result<Credential>} */
export function validateCredential(input, locale = 'en') {
  if (typeof input !== 'string' || !input.trim()) return { issues: [issue('required', 'credential', locale)] };
  const value = input.trim();
  if (value.length <= 256) {
    const code = value.toUpperCase().replace(/[-\s]/gu, '').replace(/[ILOU]/gu, c => c === 'O' ? '0' : c === 'U' ? 'V' : '1');
    if (/^[0-9A-HJKMNP-TV-Z]{10}$/u.test(code)) return { value: { kind: 'code', code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` } };
    if (/^[A-Za-z0-9_-]{43}$/u.test(value)) return { value: { kind: 'roomKey', roomKey: value } };
  }
  return { issues: [issue('credential', 'credential', locale)] };
}

/** Form boundary: returns all errors together, accepts decimal port strings, strips empty optional paths.
 * The privileged server still validates operation permissions and native configuration separately.
 * @param {unknown} input @param {Locale} [locale] @returns {Result<Configuration>} */
export function validateConfiguration(input, locale = 'en') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { issues: [issue('object', '', locale)] };
  const fields = /** @type {Record<string, unknown>} */ (input);
  const allowed = ['relay', 'port', 'dsh', 'dshHome', 'workdir', 'caCert', 'dshTls', 'tlsInsecure'];
  const issues = Object.keys(fields).filter(key => !allowed.includes(key)).map(() => issue('unknown', '', locale));
  const relay = validateRelay(fields.relay, locale);
  const port = validatePort(fields.port, locale);
  if (relay.issues) issues.push(...relay.issues);
  if (port.issues) issues.push(...port.issues);
  /** @type {Configuration} */
  const value = { relay: relay.issues ? '' : relay.value, port: port.issues ? 0 : port.value };
  for (const field of /** @type {const} */ (['dsh', 'dshHome', 'workdir', 'caCert'])) {
    const item = fields[field];
    if (item === undefined || item === '') continue;
    if (item === null && field === 'caCert') { value.caCert = null; continue; }
    if (!isLocalPath(item)) issues.push(issue('path', field, locale));
    else value[field] = /** @type {string} */ (item);
  }
  for (const field of /** @type {const} */ (['dshTls', 'tlsInsecure'])) {
    const item = fields[field];
    if (item === undefined) continue;
    if (typeof item !== 'boolean') issues.push(issue('boolean', field, locale));
    else value[field] = item;
  }
  return issues.length ? { issues } : { value };
}

/** @param {Locale} [locale] */
export function createSchemas(locale = 'en') {
  return {
    configuration: /** @type {Schema<ConfigurationInput, Configuration>} */ (schema(value => validateConfiguration(value, locale))),
    relay: /** @type {Schema<string, string>} */ (schema(value => validateRelay(value, locale))),
    port: /** @type {Schema<string | number, number>} */ (schema(value => validatePort(value, locale))),
    capability: /** @type {Schema<string, string>} */ (schema(value => validateCapability(value, locale))),
    credential: /** @type {Schema<string, Credential>} */ (schema(value => validateCredential(value, locale))),
  };
}
export const schemas = createSchemas();

/** Framework adapters can render these messages with their own reactive state.
 * @param {{issues?: readonly Issue[] | undefined}} result @returns {Record<string, string>} */
export function fieldErrors(result) {
  /** @type {Record<string, string>} */
  const errors = Object.create(null);
  for (const entry of result.issues ?? []) {
    const field = entry.path[0] ?? '_form';
    errors[field] ??= entry.message;
  }
  return errors;
}
