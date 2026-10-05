import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {JsxEmit, ModuleKind, ScriptTarget, transpileModule} from 'typescript';
import {chromium, expect as uiExpect} from '@playwright/test';
import type {Browser, BrowserContext, Page} from '@playwright/test';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {DEFAULT_SPEC, DEFAULT_STYLE} from '@local-assets/contracts';
import type {Asset, GameProjectScan, Job, Local3DStatus, ProductionPlan, ProductionRun, ProductionState, ProjectSnapshot, ProviderConnection} from '@local-assets/contracts';
import type {ProductionHomeProps} from './ProductionHome';

// Real React and Chromium; only the desktop command boundary and local preview
// pixels are fixtures. These tests do not establish native generation support.
type FixtureProps = Omit<ProductionHomeProps, 'onProvider' | 'onSnapshot' | 'onInspect' | 'onAdvanced'>;
type Result = {snapshot: ProjectSnapshot; state: ProductionState};
type Fixture = {
  props: FixtureProps; bridgeNative: boolean; state: ProductionState; template: ProductionPlan;
  local: Local3DStatus; prepare: Local3DStatus; cancel: Local3DStatus;
  commands: Record<string, unknown>[]; folderTitles: string[]; folder: string | null;
  hold: string[]; releases: Record<string, (() => void)[]>; failures: Record<string, number>;
  providerOpened: number; advancedOpened: number; inspected: string[]; snapshots: ProjectSnapshot[];
  startResult: Result | null; retryResult: Result | null; cancelResult: Result | null;
  importSnapshot: ProjectSnapshot | null; importCalls: number;
  errorMessages: Record<string, string>;
};
declare global {
  interface Window {
    __PRODUCTION_UI_FIXTURE__: Fixture;
    __PRODUCTION_UI_RENDER__: () => void;
    __PRODUCTION_UI_UNMOUNT__: () => void;
  }
}

const stamp = '2026-10-05T00:00:00Z';
const BRIEF = '작은 섬을 탐험하는 따뜻한 판타지 게임';
const PLAN_ID = '00000000-0000-4000-8000-000000000099';
const RUN_ID = '00000000-0000-4000-8000-000000000199';
function asset(id: string, source: Asset['versions'][number]['source'] = 'import', kind: Asset['kind'] = 'image'): Asset {
  return {id, name: `참고 ${id}`, kind, folder: 'Imported', tags: [], activeVersionId: `${id}-v1`, width: kind === 'model' ? null : 128,
    height: kind === 'model' ? null : 128, mesh: kind === 'model' ? {vertices: 200, triangles: 100, dimensions: [1, 1, 1], unit: 'm'} : null,
    versions: [{id: `${id}-v1`, number: 1, createdAt: stamp, prompt: 'UI fixture only', source, requestedModel: null, confirmedModel: null,
      providerVersion: null, settings: {}, validation: null, artifacts: [
        {id: `${id}-file`, path: `fixtures/${id}.${kind === 'model' ? 'glb' : 'png'}`, format: kind === 'model' ? 'glb' : 'png', sha256: 'a'.repeat(64), bytes: 100, role: source === 'import' ? 'source' : 'output'},
        {id: `${id}-thumb`, path: `fixtures/${id}-thumb.png`, format: 'png', sha256: 'b'.repeat(64), bytes: 68, role: 'thumbnail'},
      ]}]};
}
function snapshot(): ProjectSnapshot {
  const stale = asset('stale'); stale.activeVersionId = 'missing-version';
  const thumbnailOnly = asset('thumb-only'); thumbnailOnly.versions[0].artifacts = thumbnailOnly.versions[0].artifacts.filter(file => file.role === 'thumbnail');
  const noPreview = asset('no-preview', 'import', 'model'); noPreview.versions[0].artifacts = noPreview.versions[0].artifacts.filter(file => file.role !== 'thumbnail');
  return {root: '/ui-fixture-only', providers: [], project: {id: 'production-ui', name: 'UI fixture project', schemaVersion: 1,
    createdAt: stamp, updatedAt: stamp, spec: {...DEFAULT_SPEC}, styleGuide: {...DEFAULT_STYLE}, jobs: [],
    assets: [asset('one'), asset('two'), asset('three'), asset('four'), asset('five'), asset('six'), asset('model', 'import', 'model'),
      asset('fixture-library', 'fixture'), asset('old-generation', 'codex_subscription'), stale, thumbnailOnly, noPreview]}};
}
function scan(): GameProjectScan {
  return {root: '/games/small-island', engine: 'godot', projectName: '작은 섬', scannedFiles: 12, assetCount: 3,
    assets: [{path: 'art/island.png', kind: 'image'}], missingReferences: [{path: 'art/tree.png', referencedBy: 'scenes/island.tscn'}], warnings: [], fingerprint: 'scan-fixture'};
}
function plan(overrides: Partial<ProductionPlan> = {}): ProductionPlan {
  return {schemaVersion: 1, id: PLAN_ID, projectId: 'production-ui', plannerModel: 'gpt-5.5', gameRoot: scan().root, fingerprint: scan().fingerprint,
    mode: 'new', brief: BRIEF, output: 'mixed', spec: {...DEFAULT_SPEC}, styleGuide: {...DEFAULT_STYLE, approved: true}, referenceAssetIds: [], references: [],
    summary: '탐험에 필요한 숲과 수집 아이템을 함께 준비합니다.', warnings: ['생성된 형상과 텍스처를 검수하세요.'],
    items: [{id: 'tree-item', name: '섬의 나무', kind: 'image', purpose: '섬의 숲 배경에 사용', prompt: 'One tree', referenceAssetIds: [], targetAssetId: null, modelParameters: null, enabled: true}], ...overrides};
}
function local(overrides: Partial<Local3DStatus> = {}): Local3DStatus {
  return {supported: true, installed: true, busy: false, state: 'ready', message: 'UI 모형: 로컬 모델 준비 완료', stage: 'ready', modelId: 'UI-fixture-TripoSR',
    modelRevision: 'ui-fixture', device: 'cpu', pythonVersion: '3.11', weightBytes: 1_680_000_000, memoryMb: 16384, minimumMemoryMb: 8192, blenderReady: true, ...overrides};
}
function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {available: true, authenticated: true, ready: true, runtimeVersion: 'ui-fixture', reasoningModel: 'gpt-5.5', catalogSource: 'application_pinned_catalog',
    inferenceAccess: 'unknown', requestedModel: 'gpt-image-2', confirmedModel: null, reason: 'UI fixture only', usage: null, checkedAt: stamp, ...overrides};
}
function run(status: ProductionRun['status'] = 'completed'): ProductionRun {
  return {id: RUN_ID, planId: PLAN_ID, brief: BRIEF, createdAt: stamp, outputRoot: `${scan().root}/AssetStudioGenerated/${RUN_ID}`, status,
    items: [{id: 'tree-item', name: '섬의 나무', kind: 'image', jobIds: ['tree-job'], assetId: status === 'completed' ? 'tree-result' : null, status,
      review: 'pending', outputPath: status === 'completed' ? 'generated/tree.png' : null, error: null}]};
}
function job(status: Job['status'] = 'succeeded'): Job {
  return {id: 'tree-job', projectId: 'production-ui', assetId: 'tree-result', kind: 'image_generate', label: '섬의 나무', status, dependencies: [], resource: 'external',
    attempts: 1, createdAt: stamp, startedAt: stamp, finishedAt: stamp, error: null, progress: {stage: 'received', completed: 1, total: 1}, payload: {}, cacheKey: null};
}

