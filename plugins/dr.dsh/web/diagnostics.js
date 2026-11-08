/** Native reports and legacy text share a presentation model; arbitrary output is never a passing check. */
export function readDoctorReport(result) {
  if (!result || typeof result.text !== 'string') return null;
  try {
    const report = JSON.parse(result.text);
    if (report.version !== 1 || !Array.isArray(report.checks) || report.checks.length === 0 || report.checks.length > 100) return null;
    if (!report.checks.every(check => typeof check.id === 'string' && typeof check.title === 'string'
      && typeof check.message === 'string' && ['pass', 'warn', 'fail'].includes(check.level)
      && (check.remedy === undefined || typeof check.remedy === 'string'))) return null;
    return { checks: report.checks, partial: result.truncated === true, failed: result.exitCode === 1, legacy: false };
  } catch {
    const checks = result.text.split('\n').flatMap((line, index) => {
      const match = /^\[(ok\s*|warn|FAIL)\]\s+(.+)$/u.exec(line);
      if (!match) return [];
      return [{ id: `legacy-${index}`, title: '诊断项目', level: match[1].trim() === 'ok' ? 'pass' : match[1] === 'warn' ? 'warn' : 'fail', message: match[2] }];
    });
    return checks.length ? { checks, partial: result.truncated === true, failed: result.exitCode === 1, legacy: true } : null;
  }
}

const names = { platform: '运行系统', cpu: '处理器兼容性', audit: '审计记录', loopback: '本机 DSH 端口', dsh: 'DSH 可执行文件' };
const remedies = {
  platform: '请使用支持的 macOS 或 Linux 系统。',
  cpu: '确认安装包与处理器架构一致。',
  audit: '检查状态目录的读写权限，以及 DSHD_AUDIT 设置。',
  loopback: '确认端口是否已由 DSH 使用；如被其他程序占用，请更换端口。诊断不会自动接管进程。',
  dsh: '安装 DSH，或在高级配置中填写它的绝对路径，再运行诊断。',
};
export const levelNames = { pass: '通过', warn: '需注意', fail: '失败' };
export function describeCheck(check) {
  return { ...check, title: names[check.id] ?? check.title, remedy: check.level === 'pass' ? undefined : remedies[check.id] ?? check.remedy };
}

export function summarizeReport(report) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const check of report.checks) counts[check.level] += 1;
  const heading = report.partial ? '报告不完整，请重新运行诊断'
    : counts.fail ? `${counts.fail} 项需要修复`
      : report.failed ? '诊断未通过，请查看原始输出'
      : counts.warn ? `${counts.warn} 项需要确认` : '基础检查已通过';
  return { counts, heading, level: report.partial || report.failed || counts.fail ? 'fail' : counts.warn ? 'warn' : 'pass' };
}
