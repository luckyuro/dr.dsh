/**
 * dr.dsh — the DSH-side bundle.
 *
 * This plugin is the *only* DSH-aware TypeScript in the project, and it is
 * deliberately small. It reports harness events and provides a locally
 * authorized management page. With relayUrl it owns a scoped native tunnel;
 * an optional daemon service provides lifecycle supervision. Host-disrupting
 * management uses OS jobs.
 *
 * ## Why a plugin is needed at all
 *
 * The DSH Web UI can be proxied byte for byte without any DSH-side code (see
 * `docs/architecture.md`). What cannot be reached that way is the full event
 * stream: the Gateway's cross-process forwarded-event allow list is a fixed
 * compile-time constant, so `session/event`, `subagent/*`, and `goal/changed`
 * never leave the process. Approval and user-question requests *are* forwarded,
 * so the M0 notifications work without this plugin; everything richer needs to
 * run in-process, and in-process means a bundle.
 *
 * ## Why the DSH imports are confined to one module
 *
 * DSH is a developer preview that has announced compatibility-breaking changes.
 * Every harness assumption this project makes — event names, payload shapes,
 * service keys, route registration — lives in `./dsh-surface.ts` so a DSH upgrade
 * produces one file to review and one test to fix, instead of a scatter of
 * breakage. Importing anything from `@deepseek-ai/*` anywhere else in this
 * repository is a review rejection, and `pnpm lint:imports` is meant to enforce
 * it (see `docs/decisions/0003-no-fork-integration.md`).
 *
 * @module @dr.dsh/dsh-plugin
 */

import { assertSupportedSurface, watchManagementSurface, type DshContextLike } from './dsh-surface.ts';
import { mountManagementPage } from './management-web.ts';
import { mountPluginTunnel, relayOrigin } from './companion.ts';
import { Reporter } from './reporter.ts';

/** Stable Cordis plugin name; matches the row id in `cordis.patch.yml`. */
export const name = 'dr.dsh';

/**
 * Services this plugin requires before `apply` runs.
 *
 * Reporting works from a plain context. Management injects its optional Web
 * services in an isolated child so an unavailable page cannot disable reports.
 */
export const inject: readonly string[] = [];

/** Plugin configuration, validated in `apply` without a schema dependency yet. */
export interface Config {
  /** Start a plugin-owned native tunnel without installing a daemon service. */
  relayUrl?: string;
  /** Legacy profile field; the supervising daemon's DRDSH_REPORT_URL takes precedence. */
  daemonUrl: string;
  /** Which event kinds to report; notifications not listed here are dropped. */
  report: readonly string[];
}

/** Defaults, used when the patch row omits `config`. */
const DEFAULTS: Config = {
  daemonUrl: 'http://127.0.0.1:8790',
  report: ['turn_complete', 'approval_requested', 'goal_complete', 'subagent_complete'],
};

/**
 * Mounts the plugin.
 *
 * @param ctx - the Cordis context DSH hands to every bundle plugin.
 * @param config - the row's configuration, merged over {@link DEFAULTS}.
 */
export function apply(ctx: DshContextLike, config: Partial<Config> = {}): void {
  const resolved: Config = { ...DEFAULTS, ...config };
  assertSupportedSurface(ctx);
  const daemonUrl = process.env['DRDSH_REPORT_URL'];
  const daemonToken = process.env['DRDSH_REPORT_TOKEN'];
  const supervised = daemonUrl !== undefined || daemonToken !== undefined;
  const standaloneRelay = !supervised && !process.env.DRDSH_MANAGED_INSTANCE && resolved.relayUrl !== undefined
    ? relayOrigin(resolved.relayUrl) : undefined;
  const events = ['turn_complete', 'approval_requested', 'goal_complete', 'subagent_complete'];
  if (!Array.isArray(resolved.report) || resolved.report.some(event => !events.includes(event))) {
    throw new Error('dr.dsh: unknown report event; configure only turn_complete, approval_requested, goal_complete or subagent_complete');
  }
  ctx.effect(() => watchManagementSurface(ctx, surface => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const stopTunnel = standaloneRelay === undefined ? undefined
      : mountPluginTunnel(ctx, surface, { relayUrl: standaloneRelay, report: resolved.report });
    void mountManagementPage(surface).then(stop => {
      if (cancelled) stop();
      else dispose = stop;
    }).catch(() => {
      // Native errors may contain local process arguments, including credentials.
      console.error('dr.dsh: local management page could not start; check plugin compatibility and private storage permissions. Reporting remains available.');
    });
    return async () => { cancelled = true; dispose?.(); await stopTunnel?.(); };
  }, () => {
    console.error(standaloneRelay === undefined
      ? 'dr.dsh: this DSH host does not provide the supported management surface. Reporting remains available.'
      : 'dr.dsh: this DSH host lacks the Web services required for plugin relay access and local management; install a DSH version supported by this plugin.');
  }), 'dr.dsh: local management');
  // The supervisor's ephemeral receiver wins over profile relayUrl so a managed
  // host never starts a second room or a competing DSH proxy.
  if (!supervised) return;
  if (!daemonUrl || !daemonToken || !/^[A-Za-z0-9_-]{43}$/.test(daemonToken)) {
    throw new Error('dr.dsh: incomplete report credentials; restart DSH through drdsh daemon with plugin reports enabled');
  }
  resolved.daemonUrl = daemonUrl;
  assertLoopback(resolved.daemonUrl);

  const reporter = new Reporter({ ...resolved, daemonToken });
  // `ctx.effect` (not a bare subscription) so a plugin reload disposes the
  // reporter instead of stacking a second one — DSH reloads plugin trees during
  // development and duplicated reporters would double every notification.
  ctx.effect(() => {
    const dispose = reporter.start(ctx);
    return () => {
      dispose();
    };
  }, 'dr.dsh: reporter');
}

/**
 * Refuses a non-loopback daemon URL.
 *
 * The report payload contains session handles and event names. Sending them to
 * anything but the user's own machine would quietly turn a local integration
 * into a data egress, so this is a hard failure with a named cause rather than
 * a warning (§ 9.6).
 *
 * @param daemonUrl - the configured daemon endpoint.
 * @throws Error when the URL is not loopback, or is not a URL at all.
 */
export function assertLoopback(daemonUrl: string): void {
  let url: URL;
  try {
    url = new URL(daemonUrl);
  } catch {
    throw new Error('dr.dsh: daemonUrl is not a URL; use an HTTP or HTTPS loopback origin');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('dr.dsh: daemonUrl must use HTTP or HTTPS without URL credentials');
  }
  const host = url.hostname;
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) {
    throw new Error(
      `dr.dsh: daemonUrl must point at loopback, got ${JSON.stringify(host)}; `
      + 'the daemon never listens on a public interface and reports must not leave this machine',
    );
  }
}
