/**
 * dr.dsh — the DSH-side bundle.
 *
 * This plugin is the *only* DSH-aware TypeScript in the project, and it is
 * deliberately small. Its job is to listen to harness events in-process and hand
 * them to the local daemon over loopback HTTP. It does not encrypt, does not
 * proxy, and does not manage DSH's lifecycle: the daemon owns all of that.
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

import { assertSupportedSurface, type DshContextLike } from './dsh-surface.ts';
import { Reporter, type ReporterConfig } from './reporter.ts';

/** Stable Cordis plugin name; matches the row id in `cordis.patch.yml`. */
export const name = 'dr.dsh';

/**
 * Services this plugin requires before `apply` runs.
 *
 * Empty on purpose for M0: reporting works from a plain context. When the
 * plugin grows the lifecycle-control route it will inject `webServer`, and when
 * it reports session details it will inject `sessions`.
 */
export const inject: readonly string[] = [];

/** Plugin configuration, validated in `apply` without a schema dependency yet. */
export interface Config {
  /** Loopback URL of the local daemon's report endpoint. */
  daemonUrl: string;
  /** Which events to report; unknown names are a startup error, not a silent no-op. */
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
  assertLoopback(resolved.daemonUrl);

  const reporter = new Reporter(resolved as ReporterConfig);
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
  let host: string;
  try {
    host = new URL(daemonUrl).hostname;
  } catch {
    throw new Error(`dr.dsh: daemonUrl is not a URL: ${JSON.stringify(daemonUrl)}`);
  }
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) {
    throw new Error(
      `dr.dsh: daemonUrl must point at loopback, got ${JSON.stringify(host)}; `
      + 'the daemon never listens on a public interface and reports must not leave this machine',
    );
  }
}
