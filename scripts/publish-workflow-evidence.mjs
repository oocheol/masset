// Imports inspected local evidence into the static site. Does not run a provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
function option(name){const index=args.indexOf(name);assert.ok(index>=0&&args[index+1],`Missing ${name}`);return path.resolve(args[index+1]);}
const claude=option('--claude-dir'),local=option('--local-dir');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function publish(source,relative,expected) {
  const target=path.join(root,'apps/site/public',relative);
  assert.ok(target.startsWith(path.join(root,'apps/site/public')+path.sep));
  const digest=sha(source);if(expected)assert.equal(digest,expected,'Inspected file must match its actual receipt');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  if(fs.existsSync(target))assert.equal(sha(target),digest,'Never replace a different published evidence artifact');
  else fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
  return {href:`/${relative.replaceAll(path.sep,'/')}`,sha256:digest};
}
function replaceExport(file,name,type,value) {
  const source=fs.readFileSync(file,'utf8');
  assert.ok(source.includes(`export const ${name}: ${type} = `),`Unexpected type for ${name}`);
  const pattern=new RegExp(`^export const ${name}: [^=]+ = [\\s\\S]*?;$`,'m');
  assert.ok(pattern.test(source),`Missing source export ${name}`);
  fs.writeFileSync(file,source.replace(pattern,()=>`export const ${name}: ${type} = ${JSON.stringify(value,null,2)};`));
}
const probe=read(path.join(claude,'verification.json')),brief=read(path.join(claude,'input.json'));
assert.equal(probe.generationAttempted,false);assert.equal(probe.inputTransmitted,false);
assert.equal(probe.paidApiFallback,false);assert.equal(probe.nativeStatus.authentication,'notLoggedIn');
assert.equal(probe.nativeStatus.planningAvailable,false);assert.equal(probe.authStatus,'subscription-unavailable');
assert.equal(probe.schemaVersion,1);assert.ok(probe.cliVersion&&brief.brief&&brief.artDirection);
assert.equal(fs.existsSync(path.join(root,'apps/site/public/examples/claude-brief/plan.json')),false,'No generated plan may be published from a deferred request');
const development={schemaVersion:1,checkedAt:probe.checkedAt,platform:probe.platform,cliVersion:probe.cliVersion,authStatus:'subscription-unavailable',input:{brief:brief.brief,artDirection:brief.artDirection},checks:probe.checks,artifacts:[
  {label:'Developer-written request (not sent)',...publish(path.join(claude,'input.json'),'examples/claude-brief/input.json')},
  {label:'Native authentication and transmission-gate record',...publish(path.join(claude,'verification.json'),'examples/claude-brief/verification.json')},
]};
const report=read(path.join(local,'verification.json')),input=read(path.join(local,'input.json'));
assert.equal(report.schemaVersion,1);assert.equal(report.nativeCli,true);assert.equal(report.guiStarted,false);
assert.equal(report.providerGenerationRequested,false);assert.equal(report.reopenedInSeparateProcess,true);
assert.equal(report.records.length,3);
const proof={schemaVersion:1,title:'A woodland workshop, made as three local game props.',scenario:'A maintainer-run production case using the Windows native CLI and existing local Blender recipes. Claude did not select or generate these models.',verifiedAt:report.verifiedAt,platform:report.platform,runtime:report.runtime,input:{brief:input.brief,artDirection:input.artDirection},outputs:report.records.map(record=>{
  assert.ok(['crate','table','shelf'].includes(record.template));assert.equal(record.validation.valid,true);
  assert.equal(record.roundTrips.length,2);assert.ok(record.roundTrips.every(round=>round.valid===true));
  assert.deepEqual(Object.keys(record.files).sort(),['model.glb','source.blend','thumbnail.png']);
  assert.ok(record.roundTrips.some(round=>round.mode==='glb')&&record.roundTrips.some(round=>round.mode==='blend'));
  const base=`examples/local-prop-kit/${record.template}`;
  const files=Object.entries(record.files).map(([name,file])=>({label:name,...publish(path.join(local,record.template,name),`${base}/${name}`,file.sha256)}));
  const thumbnail=files.find(file=>file.label==='thumbnail.png');assert.ok(thumbnail);
  return {name:record.name,parameters:`${record.parameters.width} × ${record.parameters.depth} × ${record.parameters.height} m · ${record.mesh.triangles.toLocaleString('en-US')} triangles · ${record.template} recipe`,preview:thumbnail.href,files};
}),checks:report.checks,limitations:[
  'Developer-written input and local parameters; no Claude or Codex generation request.',
  'Fixed procedural shapes and simple materials; no claim of baked texture quality, animation, collision meshes or runtime engine performance.',
  'Native backend and portable export checked on Windows. A browser preview does not verify the desktop GUI or a Mac build.',
],artifacts:[
  {label:'Local recipe selection and parameters',...publish(path.join(local,'input.json'),'examples/local-prop-kit/input.json')},
  {label:'Native production, round-trip and export verification',...publish(path.join(local,'verification.json'),'examples/local-prop-kit/verification.json')},
]};
replaceExport(path.join(root,'apps/site/src/claudeProof.ts'),'claudeDevelopmentEvidence','ClaudeDevelopmentEvidence | null',development);
replaceExport(path.join(root,'apps/site/src/claudeProof.ts'),'claudePrototypeImplemented','boolean',true);
replaceExport(path.join(root,'apps/site/src/localWorkflow.ts'),'localWorkflowProof','LocalWorkflowEvidence | null',proof);
console.log(JSON.stringify({claudeLiveProof:false,claudeInputTransmitted:false,nativeLocalProps:proof.outputs.length,artifacts:development.artifacts.length+proof.artifacts.length+proof.outputs.reduce((total,output)=>total+output.files.length,0)}));
