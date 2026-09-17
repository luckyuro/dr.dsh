/** The PWA owns these messages; daemon diagnostics and the tunneled DSH UI keep their own language. */
const en = {
  'page.intro': 'This page connects your browser to the DeepSeek Harness running on your own computer. Traffic is end-to-end encrypted: this relay forwards it without being able to read it.',
  'page.credential': 'Pairing code or room key',
  'page.pairingHint': 'On the computer running DSH, run `drdsh daemon pair` (or `drdsh-daemon pair`) and keep the command running. Codes expire after five minutes and can be used for one attempt, even if it fails.',
  'page.connectionHint': 'Enter the pairing code and press Connect. After pairing succeeds, press Connect again to open the tunnel.',
  'page.reconnectHint': 'Leave this field empty and press Connect to use the selected computer. To add another computer, run `drdsh daemon pair` there and enter its fresh code here.',
  'page.reconnectPlaceholder': 'Leave empty to reconnect',
  'page.connect': 'Connect',
  'page.forgetAll': 'Forget all computers',
  'page.computers': 'Your computers',
  'page.open': 'Open the DeepSeek Harness interface',
  'page.keepOpen': 'The DSH interface opens in a new tab. Keep this dr.dsh tab open to maintain the tunnel, and keep your DSH computer awake and online.',
  'page.help': 'Setup and troubleshooting',
  'page.helpDaemon': 'On the DSH computer, check `drdsh daemon status`. If the service is stopped, run `drdsh daemon start`. Use `drdsh daemon logs --follow` or `drdsh daemon doctor` to investigate a failure.',
  'page.helpHttps': "Open this relay’s HTTPS address on remote devices. The browser and daemon must reach the same relay; localhost HTTP is only for testing on the relay computer.",
  'page.helpPair': 'To pair another computer, run `drdsh daemon pair` there and enter its code here. Existing pairings stay in Your computers.',
  'page.helpForget': 'Forgetting removes saved pairings from this browser. To revoke access on the DSH computer, use `drdsh daemon devices`, then `drdsh daemon devices --revoke <id>`. Read local audit and crash reports with `drdsh daemon audit` and `drdsh daemon crashes`.',
  'page.helpKey': "A room key is only for a daemon explicitly configured with that same key. `drdsh daemon room-key` generates a new key; it does not show the installed daemon’s key. Use pairing for an existing installation.",
  'page.helpRelay': 'On the relay server, check `drdsh relay status` and `drdsh relay logs --follow`. For Release installations, `drdsh relay update` updates the relay and its PWA; `drdsh daemon update` runs separately on the DSH computer. If nginx serves the PWA directly, its static files must also be updated.',
  'page.daemonGuide': 'Daemon setup guide',
  'page.relayGuide': 'Relay hosting guide',
  'page.privacy': 'Keep pairing codes and room keys private. Pairings are saved in this browser for this relay address. Clearing site data or forgetting a computer requires pairing again to reconnect.',
  'language.switch': 'Switch to Chinese',
  'device.one': 'Paired as {id} with {label}.',
  'device.many': 'Paired as {id} with {count} computers.',
  'room.selected': 'Selected {label}. Press Connect.',
  'room.never': 'never connected',
  'room.lastUsed': 'last used {date}',
  'room.forget': 'Forget',
  'room.forgot': 'Forgot {label} in this browser. To revoke access, run `drdsh daemon devices --revoke {id}` on that computer.',
  'room.forgotAll': 'This browser forgot every computer. Pair again to reconnect. To revoke access, run `drdsh daemon devices --revoke {id}` on each computer.',
  'state.connecting': 'Connecting…',
  'state.pairing': 'Pairing with your computer…',
  'state.waiting': 'Waiting for the daemon to answer. Keep `drdsh daemon pair` running on the DSH computer.',
  'state.paired': 'Paired as {id} with {label}. Press Connect to open the tunnel.',
  'state.ready': 'Connected. Keep this dr.dsh tab open while using the DSH interface.',
  'offline.paired': 'This device is offline, so dr.dsh cannot reach the relay. Your computer may still be running DSH, and this browser still remembers the pairing. When the network is back, leave the code field empty and press Connect for the selected computer.',
  'offline.unpaired': 'This device is offline, so dr.dsh cannot reach the relay. Pairing needs the network: reconnect, then run `drdsh daemon pair` on the DSH computer and enter its fresh code here.',
  'panel.disconnected': 'Not connected to your computer',
  'panel.connectHint': 'Select a saved computer and press Connect, or run `drdsh daemon pair` on the DSH computer and enter its code here.',
  'panel.noConnection': 'there is no connection to send this to',
  'panel.dropped': 'The connection to the relay dropped',
  'panel.droppedHint': 'Your computer may still be running DSH. This is the link between this browser and the relay — check your own network, then press Connect. If it keeps failing, ask the relay operator to check `drdsh relay status` and `drdsh relay logs --follow`.',
  'panel.silent': 'Your computer is not answering',
  'panel.silentHint': 'The daemon did not reply. It may have stopped, or the machine may be asleep. Wake the DSH computer and check `drdsh daemon status` and `drdsh daemon logs --follow` there.',
  'panel.noAnswer': 'the daemon is not answering',
  'panel.asking': 'Asking your computer what it is doing.',
  'panel.waiting': 'waiting for the first answer',
  'panel.relay': 'The relay is {state}.',
  'panel.process': 'Process {pid}.',
  'action.busy': 'an operation is already running',
  'action.alreadyRunning': 'DSH is already running',
  'action.notRunning': 'DSH is not running',
  'action.start': 'Start DSH',
  'action.stop': 'Stop DSH',
  'action.restart': 'Restart DSH',
  'dsh.running': 'DSH is running',
  'dsh.runningRelay': 'DSH is running; the relay is {state}',
  'dsh.starting': 'DSH is starting — this usually takes a few seconds',
  'dsh.stopping': 'DSH is shutting down',
  'dsh.stopped': 'DSH is stopped',
  'dsh.attached': 'DSH was started outside this daemon, so it cannot be controlled from here',
  'dsh.failed': 'DSH could not be kept running',
  'dsh.failedReason': 'DSH could not be kept running: {reason}',
  'dsh.unknown': 'DSH state is unknown',
  'relay.connected': 'reachable',
  'relay.reconnecting': 'reconnecting — your computer is trying to reach it again',
  'relay.rejected': 'refused — the relay rejected this daemon, which needs an operator',
  'relay.unreachable': "unreachable — check your computer’s network",
  'relay.unknown': 'in an unknown state',
  'error.load': 'This browser could not load the PWA JavaScript files. Reload this page. If it still fails, ask the relay operator to check the published PWA files; Release installations can use `drdsh relay update`. If nginx serves the PWA directly, update its static files too. ({reason})',
  'error.remember': 'This browser cannot remember a pairing: {reason}',
  'error.forget': 'Could not forget that computer: {reason}',
  'error.forgetAll': 'Could not forget the saved computers: {reason}',
  'error.connection': 'Could not connect: {reason}',
  'error.noPairing': 'this browser has no pairing and no key was given. On the DSH computer, run `drdsh daemon pair`, keep it running, then enter its code here and press Connect.',
  'error.emptyCredential': 'Enter the code `drdsh daemon pair` printed on the DSH computer. Keep that command running while you pair.',
  'error.invalidCredential': "That is neither a pairing code (10 symbols like 7Q4M-2XKP-9T) nor a room key (43 URL-safe characters matching the daemon’s configured key). Run `drdsh daemon pair` on the DSH computer and paste its code here. Codes expire after five minutes and allow only one attempt.",
  'error.roomKeyEncoding': 'the room key is not valid base64url',
  'error.roomKeyLength': 'a room key is 32 bytes (43 base64url characters), got {length}',
  'error.relayUnreachable': 'cannot reach the relay',
  'error.deviceRevoked': 'this device is not paired with that daemon any more. Run `drdsh daemon pair` on the DSH computer and enter its new code here.',
  'error.deviceRefused': 'the daemon refused this device',
  'error.deviceRequired': 'the daemon requires a paired device and this client is not paired. Run `drdsh daemon pair` on the DSH computer and enter its code here; a room key alone cannot register this browser.',
  'error.relayHandshake': 'the relay never answered the handshake',
  'error.relayRefused': 'the relay refused this client: {reason}',
  'error.noReason': 'no reason given',
  'error.workerUnsupported': 'this browser does not support service workers here, which the DSH interface needs. Open the relay over HTTPS (localhost HTTP works for local testing) in a browser with service worker support.',
  'error.workerControl': 'the service worker does not control this page yet. Reload this page, then press Connect again.',
  'error.pairingMismatch': 'the daemon refused the pairing: the code does not match the one it displayed. Check the code and run `drdsh daemon pair` again on the DSH computer — a code is spent by the attempt, whether or not it was right.',
  'error.pairingRefused': 'the daemon refused the pairing: {reason}',
  'error.pairingTimeout': 'no daemon answered in the pairing room for this code within {seconds} seconds. Check that `drdsh daemon pair` is still running on the DSH computer and that the code has not expired. Both devices must reach the same relay.',
  'error.pairingStep': 'the daemon did not send {step} within {seconds} seconds. Check that `drdsh daemon pair` is still running on the DSH computer and that the code has not expired. Both devices must reach the same relay.',
  'pairing.pake': 'its half of the PAKE',
  'pairing.enrolment': 'an answer to the enrolment',
  'credential.code': 'pairing code {code}',
  'credential.key': 'a room key',
} as const;

