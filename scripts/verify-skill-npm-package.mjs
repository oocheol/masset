import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadBundle, RECEIPT_NAME } from '../integrations/npm/lib/installer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const descriptor = JSON.parse(await fs.readFile(path.join(root, 'integrations/npm/package.json'), 'utf8'));
const archive = path.join(root, 'output/npm-skill', `oocheol-asset-studio-${descriptor.version}.tgz`);
const archiveBytes = await fs.readFile(archive);
const proof = path.join(root, 'output/npm-skill', `packed-proof-${Date.now()}-${randomUUID()}`);
const project = path.join(proof, 'Game with spaces');
await fs.mkdir(project, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this verifier with npm run skill:verify');
const results = [];
for (const command of ['install', 'update', 'status']) {
  const run = spawnSync(process.execPath, [npmCli, 'exec', '--yes', '--ignore-scripts',
    '--cache', path.join(proof, 'npm-cache'), '--package', archive, '--',
    'asset-studio-skill', command, '--project', project, '--json'], { cwd: root, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`Packed npm ${command} failed: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  if (result.state !== 'current' || result.packageVersion !== descriptor.version ||
    command === 'update' && result.operation !== 'unchanged') throw new Error('Packed npm result failed verification');
  await fs.writeFile(path.join(proof, `${command}.json`), `${JSON.stringify(result, null, 2)}\n`);
  results.push(result);
}
const bundle = await loadBundle(path.join(root, 'integrations/npm'));
for (const file of bundle.manifest.files) {
  const installed = await fs.readFile(path.join(results[0].skillPath, ...file.path.split('/')));
  if (!installed.equals(bundle.contents.get(file.path))) throw new Error(`Packed skill bytes differ: ${file.path}`);
}
await fs.readFile(path.join(results[0].skillPath, RECEIPT_NAME));
const evidence = { package: descriptor.name, version: descriptor.version, source: 'local npm tarball',
  freshNpmCache: true, project, archiveBytes: archiveBytes.length,
  sha256: createHash('sha256').update(archiveBytes).digest('hex'),
  integrity: `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`,
  inventorySha256: bundle.manifest.inventorySha256,
  install: results[0].operation, update: results[1].operation, status: results[2].state,
  nativeRuntimeDownloaded: false, userGlobalSkillChanged: false, proofPath: proof };
await fs.writeFile(path.join(proof, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
