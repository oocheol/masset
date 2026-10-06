import {readFile, mkdir, copyFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

// Tauri signs the actual archive and version during bundling. This step only
// names those existing bytes and generates the separate Mac release channel.
export async function packageMacUpdate(archive, output, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable app version is required');
  const bytes = await readFile(archive);
  if (bytes.length < 1024 || bytes.length > 256 * 1024 * 1024) throw new Error('Archive size outside release bounds');
  const signature = (await readFile(`${archive}.sig`, 'utf8')).trim();
  if (!signature || signature.length > 8192) throw new Error('Tauri update signature missing');
  const decoded = Buffer.from(signature, 'base64').toString('utf8');
  if (!decoded.split('\n').some(line => line.startsWith('trusted comment: ') && line.split('\t').includes(`version:${version}`))) throw new Error('Tauri signature has no matching authenticated version');
  const filename = `AssetStudio_${version}_macos-arm64.app.tar.gz`;
  const metadata = {version, notes:`Mac ${version}: 앱 없이 쓰는 Codex 스킬용 독립 CLI와 필요한 도구의 준비 기능을 추가했습니다. 기존 공식 Codex 로그인을 재사용하고, 승인한 Blender·Python·로컬 모델을 사용자 전용 공간에 준비합니다. 원본과 이전 버전은 보존합니다. Mac 실행 검증은 잠금 상태로 생략했습니다.`, pub_date:new Date().toISOString(), platforms:{'darwin-aarch64':{
    url:`https://github.com/oocheol/masset/releases/download/v${version}/${filename}`, signature,
    bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex'),
  }}};
  await mkdir(output, {recursive:false});
  await copyFile(archive, path.join(output, filename));
  await copyFile(`${archive}.sig`, path.join(output, `${filename}.sig`));
  await writeFile(path.join(output, 'latest-macos.json'), `${JSON.stringify(metadata,null,2)}\n`, {flag:'wx'});
  return metadata;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [archive, output] = process.argv.slice(2);
  if (!archive || !output || process.argv.length !== 4) throw new Error('Usage: package-macos-update.mjs <app.tar.gz> <new-output-directory>');
  const {version} = JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json','utf8'));
  console.log(JSON.stringify(await packageMacUpdate(archive,output,version),null,2));
}
