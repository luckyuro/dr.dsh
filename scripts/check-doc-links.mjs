/**
 * Checks that every relative link in the repository's Markdown resolves.
 *
 * WHY THIS EXISTS
 *
 * Documentation is part of the deliverable here, and this project's docs are
 * unusually cross-referential: an ADR is cited from the security model, the
 * security model from the README, the surface inventory from the contributing
 * guide. A moved file silently produces a dead link, and a dead link in a
 * security document is worse than no link — it tells the reader a claim is
 * justified somewhere they cannot reach.
 *
 * Usage:
 *   node scripts/check-doc-links.mjs           # report and exit non-zero on failure
 *   node scripts/check-doc-links.mjs --quiet   # only report failures
 *
 * Deliberately dependency-free and offline: it checks that a target *exists*,
 * not that it is reachable. External URLs are listed but never fetched, because
 * a doc check that fails when someone else's site is down teaches people to
 * ignore the check.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');

/** Directories that never contain authored Markdown. */
const IGNORED_DIRECTORIES = new Set(['node_modules', 'target', 'dist', 'dist-worker', '.git']);

/** Matches `[text](target)` and `![alt](target)`, ignoring image syntax differences. */
const LINK_PATTERN = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;

/**
 * Walks the repository for Markdown files.
 *
 * @param directory - directory to walk.
 * @returns absolute paths of every `.md` file found.
 */
function markdownFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...markdownFiles(path));
    } else if (entry.endsWith('.md')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Classifies one link target.
 *
 * @param target - the raw link target from the Markdown source.
 * @returns `external` for absolute URLs and mail links, `anchor` for same-page
 * links, otherwise `relative`.
 */
function classify(target) {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) return 'external';
  if (target.startsWith('#')) return 'anchor';
  return 'relative';
}

/**
 * Reads the heading slugs of a Markdown file, for optional anchor checking.
 *
 * @param text - file contents.
 * @returns lowercased slugs derived the same way GitHub derives them.
 */
function headingSlugs(text) {
  const slugs = new Set();
  for (const line of text.split('\n')) {
    const match = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const slug = (match[2] ?? '')
      .trim()
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}\s-]/gu, '')
      .replaceAll(/\s+/gu, '-');
    slugs.add(slug);
  }
  return slugs;
}

const files = markdownFiles(repositoryRoot);
const failures = [];
const externalTargets = new Set();
let relativeLinks = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const slugs = headingSlugs(text);
  for (const match of text.matchAll(LINK_PATTERN)) {
    const raw = match[1] ?? '';
    const kind = classify(raw);
    if (kind === 'external') {
      externalTargets.add(raw);
      continue;
    }
    const [pathPart = '', anchor = ''] = raw.split('#');
    if (kind === 'anchor') {
      relativeLinks += 1;
      if (anchor !== '' && !slugs.has(anchor)) {
        failures.push(`${relative(file, repositoryRoot)}: #${anchor} is not a heading in this file`);
      }
      continue;
    }
    relativeLinks += 1;
    const target = resolve(dirname(file), decodeURIComponent(pathPart));
    let exists = false;
    try {
      exists = statSync(target).isFile() || statSync(target).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      failures.push(`${relative(file, repositoryRoot)}: ${raw} does not exist`);
    }
  }
}

if (!quiet) {
  console.log(`checked ${String(files.length)} Markdown files, ${String(relativeLinks)} relative links`);
  console.log(`noted ${String(externalTargets.size)} distinct external URLs (never fetched)`);
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} broken link(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else if (!quiet) {
  console.log('all relative links resolve');
}
