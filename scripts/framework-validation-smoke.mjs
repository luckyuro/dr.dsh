/**
 * Exercise real framework validation consumers without adding them to product dependencies.
 * Install the versions listed in docs/development/validation.md into an isolated directory,
 * then run: node scripts/framework-validation-smoke.mjs <directory>
 * No downloads or package installation are performed by this script. Exit 2 = missing prerequisites.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { schemas, validateConfiguration } from '../packages/validation/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dependencies = resolve(process.argv[2] ?? 'target/validation-frameworks');
const require = createRequire(join(dependencies, 'package.json'));
const load = name => import(pathToFileURL(require.resolve(name)).href);
const names = ['@tanstack/form-core', '@hookform/resolvers', 'react-hook-form', 'vee-validate', '@angular/forms', '@angular/compiler', '@standard-schema/spec'];
let libraries;
try {
  libraries = Object.fromEntries(await Promise.all(names.map(async name => [name, JSON.parse(await readFile(join(dependencies, 'node_modules', name, 'package.json'), 'utf8')).version])));
  await readFile(join(root, 'packages/validation/dist/index.d.ts'));
} catch {
  console.error('Build @dr.dsh/validation and install the documented framework test dependencies in an isolated directory, then pass that directory to this script.');
  process.exit(2);
}
console.log(JSON.stringify(libraries, null, 2));
let checks = 0;
const check = text => console.log(`ok ${++checks} - ${text}`);
const good = { relay: 'wss://relay.example', port: '3080' };
const bad = { relay: 'https://relay.example', port: '0' };

const { standardSchemaResolver } = await load('@hookform/resolvers/standard-schema');
const resolver = standardSchemaResolver(schemas.configuration);
const options = { fields: {}, shouldUseNativeValidation: false, criteriaMode: 'all' };
const invalid = await resolver(bad, {}, options);
assert.deepEqual(Object.keys(invalid.errors).sort(), ['port', 'relay']);
const valid = await resolver(good, {}, options);
assert.deepEqual(valid.errors, {});
assert.deepEqual(valid.values, { relay: good.relay, port: 3080 });
check('React Hook Form Standard Schema resolver preserves field errors and normalized output');

const { FormApi, FieldApi } = await load('@tanstack/form-core');
let submitted;
const form = new FormApi({ defaultValues: bad, validators: { onSubmit: schemas.configuration }, onSubmit: ({ value }) => {
  // TanStack validates schemas but does not apply transformations to its own state.
  const result = validateConfiguration(value);
  assert.equal(result.issues, undefined);
  submitted = result.value;
} });
const unmount = form.mount();
const relayField = new FieldApi({ form, name: 'relay' });
const portField = new FieldApi({ form, name: 'port' });
const unmountFields = [relayField.mount(), portField.mount()];
try {
  await form.handleSubmit();
  assert.equal(submitted, undefined);
  assert.ok(form.state.errorMap.onSubmit);
  relayField.handleChange(good.relay);
  portField.handleChange(good.port);
  await form.handleSubmit();
  assert.deepEqual(submitted, { relay: good.relay, port: 3080 });
} finally { for (const stop of unmountFields) stop(); unmount(); }
check('TanStack Form core blocks invalid submit and accepts the shared schema after correction');

const { validate } = await load('vee-validate');
const relayRule = value => schemas.relay['~standard'].validate(value).issues?.[0]?.message ?? true;
assert.equal((await validate(bad.relay, relayRule)).valid, false);
assert.equal((await validate(good.relay, relayRule)).valid, true);
check('Vue VeeValidate function rules use the shared validation result');

await load('@angular/compiler');
const { FormControl } = await load('@angular/forms');
const portRule = control => {
  const result = schemas.port['~standard'].validate(control.value);
  return result.issues ? { drdsh: result.issues } : null;
};
const control = new FormControl('0', portRule);
assert.equal(control.invalid, true);
assert.equal(control.errors.drdsh[0].path[0], 'port');
control.setValue('3080');
assert.equal(control.valid, true);
check('Angular FormControl maps issues to ValidatorFn errors and clears them after correction');

const temp = await mkdtemp(join(dependencies, 'schema-types-'));
try {
  await writeFile(join(temp, 'consumer.ts'), `import type { StandardSchemaV1 } from '@standard-schema/spec';\nimport { schemas } from ${JSON.stringify(join(root, 'packages/validation/dist/index.js'))};\nconst config: StandardSchemaV1<{relay: string; port: string | number}, {relay: string; port: number}> = schemas.configuration;\nconst port: StandardSchemaV1<string | number, number> = schemas.port;\nconst credential: StandardSchemaV1<string, {kind: 'code'; code: string} | {kind: 'roomKey'; roomKey: string}> = schemas.credential;\nvoid [config, port, credential];\n`);
  await writeFile(join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022', skipLibCheck: true }, files: ['consumer.ts'] }));
  const tsc = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', temp], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(tsc.status, 0, tsc.stdout || tsc.stderr);
} finally { await rm(temp, { recursive: true, force: true }); }
check('published Standard Schema types accept configuration, port and credential input/output types');
console.log(`Passed ${checks} framework validation checks.`);