export type MessageKey = keyof typeof en;
export type Locale = 'en' | 'zh-CN';

const zh: Record<MessageKey, string> = {
  'page.intro': '通过此页面，你可以从浏览器连接自己电脑上运行的 DeepSeek Harness。流量经过端到端加密，中继只负责转发，无法读取内容。',
  'page.credential': '配对码或房间密钥',
  'page.pairingHint': '在运行 DSH 的电脑上执行 `drdsh daemon pair`（或 `drdsh-daemon pair`），并保持命令运行。配对码五分钟后过期，每个码只允许尝试一次，即使配对失败也会失效。',
  'page.connectionHint': '输入配对码后点击“连接”。配对成功后，再次点击“连接”以建立隧道。',
  'page.reconnectHint': '将此栏留空并点击“连接”，即可使用已选电脑。要添加另一台电脑，请在那台电脑上运行 `drdsh daemon pair`，然后在这里输入新的配对码。',
  'page.reconnectPlaceholder': '留空以重新连接',
  'page.connect': '连接',
  'page.forgetAll': '忘记所有电脑',
  'page.computers': '你的电脑',
  'page.open': '打开 DeepSeek Harness 界面',
  'page.keepOpen': 'DSH 界面将在新标签页中打开。请保持此 dr.dsh 标签页打开以维持隧道，并让运行 DSH 的电脑保持唤醒和联网。',
  'page.help': '设置与故障排查',
  'page.helpDaemon': '在运行 DSH 的电脑上执行 `drdsh daemon status` 查看状态。如果服务已停止，运行 `drdsh daemon start`。使用 `drdsh daemon logs --follow` 或 `drdsh daemon doctor` 排查故障。',
  'page.helpHttps': '在远程设备上打开此中继的 HTTPS 地址。浏览器和守护进程必须连接到同一中继；localhost HTTP 仅用于在中继所在电脑上测试。',
  'page.helpPair': '要配对另一台电脑，请在那台电脑上运行 `drdsh daemon pair`，然后在这里输入配对码。已有配对会保留在“你的电脑”中。',
  'page.helpForget': '“忘记”会从当前浏览器移除保存的配对。要在运行 DSH 的电脑上撤销访问权限，请先运行 `drdsh daemon devices`，再运行 `drdsh daemon devices --revoke <id>`。使用 `drdsh daemon audit` 和 `drdsh daemon crashes` 查看本机审计日志和崩溃报告。',
  'page.helpKey': '房间密钥仅适用于明确配置了同一密钥的守护进程。`drdsh daemon room-key` 会生成新密钥，而不是显示已安装守护进程的密钥。已有安装请使用配对方式。',
  'page.helpRelay': '在中继服务器上执行 `drdsh relay status` 和 `drdsh relay logs --follow` 查看状态与日志。通过 Release 安装时，`drdsh relay update` 更新中继及其 PWA；`drdsh daemon update` 则需在运行 DSH 的电脑上单独执行。如果 nginx 直接托管 PWA，还需要更新其静态文件。',
  'page.daemonGuide': '守护进程安装指南',
  'page.relayGuide': '中继部署指南',
  'page.privacy': '请妥善保管配对码和房间密钥。配对信息保存在当前浏览器中，仅用于此中继地址。清除网站数据或忘记电脑后，需要重新配对才能连接。',
  'language.switch': '切换为英文',
  'device.one': '已使用设备身份 {id} 与 {label} 配对。',
  'device.many': '已使用设备身份 {id} 与 {count} 台电脑配对。',
  'room.selected': '已选择 {label}，点击“连接”即可。',
  'room.never': '尚未连接',
  'room.lastUsed': '上次使用：{date}',
  'room.forget': '忘记',
  'room.forgot': '已在此浏览器中忘记 {label}。要撤销访问权限，请在那台电脑上运行 `drdsh daemon devices --revoke {id}`。',
  'room.forgotAll': '此浏览器已忘记所有电脑。请重新配对后连接。要撤销访问权限，请在每台电脑上运行 `drdsh daemon devices --revoke {id}`。',
  'state.connecting': '正在连接…',
  'state.pairing': '正在与电脑配对…',
  'state.waiting': '正在等待守护进程响应。请保持 DSH 电脑上的 `drdsh daemon pair` 命令运行。',
  'state.paired': '已使用设备身份 {id} 与 {label} 配对。点击“连接”以建立隧道。',
  'state.ready': '已连接。使用 DSH 界面时，请保持此 dr.dsh 标签页打开。',
  'offline.paired': '当前设备已离线，dr.dsh 无法连接中继。你的电脑可能仍在运行 DSH，此浏览器也仍保留配对信息。网络恢复后，将配对码栏留空并点击“连接”，即可连接已选电脑。',
  'offline.unpaired': '当前设备已离线，dr.dsh 无法连接中继。配对需要网络：请恢复网络连接，然后在运行 DSH 的电脑上执行 `drdsh daemon pair`，并在此处输入新的配对码。',
  'panel.disconnected': '尚未连接到你的电脑',
  'panel.connectHint': '请选择已保存的电脑并点击“连接”，或在运行 DSH 的电脑上执行 `drdsh daemon pair`，然后在此处输入配对码。',
  'panel.noConnection': '尚未建立连接，无法发送操作',
  'panel.dropped': '与中继的连接已断开',
  'panel.droppedHint': '你的电脑可能仍在运行 DSH。中断的是当前浏览器与中继之间的连接，请检查当前设备的网络后点击“连接”。如果问题持续，请让中继管理员检查 `drdsh relay status` 和 `drdsh relay logs --follow`。',
  'panel.silent': '你的电脑没有响应',
  'panel.silentHint': '守护进程没有回复，可能已经停止，或电脑处于睡眠状态。请唤醒运行 DSH 的电脑，并在那台电脑上检查 `drdsh daemon status` 和 `drdsh daemon logs --follow`。',
  'panel.noAnswer': '守护进程没有响应',
  'panel.asking': '正在查询电脑的运行状态。',
  'panel.waiting': '正在等待首次响应',
  'panel.relay': '中继状态：{state}。',
  'panel.process': '进程 {pid}。',
  'action.busy': '已有操作正在执行',
  'action.alreadyRunning': 'DSH 已在运行',
  'action.notRunning': 'DSH 未在运行',
  'action.start': '启动 DSH',
  'action.stop': '停止 DSH',
  'action.restart': '重启 DSH',
  'dsh.running': 'DSH 正在运行',
  'dsh.runningRelay': 'DSH 正在运行；中继状态：{state}',
  'dsh.starting': 'DSH 正在启动，通常需要几秒钟',
  'dsh.stopping': 'DSH 正在关闭',
  'dsh.stopped': 'DSH 已停止',
  'dsh.attached': 'DSH 由此守护进程之外的程序启动，无法在这里控制',
  'dsh.failed': '无法保持 DSH 运行',
  'dsh.failedReason': '无法保持 DSH 运行：{reason}',
  'dsh.unknown': 'DSH 状态未知',
  'relay.connected': '可连接',
  'relay.reconnecting': '正在重连，你的电脑正在尝试重新连接中继',
  'relay.rejected': '已拒绝，中继拒绝了此守护进程，需要管理员处理',
  'relay.unreachable': '无法连接，请检查电脑的网络',
  'relay.unknown': '未知',
  'error.load': '此浏览器无法加载 PWA 的 JavaScript 文件。请刷新页面；如果仍然失败，请让中继管理员检查发布的 PWA 文件。通过 Release 安装时可运行 `drdsh relay update`；如果 nginx 直接托管 PWA，还需更新其静态文件。（{reason}）',
  'error.remember': '此浏览器无法保存配对信息：{reason}',
  'error.forget': '无法忘记这台电脑：{reason}',
  'error.forgetAll': '无法忘记已保存的电脑：{reason}',
  'error.connection': '无法连接：{reason}',
  'error.noPairing': '此浏览器没有配对信息，也没有输入密钥。请在运行 DSH 的电脑上执行 `drdsh daemon pair` 并保持命令运行，然后在此处输入配对码并点击“连接”。',
  'error.emptyCredential': '请输入 DSH 电脑上 `drdsh daemon pair` 显示的配对码。配对期间请保持该命令运行。',
  'error.invalidCredential': '输入内容既不是配对码（10 个字符，例如 7Q4M-2XKP-9T），也不是房间密钥（与守护进程配置一致的 43 个 URL 安全字符）。请在运行 DSH 的电脑上执行 `drdsh daemon pair`，然后将配对码粘贴到这里。配对码五分钟后过期，且只能尝试一次。',
  'error.roomKeyEncoding': '房间密钥不是有效的 base64url 编码',
  'error.roomKeyLength': '房间密钥应为 32 字节（43 个 base64url 字符），当前为 {length} 字节',
  'error.relayUnreachable': '无法连接中继',
  'error.deviceRevoked': '此设备与守护进程的配对已失效。请在运行 DSH 的电脑上重新执行 `drdsh daemon pair`，然后在这里输入新的配对码。',
  'error.deviceRefused': '守护进程拒绝了此设备',
  'error.deviceRequired': '守护进程要求设备先配对，而此浏览器尚未配对。请在运行 DSH 的电脑上执行 `drdsh daemon pair`，然后在此处输入配对码；仅凭房间密钥无法注册此浏览器。',
  'error.relayHandshake': '中继未响应握手请求',
  'error.relayRefused': '中继拒绝了此客户端：{reason}',
  'error.noReason': '未提供原因',
  'error.workerUnsupported': '当前环境不支持 DSH 界面所需的 Service Worker。请在支持 Service Worker 的浏览器中通过 HTTPS 打开中继（本机测试可使用 localhost HTTP）。',
  'error.workerControl': 'Service Worker 尚未接管此页面。请刷新页面，然后再次点击“连接”。',
  'error.pairingMismatch': '守护进程拒绝了配对：配对码与电脑上显示的不一致。请检查配对码，并在运行 DSH 的电脑上重新执行 `drdsh daemon pair`。无论配对成功与否，每个配对码只能尝试一次。',
  'error.pairingRefused': '守护进程拒绝了配对：{reason}',
  'error.pairingTimeout': '在 {seconds} 秒内，没有守护进程响应此配对码。请确认 DSH 电脑上的 `drdsh daemon pair` 仍在运行，且配对码尚未过期。两台设备必须连接到同一中继。',
  'error.pairingStep': '守护进程未在 {seconds} 秒内发送{step}。请确认 DSH 电脑上的 `drdsh daemon pair` 仍在运行，且配对码尚未过期。两台设备必须连接到同一中继。',
  'pairing.pake': '其 PAKE 消息',
  'pairing.enrolment': '设备注册响应',
  'credential.code': '配对码 {code}',
  'credential.key': '房间密钥',
};

