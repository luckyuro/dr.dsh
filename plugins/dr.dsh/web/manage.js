import * as validation from '/_drdsh/validation.js';
import { readDoctorReport, describeCheck, summarizeReport, levelNames } from '/_drdsh/diagnostics.js';

(() => {
  const $ = id => document.getElementById(id);
  const apiRoot = '/_drdsh/api';
  let token;
  let expiryTimer;
  let state;
  let pairingId;
  let pairTimer;
  let jobTimer;
  let refreshBusy = false;
  let configDirty = false;
  let busy = false;
  let authorizationRevision = 0;
  const activeRequests = new Set();
  let doctorReport;
  let doctorText = '';
  let reportFilter = 'all';
  let showAllErrors = false;
  const touched = new Set();
  const configFields = { relay: 'relay', port: 'port', workdir: 'workdir', dsh: 'dsh', dshHome: 'dsh-home', caCert: 'ca-cert' };
  const sections = {
    overview: ['运行概览', '了解当前实例，继续下一步设置。'],
    configuration: ['连接与配置', '配置中继和本机环境，保存前检查输入。'],
    devices: ['配对与设备', '添加设备，或撤销不再需要的访问权限。'],
    diagnosis: ['诊断中心', '找出问题所在，获取下一步处理建议。'],
    maintenance: ['服务维护', '管理服务的启动、更新与卸载。'],
  };
  function navigate(id, updateHistory = true) {
    if (!Object.hasOwn(sections, id)) id = 'overview';
    for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.id !== id;
    for (const link of document.querySelectorAll('nav a')) {
      const selected = link.getAttribute('href') === `#${id}`;
      link.classList.toggle('selected', selected);
      if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    $('page-title').textContent = sections[id][0];
    $('page-description').textContent = sections[id][1];
    if (updateHistory) history.replaceState(null, '', `${location.pathname}${location.search}#${id}`);
  }
  let lastJob;
  let lastJobPrefix;
  const jobStorageKey = 'drdsh.management.job';
  const validJobId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  try {
    const saved = sessionStorage.getItem(jobStorageKey);
    if (saved) {
      if (validJobId(saved)) lastJob = saved;
      else {
        let hint;
        try { hint = JSON.parse(saved); } catch { /* Discard damaged recovery hints. */ }
        if (hint?.version === 1 && validJobId(hint.jobId) && typeof hint.prefix === 'string') {
          lastJob = hint.jobId;
          lastJobPrefix = hint.prefix;
        } else sessionStorage.removeItem(jobStorageKey);
      }
    }
  } catch { /* Optional recovery hint only. */ }
  const operationNames = { install: '安装 daemon', update: '更新 daemon', uninstall: '卸载 daemon', handoff: '接管 DSH', 'service.start': '启动 daemon', 'service.stop': '停止 daemon', 'service.restart': '重启 daemon', 'service.enable': '启用自启动', 'service.disable': '关闭自启动', 'lifecycle.stop': '停止 DSH', 'lifecycle.restart': '重启 DSH' };
  const jobStates = { queued: '等待执行', running: '正在执行', succeeded: '已完成', failed: '失败', interrupted: '已中断' };
  const message = (text, error = false) => {
    $('notice').textContent = text;
    $('notice').classList.toggle('error', error);
    $('notice').hidden = !text;
    $('notice').setAttribute('role', error ? 'alert' : 'status');
  };
  function setPairCode(code = '') {
    $('pair-code').textContent = code;
    $('pair-copy').hidden = !code;
  }
  const lock = (reason = '') => {
    authorizationRevision += 1;
    for (const request of activeRequests) request.abort();
    token = undefined;
    clearTimeout(expiryTimer);
    clearTimeout(pairTimer);
    clearTimeout(jobTimer);
    pairingId = undefined;
    $('authorization').hidden = false;
    $('dashboard').hidden = true;
    $('lock').hidden = true;
    $('auth-status').textContent = '等待本机授权';
    $('auth-status').removeAttribute('data-authorized');
    $('authorization-expiry').textContent = '';
    $('capability').value = '';
    $('capability-file').value = '';
    $('capability-error').hidden = true;
    $('capability').removeAttribute('aria-invalid');
    $('diagnostics').textContent = '';
    $('diagnosis-checks').replaceChildren();
    $('diagnosis-report').hidden = true;
    $('diagnosis-empty').hidden = false;
    doctorReport = undefined;
    doctorText = '';
    setPairCode();
    $('pairing').hidden = true;
    if (reason) message(reason);
  };
  function requestError(text, status, code, retryable) {
    return Object.assign(new Error(text), { status, code, retryable });
  }
  async function request(path, body, acceptDiagnostic = false) {
    const controller = new AbortController();
    const revision = authorizationRevision;
    activeRequests.add(controller);
    try {
      let response;
      try {
        response = await fetch(`${apiRoot}/${path}`, {
          method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(115_000)]),
        });
      } catch {
        throw requestError('无法连接本机 DSH。后台作业可能仍在执行；等待 DSH 重启后刷新此页并重新授权。', 0, 'network_unavailable', true);
      }
      if (revision !== authorizationRevision) throw requestError('管理页已锁定。请重新授权。', 401, 'management_locked', false);
      if (response.status === 401) {
        lock('管理授权已失效，或 DSH 已重新启动。请重新授权后查看后台作业。');
      }
      let value;
      try { value = await response.json(); } catch {
        throw requestError('DSH 未返回管理响应。请先返回 DSH 完成登录，再刷新管理页。', response.status, 'invalid_management_response', response.status !== 401);
      }
      if (!value || typeof value !== 'object') throw requestError('DSH 返回的管理响应无效，请稍后重试。', response.status, 'invalid_management_response', response.status !== 401);
      const failedDiagnostic = acceptDiagnostic && value.ok === false && value.error?.code === 'diagnostic_failed'
        && typeof value.result?.text === 'string' && value.result.exitCode === 1;
      if (!response.ok || (value.ok === false && !failedDiagnostic)) {
        const retryable = response.status >= 500 || [408, 429].includes(response.status) || value.error?.retryable === true;
        throw requestError(value.error?.message ?? value.message ?? `本机请求失败（HTTP ${response.status}）。`, response.status, value.error?.code ?? 'http_error', retryable);
      }
      if (revision !== authorizationRevision) throw requestError('管理页已锁定。请重新授权。', 401, 'management_locked', false);
      return value;
    } finally { activeRequests.delete(controller); }
  }
  async function execute(operation, params = {}) {
    const result = await request('execute', { operation, params });
    return result.result;
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    const revision = authorizationRevision;
    const buttons = [...document.querySelectorAll('button')];
    for (const button of buttons) button.disabled = true;
    $('lock').disabled = false;
    $('content').setAttribute('aria-busy', 'true');
    try { await fn(); } catch (error) { if (revision === authorizationRevision) message(error.message, true); }
    finally { busy = false; for (const button of buttons) button.disabled = false; $('content').removeAttribute('aria-busy'); }
  }
  async function unlock(capability) {
    const checked = validation.validateCapability(capability, 'zh-CN');
    $('capability-error').hidden = !checked.issues;
    $('capability-error').textContent = checked.issues?.[0].message ?? '';
    if (checked.issues) { $('capability').setAttribute('aria-invalid', 'true'); $('capability').focus(); return; }
    $('capability').removeAttribute('aria-invalid');
    const result = await request('unlock', { capability: checked.value });
    const session = result.result ?? result;
    if (typeof session.token !== 'string' || typeof session.expiresAtMs !== 'number') throw new Error('本机授权响应无效，请重启插件后重试。');
    token = session.token;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => lock('管理权限已到期。重新授权后可继续操作。'), Math.max(0, session.expiresAtMs - Date.now()));
    $('capability').value = '';
    $('authorization').hidden = true;
    $('dashboard').hidden = false;
    $('lock').hidden = false;
    $('auth-status').textContent = '本机已授权';
    $('auth-status').setAttribute('data-authorized', '');
    $('authorization-expiry').textContent = `${new Date(session.expiresAtMs).toLocaleTimeString()} 到期`;
    navigate(location.hash.slice(1), false);
    message('本机管理已解锁。');
    await refresh();
    if (lastJob) pollJob(lastJob);
  }
  function populate(config = {}) {
    if (configDirty) return;
    const defaults = state.installDefaults ?? {};
    const host = state.host ?? {};
    const values = { relay: config.relay ?? '', port: config.port ?? defaults.port ?? host.port ?? 8765, dsh: config.dsh ?? defaults.dsh ?? '', 'dsh-home': config.dshHome ?? defaults.dshHome ?? host.profile?.home ?? '', workdir: config.workdir ?? defaults.workdir ?? host.profile?.cwd ?? '', 'ca-cert': config.caCert ?? '' };
    for (const [id, value] of Object.entries(values)) $(id).value = value;
    $('dsh-tls').checked = config.dshTls ?? false;
    $('insecure-tls').checked = config.tlsInsecure ?? false;
  }
  async function refresh() {
    if (!token || refreshBusy) return;
    refreshBusy = true;
    try {
      const response = await request('state');
      state = response.result ?? response;
      $('instance-prefix').textContent = state.prefix;
      $('profile-name').textContent = state.host?.profile?.name ?? 'web';
      $('host-status').textContent = state.host?.managed ? 'daemon 托管' : '手动运行';
      $('host-detail').textContent = `本机端口 ${state.host?.port ?? '—'}`;
      $('service-status').textContent = state.installed ? '已安装' : '尚未安装';
      $('service-detail').textContent = state.installed ? '读取运行状态…' : '填写中继地址，开始安装';
      $('save-config').textContent = state.installed ? '保存配置' : '安装后台服务';
      $('config-note').textContent = state.installed ? '配置直接保存到 daemon.json。重启 daemon 后应用更改。' : '安装将保留现有 DSH 插件，并启用本机管理与事件报告。';
      $('handoff-card').hidden = !state.installed || !!state.host?.managed;
      $('next-title').textContent = state.installed ? '连接另一台设备' : '配置连接';
      $('next-description').textContent = state.installed ? '确认服务运行后，生成配对码并在另一台设备输入。' : '先填写中继地址，再安装后台服务。';
      $('next-action').textContent = state.installed ? '管理配对设备 →' : '打开连接配置 →';
      $('next-action').setAttribute('href', state.installed ? '#devices' : '#configuration');
      populate();
      if (state.hasConfiguration) {
        const status = await execute('status');
        populate(status.settings?.config ?? {});
        const runtime = status.runtime?.result ?? status.runtime;
        recoverPairing(runtime?.pairing);
        const active = runtime?.pid && status.runtime?.ok !== false;
        $('service-status').textContent = active ? '运行中' : state.installed ? '已安装' : '已卸载';
        $('service-detail').textContent = active ? `daemon PID ${runtime.pid}`
          : !state.installed ? '配置已保留，重新安装会沿用这些设置'
            : status.service?.state?.running === false && !state.host?.managed
              ? '安装已准备好，接管当前 DSH 后启动'
              : (status.runtime?.error?.message ?? '服务尚未运行或本机接口不可用');
        const config = status.settings?.config;
        if (config) $('profile-name').textContent = `${state.host?.profile?.name ?? 'web'} · ${config.pluginOwner === 'external' ? '独立插件' : '现有安装'}`;
        try { await devices(); } catch { $('device-count').textContent = '—'; }
        await jobs();
      } else {
        $('device-count').textContent = '0';
        $('service-detail').textContent = '插件已就绪，等待安装';
        if (lastJob) await jobs();
      }
    } finally { refreshBusy = false; }
  }
  function renderJob(job, target) {
    const row = document.createElement('div');
    row.className = `job ${job.state ?? ''}`;
    const text = document.createElement('div');
    const title = document.createElement('p');
    title.textContent = operationNames[job.operation] ?? job.operation ?? '后台作业';
    const detail = document.createElement('small');
    const error = typeof job.error === 'string' ? job.error : job.error?.message;
    detail.textContent = error ?? `${job.jobId} · ${new Date(job.createdAtMs ?? Date.now()).toLocaleString()}`;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = jobStates[job.state] ?? job.state ?? '已提交';
    text.append(title, detail); row.append(text, badge); target.append(row);
  }
  async function jobs() {
    const result = await execute('job.list');
    const list = Array.isArray(result) ? result : result.jobs ?? [];
    $('jobs').replaceChildren();
    if (list.length === 0) $('jobs').textContent = '暂无作业';
    for (const job of [...list].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 12)) renderJob(job, $('jobs'));
  }
  function rememberJob(id) {
    if (!validJobId(id)) throw new Error('后台返回了无效的作业编号。请刷新作业列表确认实际状态。');
    lastJob = id;
    lastJobPrefix = state?.prefix;
    try { sessionStorage.setItem(jobStorageKey, JSON.stringify({ version: 1, jobId: id, prefix: lastJobPrefix })); } catch { /* No credentials are persisted. */ }
  }
  function forgetJob(id) {
    if (lastJob !== id) return;
    clearTimeout(jobTimer);
    lastJob = undefined;
    lastJobPrefix = undefined;
    try { sessionStorage.removeItem(jobStorageKey); } catch { /* In-memory polling is stopped even if storage is unavailable. */ }
  }
  async function submit(operation, params = {}) {
    const result = await execute(operation, params);
    const job = result.job ?? result;
    if (!job.jobId) { message('操作已完成。'); await refresh(); return; }
    rememberJob(job.jobId);
    $('jobs').replaceChildren(); renderJob(job, $('jobs'));
    message(`已提交${operationNames[operation] ?? operation}。作业 ${job.jobId} 由系统后台执行；DSH 重启后请重新授权查看结果。`);
    pollJob(job.jobId);
  }
  function pollJob(id, delayMs = 1800) {
    clearTimeout(jobTimer);
    if (lastJob !== id) return;
    if (lastJobPrefix && state?.prefix && lastJobPrefix !== state.prefix) {
      forgetJob(id);
      message('上次作业属于另一个本机实例，已清除旧恢复提示。请在对应实例的作业列表中确认结果。', true);
      return;
    }
    if (!lastJobPrefix && state?.prefix) rememberJob(id);
    jobTimer = setTimeout(async () => {
      if (!token || lastJob !== id) return;
      let job;
      try {
        const result = await execute('job.status', { jobId: id });
        job = result?.job ?? result;
        if (!job || job.jobId !== id || !Object.hasOwn(jobStates, job.state)) throw requestError('后台返回的作业记录无法识别，请刷新作业列表确认实际状态。', 200, 'invalid_job_response', false);
      } catch (error) {
        if (lastJob !== id) return;
        if (error.status !== 401 && error.retryable === false) {
          forgetJob(id);
          message(`${error.message}\n作业 ${id} 的状态尚未确认；已停止自动重试并清除旧恢复提示。请刷新作业列表查看实际结果。`, true);
          return;
        }
        message(`${error.message}\n已保存作业编号：${id}`, true);
        if (token) pollJob(id, Math.min(delayMs * 2, 15_000));
        return;
      }
      if (lastJob !== id) return;
      $('jobs').replaceChildren(); renderJob(job, $('jobs'));
      if (['succeeded', 'failed', 'interrupted'].includes(job.state)) {
        forgetJob(id);
        const error = typeof job.error === 'string' ? job.error : job.error?.message;
        message(job.state === 'succeeded' ? `${operationNames[job.operation] ?? '后台操作'}已完成。` : `后台作业${jobStates[job.state]}：${error ?? '请检查诊断和服务状态。'}`, job.state !== 'succeeded');
        try { await refresh(); }
        catch (error) { message(`${error.message}\n作业 ${id} 的结果已保存：${jobStates[job.state]}。`, true); }
      } else pollJob(id);
    }, delayMs);
  }
  async function devices() {
    const result = await execute('devices.list');
    const list = result.devices ?? [];
    $('device-count').textContent = String(list.filter(device => device.revokedAtMs == null && device.revoked !== true).length);
    $('device-list').replaceChildren();
    if (list.length === 0) $('device-list').textContent = result.problem ?? '还没有配对设备。生成配对码，添加你的第一台设备。';
    for (const device of list) {
      const row = document.createElement('div'); row.className = 'device';
      const text = document.createElement('div');
      const title = document.createElement('p'); title.textContent = device.name ?? device.label ?? device.id ?? device.deviceId;
      const detail = document.createElement('small'); detail.textContent = device.id ?? device.deviceId ?? '';
      text.append(title, detail);
      const revoke = document.createElement('button'); revoke.textContent = '撤销设备'; revoke.className = 'danger';
      revoke.addEventListener('click', () => {
        if (!confirm('撤销这台设备的远程访问？现有连接将关闭，再次访问需要重新配对。')) return;
        void action(async () => { await execute('devices.revoke', { deviceId: device.deviceId ?? device.id }); await devices(); message('设备权限已撤销。'); });
      });
      row.append(text, revoke); $('device-list').append(row);
    }
  }
  function recoverPairing(current) {
    if (current?.state !== 'pending' || typeof current.pairingId !== 'string') return;
    if (pairingId !== current.pairingId) setPairCode();
    pairingId = current.pairingId;
    $('pairing').hidden = false;
    $('pair-cancel').hidden = false;
    if (!$('pair-code').textContent) {
      $('pair-detail').textContent = '已有配对正在等待。配对码不会再次显示；可在已取得配对码的设备上完成，或取消后重新生成。';
    }
    pollPair();
  }
  function pollPair() {
    clearTimeout(pairTimer);
    pairTimer = setTimeout(async () => {
      if (!token || !pairingId) return;
      const currentId = pairingId;
      try {
        const result = await execute('pair.status', { pairingId: currentId });
        if (!token || pairingId !== currentId) return;
        if (result.state === 'pending') {
          if (!$('pair-code').textContent) $('pair-detail').textContent = '配对仍在等待。原配对码已隐藏；可完成配对，或取消后重新生成。';
          pollPair();
          return;
        }
        setPairCode();
        $('pair-cancel').hidden = true;
        const states = { complete: '配对完成。设备已登记。', cancelled: '配对已取消。', expired: '配对码已过期，请重新生成。', failed: '配对失败，请检查中继连接后重试。' };
        $('pair-detail').textContent = states[result.state] ?? result.state;
        pairingId = undefined;
        await devices();
      } catch (error) {
        if (!token || pairingId !== currentId) return;
        setPairCode();
        if (error.code === 'pairing_not_found') {
          pairingId = undefined;
          $('pair-cancel').hidden = true;
          $('pair-detail').textContent = '本次配对已不可用。请刷新状态后重新生成配对码。';
          return;
        }
        $('pair-detail').textContent = `${error.message} 配对码已隐藏，正在重新确认配对状态。`;
        pollPair();
      }
    }, 1500);
  }
  $('unlock-form').addEventListener('submit', event => { event.preventDefault(); void action(() => unlock($('capability').value)); });
  $('capability-file').addEventListener('change', () => void action(async () => {
    const file = $('capability-file').files[0];
    if (!file || file.size > 256) throw new Error('请选择本机私有授权文件（不超过 256 字节）。');
    try { await unlock(await file.text()); } finally { $('capability-file').value = ''; }
  }));
  $('open-local').addEventListener('click', () => void action(async () => {
    let result;
    try { result = await request('open-local', {}); }
    catch (error) { $('authorization').querySelector('details').open = true; throw error; }
    const opened = result.result ?? result;
    message(opened.opened ? '已在运行 DSH 的电脑上打开授权页面。若打开的是其他浏览器，请先完成 DSH 登录。' : '此电脑无法打开桌面浏览器。请使用下方私有授权文件解锁。');
    if (!opened.opened) $('authorization').querySelector('details').open = true;
  }));
  $('lock').addEventListener('click', () => lock('管理页已锁定。'));
  $('refresh').addEventListener('click', () => void action(refresh));
  $('jobs-refresh').addEventListener('click', () => void action(jobs));
  $('devices-refresh').addEventListener('click', () => void action(devices));
  function configuration() {
    const value = { dshTls: $('dsh-tls').checked, tlsInsecure: $('insecure-tls').checked };
    for (const [field, id] of Object.entries(configFields)) value[field] = $(id).value;
    if (!value.caCert && state?.hasConfiguration) value.caCert = null;
    return value;
  }
  function checkConfiguration(focus = false) {
    const checked = validation.validateConfiguration(configuration(), 'zh-CN');
    const errors = validation.fieldErrors(checked);
    for (const [field, id] of Object.entries(configFields)) {
      const error = (showAllErrors || touched.has(field)) ? errors[field] : undefined;
      $(`${id}-error`).textContent = error ?? '';
      $(`${id}-error`).hidden = !error;
      if (error) $(id).setAttribute('aria-invalid', 'true'); else $(id).removeAttribute('aria-invalid');
    }
    $('config-errors').hidden = !showAllErrors || !checked.issues;
    $('config-errors').replaceChildren();
    if (showAllErrors && checked.issues) {
      const title = document.createElement('strong');
      title.textContent = `请修正 ${checked.issues.length} 项输入后继续`;
      const list = document.createElement('ul');
      for (const problem of checked.issues) {
        const id = configFields[problem.path[0]];
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.textContent = problem.message;
        link.href = `#${id}`;
        link.addEventListener('click', event => { event.preventDefault(); if (['dsh', 'dsh-home', 'ca-cert'].includes(id)) $('advanced-config').open = true; $(id).focus(); });
        item.append(link); list.append(item);
      }
      $('config-errors').append(title, list);
    }
    $('config-state').textContent = checked.issues ? '输入尚未完成' : configDirty ? '有未保存的更改' : '配置就绪';
    if (focus && checked.issues) {
      const id = configFields[checked.issues[0].path[0]];
      if (['dsh', 'dsh-home', 'ca-cert'].includes(id)) $('advanced-config').open = true;
      $(id).focus();
    }
    return checked;
  }
  for (const [field, id] of Object.entries(configFields)) $(id).addEventListener('blur', () => {
    if ($(id).value.trim()) { touched.add(field); checkConfiguration(); }
  });
  $('config-form').addEventListener('input', event => {
    configDirty = true;
    for (const [field, id] of Object.entries(configFields)) if (id === event.target?.id) touched.add(field);
    checkConfiguration();
  });
  $('config-form').addEventListener('submit', event => {
    event.preventDefault();
    showAllErrors = true;
    const checked = checkConfiguration(true);
    if (checked.issues) return;
    void action(async () => {
      const params = checked.value;
      if (state.installed) {
        const result = await execute('config.set', params);
        message(result.restartRequired ? '配置已保存。点击“重启 daemon”应用更改，当前 DSH 会重新启动。' : '配置已保存。');
        configDirty = false; await refresh();
      } else {
        if (state.hasConfiguration) {
          await execute('config.set', params);
          await submit('install', { start: false, enable: true });
        } else await submit('install', { ...params, start: false, enable: true });
        configDirty = false;
      }
      showAllErrors = false;
      touched.clear();
      checkConfiguration();
    });
  });
  $('handoff').addEventListener('click', () => void action(async () => {
    const plan = await execute('handoff.plan', { port: state.host.port, dshHome: state.host.profile.home });
    $('handoff-detail').textContent = '接管检查通过。只会关闭当前插件所在的 DSH 进程，然后启动已保存的 daemon 服务。';
    if (!confirm('接管检查通过。现在关闭当前 DSH，并交给后台 daemon 启动？请先保存正在进行的工作。')) return;
    await submit('handoff', { planId: plan.planId });
  }));
  $('pair-begin').addEventListener('click', () => void action(async () => {
    if (pairingId) {
      $('pairing').hidden = false;
      message('已有配对正在等待。请完成或取消本次配对，再生成新配对码。');
      return;
    }
    const currentToken = token;
    const result = await execute('pair.begin', { waitSeconds: 300 });
    if (!token || token !== currentToken) return;
    pairingId = result.pairingId;
    $('pairing').hidden = false; $('pair-cancel').hidden = false;
    setPairCode(result.code);
    const browserRelay = result.relay.replace(/^ws:/u, 'http:').replace(/^wss:/u, 'https:');
    $('pair-detail').textContent = `在另一台设备打开 ${browserRelay}。配对码有效至 ${new Date(result.expiresAtMs).toLocaleTimeString()}，请勿公开。`;
    pollPair();
  }));
  $('pair-copy').addEventListener('click', () => void action(async () => {
    const code = $('pair-code').textContent;
    if (!token || !pairingId || !code) return;
    try {
      await navigator.clipboard.writeText(code);
      message('配对码已复制。在另一台设备的中继网页中粘贴后，点击“连接”。');
    } catch {
      message('浏览器未允许复制。请手动选择上方配对码复制，再到另一台设备的中继网页中粘贴。', true);
    }
  }));
  $('pair-cancel').addEventListener('click', () => void action(async () => {
    if (!pairingId) return;
    await execute('pair.cancel', { pairingId });
    pairingId = undefined; clearTimeout(pairTimer);
    setPairCode(); $('pairing').hidden = true; message('配对已取消。');
  }));
  for (const button of document.querySelectorAll('[data-operation]')) button.addEventListener('click', () => {
    if (button.dataset.confirm && !confirm(button.dataset.confirm)) return;
    void action(() => submit(button.dataset.operation));
  });
  function renderReport() {
    if (!doctorReport) return;
    const summary = summarizeReport(doctorReport);
    $('diagnosis-summary').textContent = summary.heading;
    $('diagnosis-summary').parentElement.parentElement.dataset.level = summary.level;
    $('diagnosis-checks').replaceChildren();
    for (const button of document.querySelectorAll('[data-filter]')) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === reportFilter));
      button.textContent = button.dataset.filter === 'all' ? `全部 ${doctorReport.checks.length}`
        : `${levelNames[button.dataset.filter]} ${summary.counts[button.dataset.filter]}`;
    }
    const visible = doctorReport.checks.filter(check => reportFilter === 'all' || check.level === reportFilter);
    for (const item of visible) {
      const check = describeCheck(item);
      const card = document.createElement('article'); card.className = 'card check'; card.dataset.level = check.level;
      const icon = document.createElement('span'); icon.className = 'check-icon'; icon.setAttribute('aria-hidden', 'true');
      icon.textContent = check.level === 'pass' ? '✓' : check.level === 'warn' ? '!' : '×';
      const content = document.createElement('div');
      const title = document.createElement('h3'); title.textContent = check.title;
      const detail = document.createElement('p'); detail.textContent = check.message;
      content.append(title, detail);
      if (check.remedy) { const remedy = document.createElement('p'); remedy.className = 'remedy'; remedy.textContent = `建议：${check.remedy}`; content.append(remedy); }
      const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = levelNames[check.level];
      card.append(icon, content, badge); $('diagnosis-checks').append(card);
    }
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'card empty'; empty.textContent = '没有此状态的检查项。'; $('diagnosis-checks').append(empty); }
  }
  for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { reportFilter = button.dataset.filter; renderReport(); });
  $('copy-diagnosis').addEventListener('click', () => void action(async () => {
    if (!token || !doctorText) return;
    try { await navigator.clipboard.writeText(doctorText); message('诊断报告已复制。'); }
    catch { message('浏览器未允许复制。请展开“原始输出”，手动选择报告。', true); $('raw-output').open = true; }
  }));
  for (const button of document.querySelectorAll('[data-read]')) button.addEventListener('click', () => void action(async () => {
    const operation = button.dataset.read;
    navigate('diagnosis');
    message(operation === 'doctor' ? '正在检查本机环境…' : '正在读取记录…');
    const value = await request('execute', { operation, params: {} }, operation === 'doctor');
    const result = value.result;
    if (!result || typeof result !== 'object') throw new Error('本机未返回完整诊断结果，请重试。');
    $('diagnostics').textContent = `${result.text ?? JSON.stringify(result, null, 2)}${result.truncated ? '\n（结果已截断）' : ''}`;
    if (operation === 'doctor') {
      doctorText = $('diagnostics').textContent;
      doctorReport = readDoctorReport(result);
      reportFilter = 'all';
      $('diagnosis-empty').hidden = true;
      $('diagnosis-report').hidden = !doctorReport;
      $('raw-output').open = !doctorReport;
      if (doctorReport) {
        $('diagnosis-meta').textContent = `${new Date().toLocaleString()} · ${doctorReport.checks.length} 项基础检查${doctorReport.legacy ? ' · 旧版文本报告' : ''}`;
        renderReport();
        const summary = summarizeReport(doctorReport);
        message(`${summary.heading}。请查看各项结果。`, summary.level === 'fail');
      } else message('已收到原始输出，无法识别为完整诊断报告。请查看下方输出并确认原生程序版本。', true);
    } else { $('raw-output').open = true; message(`${button.textContent}已读取。`); }
  }));
  for (const link of document.querySelectorAll('nav a, [data-navigate]')) link.addEventListener('click', event => {
    event.preventDefault(); navigate(link.getAttribute('href').slice(1));
  });
  globalThis.addEventListener?.('hashchange', () => navigate(location.hash.slice(1), false));
  // Consume the one-time secret before any request; history and referrers retain no credential.
  const launch = new URLSearchParams(location.hash.slice(1)).get('launch');
  if (launch) history.replaceState(null, '', location.pathname + location.search);
  void action(async () => {
    const result = await request('access');
    const access = result.result ?? result;
    $('capability-path').textContent = access.capabilityFile;
    if (launch) await unlock(launch);
  });
})();
