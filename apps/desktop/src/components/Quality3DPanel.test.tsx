import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {JsxEmit, ModuleKind, ScriptTarget, transpileModule} from 'typescript';
import {chromium, expect as uiExpect} from '@playwright/test';
import type {Browser, BrowserContext, Page} from '@playwright/test';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {DEFAULT_SPEC, DEFAULT_STYLE} from '@local-assets/contracts';
import type {Asset, Local3DStatus, ProjectSnapshot, Quality3DRequest} from '@local-assets/contracts';
import type {Quality3DPanelProps} from './Quality3DPanel';

// UI-only fixtures: real React rendering in Chromium, fake bridge responses and tiny
// local thumbnails. No IPC, model download, reconstruction, or native artifact verification.
type FixtureProps = Omit<Quality3DPanelProps, 'onSubmit' | 'onClose'>;
type Fixture = {
  props: FixtureProps;
  bridgeNative: boolean;
  status: Local3DStatus;
  prepareStatus: Local3DStatus;
  cancelStatus: Local3DStatus;
  commands: Array<{action: string; confirmed?: boolean}>;
  requests: Quality3DRequest[];
  closed: boolean;
  failStatus: boolean;
  failSubmit: boolean;
  holdSubmit: boolean;
  deferStatus: boolean;
  releaseStatus?: () => void;
  releaseSubmit?: () => void;
};
declare global {
  interface Window {
    __QUALITY3D_UI_FIXTURE__: Fixture;
    __QUALITY3D_UI_RENDER__: () => void;
    __QUALITY3D_UI_UNMOUNT__: () => void;
  }
}

function asset(id: string, format: string, kind: Asset['kind'] = 'image'): Asset {
  return {id, name: `Fixture ${id}`, kind, folder: 'UI fixtures', tags: [], activeVersionId: `${id}-v1`,
    width: kind === 'model' ? null : 128, height: kind === 'model' ? null : 128,
    mesh: kind === 'model' ? {vertices: 200, triangles: 100, dimensions: [1, 1, 1], unit: 'm'} : null,
    versions: [{id: `${id}-v1`, number: 1, createdAt: '2026-10-04T00:00:00Z', prompt: 'UI fixture only', source: 'fixture',
      requestedModel: null, confirmedModel: null, providerVersion: null, settings: {}, validation: null,
      artifacts: [
        {id: `${id}-input`, path: `fixtures/${id}.${format}`, format, sha256: 'ui-fixture', bytes: 100, role: 'source'},
        {id: `${id}-thumb`, path: `fixtures/${id}-thumb.png`, format: 'png', sha256: 'ui-fixture', bytes: 68, role: 'thumbnail'},
      ]}],
  };
}
function snapshot(): ProjectSnapshot {
  const thumbnailOnly = asset('thumbnail-only', 'png');
  thumbnailOnly.versions[0].artifacts = thumbnailOnly.versions[0].artifacts.filter(item => item.role === 'thumbnail');
  const stale = asset('old-version-only', 'png');
  stale.activeVersionId = 'missing-current-version';
  return {root: '/ui-fixture-only', providers: [], project: {id: 'quality3d-ui', name: 'UI fixture project', schemaVersion: 1,
    createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z', spec: {...DEFAULT_SPEC, polygonBudget: 24000},
    styleGuide: {...DEFAULT_STYLE}, jobs: [], assets: [asset('jpeg', 'jpg'), asset('png', 'PNG'), asset('webp', 'webp', 'texture'),
      asset('png-2', 'png', 'sprite'), asset('jpeg-2', 'jpeg'), asset('png-3', 'png'), asset('model', 'glb', 'model'),
      asset('gif', 'gif'), asset('gltf', 'gltf', 'model'), thumbnailOnly, stale]},
  };
}
function status(overrides: Partial<Local3DStatus> = {}): Local3DStatus {
  return {supported: true, installed: true, busy: false, state: 'ready', message: 'UI 모형: 로컬 모델 준비 완료', stage: 'ready',
    modelId: 'UI-fixture-TripoSR', modelRevision: 'ui-fixture', device: 'cpu', pythonVersion: '3.11', weightBytes: 1680000000,
    memoryMb: 16384, minimumMemoryMb: 16384, blenderReady: true, ...overrides};
}