export const messages: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { en, 'zh-CN': zh };
export const LOCALE_STORAGE_KEY = 'dr.dsh.locale';
let locale: Locale = 'en';

/** The first supported browser preference wins; unknown languages fall back to English. */
export function resolveLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'en' || saved === 'zh-CN') return saved;
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/u)[0];
    if (base === 'zh') return 'zh-CN';
    if (base === 'en') return 'en';
  }
  return 'en';
}

export function getLocale(): Locale { return locale; }
export function setLocale(next: Locale): void { locale = next; }

export function t(key: MessageKey, params: Readonly<Record<string, string | number>> = {}): string {
  // A function replacement keeps $&, $` and $' in device names literal, and never re-interpolates them.
  return messages[locale][key].replace(/\{(\w+)\}/gu, (placeholder, name: string) => String(params[name] ?? placeholder));
}

export type DisplayText = string | (() => string);
export function displayText(value: DisplayText): string {
  return typeof value === 'function' ? value() : value;
}

/** Keep the cause, not a translated snapshot, so switching language also redraws an existing failure. */
export class LocalizedError extends Error {
  public constructor(message: DisplayText) {
    super();
    Object.defineProperty(this, 'message', { configurable: true, get: () => displayText(message) });
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Storage may be denied by browser policy. Language selection must still work for this visit. */
export function readLocale(storage: () => LocaleStorage, languages: readonly string[]): Locale {
  let saved: string | null = null;
  try { saved = storage().getItem(LOCALE_STORAGE_KEY); } catch { /* Use the browser preference. */ }
  return resolveLocale(saved, languages);
}

export function saveLocale(storage: () => LocaleStorage, next: Locale): void {
  setLocale(next);
  try { storage().setItem(LOCALE_STORAGE_KEY, next); } catch { /* Keep the in-memory preference. */ }
}
