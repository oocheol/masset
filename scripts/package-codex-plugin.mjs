// Package the same normalized skill bytes distributed through npm.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {zipFiles} from './package-native-cli.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const index = args.indexOf('--destination');
if (index < 0 || !args[index + 1]) throw new Error('Use --destination with a fresh output directory');
const destination = path.resolve(args[index + 1]);
if (fs.existsSync(destination)) throw new Error('Existing packages must be preserved');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const npmRoot = path.join(root, 'integrations', 'npm');
const skillManifest = JSON.parse(fs.readFileSync(path.join(npmRoot, 'skill-manifest.json'), 'utf8'));
if (skillManifest.packageVersion !== version || skillManifest.files.length !== 8) {
  throw new Error('Run npm run skill:prepare for the current version first');
}
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const relative of ['plugin.json', '.codex-plugin/plugin.json']) {
  const content = Buffer.from(fs.readFileSync(path.join(root, 'integrations', 'codex', relative), 'utf8').replace(/\r\n/g, '\n'));
  if (JSON.parse(content).version !== version) throw new Error('Plugin version does not match the release');
  files.push({path: relative, content});
}
files.push({path: 'LICENSE', content: fs.readFileSync(path.join(npmRoot, 'LICENSE'))});
for (const entry of skillManifest.files) {
  const content = fs.readFileSync(path.join(npmRoot, 'skill', entry.path));
  const source = Buffer.from(fs.readFileSync(path.join(root, 'integrations', 'codex', 'skills', 'asset-studio', entry.path), 'utf8').replace(/\r\n/g, '\n'));
  if (content.length !== entry.bytes || sha(content) !== entry.sha256 || !source.equals(content)) {
    throw new Error(`Skill source or prepared inventory differs: ${entry.path}`);
  }
  files.push({path: `skills/asset-studio/${entry.path}`, content, executable: entry.mode === 0o755});
}
const filename = `AssetStudio_${version}_codex-plugin-windows-macos.zip`;
const archive = zipFiles(files);
const evidence = {schemaVersion: 1, version, filename,
  url: `https://github.com/oocheol/masset/releases/download/v${version}/${filename}`,
  bytes: archive.length, sha256: sha(archive), runtimeVersions: skillManifest.runtimeVersions,
  skillInventorySha256: skillManifest.inventorySha256,
  files: files.map(file => ({path: file.path, bytes: file.content.length, sha256: sha(file.content)}))};
fs.mkdirSync(destination, {recursive: true});
fs.writeFileSync(path.join(destination, filename), archive, {flag: 'wx'});
fs.writeFileSync(path.join(destination, 'codex-plugin-package.json'), JSON.stringify(evidence, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({version, filename, bytes: evidence.bytes, sha256: evidence.sha256,
  files: files.length, runtimeVersions: evidence.runtimeVersions}));
