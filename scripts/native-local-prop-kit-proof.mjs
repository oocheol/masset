// Real local native-backend case: no Claude/Codex request and no generated code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {PNG} from 'pngjs';

const args=process.argv.slice(2);
function option(name){const index=args.indexOf(name);assert.ok(index>=0&&args[index+1],`Missing ${name}`);return path.resolve(args[index+1]);}
const cli=option('--cli'),resources=option('--resources'),blender=option('--blender'),output=option('--output');
assert.equal(fs.existsSync(output),false,'Case output must be new');fs.mkdirSync(output,{recursive:true});
const workspace=path.join(output,'project'),data=path.join(output,'data');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const commands=[];
function run(command,more=[]) {
  const result=spawnSync(cli,[command,'--resources',resources,'--data-dir',data,...more],{cwd:os.tmpdir(),encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:8*1024*1024,env:{...process.env,BLENDER_EXECUTABLE:blender}});
  fs.writeFileSync(path.join(output,`command-${commands.length}.jsonl`),result.stdout??'');
  assert.equal(result.status,0,`Native ${command} failed; inspect the local JSONL record`);
  commands.push({command,exitCode:result.status});
  return result.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line)).at(-1);
}
function request(value) {
  const file=path.join(output,`request-${commands.length}.json`);fs.writeFileSync(file,JSON.stringify(value));
  return run('command',['--workspace',workspace,'--json',file,'--timeout','240']).response;
}
const doctor=run('doctor');
assert.ok(doctor.environment.blenderVersion,'Installed Blender must be observed');
run('init',['--workspace',workspace,'--name','Woodland workshop local case']);
const input={brief:'A small isometric woodland workshop needs three separate game props: a storage crate, workbench and display shelf.',artDirection:'Muted teal wood and sand trim, clean silhouettes, soft studio lighting and metre scale. The creator selects existing recipes and parameters locally.',models:[
  {template:'crate',name:'Workshop storage crate',width:0.8,depth:0.65,height:0.7,color:'#799993',bevel:0.025},
  {template:'table',name:'Woodland workbench',width:1.4,depth:0.7,height:0.85,color:'#d4bd8a',bevel:0.02},
  {template:'shelf',name:'Workshop display shelf',width:1.1,depth:0.45,height:1.6,color:'#799993',bevel:0.02},
]};
fs.writeFileSync(path.join(output,'input.json'),JSON.stringify(input,null,2)+'\n');
request({action:'model',models:input.models});
const snapshot=request({action:'snapshot'});
assert.equal(snapshot.project.assets.length,3);
assert.ok(snapshot.project.jobs.every(job=>job.status==='succeeded'));
const records=[];
for(const asset of snapshot.project.assets) {
  const version=asset.versions.find(value=>value.id===asset.activeVersionId);
  assert.ok(version?.validation?.valid,'Production backend must validate each actual model');
  const parameters=input.models.find(value=>value.name===asset.name);assert.ok(parameters);
  const recordDir=path.join(output,parameters.template);fs.mkdirSync(recordDir);
  const selected={};
  for(const file of version.artifacts) {
    const source=path.resolve(workspace,file.path);assert.ok(source.startsWith(workspace+path.sep));
    assert.equal(fs.statSync(source).size,file.bytes);assert.equal(sha(source),file.sha256);
    const targetName=file.format==='glb'?'model.glb':file.format==='blend'?'source.blend':file.role==='thumbnail'&&path.basename(file.path).includes('thumbnail')?'thumbnail.png':null;
    if(targetName){assert.equal(selected[targetName],undefined);fs.copyFileSync(source,path.join(recordDir,targetName));selected[targetName]={sha256:file.sha256,bytes:file.bytes};}
  }
  assert.ok(selected['model.glb']&&selected['source.blend']&&selected['thumbnail.png']);
  const thumbnail=PNG.sync.read(fs.readFileSync(path.join(recordDir,'thumbnail.png')));
  assert.equal(thumbnail.width,512);assert.equal(thumbnail.height,512);
  const parameterFile=path.join(recordDir,'parameters.json');fs.writeFileSync(parameterFile,JSON.stringify(parameters));
  const roundTrips=[];
  for(const mode of ['glb','blend']) {
    const result=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--threads','2','--python',path.join(resources,'tests/blender/verify_artifacts.py'),'--','--input',parameterFile,'--artifact-dir',recordDir,'--mode',mode],{cwd:os.tmpdir(),encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:1024*1024});
    fs.writeFileSync(path.join(recordDir,`roundtrip-${mode}.log`),result.stdout??'');
    assert.equal(result.status,0,`Independent ${mode} round trip failed`);
    const line=result.stdout.split(/\r?\n/).find(value=>value.startsWith('{')&&value.includes('"roundtrip"'));
    assert.ok(line,'Fresh-process Blender round-trip result must be present');
    roundTrips.push(JSON.parse(line));
  }
  for(const [name,file] of Object.entries(selected))assert.equal(sha(path.join(recordDir,name)),file.sha256,'Round trip must preserve source artifacts');
  records.push({name:asset.name,template:parameters.template,parameters,mesh:asset.mesh,validation:version.validation,files:selected,roundTrips});
}
const exported=request({action:'export',destination:path.join(output,'exports'),assetIds:snapshot.project.assets.map(asset=>asset.id)});
const exportFiles=fs.readdirSync(exported.path,{recursive:true}).map(file=>path.join(exported.path,file)).filter(file=>fs.statSync(file).isFile());
const exportHashes=new Set(exportFiles.map(sha));
for(const record of records)for(const file of Object.values(record.files))assert.ok(exportHashes.has(file.sha256),'Export must include exact verified files');
const checks=[
  {label:'Three native model jobs',result:'passed',detail:'The Windows native CLI and production scheduler made three distinct parameterized Blender models. No GUI or provider request was involved.'},
  {label:'Independent file reopening',result:'passed',detail:'Each GLB and editable .blend source was reopened in its own Blender process with script auto-execution disabled; dimensions, pivot, UVs, normals and material assignments passed.'},
  {label:'Portable export integrity',result:'passed',detail:'The native export contained the same model, editable source and preview bytes; SHA-256 and file sizes matched the saved inventory.'},
  {label:'Visual and game quality',result:'limited',detail:'These are existing procedural recipes with simple materials. They are not Claude-generated shapes, baked textures, runtime performance measurements or a customer case study.'},
];
const report={schemaVersion:1,verifiedAt:new Date().toISOString(),platform:`Windows ${process.arch}`,runtime:`${doctor.environment.blenderVersion} · Asset Studio native CLI`,cliSha256:sha(cli),nativeCli:true,guiStarted:false,providerGenerationRequested:false,developerSelectedRecipes:true,reopenedInSeparateProcess:true,records,checks,commands};
fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,nativeCli:true,providerGenerationRequested:false,modelCount:records.length,runtime:report.runtime}));
