// Run the shipping CLI outside the checkout, then independently inspect its files.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return path.resolve(args[i + 1]); };
const cli = option('--cli'), resources = option('--resources'), output = option('--output');
if (fs.existsSync(output)) throw new Error('Proof output must be new');
fs.mkdirSync(output, { recursive: true });
const workspace = path.join(output, 'project'), data = path.join(output, 'data');
const sha = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const commands = [];
function run(command, more = []) {
  const argv = [command, '--resources', resources, '--data-dir', data, ...more];
  if (command !== 'doctor' && command !== 'prepare') argv.push('--workspace', workspace);
  const result = spawnSync(cli, argv, { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(output, `command-${commands.length}.jsonl`), result.stdout || '');
  commands.push({ command, exitCode: result.status });
  if (result.status !== 0) throw new Error(`Native ${command} failed: ${result.stdout} ${result.stderr}`);
  return result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)).at(-1);
}
function request(value) {
  const input = path.join(output, `request-${commands.length}.json`);
  fs.writeFileSync(input, JSON.stringify(value));
  return run('command', ['--json', input, '--timeout', '120']);
}
const doctor = run('doctor');
run('init');
const source = path.join(output, 'original.png');
const image = new PNG({ width: 32, height: 24 });
for (let i = 0; i < image.data.length; i += 4) { image.data[i] = 31; image.data[i + 1] = 172; image.data[i + 2] = 230; image.data[i + 3] = 255; }
fs.writeFileSync(source, PNG.sync.write(image));
const originalHash = sha(source);
request({ action: 'import', paths: [source] });
let snapshot = request({ action: 'snapshot' }).response;
const id = snapshot.project.assets[0].id;
request({ action: 'process', assetId: id, operation: { type: 'resize', width: 7, height: 9, pixelArt: false } });
// A new process reopens the same database and immutable versions.
snapshot = request({ action: 'snapshot' }).response;
const asset = snapshot.project.assets.find(asset => asset.id === id);
if (asset.versions.length !== 2 || snapshot.project.jobs.some(job => job.status !== 'succeeded')) throw new Error('Reopened immutable versions/jobs differ');
const resized = asset.versions.find(v => v.id === asset.activeVersionId);
const rendered = resized.artifacts.find(file => file.role === 'output' && file.format === 'png');
if (!rendered) throw new Error('Verified PNG artifact missing');
for (const version of asset.versions) {
  for (const file of version.artifacts) {
    const filename = path.resolve(workspace, file.path);
    if (!filename.startsWith(workspace + path.sep) || fs.statSync(filename).size !== file.bytes || sha(filename) !== file.sha256) throw new Error('Native artifact inventory mismatch');
  }
}
const actual = PNG.sync.read(fs.readFileSync(path.join(workspace, rendered.path)));
if (actual.width !== 7 || actual.height !== 9 || sha(source) !== originalHash) throw new Error('Real resize or original preservation failed');
const exported = request({ action: 'export', destination: path.join(output, 'exports'), assetIds: [id] }).response;
const exportedRoot = exported.path;
if (!exportedRoot || !fs.statSync(exportedRoot).isDirectory()) throw new Error('Export directory missing');
const exportFiles = fs.readdirSync(exportedRoot, { recursive: true }).map(file => path.join(exportedRoot, file)).filter(file => fs.statSync(file).isFile());
if (!exportFiles.some(file => sha(file) === rendered.sha256)) throw new Error('Independent export does not contain the exact processed PNG');
const evidence = { schemaVersion: 1, nativeCli: true, platform: process.platform, architecture: process.arch, cliSha256: sha(cli), guiStarted: false, providerGenerationRequested: false, cwdOutsideCheckout: os.tmpdir(), doctor, sourceSha256: originalHash, originalPreserved: true, versions: asset.versions.length, reopenedInSeparateProcess: true, resize: { width: actual.width, height: actual.height }, export: exported, commands };
fs.writeFileSync(path.join(output, 'native-cli-proof.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ nativeCli: true, platform: process.platform, resize: evidence.resize, originalPreserved: true, reopenedInSeparateProcess: true, output }));
