// Real shipping CLI proof; no provider requests, downloads or original writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {PNG} from 'pngjs';

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(args[i + 1]);
}
const cli = option('--cli'), resources = option('--resources'), output = option('--output');
const data = option('--data-dir'), source = option('--source'), blender = option('--blender');
if (process.platform !== 'win32' || fs.existsSync(output)) throw new Error('Use Windows and a fresh proof directory');
fs.mkdirSync(output, {recursive: true});
const workspace = path.join(output, 'project');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha = file => hash(fs.readFileSync(file));
const sourceSha = sha(source), commands = [], runs = [];
const runtime = path.join(data, 'image3d', 'triposr-cpu-v1');
const cache = path.join(data, 'image3d', 'reconstruction-cache');
if (fs.existsSync(path.join(cache, 'entries')) && fs.readdirSync(path.join(cache, 'entries')).length) {
  throw new Error('The initial benchmark needs an empty app-owned reconstruction cache; existing entries are preserved');
}
function run(command, more = []) {
  const argv = [command, '--resources', resources, '--data-dir', data, '--workspace', workspace, ...more];
  const started = performance.now();
  const result = spawnSync(cli, argv, {cwd: os.tmpdir(), env: {...process.env, BLENDER_EXECUTABLE: blender},
    encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024});
  const elapsedSeconds = (performance.now() - started) / 1000;
  fs.writeFileSync(path.join(output, `command-${commands.length}.jsonl`), result.stdout || '', {flag: 'wx'});
  fs.writeFileSync(path.join(output, `command-${commands.length}.stderr.txt`), result.stderr || '', {flag: 'wx'});
  commands.push({command, elapsedSeconds, exitCode: result.status});
  if (result.status !== 0) throw new Error(`Native ${command} failed: ${result.stdout} ${result.stderr}`);
  return {value: result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)).at(-1), elapsedSeconds};
}
function request(value) {
  const input = path.join(output, `request-${commands.length}.json`);
  fs.writeFileSync(input, JSON.stringify(value), {flag: 'wx'});
  return run('command', ['--json', input, '--timeout', '600']);
}
run('init');
request({action: 'import', paths: [source]});
let snapshot = request({action: 'snapshot'}).value.response;
const assetId = snapshot.project.assets[0].id;
for (let index = 0; index < 2; index++) {
  const readyBefore = sha(path.join(runtime, 'ready.json'));
  const result = request({action: 'quality3d', assetIds: [assetId], name: `Native performance sphere ${index + 1}`,
    quality: 'draft', heightMeters: 1, maxTriangles: 5000, textureResolution: 512, preserveMaterials: true});
  // Reopen in another process, not merely the command response snapshot.
  snapshot = request({action: 'snapshot'}).value.response;
  const model = snapshot.project.assets.find(a => a.name === `Native performance sphere ${index + 1}`);
  const version = model?.versions.find(v => v.id === model.activeVersionId);
  if (!version?.validation?.valid || version.settings.previewStatus !== 'ready') throw new Error('Core/preview version is not valid');
  const core = snapshot.project.jobs.find(j => j.id === version.settings.jobId);
  const preview = snapshot.project.jobs.find(j => j.id === version.settings.previewJobId);
  if (core?.status !== 'succeeded' || preview?.status !== 'succeeded') throw new Error('Both native jobs must actually complete');
  for (const file of version.artifacts) {
    const filename = path.resolve(workspace, file.path);
    if (!filename.startsWith(workspace + path.sep) || fs.statSync(filename).size !== file.bytes || sha(filename) !== file.sha256) {
      throw new Error('Saved artifact bytes/hash differ from the inventory');
    }
    if (file.role === 'thumbnail') {
      const pixels = PNG.sync.read(fs.readFileSync(filename));
      if (![512, 1024].includes(pixels.width) || pixels.width !== pixels.height) throw new Error('Preview decode failed');
    }
  }
  const generation = version.settings.localReconstruction;
  if (generation.cache?.hit !== (index === 1) || generation.inferenceExecuted !== (index === 0)) {
    throw new Error('Cache miss/hit and real inference execution do not match');
  }
  if (index === 1 && readyBefore !== sha(path.join(runtime, 'ready.json'))) throw new Error('Cache hit rewrote inference proof');
  const raw = version.artifacts.find(a => a.format === 'glb' && path.basename(a.path) === 'mesh.glb');
  const game = version.artifacts.find(a => a.id === version.settings.quality3dFiles.game);
  const report = version.settings.qualityReport;
  runs.push({index, commandSeconds: result.elapsedSeconds, coreSeconds: (Date.parse(core.finishedAt) - Date.parse(core.startedAt)) / 1000,
    previewSeconds: (Date.parse(preview.finishedAt) - Date.parse(preview.startedAt)) / 1000,
    reconstructionSeconds: generation.elapsedSeconds, inferenceExecuted: generation.inferenceExecuted,
    cache: generation.cache, rawSha256: raw.sha256, gameSha256: game.sha256,
    qualityReport: report, previewReport: version.settings.previewReport, modelId: model.id,
    artifactCount: version.artifacts.length, versionId: version.id});
  const artifactDirectory = path.join(output, `native-artifacts-${index + 1}`);
  fs.mkdirSync(artifactDirectory);
  for (const file of version.artifacts) fs.copyFileSync(path.join(workspace, file.path), path.join(artifactDirectory, path.basename(file.path)), fs.constants.COPYFILE_EXCL);
}
if (runs[0].rawSha256 !== runs[1].rawSha256 || sha(source) !== sourceSha) throw new Error('Cached raw mesh or original changed');
const exported = request({action: 'export', assetIds: runs.map(run => run.modelId), destination: path.join(output, 'exports')}).value.response;
const nativeVersion = spawnSync(cli, ['--version'], {cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true});
if (nativeVersion.status !== 0) throw new Error('Native version probe failed');
const evidence = {schemaVersion: 1, platform: process.platform, version: JSON.parse(nativeVersion.stdout).version,
  nativeShippingCli: true, cliSha256: sha(cli), cwdOutsideCheckout: os.tmpdir(), providerRequested: false, downloaded: false,
  sourceSha256: sourceSha, originalPreserved: true, reopenedInSeparateProcess: true, cachedMeshByteIdentical: true,
  cacheHitPreservedInferenceProof: true, runs, export: exported, commands};
fs.writeFileSync(path.join(output, 'native-image3d-performance-proof.json'), JSON.stringify(evidence, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({output, runs: runs.map(r => ({coreSeconds: r.coreSeconds, commandSeconds: r.commandSeconds,
  reconstructionSeconds: r.reconstructionSeconds, cacheHit: r.cache.hit})), originalPreserved: true}));
