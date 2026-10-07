// Local evidence only. Never submits a Claude generation request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const args=process.argv.slice(2);
function option(name) {const index=args.indexOf(name);assert.ok(index>=0&&args[index+1],`Missing ${name}`);return path.resolve(args[index+1]);}
const cli=option('--cli'),resources=option('--resources'),output=option('--output');
assert.equal(fs.existsSync(output),false,'Evidence output must be new');
fs.mkdirSync(output,{recursive:true});
const workspace=path.join(output,'project'),data=path.join(output,'data');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const commands=[];
function run(command,more=[],expected=0) {
  const result=spawnSync(cli,[command,'--resources',resources,'--data-dir',data,...more],{cwd:os.tmpdir(),encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:1024*1024});
  fs.writeFileSync(path.join(output,`command-${commands.length}.jsonl`),result.stdout??'');
  assert.equal(result.status,expected,`CLI ${command} exit status differs`);
  commands.push({command,exitCode:result.status});
  return result.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line)).at(-1);
}
const input={brief:'An isometric woodland crafting game needs a storage crate, workbench and display shelf as separate props. Keep metre scale, a bottom-centre pivot and editable sources.',artDirection:'Muted teal wood and sand trim. Orthographic three-quarter soft studio lighting, readable silhouettes, and fewer than 10,000 triangles per prop.',assetCount:3};
fs.writeFileSync(path.join(output,'input.json'),JSON.stringify(input,null,2)+'\n');
const doctor=run('doctor',['--check-claude']);
const status=doctor.claude;
assert.equal(status.provider,'claude-code');
assert.equal(status.generationAttempted,false);
assert.equal(status.planningAvailable,false,'This deferred-auth proof must not have a ready subscription');
assert.ok(status.cliVersion,'An installed official CLI must be observed');
assert.equal(status.authentication,'notLoggedIn','Use this proof only for the actually observed logged-out account');
run('init',['--workspace',workspace,'--name','Deferred Claude verification']);
const request=path.join(output,'request.json');
fs.writeFileSync(request,JSON.stringify({action:'claude_plan',...input,transmissionApproved:false}));
const cliGate=run('command',['--workspace',workspace,'--json',request],1);
assert.match(cliGate.message,/--allow-claude/);
const nativeGate=run('command',['--workspace',workspace,'--json',request,'--allow-claude'],1);
assert.match(nativeGate.message,/claude\.transmission_not_approved/);
const checks=[
  {label:'Official CLI observed',result:'passed',detail:`The native Windows CLI observed Claude Code ${status.cliVersion}. It ran version/help/auth-status probes only.`},
  {label:'Explicit transmission gate',result:'passed',detail:'Missing --allow-claude and transmissionApproved:false were independently rejected before a provider request.'},
  {label:'Live Claude execution',result:'limited',detail:'The account has no Pro or Max subscription. The user deferred execution; no planning request, generated plan or paid API fallback was used.'},
];
const report={schemaVersion:1,checkedAt:new Date().toISOString(),platform:`Windows ${process.arch}`,cliSha256:sha(cli),provider:'claude-code',cliVersion:status.cliVersion,authStatus:'subscription-unavailable',nativeStatus:status,generationAttempted:false,paidApiFallback:false,developerWrittenInput:true,inputTransmitted:false,checks,commands};
fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,cliVersion:status.cliVersion,nativeStatus:status,generationAttempted:false,checks}));
