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
const modelSource = args.includes('--source-glb') ? option('--source-glb') : null;
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
let modelProof = null;
const exportIds = [id];
if (modelSource) {
  const sourceHash = sha(modelSource);
  request({action:'import', paths:[modelSource]});
  snapshot = request({action:'snapshot'}).response;
  const imported = snapshot.project.assets.find(a => a.kind === 'model');
  if (!imported) throw new Error('Native GLB import missing');
  request({action:'quality3d', assetIds:[imported.id], name:'Native PBR refinement', quality:'draft',
    heightMeters:1, maxTriangles:1000, textureResolution:512, preserveMaterials:true});
  snapshot = request({action:'snapshot'}).response;
  const refined = snapshot.project.assets.find(a => a.id === imported.id);
  const version = refined?.versions.find(v => v.id === refined.activeVersionId);
  if (refined?.versions.length !== 2 || !version?.validation?.valid || version.settings.previewStatus !== 'ready'
      || sha(modelSource) !== sourceHash || snapshot.project.jobs.some(j => j.status !== 'succeeded')) throw new Error('Native PBR refinement/preview failed');
  for (const file of version.artifacts) {
    const filename = path.resolve(workspace, file.path);
    if (!filename.startsWith(workspace + path.sep) || sha(filename) !== file.sha256
        || fs.statSync(filename).size !== file.bytes) throw new Error('Refined PBR artifact inventory differs');
  }
  const game = version.artifacts.find(a => a.id === version.settings.quality3dFiles.game);
  function materialFlags(file) {
    const bytes = fs.readFileSync(file);
    if (bytes.toString('ascii',0,4)!=='glTF' || bytes.readUInt32LE(8)!==bytes.length) throw new Error('Actual GLB header differs');
    const document = JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString('utf8'));
    return document.materials.map(m=>({alphaMode:m.alphaMode??'OPAQUE',alphaCutoff:m.alphaCutoff??.5,
      doubleSided:m.doubleSided??false,occlusion:!!m.occlusionTexture}));
  }
  const flags = materialFlags(path.join(workspace,game.path)), expectedFlags = materialFlags(modelSource);
  if (flags.length!==expectedFlags.length || flags.some((actual,index)=>{
    const expected=expectedFlags[index];
    return actual.alphaMode!==expected.alphaMode || actual.doubleSided!==expected.doubleSided
      || actual.occlusion!==expected.occlusion
      || (expected.alphaMode==='MASK' && Math.abs(actual.alphaCutoff-expected.alphaCutoff)>1e-6);
  })) throw new Error('Actual exported PBR slots lost source opacity/MASK/AO');
  modelProof = {sourceSha256:sourceHash, originalPreserved:true, assetId:refined.id, versionId:version.id,
    versions:refined.versions.length, gameSha256:game.sha256, materialFlags:flags, qualityReport:version.settings.qualityReport,
    previewStatus:version.settings.previewStatus, artifactCount:version.artifacts.length};
  exportIds.push(refined.id);
}
const exported = request({ action: 'export', destination: path.join(output, 'exports'), assetIds: exportIds }).response;
const exportedRoot = exported.path;
if (!exportedRoot || !fs.statSync(exportedRoot).isDirectory()) throw new Error('Export directory missing');
const exportFiles = fs.readdirSync(exportedRoot, { recursive: true }).map(file => path.join(exportedRoot, file)).filter(file => fs.statSync(file).isFile());
if (!exportFiles.some(file => sha(file) === rendered.sha256)) throw new Error('Independent export does not contain the exact processed PNG');
if (modelProof && !exportFiles.some(file=>sha(file)===modelProof.gameSha256)) throw new Error('Exported PBR GLB differs');
const evidence = { schemaVersion: 1, nativeCli: true, platform: process.platform, architecture: process.arch, cliSha256: sha(cli), guiStarted: false, providerGenerationRequested: false, cwdOutsideCheckout: os.tmpdir(), doctor, sourceSha256: originalHash, originalPreserved: true, versions: asset.versions.length, reopenedInSeparateProcess: true, resize: { width: actual.width, height: actual.height }, modelProof, export: exported, commands };
fs.writeFileSync(path.join(output, 'native-cli-proof.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ nativeCli: true, platform: process.platform, resize: evidence.resize, originalPreserved: true, reopenedInSeparateProcess: true, output }));