let browser: Browser;
let context: BrowserContext;
let page: Page;
let modules: Record<string, string>;

// Wrap the locally installed React CommonJS distributions as browser modules.
// This deliberately avoids esbuild.build, which hangs on the shared Mac host.
async function reactModule(packageName: string, file: string, exports: string[], dependencies: string[] = []) {
  const require = createRequire(import.meta.url);
  const directory = dirname(require.resolve(packageName));
  const source = await readFile(join(directory, 'cjs', file), 'utf8');
  return `${dependencies.map((dependency, index) => `import dependency${index} from ${JSON.stringify(`/modules/${dependency}.js`)};`).join('\n')}
    const process = {env: {NODE_ENV: 'development'}};
    const module = {exports: {}};
    const exports = module.exports;
    const dependencies = {${dependencies.map((dependency, index) => `${JSON.stringify(dependency)}: dependency${index}`).join(',')}};
    const require = name => dependencies[name];
    ${source}
    export default module.exports;
    ${exports.map(name => `export const ${name} = module.exports.${name};`).join('\n')}
  `;
}

beforeAll(async () => {
  const [source, react, jsxRuntime, reactDOM, client, scheduler, ...styles] = await Promise.all([
    readFile(new URL('./Quality3DPanel.tsx', import.meta.url), 'utf8'),
    reactModule('react', 'react.development.js', ['createElement', 'useEffect', 'useId', 'useRef', 'useState']),
    reactModule('react', 'react-jsx-runtime.development.js', ['jsx', 'jsxs', 'Fragment'], ['react']),
    reactModule('react-dom', 'react-dom.development.js', [], ['react']),
    reactModule('react-dom/client', 'react-dom-client.development.js', ['createRoot'], ['scheduler', 'react', 'react-dom']),
    reactModule('scheduler', 'scheduler.development.js', []),
    ...['../styles.css', '../readability.css', './Quality3DPanel.css'].map(path => readFile(new URL(path, import.meta.url), 'utf8')),
  ]);
  modules = {
    '/modules/react.js': react,
    '/modules/react-jsx-runtime.js': jsxRuntime,
    '/modules/react-dom.js': reactDOM,
    '/modules/react-dom-client.js': client,
    '/modules/scheduler.js': scheduler,
    '/components/Quality3DPanel.js': transpileModule(source.replace("import './Quality3DPanel.css';", ''), {
      compilerOptions: {target: ScriptTarget.ES2022, module: ModuleKind.ESNext, jsx: JsxEmit.ReactJSX},
    }).outputText,
    // Icons are decoration-only UI mocks; state, effects and DOM are real React.
    '/modules/lucide.js': `import {createElement} from 'react';
      const Icon = props => createElement('svg', {...props, width: props.size, height: props.size, 'aria-hidden': true}, createElement('path', {d: 'M4 4h12v12H4z'}));
      export const AlertTriangle=Icon, Ban=Icon, Box=Icon, Check=Icon, Download=Icon, FileImage=Icon, Layers=Icon, LoaderCircle=Icon, RefreshCw=Icon, X=Icon;`,
    '/styles.css': styles.join('\n').replace(/^@import.*$/gm, ''),
    '/': `<html><head><link rel="stylesheet" href="/styles.css"><script type="importmap">${JSON.stringify({imports: {
      react: '/modules/react.js', 'react/jsx-runtime': '/modules/react-jsx-runtime.js', 'react-dom/client': '/modules/react-dom-client.js', 'lucide-react': '/modules/lucide.js',
    }})}</script></head><body><main class="workbench" style="display:block;min-width:0"><section class="dialog dialog-quality3d" style="margin:24px auto" id="root"></section></main><script type="module" src="/fixture.js"></script></body></html>`,
    '/fixture.js': `
      import {createElement} from 'react';
      import {createRoot} from 'react-dom/client';
      import Quality3DPanel from '/components/Quality3DPanel.js';
      const fixture = window.__QUALITY3D_UI_FIXTURE__;
      const root = createRoot(document.getElementById('root'));
      window.__QUALITY3D_UI_RENDER__ = () => root.render(createElement(Quality3DPanel, {...fixture.props,
        onClose: () => {fixture.closed = true;},
        onSubmit: async request => {
          fixture.requests.push(request);
          if (fixture.failSubmit) throw new Error('bearer UI-secret-must-not-render');
          if (fixture.holdSubmit) await new Promise(resolve => {fixture.releaseSubmit = resolve;});
        }}));
      window.__QUALITY3D_UI_UNMOUNT__ = () => root.unmount();
      window.__QUALITY3D_UI_RENDER__();
    `,
    '/lib/bridge': `
        const fixture = window.__QUALITY3D_UI_FIXTURE__;
        export const isNative = fixture.bridgeNative;
        export const artifactUrl = (_, artifact) => artifact
          ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=#' + encodeURIComponent(artifact.path)
          : '';
        export const command = async request => {
          fixture.commands.push(request);
          if (request.action === 'quality3d_status') {
            if (fixture.failStatus) throw new Error('authorization: UI-secret-must-not-render');
            const response = structuredClone(fixture.status);
            if (fixture.deferStatus) await new Promise(resolve => {fixture.releaseStatus = resolve;});
            return response;
          }
          if (request.action === 'quality3d_prepare') {
            fixture.status = structuredClone(fixture.prepareStatus);
            return structuredClone(fixture.status);
          }
          if (request.action === 'quality3d_cancel_setup') {
            fixture.status = structuredClone(fixture.cancelStatus);
            return structuredClone(fixture.status);
          }
          throw new Error('Unexpected UI fixture command');
        };
      `,
  };
  browser = await chromium.launch({headless: true});
});
beforeEach(async () => {
  context = await browser.newContext({viewport: {width: 1100, height: 1000}});
  page = await context.newPage();
  await page.clock.install({time: new Date('2026-10-04T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-10-04T00:00:00Z'));
});
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); });

