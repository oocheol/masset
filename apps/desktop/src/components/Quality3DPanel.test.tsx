import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {JsxEmit, ModuleKind, ScriptTarget, transpileModule} from 'typescript';
import {chromium, expect as uiExpect} from '@playwright/test';
import type {Browser, BrowserContext, Page} from '@playwright/test';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {DEFAULT_SPEC, DEFAULT_STYLE} from '@local-assets/contracts';
import type {Asset, Image3DEngineCapability, Local3DStatus, ProjectSnapshot, Quality3DRequest} from '@local-assets/contracts';
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
  configureStatus: Local3DStatus;
  commands: Array<{action: string; confirmed?: boolean}>;
  requests: Quality3DRequest[];
  closed: boolean;
  failStatus: boolean;
  failSubmit: boolean;
  failConfigure: boolean;
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
function trellisStatus(capability: Partial<Image3DEngineCapability> = {}, runtime: Partial<Local3DStatus> = {}): Local3DStatus {
  const local = status({memoryMb: 32768, ...runtime});
  return {...local, engines: [
    {id: 'triposr', name: 'UI fixture TripoSR', execution: 'local', available: local.supported && local.installed,
      requiresImageUpload: false, requestedModel: 'UI-fixture-TripoSR', state: local.installed ? 'ready' : 'requires_setup',
      reason: 'UI fixture CPU path', localMinimumVramMb: null},
    {id: 'trellis2_local', name: 'UI fixture TRELLIS.2', execution: 'local', available: true, requiresImageUpload: false,
      requestedModel: 'UI-fixture-TRELLIS.2', state: 'experimental', reason: 'UI 모형: 로컬 실행 환경만 연결됨. 실제 생성 미검증.',
      localMinimumVramMb: 24576, vramMb: 24576, gpuName: 'UI fixture NVIDIA', runtimeRoot: '/home/fixture/trellis2-runtime', distribution: 'Ubuntu', ...capability},
  ]};
}
function windowsDownload(): NonNullable<Local3DStatus['download']> {
  return {totalBytes: 2034000316, runtime: 'CPython 3.12.10 · PyTorch 2.2.2 CPU · TripoSR',
    sources: ['Python.org', 'PyTorch CPU', 'PyPI', 'GitHub', 'Hugging Face'], licenses: ['PSF-2.0', 'MIT', 'BSD', 'Apache-2.0', 'MPL-2.0', 'HPND'],
    manifestUrl: 'https://github.com/oocheol/masset/blob/master/workers/image3d/runtime-lock-windows.json', modelSha256: '4'.repeat(64)};
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
          if (request.action === 'quality3d_open_download_info' || request.action === 'quality3d_open_runtime_guide') return structuredClone(fixture.status);
          if (request.action === 'quality3d_cancel_setup') {
            fixture.status = structuredClone(fixture.cancelStatus);
            return structuredClone(fixture.status);
          }
          if (request.action === 'quality3d_trellis_configure') {
            if (fixture.failConfigure) throw new Error('authorization UI-secret-must-not-render');
            fixture.status = structuredClone(fixture.configureStatus);
            return structuredClone(fixture.status);
          }
          throw new Error('Unexpected UI fixture command');
        };
      `,
  };
  browser = await chromium.launch({channel: 'chrome', headless: true});
});
beforeEach(async () => {
  context = await browser.newContext({viewport: {width: 1100, height: 1000}});
  page = await context.newPage();
  await page.clock.install({time: new Date('2026-10-04T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-10-04T00:00:00Z'));
});
afterEach(async () => { await context?.close(); });
// Windows Chrome's bounded graceful process cleanup can outlast Vitest's
// default 10s hook budget during concurrent native builds. Still fail if the
// actual browser does not close within this finite cleanup window.
afterAll(async () => { await browser?.close(); }, 45_000);

async function mount(overrides: Partial<Fixture> = {}, props: Partial<FixtureProps> = {}) {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const fixture: Fixture = {props: {snapshot: snapshot(), selectedIds: ['png'], native: true, blenderReady: true, busy: false, ...props},
    bridgeNative: true, status: status(), prepareStatus: status({state: 'preparing', installed: false, busy: true, message: 'UI 모형: 준비 중'}),
    cancelStatus: status({state: 'cancelled', installed: false, message: 'UI 모형: 준비 취소됨'}), configureStatus: trellisStatus(), commands: [], requests: [], closed: false,
    failStatus: false, failSubmit: false, failConfigure: false, holdSubmit: false, deferStatus: false, ...overrides};
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
const trellisEngine = () => page.getByRole('button', {name: /TRELLIS.2 · 로컬 GPU/});
const triposrEngine = () => page.getByRole('button', {name: /TripoSR · 로컬 CPU/});
async function expectReadablePanel() {
  const overflow = await page.locator('.quality3d-panel').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return {wide: element.scrollWidth > element.clientWidth, elements: [...element.querySelectorAll('*')]
      .filter(child => child.getClientRects().length && child.getBoundingClientRect().right > bounds.right + 1)
      .map(child => ({className: child.className, text: child.textContent?.slice(0, 90)}))};
  });
  expect(overflow.wide, JSON.stringify(overflow.elements)).toBe(false);
  const smallText = await page.locator('.quality3d-panel').evaluate(element => [...element.querySelectorAll('button, p, label, small, legend, summary, .quality3d-local-tag, .quality3d-section-heading > span')]
    .filter(child => child.getClientRects().length && parseFloat(getComputedStyle(child).fontSize) < 14).map(child => child.textContent));
  expect(smallText).toEqual([]);
}

describe('Quality3DPanel UI (mocked native boundary)', () => {
  it('keeps TripoSR as the default and omits engine and seed from legacy requests even with engine capabilities', async () => {
    await mount({status: trellisStatus()});
    await uiExpect(triposrEngine()).toHaveAttribute('aria-pressed', 'true');
    await uiExpect(trellisEngine()).toHaveAttribute('aria-pressed', 'false');
    await uiExpect(page.getByLabel('생성 시드', {exact: true})).toHaveCount(0);
    await submitButton().click();
    expect(await requests()).toEqual([{assetIds: ['png'], name: 'Fixture png 3D', quality: 'high', heightMeters: 1,
      maxTriangles: 10000, textureResolution: 1024, preserveMaterials: true}]);
  });

  it('submits an explicitly selected prepared local TRELLIS runtime without TripoSR setup or image upload', async () => {
    await mount({status: trellisStatus({}, {installed: false, state: 'missing'})});
    await trellisEngine().click();
    await uiExpect(page.locator('.quality3d-state')).toHaveText('실험적');
    await uiExpect(page.getByText('로컬 실행 환경 연결 · 실행 전 모델 해시 검사 · 실제 생성 미검증', {exact: true})).toBeVisible();
    await uiExpect(page.getByLabel('생성 시드', {exact: true})).toHaveValue('0');
    await uiExpect(consent()).toHaveCount(0);
    await uiExpect(page.getByRole('checkbox', {name: /업로드|외부 전송/})).toHaveCount(0);
    await uiExpect(page.getByRole('button', {name: '로컬 모델 준비', exact: true})).toHaveCount(0);
    await uiExpect(submitButton()).toBeEnabled();
    await submitButton().click();
    expect(await requests()).toEqual([{assetIds: ['png'], name: 'Fixture png 3D', quality: 'high', heightMeters: 1,
      maxTriangles: 10000, textureResolution: 1024, preserveMaterials: true, engine: 'trellis2_local', seed: 0}]);
    expect(await commands()).toEqual([{action: 'quality3d_status'}]);
  });

  it.each(['unsupported', 'requires_setup', 'experimental'] as const)('blocks an unavailable TRELLIS runtime in %s state and keeps the CPU path usable', async state => {
    const reason = 'UI 모형: GPU VRAM 4 GB. 로컬 TRELLIS.2에는 최소 24 GB가 필요합니다.';
    await mount({status: trellisStatus({available: false, state, reason, vramMb: 4096, runtimeRoot: null})});
    await trellisEngine().click();
    await uiExpect(page.locator('.quality3d-runtime-message')).toHaveText(reason);
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(page.getByRole('button', {name: '로컬 런타임 연결', exact: true})).toHaveCount(0);
    await uiExpect(page.getByLabel('Linux 실행 환경 폴더', {exact: true})).toHaveCount(0);
    await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    expect(await requests()).toEqual([]);
    expect(await commands()).toEqual([{action: 'quality3d_status'}]);
    await triposrEngine().click();
    await uiExpect(submitButton()).toBeEnabled();
  });

  it('requires measured 24 GiB VRAM and the app 32 GiB system-memory floor even if a capability flag is inconsistent', async () => {
    await mount({status: trellisStatus({available: true, vramMb: 4096}, {memoryMb: 8192, minimumMemoryMb: 8192})});
    await trellisEngine().click();
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(page.getByText(/앱 작업 예산 때문에 시스템 메모리 32 GB 이상이 필요합니다/).first()).toBeVisible();
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.status.memoryMb = 32768;});
    await page.getByRole('button', {name: '준비 상태 다시 확인', exact: true}).click();
    await uiExpect(submitButton()).toBeDisabled();
    await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    expect(await requests()).toEqual([]);
  });

  it('allows TRELLIS only one image while preserving an over-limit selection until the user removes it', async () => {
    await mount({status: trellisStatus()}, {selectedIds: ['png', 'jpeg']});
    await trellisEngine().click();
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(page.getByText(/TRELLIS.2는 한 번에 이미지 1개를 처리합니다/)).toBeVisible();
    await uiExpect(page.getByRole('group', {name: '선택한 입력'}).getByRole('button')).toHaveCount(2);
    await page.getByRole('button', {name: 'Fixture jpeg 선택 해제', exact: true}).click();
    await uiExpect(submitButton()).toBeEnabled();
    await uiExpect(page.getByRole('button', {name: 'Fixture webp 선택', exact: true})).toBeDisabled();
    await triposrEngine().click();
    await uiExpect(page.getByRole('button', {name: 'Fixture webp 선택', exact: true})).toBeEnabled();
  });

  it('requires a bounded integer seed only for the selected TRELLIS engine', async () => {
    await mount({status: trellisStatus()});
    await trellisEngine().click();
    const seed = page.getByLabel('생성 시드', {exact: true});
    for (const value of ['', '-1', '0.5', '2147483648']) {
      await seed.fill(value);
      await uiExpect(submitButton()).toBeDisabled();
      await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    }
    expect(await requests()).toEqual([]);
    await seed.fill('2147483647');
    await submitButton().click();
    expect((await requests())[0]).toMatchObject({engine: 'trellis2_local', seed: 2147483647});
    await seed.fill('-1');
    await triposrEngine().click();
    await uiExpect(submitButton()).toBeEnabled();
  });

  it.each([{memoryMb: 8192, blenderReady: true}, {memoryMb: 16384, blenderReady: true}, {memoryMb: 32768, blenderReady: false}])('requires physical memory and Blender for TRELLIS finishing: %j', async environment => {
    await mount({status: trellisStatus({}, {memoryMb: environment.memoryMb})}, {blenderReady: environment.blenderReady});
    await trellisEngine().click();
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(consent()).toHaveCount(0);
    await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    expect(await requests()).toEqual([]);
    expect(await commands()).toEqual([{action: 'quality3d_status'}]);
  });

  it.each([{memoryMb: 16384, allowed: false}, {memoryMb: 32767, allowed: false}, {memoryMb: 32768, allowed: true}])('matches the app TRELLIS job admission threshold while preserving TripoSR at 16 GiB: %j', async environment => {
    await mount({status: trellisStatus({}, {memoryMb: environment.memoryMb})});
    await uiExpect(submitButton()).toBeEnabled();
    await trellisEngine().click();
    if (environment.allowed) await uiExpect(submitButton()).toBeEnabled();
    else {
      await uiExpect(submitButton()).toBeDisabled();
      await uiExpect(page.getByText(/앱 작업 예산 때문에 시스템 메모리 32 GB 이상이 필요합니다/).first()).toBeVisible();
      await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
      expect(await requests()).toEqual([]);
    }
  });

  it('connects a preprepared WSL runtime only on eligible hardware using reviewed directory fields', async () => {
    await mount({status: trellisStatus({state: 'requires_setup', available: false, runtimeRoot: null})});
    await trellisEngine().click();
    const connect = page.getByRole('button', {name: '로컬 런타임 연결', exact: true});
    await uiExpect(connect).toBeDisabled();
    await page.getByLabel('Linux 실행 환경 폴더', {exact: true}).fill('https://example.invalid/runtime');
    await uiExpect(connect).toBeDisabled();
    await page.getByLabel('Linux 실행 환경 폴더', {exact: true}).fill('  /home/fixture/trellis2-runtime  ');
    await page.getByLabel('WSL 배포판', {exact: true}).fill('  Ubuntu  ');
    await uiExpect(connect).toBeEnabled();
    await connect.click();
    await uiExpect.poll(commands).toEqual([{action: 'quality3d_status'}, {action: 'quality3d_trellis_configure', runtimeRoot: '/home/fixture/trellis2-runtime', distribution: 'Ubuntu'}]);
    await uiExpect(page.locator('.quality3d-state')).toHaveText('실험적');
    await uiExpect(submitButton()).toBeEnabled();
    expect(await requests()).toEqual([]);
  });

  it('sanitizes failed runtime connections and prevents submission until the next status read', async () => {
    await mount({failConfigure: true, status: trellisStatus({state: 'requires_setup', available: false})});
    await trellisEngine().click();
    await page.getByRole('button', {name: '로컬 런타임 연결', exact: true}).click();
    await uiExpect(page.getByRole('alert')).toContainText('실행 환경 연결을 확인하지 못했습니다');
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(page.locator('body')).not.toContainText('UI-secret-must-not-render');
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.status = window.__QUALITY3D_UI_FIXTURE__.configureStatus;});
    await page.getByRole('button', {name: '준비 상태 다시 확인', exact: true}).click();
    await uiExpect(submitButton()).toBeEnabled();
  });

  it('keeps existing GLB finishing independent of a previously selected TRELLIS engine', async () => {
    await mount({status: trellisStatus()});
    await trellisEngine().click();
    await page.getByRole('button', {name: /모델다듬기 기존 GLB/}).click();
    await page.getByRole('button', {name: 'Fixture model 선택', exact: true}).click();
    await uiExpect(page.getByRole('group', {name: '이미지→3D 엔진 선택'})).toHaveCount(0);
    await modelSubmit().click();
    expect((await requests())[0]).toMatchObject({assetIds: ['model']});
    expect((await requests())[0]).not.toHaveProperty('engine');
    expect((await requests())[0]).not.toHaveProperty('seed');
  });

  it('labels preserved high geometry instead of showing the reduced game triangle count', async () => {
    const project = snapshot();
    const original = project.project.assets.find(item => item.id === 'model')!;
    const version = original.versions[0];
    version.settings.quality3dFiles = {high: 'model-input', game: 'model-game'};
    version.artifacts.unshift({id: 'model-game', path: 'fixtures/reduced.glb', format: 'glb', sha256: 'ui-fixture', bytes: 80, role: 'output'});
    await mount({}, {selectedIds: ['model'], snapshot: project});
    const input = page.getByRole('button', {name: 'Fixture model 선택', exact: true});
    await uiExpect(input).toContainText('고해상도 형상');
    await uiExpect(input).not.toContainText('100 triangles');
    await modelSubmit().click();
    expect((await requests())[0].assetIds).toEqual(['model']);
    expect(await page.evaluate(() => window.__QUALITY3D_UI_FIXTURE__.props.snapshot.project.assets.find(item => item.id === 'model')?.versions[0].artifacts.length)).toBe(3);
  });

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

  it.each([{platform: 'Windows x64', pythonVersion: '3.12.10'}, {platform: 'Apple Silicon Mac', pythonVersion: '3.9.6'}])('submits five distinct image IDs on a ready $platform runtime and exactly the shared request fields', async ({platform, pythonVersion}) => {
    const ids = ['png', 'jpeg', 'webp', 'png-2', 'jpeg-2'];
    const project = snapshot();
    project.project.spec.polygonBudget = 100000;
    await mount({status: status({pythonVersion, message: `UI 모형: ${platform} 로컬 모델 준비 완료`})}, {selectedIds: ids, snapshot: project});
    await uiExpect(page.locator('.quality3d-runtime-message')).toContainText(platform);
    await uiExpect(page.locator('body')).not.toContainText('이 Mac의 시스템 Python');
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

  it('blocks preparation on unsupported platforms and explains supported desktop platforms', async () => {
    await mount({status: status({supported: false, state: 'unsupported', installed: false, message: 'UI 모형: 지원하지 않는 플랫폼'})});
    await uiExpect(consent()).toBeDisabled();
    await uiExpect(page.getByRole('button', {name: '로컬 모델 준비', exact: true})).toBeDisabled();
    await uiExpect(submitButton()).toBeDisabled();
    await uiExpect(page.getByText('이 기기에서는 이미지→3D를 지원하지 않습니다. Windows x64 또는 Apple Silicon Mac 앱에서 사용하세요.', {exact: true})).toBeVisible();
    await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    expect(await commands()).toEqual([{action: 'quality3d_status'}]);
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

  it('requires explicit Windows download consent and polls only preparing, stopping at ready', async () => {
    await mount({status: status({state: 'missing', installed: false, pythonVersion: '3.12.10', message: 'UI 모형: Windows x64 로컬 모델 준비 필요'})});
    await uiExpect(page.locator('.quality3d-runtime-message')).toContainText('Windows x64 로컬 모델 준비 필요');
    await uiExpect(page.locator('body')).not.toContainText('현재 Apple Silicon Mac에서 지원');
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

  it('shows Windows total download and reviewable source/version/license details before consent while preserving the Mac fallback', async () => {
    const download = windowsDownload();
    await mount({status: status({state: 'missing', installed: false, pythonVersion: null, download})});
    await uiExpect(consent()).toHaveAccessibleName(/Python·TripoSR 모델·의존성\(총 약 1\.89 GiB\)/);
    await uiExpect(consent()).not.toBeChecked();
    await uiExpect(page.getByRole('button', {name: '로컬 모델 준비', exact: true})).toBeDisabled();
    const details = page.locator('.quality3d-download-info');
    await uiExpect(details).not.toHaveAttribute('open');
    await details.locator('summary').click();
    for (const value of [download.runtime, '2,034,000,316 바이트', 'Python.org', 'PyTorch CPU', 'PyPI', 'GitHub', 'Hugging Face', 'PSF-2.0', 'MPL-2.0']) await uiExpect(details).toContainText(value);
    await details.getByRole('button', {name: '파일별 버전·출처·SHA-256 보기', exact: true}).click();
    await uiExpect.poll(commands).toEqual([{action: 'quality3d_status'}, {action: 'quality3d_open_download_info'}]);
    await uiExpect(details).toContainText('Microsoft Visual C++ x64 실행 라이브러리 필요');
    await details.getByRole('button', {name: 'Windows 실행 라이브러리 안내', exact: true}).click();
    await uiExpect.poll(commands).toEqual([{action: 'quality3d_status'}, {action: 'quality3d_open_download_info'}, {action: 'quality3d_open_runtime_guide'}]);
    await uiExpect(consent()).not.toBeChecked();
    expect(await requests()).toEqual([]);
    await page.evaluate(() => {window.__QUALITY3D_UI_FIXTURE__.status.download = null; window.__QUALITY3D_UI_FIXTURE__.status.pythonVersion = '3.9.6';});
    await page.getByRole('button', {name: '준비 상태 다시 확인', exact: true}).click();
    await uiExpect(page.locator('.quality3d-download-info')).toHaveCount(0);
    await uiExpect(consent()).toHaveAccessibleName('TripoSR 가중치(약 1.68 GB)와 의존성의 1회 다운로드에 동의합니다.');
    await uiExpect(page.getByRole('button', {name: '로컬 모델 준비', exact: true})).toBeDisabled();
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
    for (const text of ['Tripo Studio H3.1', '8K', '뒷면은 추정', '몇 분 이상', 'Windows x64', 'Apple Silicon Mac', '자동 리깅', '쿼드 리토폴로지', '.blend', '턴테이블']) {
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

  it('keeps preparation controls readable without horizontal overflow at 390px', async () => {
    await page.setViewportSize({width: 390, height: 844});
    await mount({status: status({state: 'missing', installed: false, message: 'UI 모형: Windows x64 로컬 모델 준비 필요', download: windowsDownload()})});
    await page.locator('.quality3d-download-info summary').click();
    await expectReadablePanel();
    await uiExpect(page.getByRole('button', {name: '로컬 모델 준비', exact: true})).toBeDisabled();
    await consent().check();
    await uiExpect(page.getByRole('button', {name: '로컬 모델 준비', exact: true})).toBeEnabled();
  });

  it('keeps local TRELLIS selection, seed and WSL connection controls readable at 390px', async () => {
    await page.setViewportSize({width: 390, height: 844});
    await mount({status: trellisStatus({state: 'requires_setup', available: false})});
    await trellisEngine().click();
    await expectReadablePanel();
    await uiExpect(page.getByLabel('생성 시드', {exact: true})).toBeVisible();
    await uiExpect(page.getByRole('button', {name: '로컬 런타임 연결', exact: true})).toBeEnabled();
  });
});
