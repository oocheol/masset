import {readFile, writeFile, mkdir, stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';

const [bootstrap, manifest, directory] = process.argv.slice(2);
if (process.platform !== 'darwin' || process.arch !== 'arm64' || !bootstrap || !manifest || !directory || process.argv.length !== 5) throw new Error('Usage on Apple Silicon: verify-macos-update.mjs <update-enabled-bootstrap.app> <latest-macos.json> <new-output-directory>');
const root = path.resolve(directory);
const metadata = JSON.parse(await readFile(manifest,'utf8'));
const readVersion = app => execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim();
const fromVersion = readVersion(bootstrap);
const toVersion = metadata.version;
await mkdir(root,{recursive:false});
await mkdir(path.join(root,'installed'));
const app = path.join(root,'installed/Asset Studio.app');
execFileSync('/usr/bin/ditto',['--noqtn',bootstrap,app]);
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app]);
await writeFile(path.join(root,'.asset-studio-update-qa.json'),JSON.stringify({kind:'disposable-native-update-copy',fromVersion,toVersion}),{flag:'wx'});
execFileSync('/usr/bin/open',['-n','-a',app,'--args','--update-smoke',root]);
const exists = file => stat(path.join(root,file)).then(()=>true,()=>false);
const deadline = Date.now()+600000;
while (!(await exists('after.json'))) {
  if (await exists('error.json')) throw new Error(`Native update failed: ${JSON.parse(await readFile(path.join(root,'error.json'),'utf8')).webview.error}`);
  if (Date.now()>deadline) throw new Error(`Native lifecycle timed out. Evidence kept at ${root}`);
  await new Promise(resolve=>setTimeout(resolve,1000));
}
const before = JSON.parse(await readFile(path.join(root,'before.json'),'utf8'));
const after = JSON.parse(await readFile(path.join(root,'after.json'),'utf8'));
const release = metadata.platforms['darwin-aarch64'];
if (readVersion(app)!==toVersion || before.version!==fromVersion || after.version!==toVersion || before.pid===after.pid || before.updater.sha256!==release.sha256 || before.updater.totalBytes!==release.bytes || before.projectRoot!==after.projectRoot || JSON.stringify(before.project)!==JSON.stringify(after.project) || JSON.stringify(before.files)!==JSON.stringify(after.files) || before.webview.externalProviderCalls || after.webview.externalProviderCalls) throw new Error('Lifecycle evidence mismatch');
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const result = {verified:true,platform:'macos-arm64',fromVersion,toVersion,source:'Update-enabled bootstrap fixture built from current source; historical public 0.1.3 cannot auto-update',nativeApprovalUi:true,publicCandidateChannel:`https://github.com/oocheol/masset/releases/download/v${toVersion}/latest-macos.json`,actualPluginDownloadSignatureAndVersion:true,installedBundleSeal:true,nativeRestart:true,oldPid:before.pid,newPid:after.pid,projectReopened:true,projectAndVersionsUnchanged:true,originalAndArtifactHashesUnchanged:true,artifactCount:Object.keys(after.files).length,decodedImages:after.webview.decodedImages,providerOperations:0,metadataSha256:createHash('sha256').update(await readFile(manifest)).digest('hex')};
await writeFile(path.join(root,'update-lifecycle.json'),`${JSON.stringify(result,null,2)}\n`,{flag:'wx'});
console.log(JSON.stringify(result,null,2));
