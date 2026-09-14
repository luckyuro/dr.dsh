/**
 * Enforces the DSH-isolation rule from ADR-0003.
 *
 * WHY THIS EXISTS
 *
 * DSH is a developer preview that has announced compatibility-breaking changes.
 * The project's answer is to confine every assumption about DSH to one file,
 * `plugins/dr.dsh/src/dsh-surface.ts`, so an upstream change produces one
 * file to read and one test to fix. That only holds if nothing else imports the
 * harness — and "please remember" is not a mechanism, so this script is.
 *
 * The rule: outside `dsh-surface.ts`, no TypeScript file may import a bare
 * `@deepseek-ai/*` module. Type-only imports are refused too: a type import still
 * breaks the build when upstream renames something, which is exactly the
 * breakage we are containing.
 *
 * Usage:
 *   node scripts/check-dsh-isolation.mjs
 *
 * Exits non-zero and names every offending file and line.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one file allowed to touch DSH directly, relative to the repository root. */
const SANCTIONED_FILE = join('plugins', 'dr.dsh', 'src', 'dsh-surface.ts');

/** Directories that never contain authored source. */
const IGNORED_DIRECTORIES = new Set(['node_modules', 'target', 'dist', 'dist-worker', '.git']);

/** Matches both `import … from '@deepseek-ai/x'` and `import type … from '@deepseek-ai/x'`. */
const DSH_IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s+['"]@deepseek-ai\/[^'"]+['"]/gu;

/** Matches a dynamic `import('@deepseek-ai/x')`, which would otherwise slip past. */
const DSH_DYNAMIC_IMPORT = /import\s*\(\s*['"]@deepseek-ai\/[^'"]+['"]\s*\)/gu;

/**
 * Walks the repository for TypeScript sources.
 *
 * @param directory - directory to walk.
 * @returns absolute paths of every `.ts` file found, excluding declaration output.
 */
function typescriptFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...typescriptFiles(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      found.push(path);
    }
  }
  return found;
}

const failures = [];
let scanned = 0;

for (const file of typescriptFiles(repositoryRoot)) {
  const relativePath = relative(repositoryRoot, file);
  if (relativePath === SANCTIONED_FILE) continue;
  scanned += 1;
  const text = readFileSync(file, 'utf8');
  for (const pattern of [DSH_IMPORT, DSH_DYNAMIC_IMPORT]) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      failures.push(`${relativePath}:${String(line)} imports DSH directly`);
    }
  }
}

console.log(`scanned ${String(scanned)} TypeScript files; only ${SANCTIONED_FILE} may import @deepseek-ai/*`);

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} violation(s) of ADR-0003:`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nMove the dependency into plugins/dr.dsh/src/dsh-surface.ts, or add a seam.');
  process.exitCode = 1;
} else {
  console.log('DSH surface is isolated');
}