let browser: Browser;
let context: BrowserContext;
let page: Page;
let modules: Record<string, string>;
let pageErrors: string[];
async function reactModule(packageName: string, file: string, exports: string[], dependencies: string[] = []) {
  const require = createRequire(import.meta.url);
  const source = await readFile(join(dirname(require.resolve(packageName)), 'cjs', file), 'utf8');
  return `${dependencies.map((dependency, index) => `import dependency${index} from ${JSON.stringify(`/modules/${dependency}.js`)};`).join('\n')}
    const process = {env: {NODE_ENV: 'development'}}; const module = {exports: {}}; const exports = module.exports;
    const dependencies = {${dependencies.map((dependency, index) => `${JSON.stringify(dependency)}: dependency${index}`).join(',')}};
    const require = name => dependencies[name]; ${source}
    export default module.exports; ${exports.map(name => `export const ${name} = module.exports.${name};`).join('\n')}`;
}

beforeAll(async () => {
  const [source, react, jsx, reactDOM, client, scheduler, ...styles] = await Promise.all([
    readFile(new URL('./ProductionHome.tsx', import.meta.url), 'utf8'),
    reactModule('react', 'react.development.js', ['createElement', 'useEffect', 'useId', 'useRef', 'useState']),
    reactModule('react', 'react-jsx-runtime.development.js', ['jsx', 'jsxs', 'Fragment'], ['react']),
    reactModule('react-dom', 'react-dom.development.js', [], ['react']),
    reactModule('react-dom/client', 'react-dom-client.development.js', ['createRoot'], ['scheduler', 'react', 'react-dom']),
    reactModule('scheduler', 'scheduler.development.js', []),
    ...['../styles.css', '../readability.css', './ProductionHome.css'].map(path => readFile(new URL(path, import.meta.url), 'utf8')),
  ]);
  modules = {
    '/modules/react.js': react, '/modules/react-jsx-runtime.js': jsx, '/modules/react-dom.js': reactDOM,
    '/modules/react-dom-client.js': client, '/modules/scheduler.js': scheduler,
    '/components/ProductionHome.js': transpileModule(source.replace("import './ProductionHome.css';", ''), {
      compilerOptions: {target: ScriptTarget.ES2022, module: ModuleKind.ESNext, jsx: JsxEmit.ReactJSX},
    }).outputText,
    '/modules/lucide.js': `import {createElement} from 'react';
      const Icon = props => createElement('svg', {...props, width: props.size, height: props.size, 'aria-hidden': true}, createElement('path', {d: 'M4 4h12v12H4z'}));
      export const AlertTriangle=Icon, ArrowRight=Icon, Box=Icon, Check=Icon, CheckCircle2=Icon, Download=Icon, FileImage=Icon, FolderOpen=Icon, Layers=Icon, Link2=Icon, LoaderCircle=Icon, RefreshCw=Icon, Sparkles=Icon, Square=Icon;`,
    '/styles.css': styles.join('\n').replace(/^@import.*$/gm, ''),
    '/': `<html lang="ko"><head><link rel="stylesheet" href="/styles.css"><script type="importmap">${JSON.stringify({imports: {
      react: '/modules/react.js', 'react/jsx-runtime': '/modules/react-jsx-runtime.js', 'react-dom/client': '/modules/react-dom-client.js', 'lucide-react': '/modules/lucide.js',
    }})}</script></head><body><div id="root" style="height:100dvh;min-width:0"></div><script type="module" src="/fixture.js"></script></body></html>`,
    '/fixture.js': `import {createElement} from 'react'; import {createRoot} from 'react-dom/client'; import ProductionHome from '/components/ProductionHome.js';
      const fixture = window.__PRODUCTION_UI_FIXTURE__; const root = createRoot(document.getElementById('root'));
      window.__PRODUCTION_UI_RENDER__ = () => root.render(createElement(ProductionHome, {...fixture.props,
        onProvider: () => {fixture.providerOpened++;}, onAdvanced: () => {fixture.advancedOpened++;},
        onInspect: asset => {fixture.inspected.push(asset.id);}, onSnapshot: snapshot => {fixture.snapshots.push(snapshot); fixture.props.snapshot = snapshot; window.__PRODUCTION_UI_RENDER__();}}));
      window.__PRODUCTION_UI_UNMOUNT__ = () => root.unmount(); window.__PRODUCTION_UI_RENDER__();`,
    '/lib/bridge': `const fixture = window.__PRODUCTION_UI_FIXTURE__;
      export const isNative = fixture.bridgeNative;
      export const artifactUrl = (_, artifact) => artifact ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=#' + encodeURIComponent(artifact.path) : '';
      async function gate(action) {
        if (fixture.hold.includes(action)) await new Promise(resolve => { (fixture.releases[action] ??= []).push(resolve); });
        if (fixture.failures[action] > 0) {fixture.failures[action]--; throw new Error(fixture.errorMessages[action] ?? 'authorization: Bearer sk-UI-secret-must-not-render access_token=private');}
      }
      export const chooseFolder = async title => {fixture.folderTitles.push(title); await gate('choose_folder'); return fixture.folder;};
      export const chooseImports = async () => {fixture.importCalls++; await gate('choose_imports'); return structuredClone(fixture.importSnapshot);};
      export const command = async request => {
        fixture.commands.push(request); const action = request.action; const requestedProject = fixture.props.snapshot.project.id; let response;
        if (action === 'production_state') response = structuredClone(fixture.state);
        else if (action === 'quality3d_status') response = structuredClone(fixture.local);
        else if (action === 'quality3d_prepare') response = structuredClone(fixture.prepare);
        else if (action === 'quality3d_cancel_setup') response = structuredClone(fixture.cancel);
        else if (action === 'game_connect') response = {...structuredClone(fixture.state), connection: {...${JSON.stringify(scan())}, root: request.root}, plan: null};
        else if (action === 'production_plan') {
          const references = request.referenceAssetIds.map(id => fixture.props.snapshot.project.assets.find(asset => asset.id === id)).map(asset => ({assetId:asset.id,versionId:asset.activeVersionId,name:asset.name,kind:asset.kind,width:asset.width,height:asset.height,mesh:asset.mesh}));
          response = {...structuredClone(fixture.state), plan: {...structuredClone(fixture.template), projectId: fixture.props.snapshot.project.id,
            brief: request.brief, output: request.output, referenceAssetIds: request.referenceAssetIds, references,
            gameRoot: fixture.state.connection.root, fingerprint: fixture.state.connection.fingerprint}};
        } else if (action === 'production_start') response = structuredClone(fixture.startResult) ?? {snapshot: structuredClone(fixture.props.snapshot),
          state: {...structuredClone(fixture.state), runs: [{...${JSON.stringify(run('pending'))}, id:request.requestId, planId:request.planId}]}};
        else if (action === 'production_review') {response = structuredClone(fixture.state); response.runs.find(run => run.id === request.runId).items.find(item => item.id === request.itemId).review = 'approved';}
        else if (action === 'production_retry') {
          response = structuredClone(fixture.retryResult) ?? {snapshot: structuredClone(fixture.props.snapshot), state: structuredClone(fixture.state)};
          const run = response.state.runs.find(run => run.id === request.runId); run.status = 'running';
          Object.assign(run.items.find(item => item.id === request.itemId), {status:'running',review:'pending',error:null});
        } else if (action === 'production_cancel') {
          response = structuredClone(fixture.cancelResult) ?? {snapshot: structuredClone(fixture.props.snapshot), state: structuredClone(fixture.state)};
          const run = response.state.runs.find(run => run.id === request.runId); run.status = 'cancelled';
          run.items.forEach(item => {if (item.status === 'pending' || item.status === 'running') item.status = 'cancelled';});
        } else throw new Error('Unexpected UI fixture action');
        await gate(action);
        if (fixture.props.snapshot.project.id !== requestedProject) return response;
        if (action.startsWith('quality3d_') && action !== 'quality3d_status') fixture.local = structuredClone(response);
        else if (action === 'production_review' || action === 'game_connect' || action === 'production_plan') fixture.state = structuredClone(response);
        else if (['production_start', 'production_retry', 'production_cancel'].includes(action)) fixture.state = structuredClone(response.state);
        return response;
      };`,
  };
  browser = await chromium.launch({channel: 'chrome', headless: true});
});
beforeEach(async () => {
  context = await browser.newContext({viewport: {width: 1200, height: 1000}}); page = await context.newPage(); pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.clock.install({time: new Date(stamp)}); await page.clock.pauseAt(new Date(stamp));
});
afterEach(async () => {try {expect(pageErrors).toEqual([]);} finally {await context?.close();}});
afterAll(async () => {await browser?.close();});

