import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { inspectGlb } from '../../scripts/verify-artifacts.mjs';

// Browser adapter acceptance only. These tests do not establish Tauri/WebView or live-provider support.
const externalRequestsByPage = new WeakMap<Page, string[]>();
test.beforeEach(async ({page}) => {
  const externalRequests: string[] = [];
  externalRequestsByPage.set(page, externalRequests);
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).hostname !== '127.0.0.1') externalRequests.push(`${request.method()} ${new URL(url).hostname}`);
  });
  await page.goto('/');
  await expect(page.getByRole('listitem')).toHaveCount(12, {timeout: 30_000});
});

test('workstation renders actual fixtures and keeps provider requests desktop-only', async ({page}, testInfo) => {
  for (const name of ['에셋 라이브러리', '2D 캔버스', '3D 뷰포트', '버전 비교']) await expect(page.getByRole('tab', {name})).toBeVisible();
  await expect(page.locator('.runtime-badge')).toContainText('브라우저');
  await expect(page.getByRole('listitem').first().locator('img')).toBeVisible();
  await expect.poll(() => page.getByRole('listitem').first().locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.screenshot({path: testInfo.outputPath('workstation-browser.png'), fullPage: false});
  await page.getByRole('button', {name: '구독 연결', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '이미지 생성 연동 상태'});
  await expect(dialog.locator('.status-tag')).toHaveText('데스크톱 전용');
  await expect(dialog).toContainText('gpt-image-2');
  await expect(dialog).toContainText('확인되지 않음');
  await expect(dialog).toContainText('0개 / 파일 검증 0개');
  await expect(dialog).toContainText('기존 이미지 가져오기');
  await expect(dialog.getByRole('button', {name: '공식 계정 연결', exact: true})).toBeDisabled();
  await expect(dialog.getByRole('button', {name: '연결 확인', exact: true})).toBeDisabled();
  await expect(dialog.getByRole('button', {name: '다운로드 준비', exact: true})).toBeDisabled();
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await expect(dialog).toContainText('Codex 준비');
  await expect(dialog.locator('.status-tag')).toHaveText('데스크톱 전용');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', {name: '이미지 제작', exact: true}).click();
  const generation = page.getByRole('dialog', {name: 'GPT Image2 이미지 제작'});
  await generation.getByLabel('이미지 설명', {exact: true}).fill('A local test icon; no provider request is authorized.');
  await generation.getByRole('textbox', {name: /^이미지 이름 \(선택\)/}).fill('QA browser gate');
  await generation.getByLabel('이미지 수', {exact: true}).fill('3');
  await generation.getByRole('checkbox', {name: '현재 규격과 스타일을 제작 기준으로 승인합니다.'}).check();
  await expect(generation.getByRole('button', {name: '이미지 요청 제출', exact: true})).toBeDisabled();
  await expect(generation.getByRole('button', {name: '공식 계정 연결', exact: true})).toBeDisabled();
  await expect(generation.locator('.status-tag')).toHaveText('데스크톱 전용');
  await page.screenshot({path: testInfo.outputPath('browser-generation-gate.png'), fullPage: false});
  await page.keyboard.press('Escape');

  const boundary = await page.evaluate(async () => {
    const modulePath = '/src/lib/browser.ts';
    const {browserCommand} = await import(/* @vite-ignore */ modulePath);
    const before = await browserCommand({action: 'snapshot'});
    const status = await browserCommand({action: 'provider_status'});
    const login = await browserCommand({action: 'provider_login'});
    let generateError: string | null = null;
    try { await browserCommand({action: 'generate', requestId: crypto.randomUUID(), prompt: 'QA browser boundary', count: 3}); }
    catch (error) { generateError = error instanceof Error ? error.message : String(error); }
    const after = await browserCommand({action: 'snapshot'});
    return {native: false, status, login, generateError, beforeJobs: before.project.jobs, afterJobs: after.project.jobs, beforeAssets: before.project.assets.length, afterAssets: after.project.assets.length};
  });
  for (const connection of [boundary.status, boundary.login]) {
    expect(connection.ready).toBe(false); expect(connection.authenticated).toBe(false);
    expect(connection.confirmedModel).toBeNull(); expect(connection.reason).toContain('데스크톱 전용');
  }
  expect(boundary.generateError).toContain('데스크톱 전용');
  expect(boundary.beforeJobs).toEqual([]); expect(boundary.afterJobs).toEqual([]);
  expect(boundary.beforeAssets).toBe(12); expect(boundary.afterAssets).toBe(12);
  const externalRequests = externalRequestsByPage.get(page)!;
  expect(externalRequests).toEqual([]);
  await writeFile(testInfo.outputPath('browser-provider-gate.json'), JSON.stringify({...boundary, externalRequests}, null, 2));
});

test('resize writes a new version, survives reload, and exports original bytes plus the new PNG', async ({page}, testInfo) => {
  const initialCard = page.getByRole('listitem').first();
  const name = await initialCard.locator('strong').innerText();
  const dimensions = (await initialCard.innerText()).match(/(\d+)\s*×\s*(\d+)/)!;
  const originalWidth = Number(dimensions[1]), originalHeight = Number(dimensions[2]);
  await initialCard.click();
  await page.getByLabel('너비 px', {exact: true}).fill('128');
  await page.getByLabel('높이 px', {exact: true}).fill('96');
  await page.getByRole('button', {name: '크기 조정', exact: true}).click();
  await expect(initialCard.locator('.version-label')).toHaveText('v2', {timeout: 30_000});
  await expect(initialCard).toContainText('128 × 96');
  await expect(page.locator('.job-status.succeeded')).toHaveCount(1);

  await page.reload();
  await expect(page.getByRole('listitem')).toHaveCount(12);
  const restored = page.getByRole('listitem').filter({hasText: name}).first();
  await expect(restored.locator('.version-label')).toHaveText('v2');
  await restored.dblclick();
  await expect(page.getByRole('tab', {name: '2D 캔버스'})).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.canvas-status')).toContainText('128 × 96 px');

  await page.getByRole('button', {name: /묶음 내보내기/}).click();
  const dialog = page.getByRole('dialog', {name: '에셋 묶음 내보내기'});
  const pendingDownload = page.waitForEvent('download');
  await dialog.getByRole('button', {name: '묶음 내보내기', exact: true}).click();
  const download = await pendingDownload;
  const archivePath = testInfo.outputPath('fixture-versions.zip');
  await download.saveAs(archivePath);
  const zip = await JSZip.loadAsync(await readFile(archivePath), {checkCRC32: true});
  const manifest = JSON.parse(await zip.file('asset-studio.json')!.async('string'));
  const asset = manifest.snapshot.project.assets[0];
  expect(manifest.snapshot.project.assets).toHaveLength(1);
  expect(asset.versions).toHaveLength(2);
  expect(asset.versions[0].source).toBe('fixture');
  const mapping = new Map<string,string>(manifest.bundledArtifacts.map((entry: {artifactPath: string; zipPath: string}) => [entry.artifactPath,entry.zipPath]));
  const decoded: {number: number; role: string; width: number; height: number}[] = [];
  for (const version of asset.versions) {
    expect(version.requestedModel).toBeNull();
    expect(version.confirmedModel).toBeNull();
    for (const artifact of version.artifacts) {
      const bytes = await zip.file(mapping.get(artifact.path)!)!.async('nodebuffer');
      expect(bytes.length).toBe(artifact.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
      if (artifact.format === 'png') {
        const png = PNG.sync.read(bytes, {checkCRC: true});
        decoded.push({number: version.number, role: artifact.role, width: png.width, height: png.height});
      }
    }
  }
  expect(decoded).toContainEqual({number: 1, role: 'source', width: originalWidth, height: originalHeight});
  expect(decoded).toContainEqual({number: 2, role: 'output', width: 128, height: 96});
});

test('selected fixture icons produce an atlas with valid frames in the downloaded bundle', async ({page}, testInfo) => {
  const cards = page.getByRole('listitem');
  await cards.nth(0).click();
  await cards.nth(1).click({modifiers: ['Control']});
  await cards.nth(2).click({modifiers: ['Control']});
  await page.getByRole('button', {name: '아틀라스', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '스프라이트 아틀라스'});
  await expect(dialog).toContainText('2D 에셋 3개');
  await dialog.getByLabel('아틀라스 너비 px', {exact: true}).fill('2048');
  await dialog.getByLabel('아틀라스 높이 px', {exact: true}).fill('1024');
  await dialog.getByRole('button', {name: '아틀라스 제작', exact: true}).click();
  await expect(cards).toHaveCount(13, {timeout: 30_000});
  const atlasCard = cards.filter({hasText: 'Atlas 1'});
  await atlasCard.click();
  await page.getByRole('button', {name: /묶음 내보내기/}).click();
  const exportDialog = page.getByRole('dialog', {name: '에셋 묶음 내보내기'});
  const pendingDownload = page.waitForEvent('download');
  await exportDialog.getByRole('button', {name: '묶음 내보내기', exact: true}).click();
  const archivePath = testInfo.outputPath('fixture-atlas.zip');
  await (await pendingDownload).saveAs(archivePath);
  const zip = await JSZip.loadAsync(await readFile(archivePath), {checkCRC32: true});
  const manifest = JSON.parse(await zip.file('asset-studio.json')!.async('string'));
  const asset = manifest.snapshot.project.assets[0];
  expect(asset.kind).toBe('sprite');
  const mapping = new Map<string,string>(manifest.bundledArtifacts.map((entry: {artifactPath: string; zipPath: string}) => [entry.artifactPath,entry.zipPath]));
  const version = asset.versions[0];
  const output = version.artifacts.find((artifact: {role: string; format: string}) => artifact.role === 'output' && artifact.format === 'png');
  const metadata = version.artifacts.find((artifact: {role: string}) => artifact.role === 'metadata');
  const pixels = PNG.sync.read(await zip.file(mapping.get(output.path)!)!.async('nodebuffer'), {checkCRC: true});
  const layout = JSON.parse(await zip.file(mapping.get(metadata.path)!)!.async('string'));
  expect([pixels.width,pixels.height]).toEqual([2048,1024]);
  const frames = Object.values(layout.frames) as {frame: {x: number;y: number;w: number;h: number}}[];
  expect(frames).toHaveLength(3);
  for (const {frame} of frames) {
    expect(frame.x).toBeGreaterThanOrEqual(0); expect(frame.y).toBeGreaterThanOrEqual(0);
    expect(frame.x+frame.w).toBeLessThanOrEqual(pixels.width); expect(frame.y+frame.h).toBeLessThanOrEqual(pixels.height);
    let visible = 0;
    for(let y=frame.y;y<frame.y+frame.h;y++) for(let x=frame.x;x<frame.x+frame.w;x++) if(pixels.data[(y*pixels.width+x)*4+3]) visible++;
    expect(visible).toBeGreaterThan(0);
  }
  // Exact native source/atlas pixel equality is checked separately by Rust + independent artifact tests.
});

test('keyboard dialogs keep focus inside and return focus to the triggering control', async ({page}) => {
  const trigger = page.getByRole('button', {name: '구독 연결', exact: true});
  await trigger.focus();
  await page.keyboard.press('Enter');
  const provider = page.getByRole('dialog', {name: '이미지 생성 연동 상태'});
  await expect(provider).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    await expect(provider.locator(':focus')).toHaveCount(1);
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Shift+Tab');
    await expect(provider.locator(':focus')).toHaveCount(1);
  }
  await page.keyboard.press('Escape');
  await expect(provider).toBeHidden();
  await expect(trigger).toBeFocused();

  const newProject = page.getByRole('button', {name: '새 프로젝트', exact: true});
  await newProject.focus();
  await page.keyboard.press('Enter');
  const project = page.getByRole('dialog', {name: '새 프로젝트', exact: true});
  await expect(project.getByLabel('프로젝트 이름')).toBeFocused();
  await project.getByLabel('프로젝트 이름').fill('QA 키보드');
  await page.keyboard.press('Escape');
  await expect(project).toBeHidden();
  await expect(newProject).toBeFocused();
  await expect(page.getByRole('listitem')).toHaveCount(12);
});

for (const unit of ['m', 'cm'] as const) test(`browser procedural model (${unit}) exports real GLB with independent geometry checks and explicit Blender provenance`, async ({page}, testInfo) => {
  const displayFactor = unit === 'cm' ? 100 : 1;
  if (unit === 'cm') {
    const specification = page.getByRole('tab', {name: '규격', exact: true});
    await specification.click();
    await expect(specification).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('combobox', {name: /3D 단위/}).selectOption('cm');
    await page.getByRole('button', {name: '규격 저장', exact: true}).click();
    await expect(page.getByRole('status')).toContainText('제작 규격을 저장했습니다.');
  }
  await page.getByRole('button', {name: '3D 만들기', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '절차적 3D 모델 제작'});
  await expect(dialog).toContainText('브라우저에서는 Three.js로 GLB 메시를 제작합니다.');
  await expect(dialog).toContainText('Blender 원본과 네이티브 작업 검증은 데스크톱에서 가능합니다.');
  await dialog.getByRole('button', {name: /^테이블/}).click();
  await dialog.getByLabel('모델 이름', {exact: true}).fill('QA 브라우저 테이블');
  await dialog.getByLabel(`너비 (${unit})`, {exact: true}).fill(String(2 * displayFactor));
  await dialog.getByLabel(`깊이 (${unit})`, {exact: true}).fill(String(0.9 * displayFactor));
  await dialog.getByLabel(`높이 (${unit})`, {exact: true}).fill(String(0.75 * displayFactor));
  await dialog.getByLabel(`모서리 베벨 (${unit})`, {exact: true}).fill(String(0.02 * displayFactor));
  await dialog.getByRole('button', {name: '모델 제작 시작', exact: true}).click();
  await expect(page.getByRole('listitem')).toHaveCount(13, {timeout: 30_000});
  await page.getByRole('listitem').filter({hasText: 'QA 브라우저 테이블'}).click();
  await page.getByRole('button', {name: /묶음 내보내기/}).click();
  const exportDialog = page.getByRole('dialog', {name: '에셋 묶음 내보내기'});
  const pendingDownload = page.waitForEvent('download');
  await exportDialog.getByRole('button', {name: '묶음 내보내기', exact: true}).click();
  const archivePath = testInfo.outputPath('browser-procedural-table.zip');
  await (await pendingDownload).saveAs(archivePath);
  const zip = await JSZip.loadAsync(await readFile(archivePath), {checkCRC32: true});
  const manifest = JSON.parse(await zip.file('asset-studio.json')!.async('string'));
  const asset = manifest.snapshot.project.assets[0], version = asset.versions[0];
  expect(asset.kind).toBe('model');
  expect(version.source).toBe('procedural');
  expect(version.settings.generator).toBe('three-mesh-template');
  expect(version.settings.blenderUsed).toBe(false);
  expect(version.settings.parameters.width).toBeCloseTo(2, 4);
  expect(version.artifacts.some((artifact: {format: string}) => artifact.format === 'blend')).toBe(false);
  expect(version.requestedModel).toBeNull(); expect(version.confirmedModel).toBeNull();
  const output = version.artifacts.find((artifact: {format: string; role: string}) => artifact.format === 'glb' && artifact.role === 'output');
  const mapping = manifest.bundledArtifacts.find((entry: {artifactPath: string}) => entry.artifactPath === output.path);
  const bytes = await zip.file(mapping.zipPath)!.async('nodebuffer');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(output.sha256);
  expect(bytes.length).toBe(output.bytes);
  await writeFile(testInfo.outputPath('browser-procedural-table.glb'), bytes);
  const geometry = await inspectGlb(bytes);
  expect(geometry.loader).toBe('Three.js GLTFLoader');
  expect(geometry.triangles).toBe(asset.mesh.triangles);
  expect(geometry.vertices).toBeGreaterThan(0); expect(geometry.materials).toBeGreaterThan(0);
  expect(geometry.degenerateTriangles).toBe(0);
  expect(geometry.dimensions[0]).toBeCloseTo(2, 4);
  expect(geometry.dimensions[1]).toBeCloseTo(0.75, 4);
  expect(geometry.dimensions[2]).toBeCloseTo(0.9, 4);
  await writeFile(testInfo.outputPath('browser-model-independent-verification.json'), JSON.stringify({scope: 'Browser Three.js procedural export; native Blender not used', displayUnit: unit, ...geometry}, null, 2));
});
