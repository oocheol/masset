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
  const metadata = {version, notes:'Mac 0.1.10: Codex 스킬과 네이티브 CLI로 게임 제작 중 개별 2D·정적 3D 에셋을 제작합니다. 긴 제작 목록의 분석 대기, 큐 이어받기, 모델 UV 처리와 앱 내부 Python 캐시를 개선했습니다. 원본과 이전 버전은 보존합니다. 로컬 3D는 CPython 3.9·최소 16GB 메모리와 Blender가 필요합니다. 최종 배포본 추가 테스트는 요청에 따라 생략했습니다.', pub_date:new Date().toISOString(), platforms:{'darwin-aarch64':{
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