async function mount(overrides: Partial<Fixture> = {}, props: Partial<FixtureProps> = {}) {
  const fixture: Fixture = {props: {snapshot: snapshot(), native: true, connection: connection(), providerChecking: false, busy: false, ...props}, bridgeNative: true,
    state: {connection: scan(), plan: null, runs: []}, template: plan(), local: local(),
    prepare: local({state: 'preparing', installed: false, busy: true, message: 'UI 모형: 준비 중'}), cancel: local({state: 'cancelled', installed: false, busy: false, message: 'UI 모형: 준비 취소됨'}),
    commands: [], folderTitles: [], folder: scan().root, hold: [], releases: {}, failures: {}, providerOpened: 0, advancedOpened: 0, inspected: [], snapshots: [],
    startResult: null, retryResult: null, cancelResult: null, importSnapshot: null, importCalls: 0, errorMessages: {}, ...overrides};
  await page.route('https://production-ui.test/**', async route => {
    const path = new URL(route.request().url()).pathname; const body = modules[path];
    if (body === undefined) return route.abort();
    await route.fulfill({body, contentType: path === '/' ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript'});
  });
  await page.addInitScript(value => {window.__PRODUCTION_UI_FIXTURE__ = value;}, fixture);
  await page.goto('https://production-ui.test/');
  await uiExpect(page.getByRole('heading', {name: '게임에 필요한 에셋을 한 번에', exact: true})).toBeVisible();
  if (fixture.props.native && fixture.bridgeNative && !fixture.hold.includes('production_state')) await uiExpect.poll(async () => (await commands('production_state')).length).toBe(1);
  if (fixture.props.native && fixture.bridgeNative && !fixture.hold.includes('quality3d_status')) {
    if (fixture.failures.quality3d_status > 0) await uiExpect(page.locator('.production-local').getByRole('alert')).toBeVisible();
    else if (fixture.local.supported) await uiExpect(page.getByRole('radio', {name: '3D 모델', exact: true})).toBeEnabled();
    else await uiExpect(page.getByText('이 제작 화면의 이미지→3D는 현재 Mac 전용입니다. 이 환경에서는 이미지 제작을 이용하세요.', {exact: true})).toBeVisible();
  }
}
const analyzeButton = () => page.getByRole('button', {name: '필요한 에셋 분석', exact: true});
const startButton = () => page.getByRole('button', {name: '필요한 에셋 모두 제작', exact: true});
const consent = () => page.getByRole('checkbox', {name: '분석·제작을 위한 외부 전송에 동의합니다.', exact: true});
const commands = (action?: string) => page.evaluate(action => window.__PRODUCTION_UI_FIXTURE__.commands.filter(request => !action || request.action === action), action);
async function release(action: string) {
  await page.evaluate(action => {const fixture = window.__PRODUCTION_UI_FIXTURE__; fixture.hold = fixture.hold.filter(value => value !== action); fixture.releases[action]?.shift()?.();}, action);
}
async function describeGame(output: ProductionPlan['output'] = 'mixed') {
  await page.getByRole('textbox', {name: '게임 설명', exact: true}).fill(BRIEF);
  if (output !== 'mixed') await page.getByRole('radio', {name: output === 'images' ? '이미지' : '3D 모델', exact: true}).check();
  await consent().check();
}
async function analyze(output: ProductionPlan['output'] = 'mixed') {
  await describeGame(output); await analyzeButton().click();
  await uiExpect(page.getByRole('list', {name: '제작 계획'})).toBeVisible();
}

describe('ProductionHome UI (mocked desktop boundary)', () => {
  it('keeps mixed output on a supported Mac desktop boundary and forwards provider/import controls', async () => {
    await mount();
    await uiExpect(page.getByRole('radio', {name: '이미지 + 3D', exact: true})).toBeChecked();
    await uiExpect(page.getByRole('radio', {name: '이미지 + 3D', exact: true})).toBeEnabled();
    await uiExpect(page.getByRole('radio', {name: '3D 모델', exact: true})).toBeEnabled();
    expect((await commands()).map(request => request.action).sort()).toEqual(['production_state', 'quality3d_status']);
    await uiExpect(analyzeButton()).toBeDisabled(); await uiExpect(startButton()).toBeDisabled();
    await page.getByRole('button', {name: 'GPT 연결 확인', exact: true}).click();
    await page.getByText('참고 에셋 선택', {exact: false}).first().click();
    await page.getByRole('button', {name: '에셋 작업실', exact: true}).click();
    expect(await page.evaluate(() => [window.__PRODUCTION_UI_FIXTURE__.providerOpened, window.__PRODUCTION_UI_FIXTURE__.advancedOpened])).toEqual([1, 1]);
    await uiExpect(page.getByText(/fixture-library/)).toHaveCount(0);
    await uiExpect(page.locator('.production-gallery .production-result')).toHaveCount(0);
    expect(await commands('production_start')).toEqual([]);
  });

  it('never calls the bridge or enables native controls in browser mode', async () => {
    await mount({bridgeNative: false}, {native: false});
    await uiExpect(page.getByRole('button', {name: '게임 프로젝트 루트 연결', exact: true})).toBeDisabled();
    await uiExpect(page.getByRole('button', {name: 'GPT 연결하기', exact: true})).toBeDisabled();
    await uiExpect(consent()).toBeDisabled(); await uiExpect(startButton()).toBeDisabled();
    await page.clock.fastForward(5000); expect(await commands()).toEqual([]);
  });

  it('waits for the parent provider check and requires consent plus an actual game connection', async () => {
    await mount({state: {connection: null, plan: null, runs: []}}, {connection: null, providerChecking: true});
    await describeGame(); await uiExpect(analyzeButton()).toBeDisabled();
    await uiExpect(page.getByRole('button', {name: 'GPT 연결하기', exact: true})).toBeDisabled();
    await page.evaluate(() => {const fixture = window.__PRODUCTION_UI_FIXTURE__; fixture.props.connection = {...fixture.props.connection!, ...JSON.parse(JSON.stringify({available:true,authenticated:true,ready:true}))}; fixture.props.providerChecking = false; window.__PRODUCTION_UI_RENDER__();});
    await uiExpect(analyzeButton()).toBeDisabled();
    await page.getByRole('button', {name: '게임 프로젝트 루트 연결', exact: true}).click();
    await uiExpect(page.getByText('작은 섬', {exact: true})).toBeVisible();
    await uiExpect(consent()).not.toBeChecked(); await consent().check(); await uiExpect(analyzeButton()).toBeEnabled();
    expect(await commands('game_connect')).toEqual([{action: 'game_connect', root: scan().root}]);
    expect(await page.evaluate(() => window.__PRODUCTION_UI_FIXTURE__.folderTitles)).toEqual(['게임 프로젝트 루트 연결']);
    expect(await commands('production_start')).toEqual([]);
  });

  it('locks folder selection immediately and treats cancelling the chooser as no mutation', async () => {
    await mount({state: {connection: null, plan: null, runs: []}, hold: ['choose_folder'], folder: null});
    await page.getByRole('button', {name: '게임 프로젝트 루트 연결', exact: true}).evaluate(button => {(button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();});
    await uiExpect.poll(() => page.evaluate(() => window.__PRODUCTION_UI_FIXTURE__.folderTitles.length)).toBe(1);
    await release('choose_folder');
    await uiExpect(page.getByRole('button', {name: '게임 프로젝트 루트 연결', exact: true})).toBeEnabled();
    expect(await commands('game_connect')).toEqual([]);
  });

  it('selects at most five current real references and sends only the explicit planning fields', async () => {
    await mount(); await describeGame(); await page.locator('.production-references summary').click();
    for (const id of ['one', 'two', 'three', 'four', 'five']) await page.getByRole('button', {name: `참고 ${id} 참고 선택`, exact: true}).click();
    await uiExpect(page.getByRole('button', {name: '참고 six 참고 선택', exact: true})).toBeDisabled();
    await uiExpect(page.getByRole('button', {name: '참고 no-preview 참고 선택', exact: true})).toBeDisabled();
    await uiExpect(page.getByRole('button', {name: /stale|thumb-only|fixture-library/})).toHaveCount(0);
    await uiExpect(consent()).not.toBeChecked(); await uiExpect(analyzeButton()).toBeDisabled();
    await uiExpect(page.getByText('전송 범위: 게임 설명, 에셋의 상대 파일 이름과 누락된 참조 정보, 직접 선택한 참고 에셋의 메타데이터와 미리보기(있는 경우). 소스 파일 내용은 전송하지 않습니다.', {exact: true})).toBeVisible();
    await consent().check(); await analyzeButton().click();
    await uiExpect(page.getByRole('list', {name: '제작 계획'})).toContainText('섬의 나무');
    expect(await commands('production_plan')).toEqual([{action: 'production_plan', brief: BRIEF, output: 'mixed', referenceAssetIds: ['one', 'two', 'three', 'four', 'five'], uploadApproved: true}]);
    await uiExpect(page.getByRole('list', {name: '제작 계획'})).toContainText('섬의 숲 배경에 사용');
    await uiExpect(page.getByRole('list', {name: '제작 계획'}).locator('input')).toHaveCount(0);
    await uiExpect(page.getByText(/한 계획에서 최대 120개/)).toBeVisible();
    expect(await commands('production_start')).toEqual([]);
  });

  it('imports references directly in the home, updates the parent snapshot and keeps selection explicit', async () => {
    const imported = snapshot(); imported.project.assets.push(asset('new-import'));
    await mount({importSnapshot: imported, hold: ['choose_imports']});
    await page.getByRole('button', {name: '참고 이미지·모델 추가', exact: true}).evaluate(button => {(button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();});
    await uiExpect.poll(() => page.evaluate(() => window.__PRODUCTION_UI_FIXTURE__.importCalls)).toBe(1);
    await release('choose_imports');
    await uiExpect(page.getByRole('button', {name: '참고 new-import 참고 선택', exact: true})).toBeVisible();
    await uiExpect(page.getByRole('button', {name: '참고 new-import 참고 선택', exact: true})).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => [window.__PRODUCTION_UI_FIXTURE__.snapshots.length, window.__PRODUCTION_UI_FIXTURE__.advancedOpened])).toEqual([1, 0]);
    expect(await commands('production_start')).toEqual([]);
  });

  it('handles cancelled imports and import failures without leaving the home', async () => {
    await mount({importSnapshot: null}); await page.getByRole('button', {name: '참고 이미지·모델 추가', exact: true}).click();
    await uiExpect(page.getByRole('button', {name: '참고 이미지·모델 추가', exact: true})).toBeEnabled();
    expect(await page.evaluate(() => window.__PRODUCTION_UI_FIXTURE__.snapshots.length)).toBe(0);
    await page.evaluate(() => {window.__PRODUCTION_UI_FIXTURE__.failures.choose_imports = 1;});
    await page.getByRole('button', {name: '참고 이미지·모델 추가', exact: true}).click();
    await uiExpect(page.getByRole('alert')).toContainText('참고 파일을 가져오지 못했습니다');
    await uiExpect(page.locator('body')).not.toContainText('sk-UI-secret');
  });

  it('allows actual generated references and models with metadata but no thumbnail', async () => {
    const project = snapshot(); project.project.assets.push(asset('local-result', 'local_image3d', 'model'), asset('procedural-result', 'procedural', 'model'));
    await mount({}, {snapshot: project}); await describeGame(); await page.locator('.production-references summary').click();
    for (const id of ['old-generation', 'no-preview', 'local-result', 'procedural-result']) await page.getByRole('button', {name: `참고 ${id} 참고 선택`, exact: true}).click();
    await uiExpect(page.getByText('3D 모델 · 메타데이터 참고', {exact: true})).toBeVisible();
    await consent().check(); await analyzeButton().click(); await uiExpect(page.getByRole('list', {name: '제작 계획'})).toBeVisible();
    await uiExpect(startButton()).toBeEnabled();
    expect((await commands('production_plan'))[0].referenceAssetIds).toEqual(['old-generation', 'no-preview', 'local-result', 'procedural-result']);
  });

  it('keeps actionable native errors for changed projects and folder permissions while discarding secrets', async () => {
    await mount({failures: {production_start: 1}, errorMessages: {production_start: '게임 프로젝트가 분석 후 변경됐습니다. 다시 분석해 주세요.'}});
    await analyze(); await startButton().click();
    await uiExpect(page.getByRole('alert')).toHaveText('게임 프로젝트가 분석 후 변경됐습니다. 다시 분석해 주세요.');
    await uiExpect(startButton()).toBeDisabled(); await uiExpect(page.getByRole('list', {name: '제작 계획'})).toHaveCount(0);
    await page.evaluate(() => {const fixture = window.__PRODUCTION_UI_FIXTURE__; fixture.failures.game_connect = 1; fixture.errorMessages.game_connect = 'Permission denied (os error 13)';});
    await page.getByRole('button', {name: '게임 프로젝트 변경', exact: true}).click();
    await uiExpect(page.getByRole('alert')).toContainText('폴더에 접근할 권한이 없습니다');
    await page.evaluate(() => {const fixture = window.__PRODUCTION_UI_FIXTURE__; fixture.failures.production_plan = 1; fixture.errorMessages.production_plan = '에셋 제작 오류: authorization Bearer private-token';});
    await consent().check(); await analyzeButton().click();
    await uiExpect(page.getByRole('alert')).toContainText('필요한 에셋을 분석하지 못했습니다');
    await uiExpect(page.locator('body')).not.toContainText('private-token');
  });

  it('deduplicates plan submits and hides a delayed plan after the brief changes', async () => {
    await mount({hold: ['production_plan']}); await describeGame();
    await analyzeButton().evaluate(button => {(button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();});
    await uiExpect.poll(async () => (await commands('production_plan')).length).toBe(1);
    await page.getByRole('textbox', {name: '게임 설명', exact: true}).fill('우주에서 싸우는 게임');
    await release('production_plan');
    await uiExpect(page.getByText(/입력이 바뀌었거나 저장된 계획이 일치하지 않습니다/)).toBeVisible();
    await uiExpect(page.getByRole('list', {name: '제작 계획'})).toHaveCount(0); await uiExpect(startButton()).toBeDisabled();
    await uiExpect(consent()).not.toBeChecked(); expect(await commands('production_start')).toEqual([]);
  });

  it('invalidates plans and consent when brief, output or selected references change', async () => {
    await mount(); await analyze(); await uiExpect(startButton()).toBeEnabled();
    await page.getByRole('textbox', {name: '게임 설명', exact: true}).fill(`${BRIEF}와 배`);
    await uiExpect(startButton()).toBeDisabled(); await uiExpect(consent()).not.toBeChecked();
    await consent().check(); await analyzeButton().click(); await uiExpect(page.getByRole('list', {name: '제작 계획'})).toBeVisible();
    await page.getByRole('radio', {name: '이미지', exact: true}).check();
    await uiExpect(page.getByRole('list', {name: '제작 계획'})).toHaveCount(0); await uiExpect(consent()).not.toBeChecked();
    await consent().check(); await analyzeButton().click(); await uiExpect(page.getByRole('list', {name: '제작 계획'})).toBeVisible();
    await page.locator('.production-references summary').click(); await page.getByRole('button', {name: '참고 one 참고 선택', exact: true}).click();
    await page.getByRole('button', {name: '제작 상태 다시 확인', exact: true}).click();
    await uiExpect(page.getByRole('list', {name: '제작 계획'})).toHaveCount(0); await uiExpect(startButton()).toBeDisabled();
    expect(await commands('production_start')).toEqual([]);
  });

  it('invalidates a plan when a selected current reference file changes in a new snapshot', async () => {
    await mount(); await describeGame(); await page.locator('.production-references summary').click();
    await page.getByRole('button', {name: '참고 one 참고 선택', exact: true}).click(); await consent().check(); await analyzeButton().click();
    await uiExpect(startButton()).toBeEnabled();
    await page.evaluate(() => {const fixture = window.__PRODUCTION_UI_FIXTURE__; const next = structuredClone(fixture.props.snapshot); next.project.assets[0].versions[0].artifacts[0].sha256 = 'c'.repeat(64); fixture.props.snapshot = next; window.__PRODUCTION_UI_RENDER__();});
    await uiExpect(startButton()).toBeDisabled(); await uiExpect(page.getByRole('list', {name: '제작 계획'})).toHaveCount(0);
  });

  it('retains one UUID for ambiguous start retries and suppresses synchronous double submission', async () => {
    await mount({hold: ['production_start'], failures: {production_start: 1}}); await analyze();
    await startButton().evaluate(button => {(button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();});
    await uiExpect.poll(async () => (await commands('production_start')).length).toBe(1);
    await release('production_start'); await uiExpect(page.getByRole('alert')).toContainText('제작 요청의 결과를 확인하지 못했습니다');
    await uiExpect(startButton()).toBeEnabled(); await startButton().click();
    await uiExpect(page.getByRole('button', {name: '제작 취소', exact: true})).toBeVisible();
    const requests = await commands('production_start'); expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({action: 'production_start', planId: PLAN_ID, requestId: expect.stringMatching(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/), uploadApproved: true});
    expect(requests[1]).toEqual(requests[0]); expect(await page.evaluate(() => window.__PRODUCTION_UI_FIXTURE__.snapshots.length)).toBe(1);
    await uiExpect(startButton()).toBeDisabled(); await uiExpect(page.locator('.production-saved-folder')).toContainText('AssetStudioGenerated');
  });

  it('blocks every plan larger than 120 total items even when some rows are disabled', async () => {
    const template = plan(); template.items = Array.from({length: 121}, (_, index) => ({...template.items[0], id: `item-${index}`, name: `에셋 ${index}`, enabled: index < 120}));
    await mount({template}); await analyze(); await uiExpect(startButton()).toBeDisabled();
    await uiExpect(page.getByText(/120개를 초과한 계획/)).toBeVisible(); expect(await commands('production_start')).toEqual([]);
  });

  it('requires explicit local download preparation and ready state before starting a model plan', async () => {
    const template = plan(); template.items[0].kind = 'model';
    await mount({template, local: local({installed: false, state: 'missing', message: 'UI 모형: 준비 필요'})}); await analyze('models');
    await uiExpect(startButton()).toBeDisabled();
    const downloadConsent = page.getByRole('checkbox', {name: /TripoSR 가중치와 의존성 다운로드에 동의합니다/});
    await uiExpect(page.getByRole('button', {name: '로컬 3D 준비', exact: true})).toBeDisabled();
    await downloadConsent.check(); await page.getByRole('button', {name: '로컬 3D 준비', exact: true}).click();
    await uiExpect(page.getByRole('button', {name: '준비 취소', exact: true})).toBeEnabled();
    expect(await commands('quality3d_prepare')).toEqual([{action: 'quality3d_prepare', confirmed: true}]); await uiExpect(startButton()).toBeDisabled();
    await page.getByRole('button', {name: '준비 취소', exact: true}).click();
    expect(await commands('quality3d_cancel_setup')).toEqual([{action: 'quality3d_cancel_setup'}]); await uiExpect(startButton()).toBeDisabled();
    await page.evaluate(value => {window.__PRODUCTION_UI_FIXTURE__.local = value;}, local());
    await page.getByRole('button', {name: '3D 상태 다시 확인', exact: true}).click(); await uiExpect(startButton()).toBeEnabled();
    await uiExpect(page.getByText(/GPT로 개념 이미지를 만든 뒤, 로컬 TripoSR로 3D 모델을 재구성/)).toBeVisible();
    await page.evaluate(() => {window.__PRODUCTION_UI_FIXTURE__.props.connection!.ready = false; window.__PRODUCTION_UI_RENDER__();});
    await uiExpect(startButton()).toBeDisabled(); expect(await commands('production_start')).toEqual([]);
  });

  it('defaults unsupported Windows desktop to images, blocks model choices and starts only after explicit image approval', async () => {
    await mount({local: local({supported: false, installed: false, state: 'unsupported', blenderReady: false})});
    await uiExpect(page.getByRole('radio', {name: '이미지', exact: true})).toBeChecked();
    await uiExpect(page.getByRole('radio', {name: '이미지', exact: true})).toBeEnabled();
    await uiExpect(page.getByRole('radio', {name: '3D 모델', exact: true})).toBeDisabled();
    await uiExpect(page.getByRole('radio', {name: '이미지 + 3D', exact: true})).toBeDisabled();
    expect(await commands('production_plan')).toEqual([]);
    expect(await commands('production_start')).toEqual([]);
    expect(await commands('quality3d_prepare')).toEqual([]);
    await analyze('images'); await uiExpect(startButton()).toBeEnabled();
    expect(await commands('production_plan')).toEqual([{action: 'production_plan', brief: BRIEF, output: 'images', referenceAssetIds: [], uploadApproved: true}]);
    expect(await commands('production_start')).toEqual([]);
    await startButton().click();
    await uiExpect.poll(async () => (await commands('production_start')).length).toBe(1);
    expect(await commands('quality3d_prepare')).toEqual([]);
  });

  it('preserves an incompatible saved plan until explicit image conversion and fresh analysis', async () => {
    const one = asset('one');
    const saved = plan({referenceAssetIds: [one.id], references: [{assetId: one.id, versionId: one.activeVersionId,
      name: one.name, kind: one.kind, width: one.width, height: one.height, mesh: one.mesh}], items: [{...plan().items[0], kind: 'model'}]});
    await mount({local: local({supported: false, installed: false, state: 'unsupported', blenderReady: false}),
      state: {connection: scan(), plan: saved, runs: []}, hold: ['production_state']});
    await uiExpect(page.getByRole('radio', {name: '이미지 + 3D', exact: true})).toBeChecked();
    await release('production_state');
    await uiExpect(page.getByRole('textbox', {name: '게임 설명', exact: true})).toHaveValue(BRIEF);
    await uiExpect(page.getByRole('list', {name: '제작 계획'})).toContainText('3D 모델');
    await uiExpect(page.getByRole('radio', {name: '이미지 + 3D', exact: true})).toBeChecked();
    await uiExpect(startButton()).toBeDisabled();
    expect(await commands('production_plan')).toEqual([]);
    await page.getByRole('button', {name: '이미지 전용으로 전환', exact: true}).click();
    await uiExpect(page.getByRole('radio', {name: '이미지', exact: true})).toBeChecked();
    await uiExpect(page.getByRole('textbox', {name: '게임 설명', exact: true})).toHaveValue(BRIEF);
    await page.locator('.production-references summary').click();
    await uiExpect(page.getByRole('button', {name: '참고 one 참고 선택', exact: true})).toHaveAttribute('aria-pressed', 'true');
    await uiExpect(consent()).not.toBeChecked();
    expect(await page.evaluate(() => window.__PRODUCTION_UI_FIXTURE__.state.plan)).toEqual(saved);
    expect(await commands('production_plan')).toEqual([]); expect(await commands('production_start')).toEqual([]);
    await consent().check(); await analyzeButton().click();
    await uiExpect(startButton()).toBeEnabled();
    expect(await commands('production_plan')).toEqual([{action: 'production_plan', brief: BRIEF, output: 'images', referenceAssetIds: ['one'], uploadApproved: true}]);
    expect(await commands('production_start')).toEqual([]);
  });

  it('keeps a user draft when unsupported capability arrives late and never auto-analyzes it', async () => {
    await mount({local: local({supported: false, installed: false, state: 'unsupported', blenderReady: false}), hold: ['quality3d_status']});
    const edited = `${BRIEF}와 직접 입력한 새 게임 설정`;
    await page.getByRole('textbox', {name: '게임 설명', exact: true}).fill(edited);
    await release('quality3d_status');
    await uiExpect(page.getByRole('radio', {name: '3D 모델', exact: true})).toBeDisabled();
    await uiExpect(page.getByRole('button', {name: '이미지 전용으로 전환', exact: true})).toBeVisible();
    await uiExpect(page.getByRole('radio', {name: '이미지 + 3D', exact: true})).toBeChecked();
    await uiExpect(page.getByRole('textbox', {name: '게임 설명', exact: true})).toHaveValue(edited);
    await uiExpect(analyzeButton()).toBeDisabled();
    await page.getByRole('button', {name: '이미지 전용으로 전환', exact: true}).click();
    await uiExpect(page.getByRole('radio', {name: '이미지', exact: true})).toBeChecked();
    await uiExpect(page.getByRole('textbox', {name: '게임 설명', exact: true})).toHaveValue(edited);
    expect(await commands('production_plan')).toEqual([]); expect(await commands('production_start')).toEqual([]);
    expect(await commands('quality3d_prepare')).toEqual([]);
  });

  it('restores saved plans and runs without automatic consent, generation or fixture library cards', async () => {
    const project = snapshot(); project.project.assets.push({...asset('tree-result', 'codex_subscription'), name: '섬의 나무'});
    await mount({state: {connection: scan(), plan: plan(), runs: [run()]}}, {snapshot: project});
    await uiExpect(page.getByRole('textbox', {name: '게임 설명', exact: true})).toHaveValue(BRIEF);
    await uiExpect(page.getByRole('list', {name: '제작 계획'})).toBeVisible(); await uiExpect(consent()).not.toBeChecked(); await uiExpect(startButton()).toBeDisabled();
    await uiExpect(page.locator('.production-gallery .production-result')).toHaveCount(1);
    const preview = page.getByRole('button', {name: '섬의 나무 결과 살펴보기', exact: true});
    await uiExpect(preview.locator('img')).toHaveAttribute('src', /fixtures%2Ftree-result-thumb\.png$/);
    await uiExpect.poll(() => preview.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await preview.click(); expect(await page.evaluate(() => window.__PRODUCTION_UI_FIXTURE__.inspected)).toEqual(['tree-result']);
    await uiExpect(page.locator('.production-gallery').getByText(/fixture-library|old-generation/)).toHaveCount(0); expect(await commands('production_start')).toEqual([]);
  });

  it('prepares a focused improvement from a completed result without submitting or retaining consent', async () => {
    const project = snapshot(); project.project.assets.push({...asset('tree-result', 'codex_subscription'), name: '섬의 나무'});
    await mount({state: {connection: scan(), plan: plan(), runs: [run()]}}, {snapshot: project});
    await consent().check();
    await page.getByRole('button', {name: '이 에셋 개선하기', exact: true}).click();
    const brief = page.getByRole('textbox', {name: '게임 설명', exact: true});
    await uiExpect(brief).toBeFocused();
    await uiExpect(brief).toHaveValue(new RegExp(`게임 기준: ${BRIEF}.*이번 제작 범위: "섬의 나무" 이미지 에셋 하나만`, 's'));
    await uiExpect(page.getByRole('radio', {name: '이미지', exact: true})).toBeChecked();
    await uiExpect(consent()).not.toBeChecked();
    await uiExpect(page.getByRole('list', {name: '제작 계획'})).toHaveCount(0);
    expect(await commands('production_plan')).toEqual([]);
    expect(await commands('production_start')).toEqual([]);
    await consent().check(); await analyzeButton().click();
    await uiExpect(page.getByRole('list', {name: '제작 계획'})).toBeVisible();
    expect((await commands('production_plan'))[0].referenceAssetIds).toEqual(['tree-result']);
  });

  it('saves review only on actual returned approval, redacts failures and deduplicates review clicks', async () => {
    const project = snapshot(); project.project.assets.push(asset('tree-result', 'codex_subscription'));
    await mount({state: {connection: scan(), plan: null, runs: [run()]}, hold: ['production_review'], failures: {production_review: 1}}, {snapshot: project});
    await page.getByRole('button', {name: '검수 승인', exact: true}).evaluate(button => {(button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();});
    await uiExpect.poll(async () => (await commands('production_review')).length).toBe(1);
    await uiExpect(page.getByText(/검수 승인됨/)).toHaveCount(0); await release('production_review');
    await uiExpect(page.getByRole('alert')).toContainText('검수 승인을 저장하지 못했습니다');
    await uiExpect(page.locator('body')).not.toContainText('sk-UI-secret');
    await page.getByRole('button', {name: '검수 승인', exact: true}).click(); await uiExpect(page.getByText(/검수 승인됨/)).toBeVisible();
    expect((await commands('production_review'))[1]).toEqual({action: 'production_review', runId: RUN_ID, itemId: 'tree-item', approved: true});
  });

  it('uses retry/cancel response snapshots and keeps missing artifacts uninspectable and unapprovable', async () => {
    const failed = run('needs_attention'); failed.items[0].error = 'Bearer private-provider-secret';
    await mount({state: {connection: scan(), plan: null, runs: [failed]}, hold: ['production_retry']});
    await page.getByRole('button', {name: '이 에셋 다시 제작', exact: true}).evaluate(button => {(button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();});
    await uiExpect.poll(async () => (await commands('production_retry')).length).toBe(1); await release('production_retry');
    await uiExpect(page.getByRole('button', {name: '제작 취소', exact: true})).toBeVisible(); await page.getByRole('button', {name: '제작 취소', exact: true}).click();
    await uiExpect(page.locator('.production-item-status')).toContainText('취소됨');
    expect(await commands('production_retry')).toEqual([{action: 'production_retry', runId: RUN_ID, itemId: 'tree-item'}]);
    expect(await commands('production_cancel')).toEqual([{action: 'production_cancel', runId: RUN_ID}]);
    expect(await page.evaluate(() => window.__PRODUCTION_UI_FIXTURE__.snapshots.length)).toBe(2);
    await page.evaluate(value => {window.__PRODUCTION_UI_FIXTURE__.state.runs = [value];}, run());
    await page.getByRole('button', {name: '제작 상태 다시 확인', exact: true}).click();
    await uiExpect(page.getByRole('button', {name: '섬의 나무 결과 살펴보기', exact: true})).toBeDisabled(); await uiExpect(page.getByRole('button', {name: '검수 승인', exact: true})).toBeDisabled();
    await uiExpect(page.locator('body')).not.toContainText('private-provider-secret');
  });

  it('polls active runs serially at one second and stops after a terminal response or unmount', async () => {
    await mount({state: {connection: scan(), plan: null, runs: [run('running')]}});
    await page.clock.fastForward(999); expect(await commands('production_state')).toHaveLength(1);
    await page.evaluate(() => {window.__PRODUCTION_UI_FIXTURE__.hold = ['production_state'];});
    await page.clock.fastForward(1); await uiExpect.poll(async () => (await commands('production_state')).length).toBe(2);
    await page.clock.fastForward(5000); expect(await commands('production_state')).toHaveLength(2);
    await release('production_state');
    await page.evaluate(value => {window.__PRODUCTION_UI_FIXTURE__.state.runs = [value];}, run());
    await page.clock.fastForward(1000); await uiExpect.poll(async () => (await commands('production_state')).length).toBe(3);
    await page.clock.fastForward(4000); expect(await commands('production_state')).toHaveLength(3);
    expect((await commands()).every(request => ['production_state', 'quality3d_status'].includes(String(request.action)))).toBe(true);
    await page.evaluate(() => {window.__PRODUCTION_UI_UNMOUNT__();}); await page.clock.fastForward(5000); expect(await commands('production_state')).toHaveLength(3);
  });

  it('refreshes on final job progress/count changes even with no active run', async () => {
    const project = snapshot(); project.project.jobs = [job()];
    await mount({state: {connection: scan(), plan: null, runs: [run()]}}, {snapshot: project});
    await page.evaluate(() => {const fixture = window.__PRODUCTION_UI_FIXTURE__; const next = structuredClone(fixture.props.snapshot); next.project.jobs[0].progress.completed = 2; next.project.jobs[0].progress.total = 2; fixture.props.snapshot = next; window.__PRODUCTION_UI_RENDER__();});
    await uiExpect.poll(async () => (await commands('production_state')).length).toBe(2);
    await page.evaluate(() => {const fixture = window.__PRODUCTION_UI_FIXTURE__; const next = structuredClone(fixture.props.snapshot); next.project.jobs.push({...next.project.jobs[0], id: 'second-finished-job'}); fixture.props.snapshot = next; window.__PRODUCTION_UI_RENDER__();});
    await uiExpect.poll(async () => (await commands('production_state')).length).toBe(3);
  });

  it('renders live counts from real job fields and keeps the backend failure reason visible', async () => {
    const project = snapshot(); const active = job('running'); active.progress = {stage: '이미지 수신', completed: 2, total: 3}; project.project.jobs = [active];
    await mount({state: {connection: scan(), plan: null, runs: [run('running')]}}, {snapshot: project});
    await uiExpect(page.locator('.production-job-progress')).toHaveText('이미지 수신 · 2/3');
    const failed = run('needs_attention'); failed.items[0].error = '개념 이미지의 배경이 균일하지 않습니다. 단색 배경으로 다시 제작해 주세요.';
    await page.evaluate(value => {window.__PRODUCTION_UI_FIXTURE__.state.runs = [value];}, failed);
    await page.clock.fastForward(1000); await uiExpect(page.locator('.production-item-error')).toHaveText(failed.items[0].error!);
    await uiExpect(page.getByRole('button', {name: '이 에셋 다시 제작', exact: true})).toBeEnabled();
  });

  it('ignores an older state read that finishes after a successful connection mutation', async () => {
    await mount({state: {connection: null, plan: null, runs: []}, hold: ['production_state']});
    await page.getByRole('button', {name: '게임 프로젝트 루트 연결', exact: true}).click();
    await uiExpect(page.getByText('작은 섬', {exact: true})).toBeVisible(); await release('production_state');
    await uiExpect.poll(async () => (await commands('production_state')).length).toBe(2);
    await uiExpect(page.getByText('작은 섬', {exact: true})).toBeVisible();
  });

  it('ignores a delayed start response when the parent switches projects', async () => {
    await mount({hold: ['production_start']}); await analyze(); await startButton().click();
    await uiExpect.poll(async () => (await commands('production_start')).length).toBe(1);
    await page.evaluate(() => {const fixture = window.__PRODUCTION_UI_FIXTURE__; fixture.state = {connection:null,plan:null,runs:[]}; fixture.props.snapshot = {...fixture.props.snapshot, root:'/another-ui-fixture', project:{...fixture.props.snapshot.project,id:'another-project'}}; window.__PRODUCTION_UI_RENDER__();});
    await uiExpect(page.getByRole('textbox', {name: '게임 설명', exact: true})).toHaveValue('');
    await release('production_start'); await uiExpect(page.getByRole('textbox', {name: '게임 설명', exact: true})).toHaveValue('');
    expect(await page.evaluate(() => window.__PRODUCTION_UI_FIXTURE__.snapshots)).toEqual([]);
    await uiExpect(page.locator('.production-gallery .production-result')).toHaveCount(0);
  });

  it('uses safe error copy for state/provider diagnostics and accepts a manual state recovery', async () => {
    await mount({failures: {production_state: 1, quality3d_status: 1}}, {connection: connection({ready: false, reason: 'Bearer private-provider-secret'})});
    await uiExpect(page.getByRole('alert').filter({hasText: '제작 상태를 불러오지 못했습니다'})).toBeVisible();
    await uiExpect(page.locator('body')).not.toContainText('sk-UI-secret'); await uiExpect(page.locator('body')).not.toContainText('private-provider-secret');
    await page.getByRole('button', {name: '제작 상태 다시 확인', exact: true}).click();
    await uiExpect(page.getByText('작은 섬', {exact: true})).toBeVisible();
    await uiExpect(analyzeButton()).toBeDisabled();
  });

  it('keeps readable controls and responsive content without horizontal overflow at 390px', async () => {
    await page.setViewportSize({width: 390, height: 844}); await mount(); await analyze();
    const overflow = await page.locator('.production-home').evaluate(element => element.scrollWidth > element.clientWidth);
    expect(overflow).toBe(false);
    const smallText = await page.locator('.production-home').evaluate(element => [...element.querySelectorAll('button, p, label, small, li, legend, summary, .production-badge')]
      .filter(child => child.getClientRects().length && parseFloat(getComputedStyle(child).fontSize) < 14).map(child => child.textContent));
    expect(smallText).toEqual([]);
    await page.getByRole('textbox', {name: '게임 설명', exact: true}).focus();
    await uiExpect(page.getByRole('textbox', {name: '게임 설명', exact: true})).toBeFocused();
    expect(await page.getByRole('textbox', {name: '게임 설명', exact: true}).evaluate(element => getComputedStyle(element).outlineWidth)).toBe('3px');
  });
});
