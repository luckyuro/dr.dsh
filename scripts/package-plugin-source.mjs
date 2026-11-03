#!/usr/bin/env node
// Node type stripping deliberately excludes node_modules, so npm/DSH packages
// ship ordinary ESM while repository tests continue to execute their TS sources.
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function stagePluginSource(destination) {
  const source = join(root, 'plugins/dr.dsh');
  await mkdir(join(destination, 'src'), { recursive: true });
  for (const name of await readdir(join(source, 'src'))) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const result = ts.transpileModule(await readFile(join(source, 'src', name), 'utf8'), {
      fileName: name, reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true, rewriteRelativeImportExtensions: true,
      },
    });
    if (result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
      throw new Error(`Plugin source ${name} could not be compiled; run the repository TypeScript checks before packaging.`);
    }
    await writeFile(join(destination, 'src', name.replace(/\.ts$/u, '.js')), result.outputText);
  }
  for (const file of ['web', 'cordis.patch.yml']) await cp(join(source, file), join(destination, file), { recursive: true });
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  metadata.version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  metadata.exports = { '.': './src/index.js' };
  delete metadata.devDependencies;
  delete metadata.scripts;
  await writeFile(join(destination, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/package-plugin-source.mjs <staging-directory>');
  await stagePluginSource(resolve(process.argv[2]));
}
