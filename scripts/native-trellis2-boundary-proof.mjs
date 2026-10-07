// Actual Windows CLI admission check on low-VRAM hardware, with no inference/downloads.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {PNG} from 'pngjs';
const args = process.argv.slice(2);
const option = name => {const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return path.resolve(args[i + 1]);};
const cli = option('--cli'), resources = option('--resources'), output = option('--output');
if (process.platform !== 'win32' || fs.existsSync(output)) throw new Error('Use Windows and a fresh proof folder');
fs.mkdirSync(output, {recursive:true});
const workspace = path.join(output, 'project'), data = path.join(output, 'data'), commands = [];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(command, more = [], failure = false) {
  const result = spawnSync(cli, [command, '--resources', resources, '--data-dir', data, '--workspace', workspace, ...more],
    {cwd:os.tmpdir(), encoding:'utf8', windowsHide:true, timeout:180000, maxBuffer:8 * 1024 * 1024});
  fs.writeFileSync(path.join(output, `command-${commands.length}.jsonl`), result.stdout || '', {flag:'wx'});
  fs.writeFileSync(path.join(output, `command-${commands.length}.stderr.txt`), result.stderr || '', {flag:'wx'});
  commands.push({command, exitCode:result.status});
  if (result.error || (!failure && result.status !== 0) || (failure && result.status === 0)) throw new Error(`Unexpected native result: ${result.stdout} ${result.stderr}`);
  return result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)).at(-1);
}
function request(value, failure = false) {
  const input = path.join(output, `request-${commands.length}.json`);
  fs.writeFileSync(input, JSON.stringify(value), {flag:'wx'});
  return run('command', ['--json', input, '--timeout', '120'], failure);
}
const doctor = run('doctor');
const capability = doctor.local3D?.engines?.find(engine => engine.id === 'trellis2_local');
if (!capability || capability.available || capability.requiresImageUpload || capability.state !== 'unsupported'
    || !(capability.vramMb > 0 && capability.vramMb < 24576)) throw new Error('Proof requires a measured NVIDIA GPU below 24 GiB');
run('init');
const source = path.join(output, 'original.png'), image = new PNG({width:32,height:32});
for (let y=4;y<28;y++) for (let x=4;x<28;x++) image.data.set([31,172,230,255], (y*32+x)*4);
fs.writeFileSync(source, PNG.sync.write(image), {flag:'wx'});
const originalHash = sha(source);
request({action:'import', paths:[source]});
const before = request({action:'snapshot'}).response, assetId = before.project.assets[0].id;
const configError = request({action:'quality3d_trellis_configure',runtimeRoot:'/opt/trellis2-runtime',distribution:'Ubuntu'},true);
const generationError = request({action:'quality3d',assetIds:[assetId],name:'Blocked TRELLIS request',quality:'standard',heightMeters:1,
  maxTriangles:10000,textureResolution:1024,preserveMaterials:true,engine:'trellis2_local',seed:42},true);
const after = request({action:'snapshot'}).response;
if (JSON.stringify(before.project.assets) !== JSON.stringify(after.project.assets)
    || JSON.stringify(before.project.jobs) !== JSON.stringify(after.project.jobs) || sha(source) !== originalHash
    || fs.existsSync(path.join(data,'image3d/trellis2-local-v1/config.json'))) throw new Error('Blocked admission changed original/project/config');
for (const asset of after.project.assets) for (const version of asset.versions) for (const artifact of version.artifacts) {
  const file = path.resolve(workspace, artifact.path);
  if (!file.startsWith(workspace+path.sep) || sha(file) !== artifact.sha256 || fs.statSync(file).size !== artifact.bytes) throw new Error('Preserved native artifact differs');
}
const evidence = {schemaVersion:1,nativeCli:true,platform:process.platform,cliSha256:sha(cli),capability,
  configureRejected:configError,generationRejected:generationError,originalPreserved:true,jobsUnchanged:true,assetsUnchanged:true,
  configurationNotCreated:true,reopenedInSeparateProcess:true,actualTrellisInferenceVerified:false,actualWslCancellationVerified:false,
  modelDownloadsRequested:false,providerGenerationRequested:false,commands};
fs.writeFileSync(path.join(output,'trellis2-boundary-proof.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({nativeCli:true,gpu:capability.gpuName,vramMb:capability.vramMb,configureRejected:true,generationRejected:true,originalPreserved:true,output}));