async function mount(overrides: Partial<Fixture> = {}, props: Partial<FixtureProps> = {}) {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const fixture: Fixture = {props: {snapshot: snapshot(), selectedIds: ['png'], native: true, blenderReady: true, busy: false, ...props},
    bridgeNative: true, status: status(), prepareStatus: status({state: 'preparing', installed: false, busy: true, message: 'UI 모형: 준비 중'}),
    cancelStatus: status({state: 'cancelled', installed: false, message: 'UI 모형: 준비 취소됨'}), commands: [], requests: [], closed: false,
    failStatus: false, failSubmit: false, holdSubmit: false, deferStatus: false, ...overrides};
  await page.route('http://quality3d-ui.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = modules[path];
    if (body === undefined) return route.abort();
    await route.fulfill({body, contentType: path === '/' ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript'});
  });
  await page.addInitScript(value => {window.__QUALITY3D_UI_FIXTURE__ = value;}, fixture);
  await page.goto('http://quality3d-ui.test/');
  expect(pageErrors).toEqual([]);
  await uiExpect(page.getByRole('heading', {name: '정밀3D', exact: true})).toBeVisible();
  if (fixture.bridgeNative && fixture.props.native) {
    await uiExpect.poll(() => page.evaluate(() => window.__QUALITY3D_UI_FIXTURE__.commands.length)).toBe(1);
    await uiExpect(page.locator('.quality3d-state')).not.toHaveText('확인 중');
  }
}
const submitButton = () => page.getByRole('button', {name: '이미지에서3D 만들기', exact: true});
const modelSubmit = () => page.getByRole('button', {name: '모델다듬기 새 버전 만들기', exact: true});
const consent = () => page.getByRole('checkbox', {name: /1회 다운로드에 동의합니다/});
const commands = () => page.evaluate(() => window.__QUALITY3D_UI_FIXTURE__.commands);
const requests = () => page.evaluate(() => window.__QUALITY3D_UI_FIXTURE__.requests);

describe('Quality3DPanel UI (mocked native boundary)', () => {
  it('uses current source/output artifacts, PNG-first ordering, real thumbnail URLs and initial IDs', async () => {
    await mount({}, {selectedIds: ['jpeg', 'png', 'jpeg', 'unavailable']});
    const choices = page.getByRole('group', {name: '프로젝트 에셋 선택'}).getByRole('button');
    await uiExpect(choices).toHaveCount(6);
    await uiExpect(choices.first()).toHaveAttribute('aria-label', 'Fixture png 선택');
    await uiExpect(page.getByRole('button', {name: 'Fixture jpeg 선택', exact: true})).toHaveAttribute('aria-pressed', 'true');
    await uiExpect(page.getByRole('button', {name: 'Fixture png 선택', exact: true})).toHaveAttribute('aria-pressed', 'true');
    await uiExpect(page.getByLabel('결과 이름', {exact: true})).toHaveValue('Fixture jpeg 3D');
    await uiExpect(page.getByRole('group', {name: '선택한 입력'}).getByRole('button')).toHaveCount(2);
    await uiExpect(choices.first().locator('img')).toHaveAttribute('src', /fixtures%2Fpng-thumb\.png$/);
    await uiExpect.poll(() => choices.first().locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await uiExpect(page.getByRole('button', {name: /thumbnail-only|old-version-only|Fixture gif 선택/})).toHaveCount(0);
    await uiExpect(page.getByLabel('삼각형 예산', {exact: true})).toHaveValue('10000');
  });

  it('submits five distinct image IDs and exactly the shared request fields, leaving suffixes to the parent', async () => {
    const ids = ['png', 'jpeg', 'webp', 'png-2', 'jpeg-2'];
    const project = snapshot();
    project.project.spec.polygonBudget = 100000;
    await mount({}, {selectedIds: ids, snapshot: project});
    await page.getByLabel('결과 이름', {exact: true}).fill('  Local batch  ');
    await page.getByLabel('형상 추정 품질', {exact: true}).selectOption('high');
    await page.getByLabel('높이 (m)', {exact: true}).fill('0.03');
    await page.getByLabel('삼각형 예산', {exact: true}).fill('100000');
    await page.getByLabel('텍스처 크기', {exact: true}).selectOption('2048');
    await page.getByRole('checkbox', {name: '원본 재질·색상 보존'}).uncheck();
    await uiExpect(page.locator('.quality3d-output-summary')).toContainText('이미지 5개 → 개별 3D 에셋 5개');
    await submitButton().click();
    await uiExpect.poll(requests).toEqual([{assetIds: ids, name: 'Local batch', quality: 'high', heightMeters: .03,
      maxTriangles: 100000, textureResolution: 2048, preserveMaterials: false}]);
    expect(await commands()).toEqual([{action: 'quality3d_status'}]);
  });

  it('limits new choices to five, lets chips remove inputs and keeps edited names', async () => {
    await mount();
    for (const id of ['jpeg', 'webp', 'png-2', 'jpeg-2']) await page.getByRole('button', {name: `Fixture ${id} 선택`, exact: true}).click();
    await uiExpect(page.getByRole('button', {name: 'Fixture png-3 선택', exact: true})).toBeDisabled();
    await page.getByLabel('결과 이름', {exact: true}).fill('Keep this name');
    await page.getByRole('button', {name: 'Fixture png 선택 해제', exact: true}).click();
    await page.getByRole('button', {name: 'Fixture png-3 선택', exact: true}).click();
    await uiExpect(page.getByLabel('결과 이름', {exact: true})).toHaveValue('Keep this name');
    await uiExpect(page.getByRole('group', {name: '선택한 입력'}).getByRole('button')).toHaveCount(5);
    await page.getByLabel('프로젝트 입력 검색').fill('webp');
    await uiExpect(page.getByRole('group', {name: '프로젝트 에셋 선택'}).getByRole('button')).toHaveCount(1);
  });

  it('keeps over-limit initial selection visible and blocks it until corrected', async () => {
    await mount({}, {selectedIds: ['png', 'jpeg', 'webp', 'png-2', 'jpeg-2', 'png-3']});
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(page.getByRole('group', {name: '선택한 입력'}).getByRole('button')).toHaveCount(6);
    await page.getByRole('button', {name: 'Fixture png-3 선택 해제', exact: true}).click();
    await uiExpect(submitButton()).toBeEnabled();
  });

  it('requires homogeneous inputs and switches to model finishing without TripoSR', async () => {
    await mount({status: status({installed: false, state: 'missing'})}, {selectedIds: ['png', 'model']});
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(page.getByText('이미지와 GLB는 나누어 선택하세요.', {exact: false})).toBeVisible();
    await page.getByRole('button', {name: /모델다듬기 기존 GLB/}).click();
    await uiExpect(modelSubmit()).toBeEnabled();
    await uiExpect(page.getByRole('group', {name: '선택한 입력'}).getByRole('button')).toHaveCount(1);
    await uiExpect(page.getByRole('button', {name: '로컬 모델 준비', exact: true})).toHaveCount(0);
    await modelSubmit().click();
    const submitted = await requests();
    expect(submitted[0].assetIds).toEqual(['model']);
    expect(submitted[0].preserveMaterials).toBe(true);
    expect(await commands()).toEqual([{action: 'quality3d_status'}]);
  });

  it.each([{native: false, bridgeNative: true}, {native: true, bridgeNative: false}])('never sends IPC when either native flag is false: %j', async flags => {
    await mount({bridgeNative: flags.bridgeNative}, {native: flags.native});
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(consent()).toBeDisabled();
    await uiExpect(page.getByRole('button', {name: '로컬 모델 준비', exact: true})).toBeDisabled();
    await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    await page.clock.runFor(6000);
    expect(await commands()).toEqual([]);
    expect(await requests()).toEqual([]);
  });

  it.each(['missing', 'error', 'cancelled', 'unsupported', 'preparing'] as const)('gates image requests while runtime is %s', async state => {
    await mount({status: status({state, installed: false, supported: state !== 'unsupported', busy: state === 'preparing'})});
    await uiExpect(submitButton()).toBeDisabled();
    await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    expect(await requests()).toEqual([]);
  });

  it('requires both an installed runtime and Blender for image reconstruction', async () => {
    await mount({status: status({installed: false})});
    await uiExpect(submitButton()).toBeDisabled();
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.status.installed = true;});
    await page.getByRole('button', {name: '준비 상태 다시 확인'}).click();
    await uiExpect(submitButton()).toBeEnabled();
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.props.blenderReady = false; window.__QUALITY3D_UI_RENDER__();});
    await uiExpect(submitButton()).toBeDisabled();
  });

  it('blocks stale ready status after a failed refresh and recovers on a successful read', async () => {
    await mount();
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.failStatus = true;});
    await page.getByRole('button', {name: '준비 상태 다시 확인'}).click();
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(page.locator('.quality3d-state')).toHaveText('확인 필요');
    await uiExpect(page.getByRole('alert')).toContainText('상태를 다시 확인하세요');
    await uiExpect(page.locator('body')).not.toContainText('UI-secret-must-not-render');
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.failStatus = false;});
    await page.getByRole('button', {name: '준비 상태 다시 확인'}).click();
    await uiExpect(submitButton()).toBeEnabled();
  });

  it('allows existing GLB with Blender even if runtime status fails; still requires Blender', async () => {
    await mount({failStatus: true}, {selectedIds: ['model']});
    await uiExpect(modelSubmit()).toBeEnabled();
    await uiExpect(page.getByText(/TripoSR 설치가 필요 없습니다/)).toBeVisible();
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.props.blenderReady = false; window.__QUALITY3D_UI_RENDER__();});
    await uiExpect(modelSubmit()).toBeDisabled();
  });

  it('requires explicit download consent and polls only preparing, stopping at ready', async () => {
    await mount({status: status({state: 'missing', installed: false})});
    const prepare = page.getByRole('button', {name: '로컬 모델 준비', exact: true});
    await uiExpect(consent()).not.toBeChecked();
    await uiExpect(prepare).toBeDisabled();
    await page.clock.runFor(5000);
    expect(await commands()).toEqual([{action: 'quality3d_status'}]);
    await consent().check();
    expect(await commands()).toEqual([{action: 'quality3d_status'}]);
    await prepare.click();
    await uiExpect(page.locator('.quality3d-state')).toHaveText('준비 중');
    expect(await commands()).toEqual([{action: 'quality3d_status'}, {action: 'quality3d_prepare', confirmed: true}]);
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.status = {...window.__QUALITY3D_UI_FIXTURE__.status, state: 'ready', installed: true, busy: false};});
    await page.clock.runFor(1100);
    await uiExpect(submitButton()).toBeEnabled();
    const stopped = await commands();
    await page.clock.runFor(6000);
    expect(await commands()).toEqual(stopped);
  });

  it('cancels setup and ignores a stale in-flight poll instead of restarting it', async () => {
    await mount({status: status({state: 'preparing', installed: false, busy: true}), cancelStatus: status({state: 'cancelled', installed: false})});
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.deferStatus = true;});
    await page.clock.runFor(1100);
    await uiExpect.poll(async () => (await commands()).length).toBe(2);
    await page.getByRole('button', {name: '준비 취소', exact: true}).click();
    await uiExpect(page.locator('.quality3d-state')).toHaveText('준비 취소됨');
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.releaseStatus?.();});
    await page.clock.runFor(6000);
    await uiExpect(page.locator('.quality3d-state')).toHaveText('준비 취소됨');
    expect(await commands()).toEqual([{action: 'quality3d_status'}, {action: 'quality3d_status'}, {action: 'quality3d_cancel_setup'}]);
    await uiExpect(consent()).not.toBeChecked();
  });

  it('rejects blank or out-of-range fields, including fractional triangle budgets', async () => {
    await mount();
    for (const [label, values, valid] of [
      ['결과 이름', [' ', ''], 'Valid name'],
      ['높이 (m)', ['', '0.029', '100.001'], '100'],
      ['삼각형 예산', ['', '999', '100001', '1000.5'], '1000'],
    ] as const) {
      for (const value of values) {
        await page.getByLabel(label, {exact: true}).fill(value);
        await uiExpect(submitButton()).toBeDisabled();
        await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
      }
      await page.getByLabel(label, {exact: true}).fill(valid);
      await uiExpect(submitButton()).toBeEnabled();
    }
    expect(await requests()).toEqual([]);
    await page.getByLabel('형상 추정 품질', {exact: true}).selectOption('draft');
    await page.getByLabel('텍스처 크기', {exact: true}).selectOption('512');
    await submitButton().click();
    expect((await requests())[0]).toMatchObject({quality: 'draft', heightMeters: 100, maxTriangles: 1000, textureResolution: 512});
  });

  it('uses a smaller project budget and blocks inputs that disappear from the snapshot', async () => {
    const project = snapshot();
    project.project.spec.polygonBudget = 4500;
    await mount({}, {snapshot: project});
    await uiExpect(page.getByLabel('삼각형 예산', {exact: true})).toHaveValue('4500');
    await uiExpect(page.getByLabel('삼각형 예산', {exact: true})).toHaveAttribute('max', '4500');
    await page.getByLabel('삼각형 예산', {exact: true}).fill('4501');
    await uiExpect(submitButton()).toBeDisabled();
    await page.getByLabel('삼각형 예산', {exact: true}).fill('4500');
    await uiExpect(submitButton()).toBeEnabled();
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.props.snapshot.project.assets = []; window.__QUALITY3D_UI_RENDER__();});
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(page.getByText(/선택한 입력의 현재 파일을 사용할 수 없습니다/)).toBeVisible();
  });

  it('clearly rejects project budgets below 1000 without silently raising them', async () => {
    const project = snapshot();
    project.project.spec.polygonBudget = 500;
    await mount({}, {snapshot: project});
    await uiExpect(page.getByLabel('삼각형 예산', {exact: true})).toHaveValue('500');
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(page.getByText(/프로젝트 삼각형 예산은 1,000 이상이어야 합니다/)).toBeVisible();
    await page.getByLabel('삼각형 예산', {exact: true}).fill('1000');
    await uiExpect(submitButton()).toBeDisabled();
    expect(await requests()).toEqual([]);
  });

  it('honors parent/runtime busy flags and prevents duplicate pending submission', async () => {
    await mount({holdSubmit: true, status: status({busy: true})}, {busy: true});
    await uiExpect(submitButton()).toBeDisabled();
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.props.busy = false; window.__QUALITY3D_UI_RENDER__();});
    await uiExpect(submitButton()).toBeDisabled();
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.status.busy = false;});
    await page.getByRole('button', {name: '준비 상태 다시 확인'}).click();
    await submitButton().click();
    await uiExpect(page.getByRole('button', {name: '요청 제출 중', exact: true})).toBeDisabled();
    await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    expect(await requests()).toHaveLength(1);
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.releaseSubmit?.();});
    await uiExpect(submitButton()).toBeEnabled();
  });

  it('shows honest limitations, safe errors and invokes onClose', async () => {
    await mount({failSubmit: true});
    await uiExpect(page.locator('.quality3d-limits')).not.toHaveAttribute('open');
    await page.getByText('결과와 처리 시간 안내', {exact: true}).click();
    for (const text of ['Tripo Studio H3.1', '8K', '뒷면은 추정', '몇 분 이상', 'Python 3.9', '자동 리깅', '쿼드 리토폴로지', '.blend', '턴테이블']) {
      await uiExpect(page.getByText(text, {exact: false}).first()).toBeVisible();
    }
    await submitButton().click();
    await uiExpect(page.getByRole('alert')).toContainText('작업을 제출하지 못했습니다');
    await uiExpect(page.locator('body')).not.toContainText('UI-secret-must-not-render');
    await page.getByRole('button', {name: '닫기', exact: true}).click();
    expect(await page.evaluate(() => window.__QUALITY3D_UI_FIXTURE__.closed)).toBe(true);
  });

  it('validates the backend 72-codepoint name limit and rejects path/control characters', async () => {
    await mount();
    const name = page.getByLabel('결과 이름', {exact: true});
    for (const invalid of ['a'.repeat(73), '😀'.repeat(73), 'bad/name', 'bad\\name', 'bad:name', 'bad*name', 'bad?name', 'bad"name', 'bad<name', 'bad>name', 'bad|name', 'bad\u0001name', 'bad\u007fname', '.', '..']) {
      await name.fill(invalid);
      await uiExpect(submitButton()).toBeDisabled();
    }
    for (const valid of ['a'.repeat(72), '😀'.repeat(72)]) {
      await name.fill(valid);
      await uiExpect(submitButton()).toBeEnabled();
    }
    await submitButton().click();
    expect(Array.from((await requests())[0].name)).toHaveLength(72);
  });

  it('truncates only the proposed new model name, preserving the original asset', async () => {
    const project = snapshot();
    const original = project.project.assets.find(item => item.id === 'model')!;
    original.name = '😀'.repeat(80);
    await mount({}, {selectedIds: ['model'], snapshot: project});
    await uiExpect(page.getByLabel('결과 이름', {exact: true})).toHaveValue(`${'😀'.repeat(69)} 3D`);
    await modelSubmit().click();
    expect(Array.from((await requests())[0].name)).toHaveLength(72);
    expect(await page.evaluate(() => window.__QUALITY3D_UI_FIXTURE__.props.snapshot.project.assets.find(item => item.id === 'model')?.name)).toBe(original.name);
  });

  it('blocks setup and image requests below the reported memory minimum', async () => {
    await mount({status: status({installed: false, state: 'missing', memoryMb: 8192})});
    await uiExpect(consent()).toBeDisabled();
    await uiExpect(page.getByRole('button', {name: '로컬 모델 준비', exact: true})).toBeDisabled();
    await uiExpect(page.getByText(/최소 16 GB 메모리가 필요합니다/).first()).toBeVisible();
    await uiExpect(submitButton()).toBeDisabled();
    expect(await commands()).toEqual([{action: 'quality3d_status'}]);
    await page.getByRole('button', {name: /모델다듬기 기존 GLB/}).click();
    await page.getByRole('button', {name: 'Fixture model 선택', exact: true}).click();
    await uiExpect(modelSubmit()).toBeEnabled();
  });

  it('shows actual setup phases and sanitizes status text without percentages or stderr', async () => {
    await mount({status: status({state: 'preparing', installed: false, busy: true, stage: '다운로드 검증'})});
    await uiExpect(page.locator('.quality3d-runtime-phase')).toHaveText('현재 단계: 다운로드 검증');
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.status.stage = 'https://example.invalid/?api_key=UI-secret-must-not-render'; window.__QUALITY3D_UI_FIXTURE__.status.message = 'bearer UI-secret-must-not-render';});
    await page.clock.runFor(1100);
    await uiExpect(page.locator('.quality3d-runtime-phase')).toHaveText('현재 단계: 준비 중');
    await uiExpect(page.locator('body')).not.toContainText('UI-secret-must-not-render');
    await uiExpect(page.locator('body')).not.toContainText('%');
  });

  it('stops polling when unmounted', async () => {
    await mount({status: status({state: 'preparing', installed: false, busy: true})});
    await page.evaluate(() => {window.__QUALITY3D_UI_UNMOUNT__();});
    await page.clock.runFor(6000);
    expect(await commands()).toEqual([{action: 'quality3d_status'}]);
  });
});
