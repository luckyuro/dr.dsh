import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { classifyCredential } from './credential.ts';
import {
  LOCALE_STORAGE_KEY, LocalizedError, errorText, getLocale, messages, readLocale,
  resolveLocale, saveLocale, setLocale, t,
} from './i18n.ts';
import type { MessageKey } from './i18n.ts';
import { offlineNotice, PRECACHE_PATHS } from './offline.ts';
import { ControlPanel } from './panel.ts';
import type { PanelView } from './panel.ts';

afterEach(() => setLocale('en'));

test('browser language preference order, regional Chinese, and unsupported languages', () => {
  for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans', 'ZH-hant']) {
    assert.equal(resolveLocale(null, [language, 'en-US']), 'zh-CN');
  }
  assert.equal(resolveLocale(null, ['fr-FR', 'zh-CN', 'en-US']), 'zh-CN');
  assert.equal(resolveLocale(null, ['en-GB', 'zh-CN']), 'en');
  assert.equal(resolveLocale(null, ['fr-FR', 'de']), 'en');
  assert.equal(resolveLocale(null, []), 'en');
  assert.equal(resolveLocale('en', ['zh-CN']), 'en');
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLocale('broken preference', ['zh-CN']), 'zh-CN');
});

test('an explicit choice survives a new visit without touching other site data', () => {
  const values = new Map([['unrelated', 'keep']]);
  const storage = () => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
  assert.equal(readLocale(storage, ['zh-TW']), 'zh-CN');
  saveLocale(storage, 'en');
  assert.equal(readLocale(storage, ['zh-CN']), 'en');
  assert.equal(values.get(LOCALE_STORAGE_KEY), 'en');
  assert.equal(values.get('unrelated'), 'keep');
  saveLocale(storage, 'zh-CN');
  assert.equal(readLocale(storage, ['en']), 'zh-CN');
});

test('denied storage still permits detection and an in-memory language switch', () => {
  const denied = () => { throw new Error('Storage access denied'); };
  assert.equal(readLocale(denied, ['zh-CN']), 'zh-CN');
  assert.doesNotThrow(() => saveLocale(denied, 'zh-CN'));
  assert.equal(getLocale(), 'zh-CN');
  assert.equal(t('page.connect'), '连接');
  assert.doesNotThrow(() => saveLocale(denied, 'en'));
  assert.equal(t('page.connect'), 'Connect');
});

test('translations cover the same placeholders and every static page message', () => {
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort();
  for (const key of Object.keys(messages.en) as MessageKey[]) {
    assert.ok(messages['zh-CN'][key].trim().length > 0, key);
    assert.deepEqual(placeholders(messages.en[key]), placeholders(messages['zh-CN'][key]), key);
  }
  const shell = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  for (const match of shell.matchAll(/data-i18n="([^"]+)"/gu)) {
    assert.ok(Object.hasOwn(messages.en, match[1] ?? ''), match[1]);
  }
  for (const module of ['shell', 'i18n', 'offline']) {
    assert.ok(PRECACHE_PATHS.includes(`/client/${module}.js`), `${module} is needed on an offline reload`);
  }
});

test('interpolated device names are literal and are never translated or interpolated again', () => {
  const label = '$& {id} <script> & 中文';
  assert.equal(t('room.selected', { label }), `Selected ${label}. Press Connect.`);
  setLocale('zh-CN');
  assert.equal(t('room.selected', { label }), `已选择 ${label}，点击“连接”即可。`);
});

test('an already-visible validation error and offline advice follow the selected language', () => {
  let failure: unknown;
  try { classifyCredential('not-a-code'); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.match(errorText(failure), /neither a pairing code/);
  setLocale('zh-CN');
  assert.match(errorText(failure), /输入内容既不是配对码/);
  assert.match(offlineNotice({ paired: true }), /仍保留配对信息/);
  assert.match(offlineNotice({ paired: false }), /drdsh daemon pair/);
  setLocale('en');
  assert.match(errorText(failure), /neither a pairing code/);
  assert.match(offlineNotice({ paired: true }), /still remembers the pairing/);
});

test('redrawing a connected panel in another language retains its state without sending commands', () => {
  const drawn: PanelView[] = [];
  const panel = new ControlPanel({
    control: () => { throw new Error('Redrawing must not contact the daemon'); },
    render: view => drawn.push(view),
    schedule: () => () => {},
  }, {
    connected: true,
    status: {
      state: 'running', localUrl: null, pid: 42, uptimeSecs: 10, owned: true,
      lastError: null, relay: 'connected', protocol: [0, 1],
    },
  });
  panel.draw();
  assert.equal(drawn.at(-1)?.headline, 'DSH is running');
  setLocale('zh-CN');
  panel.draw();
  assert.equal(drawn.at(-1)?.headline, 'DSH 正在运行');
  assert.equal(drawn.at(-1)?.detail, '进程 42。');
  assert.deepEqual(drawn.at(-1)?.actions.map(action => action.enabled), [false, true, true]);
  assert.equal(drawn.at(-1)?.actions[0]?.label, '启动 DSH');

  const failure = new LocalizedError(() => t('error.deviceRevoked'));
  panel.disconnected(() => errorText(failure));
  assert.match(drawn.at(-1)?.detail ?? '', /配对已失效/);
  setLocale('en');
  panel.draw();
  assert.match(drawn.at(-1)?.detail ?? '', /not paired/);
});
