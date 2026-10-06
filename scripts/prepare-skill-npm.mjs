import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryDigest, loadBundle } from '../integrations/npm/lib/installer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = path.join(root, 'integrations', 'npm');
const source = path.join(root, 'integrations', 'codex', 'skills', 'asset-studio');
const descriptor = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const distributable = [
  'SKILL.md', 'agents/openai.yaml', 'references/cli.md', 'references/manifest.json',
  'references/native-runtime.json', 'scripts/bootstrap.ps1', 'scripts/bootstrap.py', 'scripts/bootstrap.sh',
];
const files = [];
for (const relative of distributable.sort()) {
  const content = Buffer.from((await fs.readFile(path.join(source, relative), 'utf8')).replace(/\r\n/g, '\n'));
  const destination = path.join(packageRoot, 'skill', relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const mode = relative.endsWith('.sh') ? 0o755 : 0o644;
  await fs.writeFile(destination, content, { mode });
  files.push({ path: relative, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), mode });
}
const runtime = JSON.parse(await fs.readFile(path.join(packageRoot, 'skill', 'references', 'native-runtime.json'), 'utf8'));
const runtimeVersions = Object.fromEntries(['windows-x64', 'macos-arm64'].map(platform => [platform, runtime.packages[platform].version]));
const manifest = { schemaVersion: 1, format: 'asset-studio-skill-bundle', packageName: descriptor.name,
  packageVersion: descriptor.version, skillName: 'asset-studio', runtimeVersions, files };
manifest.inventorySha256 = inventoryDigest(manifest);
await fs.writeFile(path.join(packageRoot, 'skill-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await fs.writeFile(path.join(packageRoot, 'LICENSE'), (await fs.readFile(path.join(root, 'LICENSE'), 'utf8')).replace(/\r\n/g, '\n'));
await fs.mkdir(path.join(root, 'output', 'npm-skill'), { recursive: true });
await loadBundle(packageRoot);
console.log(JSON.stringify({ package: descriptor.name, version: descriptor.version, runtimeVersions,
  files: files.length, skillBytes: files.reduce((total, file) => total + file.bytes, 0), inventorySha256: manifest.inventorySha256 }));
