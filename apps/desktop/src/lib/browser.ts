import JSZip from 'jszip';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  DEFAULT_SPEC, DEFAULT_STYLE, EXPORT_PRESETS, SCHEMA_VERSION,
  type Artifact, type Asset, type AssetVersion, type AtlasOptions, type EnvironmentInfo,
  type ImageOperation, type Job, type ModelParameters, type ProjectSnapshot, type ProviderConnection,
  type ValidationReport, type AppUpdateStatus,
} from '@local-assets/contracts';
import {unsupportedUpdateStatus} from './appUpdate';

/** Browser preview uses local files and IndexedDB. Native production jobs use the Rust bridge. */
type Session = { snapshot: ProjectSnapshot };
type StoredBlob = { path: string; blob: Blob };
type PackedManifest = {
  app: 'asset-studio'; version: 1; snapshot: ProjectSnapshot;
  bundledArtifacts: { artifactPath: string; zipPath: string }[];
};
type JobContext = {
  session: Session; job: Job; signal: AbortSignal;
  stage: (name: string, completed?: number | null, total?: number | null) => Promise<void>;
};

const DB_NAME = 'asset-studio-browser-v1';
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;
const CPU_CONCURRENCY = 2;
const exampleManifest = fetch(`${import.meta.env.BASE_URL}examples/index.json`).then(async response => {
  if(!response.ok) throw new Error('번들 예제 목록을 읽지 못했습니다.');
  const entries = await response.json() as {name:string;path:string}[];
  if(!Array.isArray(entries)||!entries.length||entries.some(item=>typeof item.name!=='string'||!/^\/examples\/[a-z0-9-]+\.png$/.test(item.path))) throw new Error('번들 예제 목록 형식이 잘못되었습니다.');
  return entries;
});
const sessions = new Map<string, Session>();
const objectUrls = new Map<string, string>();
const listeners = new Set<() => void>();
const controllers = new Map<string, AbortController>();
let database: Promise<IDBDatabase> | undefined;
let initialization: Promise<ProjectSnapshot> | undefined;
let active: Session | undefined;
let running = 0;
let pumping = false;
let commandTail: Promise<unknown> = Promise.resolve();

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const clone = <T,>(value: T): T => structuredClone(value);
const safeName = (name: string) => name.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.\./g, '_').trim().slice(0, 100) || 'Untitled';

export function subscribeBrowser(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBrowserArtifactUrl(path: string): string {
  return objectUrls.get(path) ?? '';
}

export function bootstrapBrowser(): Promise<ProjectSnapshot> {
  initialization ??= initialize();
  return initialization.then(() => snapshot());
}

export async function browserCommand(request: Record<string, unknown>): Promise<ProjectSnapshot | EnvironmentInfo | ProviderConnection | AppUpdateStatus | { path: string }> {
  if (['update_status','update_check','update_install'].includes(String(request.action))) return unsupportedUpdateStatus();
  // Provider checks never initialize or mutate a browser project, or open an auth URL.
  if (request.action === 'provider_status' || request.action === 'provider_login') return {
    available: false, authenticated: false, ready: false, runtimeVersion: null,
    requestedModel: 'gpt-image-2', confirmedModel: null, usage: null,
    reasoningModel: null, catalogSource: 'unknown', inferenceAccess: 'unknown',
    reason: '데스크톱 전용: GPT Image2 연결과 생성은 Tauri 앱의 공식 런타임에서 확인하세요.', checkedAt: now(),
  };
  if (request.action === 'generate') throw new Error('데스크톱 전용: 브라우저에서는 GPT Image2 생성 요청을 제출할 수 없습니다.');
  if (['plan_assets', 'generate_bundle', 'cancel_plan'].includes(String(request.action))) throw new Error('데스크톱 전용: 게임 에셋 구성안과 묶음 제작은 공식 Codex 연결이 있는 Tauri 앱에서 사용할 수 있습니다.');
  await bootstrapBrowser();
  if (request.action === 'snapshot' || request.action === 'bootstrap') return snapshot();
  if (request.action === 'environment') return { blenderPath: null, blenderVersion: null, platform: 'browser', native: false };
  return exclusive(async () => {
    const session = requireSession();
    switch (request.action) {
      case 'create': {
        const created = newSession(typeof request.name === 'string' ? request.name : 'Untitled collection');
        sessions.set(created.snapshot.root, created);
        active = created;
        await persist(created);
        emit();
        return snapshot();
      }
      case 'open': {
        if (typeof request.root !== 'string') throw new Error('열 프로젝트 식별자가 필요합니다.');
        const loaded = sessions.get(request.root) ?? await readProject(request.root);
        if (!loaded) throw new Error('브라우저에 저장된 프로젝트를 찾지 못했습니다. ZIP 파일은 파일 가져오기로 열 수 있습니다.');
        await hydrate(loaded);
        active = loaded;
        sessions.set(loaded.snapshot.root, loaded);
        await persist(loaded);
        emit();
        void pump();
        return snapshot();
      }
      case 'update': {
        const project = session.snapshot.project;
        if (request.spec && typeof request.spec === 'object') {
          project.spec = { ...project.spec, ...clone(request.spec as Partial<typeof project.spec>) };
          checkDimensions(project.spec.width, project.spec.height);
        }
        if (request.styleGuide && typeof request.styleGuide === 'object') {
          project.styleGuide = { ...project.styleGuide, ...clone(request.styleGuide as Partial<typeof project.styleGuide>) };
        }
        if (typeof request.assetId === 'string') {
          const asset = requireAsset(session, request.assetId);
          if (typeof request.name === 'string') asset.name = safeName(request.name);
          if (Array.isArray(request.tags)) asset.tags = request.tags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.slice(0, 80)).slice(0, 30);
          // Version selection is metadata only; every original/version blob stays intact.
          if (typeof request.activeVersionId === 'string' && asset.versions.some(v => v.id === request.activeVersionId)) asset.activeVersionId = request.activeVersionId;
        } else if (typeof request.name === 'string') project.name = safeName(request.name);
        await persist(session);
        emit();
        return snapshot();
      }
      case 'import': {
        if (Array.isArray(request.files) && request.files.every(file => file instanceof File)) {
          await importFilesInto(session, request.files as File[]);
          return snapshot();
        }
        throw new Error('브라우저 파일 선택기로 PNG, JPEG, WebP, GLB 또는 프로젝트 ZIP을 가져오세요. 로컬 경로 접근은 데스크톱에서 지원됩니다.');
      }
      case 'fixture': {
        const count = integer(request.count ?? 12, 1, 32, '예제 수');
        await addFixtures(session, count);
        return snapshot();
      }
      case 'process': {
        const assetId = string(request.assetId, '에셋');
        const asset = requireAsset(session, assetId);
        if (asset.kind === 'model') throw new Error('이미지 에셋을 선택하세요.');
        const operation = validateOperation(request.operation);
        enqueue(session, 'process', `이미지 · ${operationName(operation.type)}`, { assetId, operation }, assetId);
        await persist(session);
        emit(); void pump();
        return snapshot();
      }
      case 'split': {
        const assetId = string(request.assetId, '스프라이트');
        const asset = requireAsset(session, assetId);
        if (asset.kind === 'model') throw new Error('이미지 에셋을 선택하세요.');
        const frameWidth = integer(request.frameWidth, 1, MAX_DIMENSION, '프레임 너비');
        const frameHeight = integer(request.frameHeight, 1, MAX_DIMENSION, '프레임 높이');
        const playback = spritePlayback(request.frameRate, session.snapshot.project.spec.pivot);
        enqueue(session, 'split', '스프라이트 · 프레임 분할', { assetId, frameWidth, frameHeight, ...playback }, assetId);
        await persist(session);
        emit(); void pump();
        return snapshot();
      }
      case 'atlas': {
        const assetIds = strings(request.assetIds).slice(0, 256);
        if (!assetIds.length) throw new Error('아틀라스로 묶을 이미지를 선택하세요.');
        for (const assetId of assetIds) if (requireAsset(session, assetId).kind === 'model') throw new Error('3D 모델은 이미지 아틀라스에 포함할 수 없습니다.');
        const options = request.options as AtlasOptions | undefined;
        if (!options) throw new Error('아틀라스 크기가 필요합니다.');
        checkDimensions(options.width, options.height);
        integer(options.padding, 0, 128, '패딩');
        const playback = spritePlayback(request.frameRate, session.snapshot.project.spec.pivot);
        enqueue(session, 'atlas', '스프라이트 · 아틀라스 패킹', { assetIds, options: clone(options), ...playback }, null);
        await persist(session);
        emit(); void pump();
        return snapshot();
      }
      case 'model': {
        if (!Array.isArray(request.models) || !request.models.length || request.models.length > 24) throw new Error('1–24개 모델 파라미터가 필요합니다.');
        const models = request.models.map(validateModel);
        for (const model of models) enqueue(session, 'model', `로컬 3D · ${model.name}`, { model }, null);
        await persist(session);
        emit(); void pump();
        return snapshot();
      }
      case 'cancel': {
        const job = requireJob(session, string(request.jobId, '작업'));
        if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) {
          controllers.get(job.id)?.abort();
          job.status = 'cancelled'; job.finishedAt = now();
          job.progress.stage = '사용자가 취소함'; job.error = null;
          await persist(session); emit();
        }
        return snapshot();
      }
      case 'rerun': {
        const job = requireJob(session, string(request.jobId, '작업'));
        if (controllers.has(job.id)) throw new Error('이전 실행의 취소 정리가 끝난 뒤 다시 시도하세요.');
        if (['pending', 'ready', 'running'].includes(job.status)) throw new Error('이미 대기 중이거나 실행 중인 작업입니다.');
        job.status = 'ready'; job.startedAt = null; job.finishedAt = null; job.error = null;
        job.progress = { stage: '재실행 대기', completed: null, total: null };
        await persist(session); emit(); void pump();
        return snapshot();
      }
      case 'export': return exportProject(session, request);
      default: throw new Error(`지원하지 않는 브라우저 작업: ${String(request.action)}`);
    }
  });
}

export async function importBrowserFiles(files: File[]): Promise<ProjectSnapshot> {
  await bootstrapBrowser();
  return exclusive(async () => {
    if (!files.length) return snapshot();
    if (files.length > 128) throw new Error('한 번에 가져올 수 있는 파일은 최대 128개입니다.');
    const archives = files.filter(file => /\.zip$/i.test(file.name));
    const manifests = files.filter(file => /\.json$/i.test(file.name));
    if (archives.length) {
      if (files.length !== 1) throw new Error('프로젝트 ZIP은 한 번에 하나씩 여세요.');
      await importArchive(archives[0]);
    } else if (manifests.length) {
      if (files.length !== 1) throw new Error('프로젝트 JSON은 한 번에 하나씩 여세요.');
      await importEmbeddedManifest(manifests[0]);
    } else await importFilesInto(requireSession(), files);
    return snapshot();
  });
}

async function initialize(): Promise<ProjectSnapshot> {
  await db();
  const root = await readValue<string>('settings', 'activeRoot');
  const loaded = typeof root === 'string' ? await readProject(root) : undefined;
  if (loaded) {
    active = loaded;
    sessions.set(loaded.snapshot.root, loaded);
    await hydrate(loaded);
    for (const job of loaded.snapshot.project.jobs) {
      if (['running', 'retry_wait'].includes(job.status)) {
        job.status = 'ready'; job.startedAt = null;
        job.progress = { stage: '브라우저 재시작 후 재개 대기', completed: null, total: null };
      }
    }
    await persist(loaded);
  } else {
    active = newSession('Meadow Relics');
    sessions.set(active.snapshot.root, active);
    await addFixtures(active, 12);
  }
  emit(); void pump();
  return snapshot();
}

function newSession(name: string): Session {
  const projectId = id('project');
  const createdAt = now();
  return { snapshot: {
    root: `browser:${projectId}`,
    project: {
      id: projectId, name: safeName(name), schemaVersion: SCHEMA_VERSION, createdAt, updatedAt: createdAt,
      spec: clone(DEFAULT_SPEC), styleGuide: clone(DEFAULT_STYLE), assets: [], jobs: [],
    },
    providers: [{
      id: 'codex_subscription', name: 'GPT Image2 · 공식 런타임', status: 'blocked', authentication: '데스크톱 전용',
      requestedModels: ['gpt-image-2'], confirmedModel: null, generation: false, editing: false, transparency: false,
      masks: false, referenceImageLimit: null, cancellation: 'unknown', concurrency: null, resolutions: [],
      reason: '브라우저 예제와 후처리는 로컬에서 실행됩니다. GPT Image2 연결과 생성은 데스크톱 공식 런타임에서 확인해야 합니다.', checkedAt: createdAt,
    }],
  } };
}

function snapshot(): ProjectSnapshot { return clone(requireSession().snapshot); }
function requireSession(): Session {
  if (!active) throw new Error('프로젝트를 먼저 여세요.');
  return active;
}
function requireAsset(session: Session, assetId: string): Asset {
  const asset = session.snapshot.project.assets.find(item => item.id === assetId);
  if (!asset) throw new Error('선택한 에셋을 찾지 못했습니다.');
  return asset;
}
function requireJob(session: Session, jobId: string): Job {
  const job = session.snapshot.project.jobs.find(item => item.id === jobId);
  if (!job) throw new Error('작업을 찾지 못했습니다.');
  return job;
}
function activeVersion(asset: Asset): AssetVersion {
  const version = asset.versions.find(item => item.id === asset.activeVersionId);
  if (!version) throw new Error('에셋 버전을 찾지 못했습니다.');
  return version;
}
function imageArtifact(asset: Asset, version = activeVersion(asset)): Artifact {
  const result = version.artifacts.find(a => a.role === 'output' && isRasterFormat(a.format))
    ?? version.artifacts.find(a => a.role === 'source' && isRasterFormat(a.format));
  if (!result) throw new Error('이 버전에는 처리 가능한 이미지가 없습니다.');
  return result;
}
function isRasterFormat(format: string) { return ['png', 'jpg', 'jpeg', 'webp'].includes(format.toLowerCase()); }
function emit() { for (const listener of listeners) { try { listener(); } catch { /* One subscriber must not stop persistence. */ } } }
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = commandTail.then(task, task);
  commandTail = run.catch(() => undefined);
  return run;
}

function db(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('이 브라우저에서는 로컬 저장소(IndexedDB)를 사용할 수 없습니다.')); return; }
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      for (const store of ['projects', 'artifacts', 'settings']) if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('로컬 저장소를 열지 못했습니다.'));
    open.onblocked = () => reject(new Error('다른 브라우저 탭이 로컬 저장소 업데이트를 막고 있습니다.'));
  });
  return database;
}
async function readValue<T>(store: string, key: string): Promise<T | undefined> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const request = connection.transaction(store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error('저장된 데이터를 읽지 못했습니다.'));
  });
}
async function readProject(root: string): Promise<Session | undefined> {
  const stored = await readValue<ProjectSnapshot>('projects', root);
  return stored ? { snapshot: stored } : undefined;
}
async function readBlob(path: string): Promise<Blob> {
  const blob = await readValue<Blob>('artifacts', path);
  if (!(blob instanceof Blob)) throw new Error(`이미지 원본이 저장소에 없습니다: ${path.split('/').at(-1) ?? 'artifact'}`);
  return blob;
}
async function persist(session: Session, blobs: StoredBlob[] = []): Promise<void> {
  session.snapshot.project.updatedAt = now();
  const stored = clone(session.snapshot);
  const connection = await db();
  await new Promise<void>((resolve, reject) => {
    const transaction = connection.transaction(['projects', 'artifacts', 'settings'], 'readwrite');
    transaction.objectStore('projects').put(stored, stored.root);
    if (active === session) transaction.objectStore('settings').put(stored.root, 'activeRoot');
    for (const entry of blobs) transaction.objectStore('artifacts').add(entry.blob, entry.path);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('로컬 저장에 실패했습니다. 디스크 공간을 확인하세요.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('로컬 저장에 실패했습니다.'));
  });
  for (const entry of blobs) registerUrl(entry.path, entry.blob);
}
function registerUrl(path: string, blob: Blob) {
  if (!objectUrls.has(path)) objectUrls.set(path, URL.createObjectURL(blob));
}
async function hydrate(session: Session) {
  const artifacts = session.snapshot.project.assets.flatMap(a => a.versions.flatMap(v => v.artifacts));
  await Promise.all(artifacts.map(async artifact => {
    if (objectUrls.has(artifact.path)) return;
    const blob = await readValue<Blob>('artifacts', artifact.path);
    if (blob instanceof Blob) registerUrl(artifact.path, blob);
  }));
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function artifact(session: Session, assetId: string, versionId: string, blob: Blob, format: string, role: Artifact['role'], basename: string): Promise<{ artifact: Artifact; stored: StoredBlob }> {
  const path = `${session.snapshot.root}/${assetId}/${versionId}/${safeName(basename)}.${format}`;
  return { artifact: { id: id('artifact'), path, format, sha256: await sha256(blob), bytes: blob.size, role }, stored: { path, blob } };
}
function version(number: number, prompt: string, source: AssetVersion['source'], settings: Record<string, unknown> = {}): AssetVersion {
  return { id: id('version'), number, createdAt: now(), prompt, source, requestedModel: null, confirmedModel: null,
    providerVersion: null, artifacts: [], settings, validation: null };
}
async function newImageAsset(session: Session, name: string, blob: Blob, kind: Asset['kind'], source: AssetVersion['source'], settings: Record<string, unknown>, tags: string[] = [], original?: {blob: Blob; format: string; name: string}): Promise<{ asset: Asset; blobs: StoredBlob[] }> {
  const bitmap = await decode(blob);
  const width = bitmap.width, height = bitmap.height; bitmap.close();
  const assetId = id('asset');
  const v = version(1, source === 'fixture' ? '번들 로컬 PNG 예제' : '로컬 파일 / 절차적 처리', source, settings);
  const output = await artifact(session, assetId, v.id, blob, 'png', 'output', `${safeName(name)}_v1`);
  v.artifacts.push(output.artifact);
  const blobs = [output.stored];
  if (original) {
    const raw = await artifact(session, assetId, v.id, original.blob, original.format, 'source', `original_${original.name}`);
    v.artifacts.unshift(raw.artifact); blobs.push(raw.stored);
  } else {
    // The example itself is an original; retain its exact bytes separately from future versions.
    const raw = await artifact(session, assetId, v.id, blob, 'png', 'source', `original_${name}`);
    v.artifacts.unshift(raw.artifact); blobs.push(raw.stored);
  }
  v.validation = imageValidation(v.artifacts.at(-1)!, width, height, source === 'fixture');
  return { asset: { id: assetId, name: safeName(name), kind, folder: source === 'fixture' ? 'Examples' : 'Images', tags,
    activeVersionId: v.id, versions: [v], width, height, mesh: null }, blobs };
}
function imageValidation(a: Artifact, width: number, height: number, fixture = false): ValidationReport {
  return { id: id('validation'), artifactId: a.id, createdAt: now(), valid: true, checks: [
    {code:'image.dimensions',status:'pass',message:`PNG ${width} × ${height}px`,measured:`${width}x${height}`},
    {code:'artifact.sha256',status:'pass',message:'출력 바이트에서 SHA-256 계산',measured:a.sha256},
    ...(fixture ? [{code:'source.local',status:'pass' as const,message:'직접 작성한 결정적 로컬 예제 · AI 생성 아님'}] : []),
  ] };
}
async function addFixtures(session: Session, count: number) {
  const examples = await exampleManifest;
  const blobs: StoredBlob[] = [];
  const additions: Asset[] = [];
  for (let index = 0; index < count; index++) {
    const example = examples[index % examples.length];
    const response = await fetch(`${import.meta.env.BASE_URL}${example.path.replace(/^\//,'')}`);
    if(!response.ok) throw new Error(`번들 예제 ${example.name}를 읽지 못했습니다.`);
    const original = await response.blob();
    if(await sniffRaster(original)!=='png') throw new Error('번들 예제가 PNG 형식이 아닙니다.');
    const created = await newImageAsset(session, example.name + (index >= examples.length ? ` ${Math.floor(index / examples.length) + 1}` : ''), original, 'image', 'fixture',
      { localExample: true, generator: 'bundled-procedural-png', exampleIndex: index % examples.length }, ['example', 'fantasy']);
    additions.push(created.asset); blobs.push(...created.blobs);
  }
  session.snapshot.project.assets.push(...additions);
  await persist(session, blobs); emit();
}

async function importFilesInto(session: Session, files: File[]) {
  const additions: Asset[] = [], blobs: StoredBlob[] = [];
  for (const file of files) {
    if (!file.size || file.size > MAX_IMPORT_BYTES) throw new Error(`${file.name}: 비어 있거나 128 MiB 제한을 넘는 파일입니다.`);
    const imageFormat = await sniffRaster(file);
    if (imageFormat) {
      const bitmap = await decode(file);
      checkDimensions(bitmap.width, bitmap.height);
      const canvas = makeCanvas(bitmap.width, bitmap.height);
      context(canvas).drawImage(bitmap, 0, 0); bitmap.close();
      const converted = await png(canvas);
      const created = await newImageAsset(session, file.name.replace(/\.[^.]+$/, ''), converted, 'image', 'import',
        { originalName: file.name, originalFormat: imageFormat }, [], {blob: file, format: imageFormat, name: file.name.replace(/\.[^.]+$/, '')});
      additions.push(created.asset); blobs.push(...created.blobs);
    } else if (/\.glb$/i.test(file.name)) {
      const created = await importGlb(session, file);
      additions.push(created.asset); blobs.push(...created.blobs);
    } else throw new Error(`${file.name}: PNG, JPEG, WebP, GLB만 직접 가져올 수 있습니다. SVG·코드는 실행하지 않습니다.`);
  }
  session.snapshot.project.assets.push(...additions);
  await persist(session, blobs); emit();
}
async function sniffRaster(blob: Blob): Promise<string | null> {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if ([137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b)) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP') return 'webp';
  return null;
}
async function decode(blob: Blob): Promise<ImageBitmap> {
  try { return await createImageBitmap(blob); }
  catch { throw new Error('이미지를 디코딩하지 못했습니다. 올바른 PNG, JPEG, WebP인지 확인하세요.'); }
}
function makeCanvas(width: number, height: number): HTMLCanvasElement {
  checkDimensions(width, height);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
}
function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D를 사용할 수 없습니다.');
  return ctx;
}
function png(canvas: HTMLCanvasElement): Promise<Blob> { return canvasBlob(canvas, 'image/png'); }
function canvasBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob || blob.type !== mime) reject(new Error(`${mime} 이미지 인코딩을 지원하지 않는 브라우저입니다.`));
    else resolve(blob);
  }, mime, quality));
}

function enqueue(session: Session, kind: string, label: string, payload: Record<string, unknown>, assetId: string | null): Job {
  const sourceIds = assetId ? [assetId] : kind === 'atlas' ? strings(payload.assetIds) : [];
  const dependencies = sourceIds.flatMap(sourceId => {
    const predecessor = [...session.snapshot.project.jobs].reverse().find(j => j.assetId === sourceId && ['ready','pending','running','retry_wait'].includes(j.status));
    return predecessor ? [predecessor.id] : [];
  });
  const job: Job = { id: id('job'), projectId: session.snapshot.project.id, assetId, kind, label, status: 'ready',
    dependencies: [...new Set(dependencies)], resource: 'cpu', attempts: 0, createdAt: now(), startedAt: null, finishedAt: null,
    error: null, progress: {stage: 'CPU 작업 슬롯 대기', completed: null, total: null}, payload: clone(payload), cacheKey: null };
  session.snapshot.project.jobs.push(job);
  return job;
}
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (running < CPU_CONCURRENCY) {
      let found: {session: Session; job: Job} | undefined;
      for (const session of sessions.values()) {
        let changed = false;
        for (const job of session.snapshot.project.jobs) {
          if (['ready','pending'].includes(job.status) && job.dependencies.some(d => ['failed','cancelled'].includes(session.snapshot.project.jobs.find(dep => dep.id === d)?.status ?? 'failed'))) {
            job.status = 'failed'; job.finishedAt = now(); job.error = '선행 작업이 실패하거나 취소되었습니다. 선행 작업을 완료한 뒤 다시 실행하세요.';
            job.progress.stage = '선행 작업 확인 필요'; changed = true;
          }
        }
        if (changed) { await persist(session); emit(); }
        const job = session.snapshot.project.jobs.find(j => ['ready', 'pending'].includes(j.status) && j.dependencies.every(d => session.snapshot.project.jobs.find(dep => dep.id === d)?.status === 'succeeded'));
        if (job) { found = {session, job}; break; }
      }
      if (!found) break;
      const {session, job} = found;
      job.status = 'running'; job.attempts++; job.startedAt = now(); job.finishedAt = null; job.error = null;
      job.progress = {stage: '입력 확인', completed: null, total: null};
      const controller = new AbortController(); controllers.set(job.id, controller); running++;
      try { await persist(session); } catch (error) {
        job.status = 'failed'; job.error = message(error); controllers.delete(job.id); running--; emit(); continue;
      }
      emit();
      void execute({session, job, signal: controller.signal, stage: async (name, completed = null, total = null) => {
        aborted(controller.signal);
        job.progress = { stage: name, completed, total };
        await persist(session); emit();
      }}).finally(() => { controllers.delete(job.id); running--; void pump(); });
    }
  } finally { pumping = false; }
}
async function execute(ctx: JobContext): Promise<void> {
  try {
    if (ctx.job.kind === 'process') await processImage(ctx);
    else if (ctx.job.kind === 'split') await splitImage(ctx);
    else if (ctx.job.kind === 'atlas') await createAtlas(ctx);
    else if (ctx.job.kind === 'model') await createModel(ctx);
    else throw new Error('저장된 작업 유형을 실행할 수 없습니다.');
    aborted(ctx.signal);
    ctx.job.status = 'succeeded'; ctx.job.finishedAt = now();
    ctx.job.progress = { stage: '출력 저장 및 검증 완료', completed: 1, total: 1 };
  } catch (error) {
    ctx.job.status = ctx.signal.aborted ? 'cancelled' : 'failed';
    ctx.job.finishedAt = now(); ctx.job.error = ctx.signal.aborted ? null : message(error);
    ctx.job.progress.stage = ctx.signal.aborted ? '사용자가 취소함' : '작업 실패';
  }
  try { await persist(ctx.session); } catch (error) { ctx.job.status = 'failed'; ctx.job.error = message(error); }
  emit();
}
function aborted(signal: AbortSignal) { if (signal.aborted) throw new DOMException('작업 취소', 'AbortError'); }
async function yieldTask(signal: AbortSignal) { await new Promise<void>(resolve => setTimeout(resolve, 0)); aborted(signal); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function processImage(ctx: JobContext) {
  const asset = requireAsset(ctx.session, string(ctx.job.payload.assetId, '에셋'));
  const previous = activeVersion(asset);
  const operation = validateOperation(ctx.job.payload.operation);
  await ctx.stage('원본 이미지 디코딩');
  const bitmap = await decode(await readBlob(imageArtifact(asset).path));
  let canvas: HTMLCanvasElement;
  try {
    canvas = makeCanvas(bitmap.width, bitmap.height);
    context(canvas).drawImage(bitmap, 0, 0);
    await ctx.stage(operationName(operation.type));
    await yieldTask(ctx.signal);
    if (operation.type === 'resize') {
      const resized = makeCanvas(operation.width, operation.height);
      const draw = context(resized); draw.imageSmoothingEnabled = !operation.pixelArt;
      draw.imageSmoothingQuality = 'high'; draw.drawImage(canvas, 0, 0, resized.width, resized.height);
      canvas = resized;
    } else if (operation.type === 'crop') {
      if (operation.x + operation.width > canvas.width || operation.y + operation.height > canvas.height) throw new Error('자르기 영역이 이미지 범위를 벗어났습니다.');
      const cropped = makeCanvas(operation.width, operation.height);
      context(cropped).drawImage(canvas, operation.x, operation.y, operation.width, operation.height, 0, 0, operation.width, operation.height);
      canvas = cropped;
    } else if (operation.type === 'trim') canvas = await trimCanvas(canvas, operation.padding, ctx);
    else if (operation.type === 'color') {
      const adjusted = makeCanvas(canvas.width, canvas.height);
      const draw = context(adjusted);
      draw.filter = `hue-rotate(${operation.hue}deg) saturate(${operation.saturation * 100}%)`;
      draw.drawImage(canvas, 0, 0); draw.filter = 'none'; canvas = adjusted;
    } else if (operation.type === 'background') await removeBackground(canvas, operation, ctx);
    else if (operation.type === 'mask') await applyMask(canvas, asset, operation, ctx);
  } finally { bitmap.close(); }
  aborted(ctx.signal);
  await ctx.stage('PNG 인코딩 및 SHA-256 계산');
  const outputBlob = await png(canvas);
  const next = version(Math.max(...asset.versions.map(v => v.number)) + 1, operationName(operation.type), 'procedural',
    { operation, sourceVersionId: previous.id, localProcessor: 'browser-canvas' });
  const output = await artifact(ctx.session, asset.id, next.id, outputBlob, 'png', 'output', `${asset.name}_v${next.number}`);
  next.artifacts.push(output.artifact);
  next.validation = imageValidation(output.artifact, canvas.width, canvas.height);
  aborted(ctx.signal);
  asset.versions.push(next); asset.activeVersionId = next.id; asset.width = canvas.width; asset.height = canvas.height;
  await persist(ctx.session, [output.stored]); emit();
}
async function trimCanvas(canvas: HTMLCanvasElement, padding: number, ctx: JobContext): Promise<HTMLCanvasElement> {
  const pixels = context(canvas).getImageData(0, 0, canvas.width, canvas.height);
  let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (pixels.data[(y * canvas.width + x) * 4 + 3]) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = y; }
    }
    if (y % 128 === 0) { await ctx.stage('알파 경계 탐색', y, canvas.height); await yieldTask(ctx.signal); }
  }
  if (right < 0) throw new Error('이미지가 완전히 투명합니다. 트림할 경계가 없습니다.');
  const result = makeCanvas(right - left + 1 + padding * 2, bottom - top + 1 + padding * 2);
  context(result).drawImage(canvas, left, top, right-left+1, bottom-top+1, padding, padding, right-left+1, bottom-top+1);
  return result;
}
async function removeBackground(canvas: HTMLCanvasElement, operation: Extract<ImageOperation, {type:'background'}>, ctx: JobContext) {
  const color = rgb(operation.color);
  const draw = context(canvas), pixels = draw.getImageData(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const index = (y * canvas.width + x) * 4;
      const distance = Math.sqrt(((pixels.data[index]-color[0])**2 + (pixels.data[index+1]-color[1])**2 + (pixels.data[index+2]-color[2])**2) / 3);
      if (distance <= operation.tolerance) pixels.data[index+3] = 0;
    }
    if (y % 128 === 0) { await ctx.stage('배경 색상 비교', y, canvas.height); await yieldTask(ctx.signal); }
  }
  draw.putImageData(pixels, 0, 0);
}
async function applyMask(canvas: HTMLCanvasElement, asset: Asset, operation: Extract<ImageOperation, {type:'mask'}>, ctx: JobContext) {
  const draw = context(canvas);
  draw.save();
  try {
    const mask = new Path2D();
    for (const [x,y] of operation.points) { mask.moveTo(x+operation.radius,y); mask.arc(x,y,operation.radius,0,Math.PI*2); }
    if (operation.mode === 'erase') {
      draw.globalCompositeOperation = 'destination-out'; draw.fillStyle = '#000'; draw.fill(mask);
      if (operation.points.length > 1) {
        draw.beginPath(); draw.moveTo(...operation.points[0]);
        for(const point of operation.points.slice(1)) draw.lineTo(...point);
        draw.lineWidth = operation.radius * 2; draw.lineCap = 'round'; draw.lineJoin = 'round'; draw.strokeStyle = '#000'; draw.stroke();
      }
    } else {
      // Restore the processed image from before the mask chain, including prior crop/color work.
      let baseline = activeVersion(asset);
      const visited = new Set<string>();
      while ((baseline.settings.operation as ImageOperation | undefined)?.type === 'mask' && !visited.has(baseline.id)) {
        visited.add(baseline.id);
        const previous = asset.versions.find(v => v.id === baseline.settings.sourceVersionId);
        if (!previous) break;
        baseline = previous;
      }
      const original = await decode(await readBlob(imageArtifact(asset, baseline).path));
      try { aborted(ctx.signal); draw.clip(mask); draw.clearRect(0,0,canvas.width,canvas.height); draw.drawImage(original,0,0,canvas.width,canvas.height); }
      finally { original.close(); }
    }
  } finally { draw.restore(); }
}

async function splitImage(ctx: JobContext) {
  const source = requireAsset(ctx.session, string(ctx.job.payload.assetId, '에셋'));
  const frameWidth = integer(ctx.job.payload.frameWidth, 1, MAX_DIMENSION, '프레임 너비');
  const frameHeight = integer(ctx.job.payload.frameHeight, 1, MAX_DIMENSION, '프레임 높이');
  const {frameRate, pivot} = spritePlayback(ctx.job.payload.frameRate, ctx.job.payload.pivot ?? [.5,.5]);
  await ctx.stage('스프라이트 시트 디코딩');
  const bitmap = await decode(await readBlob(imageArtifact(source).path));
  const additions: Asset[] = [], blobs: StoredBlob[] = [];
  try {
    if (bitmap.width % frameWidth || bitmap.height % frameHeight) throw new Error('시트 크기가 프레임 크기의 배수가 아닙니다. 원본을 자르거나 프레임 크기를 조정하세요.');
    const columns = bitmap.width / frameWidth, rows = bitmap.height / frameHeight, count = columns * rows;
    if (count > 256) throw new Error('한 번에 최대 256개의 스프라이트 프레임을 분할할 수 있습니다.');
    for (let i = 0; i < count; i++) {
      await ctx.stage('프레임 PNG 분할', i, count);
      const canvas = makeCanvas(frameWidth, frameHeight);
      context(canvas).drawImage(bitmap, (i % columns)*frameWidth, Math.floor(i/columns)*frameHeight, frameWidth, frameHeight,0,0,frameWidth,frameHeight);
      const frame = {x:(i%columns)*frameWidth,y:Math.floor(i/columns)*frameHeight,w:frameWidth,h:frameHeight};
      const result = await newImageAsset(ctx.session, `${source.name}_${String(i+1).padStart(3,'0')}`, await png(canvas), 'sprite', 'procedural',
        { sourceAssetId: source.id, sourceVersionId: source.activeVersionId, frame, frameIndex:i, frameCount:count, pivot, frameRate }, ['sprite','frame']);
      const metadata = new Blob([JSON.stringify({frame,frameIndex:i,frameCount:count,frameRate,pivot:{x:pivot[0],y:pivot[1]},sourceAssetId:source.id,sourceVersionId:source.activeVersionId,sourceSize:{w:bitmap.width,h:bitmap.height},meta:{app:'Asset Studio browser local',version:1,image:result.asset.versions[0].artifacts.find(a=>a.role==='output')!.path.split('/').at(-1)}},null,2)],{type:'application/json'});
      const meta = await artifact(ctx.session,result.asset.id,result.asset.activeVersionId,metadata,'json','metadata','frame');
      result.asset.versions[0].artifacts.push(meta.artifact);result.blobs.push(meta.stored);
      result.asset.folder = 'Sprites'; additions.push(result.asset); blobs.push(...result.blobs);
      await yieldTask(ctx.signal);
    }
  } finally { bitmap.close(); }
  aborted(ctx.signal);
  ctx.session.snapshot.project.assets.push(...additions);
  await persist(ctx.session,blobs); emit();
}

async function createAtlas(ctx: JobContext) {
  const assetIds = strings(ctx.job.payload.assetIds);
  const options = ctx.job.payload.options as AtlasOptions;
  checkDimensions(options.width,options.height);
  const padding = integer(options.padding,0,128,'패딩');
  const {frameRate, pivot} = spritePlayback(ctx.job.payload.frameRate, ctx.job.payload.pivot ?? [.5,.5]);
  const inputs: {asset: Asset; bitmap: ImageBitmap}[] = [];
  const frames: Record<string, unknown> = {};
  const canvas = makeCanvas(options.width,options.height), draw = context(canvas);
  let x = padding, y = padding, rowHeight = 0;
  try {
    for(let i=0;i<assetIds.length;i++) {
      await ctx.stage('아틀라스 입력 디코딩',i,assetIds.length);
      const asset = requireAsset(ctx.session,assetIds[i]);
      const bitmap = await decode(await readBlob(imageArtifact(asset).path));
      inputs.push({asset,bitmap});
    }
    // Deterministic height-first shelf packing never silently scales an original.
    inputs.sort((a,b) => b.bitmap.height-a.bitmap.height || b.bitmap.width-a.bitmap.width || a.asset.id.localeCompare(b.asset.id));
    for(let i=0;i<inputs.length;i++) {
      const {asset,bitmap} = inputs[i];
      await ctx.stage('선반 방식 아틀라스 패킹',i,inputs.length);
      if(bitmap.width+padding*2>canvas.width || bitmap.height+padding*2>canvas.height) throw new Error(`${asset.name}: 아틀라스보다 큰 이미지입니다.`);
      if(x+bitmap.width+padding>canvas.width) { x=padding; y+=rowHeight+padding; rowHeight=0; }
      if(y+bitmap.height+padding>canvas.height) throw new Error('선택한 이미지가 아틀라스에 모두 들어가지 않습니다. 크기를 늘리거나 이미지를 줄이세요.');
      draw.drawImage(bitmap,x,y);
      const name = `${safeName(asset.name)}_${asset.id.slice(-8)}.png`;
      frames[name] = { frame:{x,y,w:bitmap.width,h:bitmap.height},rotated:false,trimmed:false,
        spriteSourceSize:{x:0,y:0,w:bitmap.width,h:bitmap.height},sourceSize:{w:bitmap.width,h:bitmap.height},
        pivot: {x:pivot[0],y:pivot[1]}, frameRate, assetId:asset.id, versionId:asset.activeVersionId };
      x+=bitmap.width+padding; rowHeight=Math.max(rowHeight,bitmap.height); await yieldTask(ctx.signal);
    }
  } finally { for(const input of inputs) input.bitmap.close(); }
  await ctx.stage('아틀라스 PNG 및 JSON 저장');
  const created = await newImageAsset(ctx.session,`Atlas ${ctx.session.snapshot.project.assets.filter(a=>a.tags.includes('atlas')).length+1}`,await png(canvas),'sprite','procedural',{assetIds,options,frames,pivot,frameRate},['atlas','sprites']);
  created.asset.folder='Sprites';
  const metadata = new Blob([JSON.stringify({frames,meta:{app:'Asset Studio browser local',version:1,image:created.asset.versions[0].artifacts.find(a=>a.role==='output')!.path.split('/').at(-1),size:{w:canvas.width,h:canvas.height},scale:'1',padding,frameRate,pivot:{x:pivot[0],y:pivot[1]}}},null,2)],{type:'application/json'});
  const meta = await artifact(ctx.session,created.asset.id,created.asset.activeVersionId,metadata,'json','metadata','atlas');
  created.asset.versions[0].artifacts.push(meta.artifact); created.blobs.push(meta.stored);
  aborted(ctx.signal);ctx.session.snapshot.project.assets.push(created.asset);
  await persist(ctx.session,created.blobs); emit();
}

function string(value: unknown, label: string): string { if(typeof value!=='string'||!value.trim())throw new Error(`${label} 값이 필요합니다.`);return value; }
function strings(value: unknown): string[] { if(!Array.isArray(value)||value.some(v=>typeof v!=='string'))throw new Error('에셋 목록 형식이 잘못되었습니다.');return [...new Set(value)] as string[]; }
function number(value: unknown, min: number, max: number, label: string): number { if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`${label}: ${min}–${max} 범위의 숫자가 필요합니다.`);return value; }
function integer(value: unknown, min: number, max: number, label: string): number { const result=number(value,min,max,label);if(!Number.isInteger(result))throw new Error(`${label}는 정수여야 합니다.`);return result; }
function spritePlayback(frameRateValue:unknown,pivotValue:unknown):{frameRate:number;pivot:[number,number]} {
  if(!Array.isArray(pivotValue)||pivotValue.length!==2)throw new Error('피벗에는 X와 Y 두 좌표가 필요합니다.');
  return {frameRate:number(frameRateValue===undefined?12:frameRateValue,1,240,'재생 속도 fps'),pivot:[number(pivotValue[0],0,1,'피벗 X'),number(pivotValue[1],0,1,'피벗 Y')]};
}
function checkDimensions(width: unknown,height: unknown) { const w=integer(width,1,MAX_DIMENSION,'너비'),h=integer(height,1,MAX_DIMENSION,'높이');if(w*h>MAX_PIXELS)throw new Error('이미지가 브라우저 처리 한도인 32메가픽셀을 넘습니다.'); }
function rgb(value: string): [number,number,number] { if(!/^#[0-9a-f]{6}$/i.test(value))throw new Error('색상은 #RRGGBB 형식이어야 합니다.');return [parseInt(value.slice(1,3),16),parseInt(value.slice(3,5),16),parseInt(value.slice(5,7),16)]; }
function operationName(type: ImageOperation['type']): string { return {resize:'크기 조절',crop:'영역 자르기',trim:'투명 여백 정리',color:'색상 조정',background:'배경 색상 제거',mask:'마스크 편집'}[type]; }
function validateOperation(value: unknown): ImageOperation {
  if(!value||typeof value!=='object')throw new Error('이미지 작업 옵션이 필요합니다.');
  const op=value as ImageOperation;
  if(op.type==='resize') {checkDimensions(op.width,op.height);return {type:op.type,width:op.width,height:op.height,pixelArt:!!op.pixelArt};}
  if(op.type==='crop'){checkDimensions(op.width,op.height);return {type:op.type,x:integer(op.x,0,MAX_DIMENSION,'X'),y:integer(op.y,0,MAX_DIMENSION,'Y'),width:op.width,height:op.height};}
  if(op.type==='trim')return {type:op.type,padding:integer(op.padding,0,256,'트림 패딩')};
  if(op.type==='color')return {type:op.type,hue:number(op.hue,-360,360,'색조'),saturation:number(op.saturation,0,4,'채도 배수')};
  if(op.type==='background'){rgb(op.color);return {type:op.type,color:op.color,tolerance:number(op.tolerance,0,255,'색상 허용 오차')};}
  if(op.type==='mask') {
    if(!Array.isArray(op.points)||!op.points.length||op.points.length>10000)throw new Error('마스크 브러시 점이 필요합니다.');
    for(const point of op.points){if(!Array.isArray(point)||point.length!==2)throw new Error('마스크 좌표 형식이 잘못되었습니다.');number(point[0],0,MAX_DIMENSION,'마스크 X');number(point[1],0,MAX_DIMENSION,'마스크 Y');}
    if(op.mode!=='erase'&&op.mode!=='restore')throw new Error('마스크 모드가 잘못되었습니다.');
    return {type:op.type,points:clone(op.points),radius:number(op.radius,.5,2048,'브러시 크기'),mode:op.mode};
  }
  throw new Error('지원하지 않는 이미지 작업입니다.');
}

function validateModel(value: unknown): ModelParameters {
  if(!value||typeof value!=='object')throw new Error('모델 파라미터가 필요합니다.');
  const model=value as ModelParameters;
  if(!['crate','table','shelf'].includes(model.template))throw new Error('지원하는 템플릿은 상자, 테이블, 선반입니다.');
  rgb(model.color);
  return {template:model.template,name:safeName(string(model.name,'모델 이름')),width:number(model.width,.03,10000,'너비'),
    depth:number(model.depth,.03,10000,'깊이'),height:number(model.height,.03,10000,'높이'),color:model.color,bevel:number(model.bevel,0,100,'베벨')};
}

function modelGroup(model: ModelParameters): THREE.Group {
  // Shared ModelParameters are canonical metres; the UI converts its display unit before dispatch.
  const w=model.width,h=model.height,d=model.depth;
  const radius=model.bevel;
  const group=new THREE.Group();group.name=model.name;
  const wood=new THREE.MeshStandardMaterial({color:model.color,roughness:.68,metalness:.05});
  const trim=new THREE.MeshStandardMaterial({color:'#c7ad78',roughness:.48,metalness:.35});
  const box=(name:string,bw:number,bh:number,bd:number,x:number,y:number,z:number,material=wood) => {
    const r=Math.min(radius,Math.min(bw,bh,bd)*.24);
    const geometry=r>0?new RoundedBoxGeometry(bw,bh,bd,1,r):new THREE.BoxGeometry(bw,bh,bd);
    const mesh=new THREE.Mesh(geometry,material);mesh.name=name;mesh.position.set(x,y,z);group.add(mesh);
  };
  if(model.template==='table') {
    const top=Math.min(h*.09,w*.1,d*.13),leg=Math.min(w,d)*.09;
    box('tabletop',w,top,d,0,h-top/2,0);
    for(const x of [-1,1])for(const z of [-1,1])box(`leg_${x}_${z}`,leg,h-top,leg,x*(w/2-leg), (h-top)/2,z*(d/2-leg));
    box('front_apron',w-leg*2,top*1.4,leg,0,h-top*1.7,d/2-leg);
    box('back_apron',w-leg*2,top*1.4,leg,0,h-top*1.7,-d/2+leg);
  } else if(model.template==='shelf') {
    const t=Math.min(w*.055,h*.045,d*.14);
    box('left_side',t,h,d,-w/2+t/2,h/2,0);box('right_side',t,h,d,w/2-t/2,h/2,0);
    for(let i=0;i<4;i++)box(`shelf_${i}`,w-t*2,t,d,0,t/2+i*(h-t)/3,0);
    box('back_panel',w-t*2,h-t*2,t,0,h/2,-d/2+t/2);
  } else {
    const t=Math.min(w,h,d)*.075;
    box('crate_body',w-t*.5,h-t*.5,d-t*.5,0,h/2,0);
    for(const y of [t/2,h-t/2]) {
      box(`front_band_${y}`,w,t,t,0,y,d/2-t/2,trim);box(`back_band_${y}`,w,t,t,0,y,-d/2+t/2,trim);
      box(`left_band_${y}`,t,t,d,-w/2+t/2,y,0,trim);box(`right_band_${y}`,t,t,d,w/2-t/2,y,0,trim);
    }
    for(const x of [-w*.3,0,w*.3])box(`front_plank_${x}`,w*.28,h-t*2,t*.35,x,h/2,d/2-t*.2);
  }
  group.userData={generator:'Asset Studio browser mesh templates',template:model.template,unit:'m',parameters:model};
  return group;
}

function geometryStats(group: THREE.Object3D) {
  let vertices=0,triangles=0;
  group.updateMatrixWorld(true);
  group.traverse(object=>{
    if(object instanceof THREE.Mesh&&object.geometry instanceof THREE.BufferGeometry) {
      const positions=object.geometry.getAttribute('position');
      vertices+=positions?.count??0;triangles+=(object.geometry.index?.count??positions?.count??0)/3;
    }
  });
  const size=new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  if(!vertices||!triangles||![size.x,size.y,size.z].every(v=>Number.isFinite(v)&&v>=0))throw new Error('모델에 유효한 메시가 없습니다.');
  return {vertices,triangles:Math.round(triangles),dimensions:[size.x,size.y,size.z] as [number,number,number],unit:'m'};
}
function disposeGroup(group: THREE.Object3D) {
  const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();
  group.traverse(object=>{if(object instanceof THREE.Mesh){geometries.add(object.geometry);for(const material of Array.isArray(object.material)?object.material:[object.material])materials.add(material);}});
  for(const geometry of geometries)geometry.dispose();for(const material of materials)material.dispose();
}
async function renderModelThumbnail(group: THREE.Object3D): Promise<Blob | null> {
  let renderer: THREE.WebGLRenderer | undefined;
  try {
    renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});renderer.setSize(512,512);renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000,0);renderer.outputColorSpace=THREE.SRGBColorSpace;
    const box=new THREE.Box3().setFromObject(group),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
    const extent=Math.max(size.x,size.y,size.z)*.84||1;
    const camera=new THREE.OrthographicCamera(-extent,extent,extent,-extent,.01,extent*100);
    camera.position.copy(center).add(new THREE.Vector3(extent*3,extent*2.1,extent*3));camera.lookAt(center);
    const scene=new THREE.Scene();scene.add(group.clone(true));
    scene.add(new THREE.HemisphereLight(0xfff9e8,0x566b60,2.6));
    const key=new THREE.DirectionalLight(0xfff2d5,3.2);key.position.set(extent*2,extent*4,extent*3);scene.add(key);
    const rim=new THREE.DirectionalLight(0xcde4e4,1.2);rim.position.set(-extent*4,extent*2,-extent);scene.add(rim);
    renderer.render(scene,camera);
    return await png(renderer.domElement);
  } catch { return null; }
  finally { renderer?.dispose(); renderer?.forceContextLoss(); }
}
async function createModel(ctx: JobContext) {
  const model=validateModel(ctx.job.payload.model);
  await ctx.stage('템플릿 메시 구성');await yieldTask(ctx.signal);
  const group=modelGroup(model);
  try {
    const stats=geometryStats(group);
    const assetId=id('asset'),v=version(1,`${model.template} 로컬 절차적 메시`,'procedural',{parameters:model,generator:'three-mesh-template',blenderUsed:false,axis:'Y-up',unit:'m'});
    await ctx.stage('GLB 직렬화');
    const binary=await new GLTFExporter().parseAsync(group,{binary:true,onlyVisible:true});
    if(!(binary instanceof ArrayBuffer))throw new Error('GLB 바이너리 출력에 실패했습니다.');
    const output=await artifact(ctx.session,assetId,v.id,new Blob([binary],{type:'model/gltf-binary'}),'glb','output',`${model.name}_v1`);
    const source=await artifact(ctx.session,assetId,v.id,new Blob([JSON.stringify({app:'Asset Studio',generator:'three-mesh-template',parameters:model,inputUnit:'m',displayUnit:ctx.session.snapshot.project.spec.unit,outputUnit:'m',axis:'Y-up'},null,2)],{type:'application/json'}),'json','source','model_parameters');
    const blobs=[output.stored,source.stored];v.artifacts.push(source.artifact,output.artifact);
    await ctx.stage('메시 검사 및 썸네일 렌더링');
    const thumbnail=await renderModelThumbnail(group);
    if(thumbnail){const preview=await artifact(ctx.session,assetId,v.id,thumbnail,'png','thumbnail','preview');v.artifacts.push(preview.artifact);blobs.push(preview.stored);}
    v.validation=modelValidation(output.artifact,stats,ctx.session.snapshot.project.spec.polygonBudget);
    const asset:Asset={id:assetId,name:model.name,kind:'model',folder:'Models',tags:['procedural',model.template],activeVersionId:v.id,versions:[v],width:null,height:null,mesh:stats};
    aborted(ctx.signal);ctx.job.assetId=assetId;ctx.session.snapshot.project.assets.push(asset);
    await persist(ctx.session,blobs);emit();
  } finally {disposeGroup(group);}
}
function modelValidation(a: Artifact,mesh:NonNullable<Asset['mesh']>,budget:number):ValidationReport {
  return {id:id('validation'),artifactId:a.id,createdAt:now(),valid:true,checks:[
    {code:'mesh.geometry',status:'pass',message:`${mesh.vertices} 정점 · ${mesh.triangles} 삼각형`,measured:mesh.triangles},
    {code:'mesh.budget',status:mesh.triangles<=budget?'pass':'warn',message:`폴리곤 예산 ${budget} 삼각형`,measured:mesh.triangles},
    {code:'mesh.units',status:'pass',message:'GLB 좌표 Y-up · 미터 단위'},
    {code:'artifact.sha256',status:'pass',message:'실제 GLB 바이트에서 SHA-256 계산',measured:a.sha256},
  ]};
}
async function parseLocalGlb(blob:Blob):Promise<THREE.Group> {
  const bytes=await blob.arrayBuffer(),view=new DataView(bytes);
  if(bytes.byteLength<20||view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==bytes.byteLength)throw new Error('유효한 glTF 2.0 GLB 파일이 아닙니다.');
  const jsonSize=view.getUint32(12,true);
  if(view.getUint32(16,true)!==0x4e4f534a||jsonSize>bytes.byteLength-20)throw new Error('GLB JSON 청크가 손상되었습니다.');
  const json=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,20,jsonSize))) as {buffers?:{uri?:string}[];images?:{uri?:string;mimeType?:string}[]};
  if(json.buffers?.some(b=>b.uri&&!/^data:application\/(octet-stream|gltf-buffer);base64,/i.test(b.uri))||json.images?.some(image=>(image.uri&&!/^data:image\/(png|jpeg|webp);base64,/i.test(image.uri))||(image.mimeType&&!['image/png','image/jpeg','image/webp'].includes(image.mimeType))))throw new Error('브라우저에서는 외부 파일·URL을 참조하지 않는 자체 포함 GLB만 가져올 수 있습니다.');
  const gltf=await new GLTFLoader().parseAsync(bytes,'');
  return gltf.scene;
}
async function importGlb(session:Session,file:File):Promise<{asset:Asset;blobs:StoredBlob[]}> {
  const group=await parseLocalGlb(file);
  try {
    const mesh=geometryStats(group),assetId=id('asset'),name=safeName(file.name.replace(/\.glb$/i,''));
    const v=version(1,'로컬 GLB 원본 가져오기','import',{originalName:file.name,axis:'Y-up',unit:'m'});
    const original=await artifact(session,assetId,v.id,file,'glb','source',`original_${name}`);v.artifacts.push(original.artifact);
    const blobs=[original.stored],thumbnail=await renderModelThumbnail(group);
    if(thumbnail){const preview=await artifact(session,assetId,v.id,thumbnail,'png','thumbnail','preview');v.artifacts.push(preview.artifact);blobs.push(preview.stored);}
    v.validation=modelValidation(original.artifact,mesh,session.snapshot.project.spec.polygonBudget);
    return {asset:{id:assetId,name,kind:'model',folder:'Models',tags:['imported'],activeVersionId:v.id,versions:[v],width:null,height:null,mesh},blobs};
  }finally{disposeGroup(group);}
}

async function exportProject(session:Session,request:Record<string,unknown>):Promise<{path:string}> {
  const assetIds=Array.isArray(request.assetIds)?strings(request.assetIds):session.snapshot.project.assets.map(a=>a.id);
  if(!assetIds.length)throw new Error('내보낼 에셋을 선택하세요.');
  const assets=assetIds.map(assetId=>requireAsset(session,assetId));
  const preset=EXPORT_PRESETS.find(p=>p.id===request.preset)??EXPORT_PRESETS.find(p=>p.domain===session.snapshot.project.spec.domain)??EXPORT_PRESETS[0];
  const chosen=typeof request.format==='string'?request.format.toLowerCase():preset.formats.find(isRasterFormat)??'png';
  const format=chosen==='jpg'?'jpeg':chosen;
  if(!['png','jpeg','webp','glb','json'].includes(format))throw new Error('지원하는 내보내기 형식은 PNG, JPEG, WebP, GLB, JSON입니다.');
  const zip=new JSZip(),bundledArtifacts:PackedManifest['bundledArtifacts']=[];
  const exportedAssets=clone(assets);
  let totalBytes=0;
  for(const asset of assets) {
    const current=activeVersion(asset),base=`assets/${safeName(asset.name)}_${asset.id.slice(-8)}`;
    const imageExportFormat = isRasterFormat(format) ? format : 'png';
    const exportImageName = `${safeName(asset.name)}.${imageExportFormat==='jpeg'?'jpg':imageExportFormat}`;
    // Every selected original and historical output is bundled, never replaced by conversion.
    for(const v of asset.versions)for(const a of v.artifacts) {
      const blob=await readBlob(a.path);
      const zipPath=`${base}/versions/v${v.number}/${a.role}_${a.id.slice(-8)}.${a.format}`;
      zip.file(zipPath,await blob.arrayBuffer());bundledArtifacts.push({artifactPath:a.path,zipPath});totalBytes+=blob.size;
    }
    if(asset.kind==='model') {
      const glb=current.artifacts.find(a=>a.format==='glb');
      if(glb)zip.file(`${base}/${safeName(asset.name)}.glb`,await (await readBlob(glb.path)).arrayBuffer());
      else throw new Error(`${asset.name}: 브라우저에서 내보낼 GLB가 없습니다.`);
    } else {
      const bitmap=await decode(await readBlob(imageArtifact(asset).path));
      try {
        const canvas=makeCanvas(bitmap.width,bitmap.height),draw=context(canvas);
        if(imageExportFormat==='jpeg'){draw.fillStyle='#f5f3eb';draw.fillRect(0,0,canvas.width,canvas.height);}
        draw.drawImage(bitmap,0,0);
        const blob=await canvasBlob(canvas,`image/${imageExportFormat}`,imageExportFormat==='png'?undefined:.92);
        zip.file(`${base}/${exportImageName}`,await blob.arrayBuffer());
      }finally{bitmap.close();}
    }
    const metadata=current.artifacts.filter(a=>a.role==='metadata');
    for(const a of metadata) {
      const metadataBlob = await readBlob(a.path);
      if ((asset.tags.includes('atlas') || asset.tags.includes('frame')) && a.format === 'json') {
        const exportedMeta = JSON.parse(await metadataBlob.text()) as {meta?:{image?:string}};
        if (exportedMeta.meta) exportedMeta.meta.image = exportImageName;
        zip.file(`${base}/${safeName(asset.name)}.json`,JSON.stringify(exportedMeta,null,2));
      } else zip.file(`${base}/${safeName(asset.name)}_${a.id.slice(-8)}.${a.format}`,await metadataBlob.arrayBuffer());
    }
    if(totalBytes>512*1024*1024)throw new Error('선택한 프로젝트의 원본과 버전이 512 MiB를 넘습니다. 에셋을 나누어 내보내세요.');
  }
  const manifest:PackedManifest={app:'asset-studio',version:1,snapshot:{...clone(session.snapshot),project:{...clone(session.snapshot.project),assets:exportedAssets,jobs:[]}},bundledArtifacts};
  zip.file('asset-studio.json',JSON.stringify(manifest,null,2));
  zip.file('export-info.json',JSON.stringify({project:session.snapshot.project.name,exportedAt:now(),preset:preset.id,format,requestedAxis:session.snapshot.project.spec.axis,requestedUnit:session.snapshot.project.spec.unit,
    browser:true,originalsPreserved:true,jpegMatte:format==='jpeg'?'#f5f3eb':null,modelCoordinateSystem:'GLB Y-up / m',assetIds},null,2));
  const filename=`${safeName(session.snapshot.project.name)}.zip`;
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
  download(blob,filename);
  return {path:`다운로드 / ${filename}`};
}
function download(blob:Blob,name:string) {
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.style.display='none';
  document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function importArchive(file:File) {
  if(file.size>MAX_IMPORT_BYTES)throw new Error('프로젝트 ZIP은 최대 128 MiB까지 가져올 수 있습니다.');
  const zip=await JSZip.loadAsync(await file.arrayBuffer(),{checkCRC32:true});
  const manifestFile=zip.file('asset-studio.json');
  if(!manifestFile)throw new Error('ZIP에 asset-studio.json 프로젝트 매니페스트가 없습니다.');
  const manifest=validateManifest(JSON.parse(await manifestFile.async('string')));
  let expandedBytes=0;
  await restoreProject(manifest,async path=>{
    if(!path||path.includes('..')||path.startsWith('/')||path.includes('\\'))throw new Error('ZIP에 안전하지 않은 경로가 있습니다.');
    const entry=zip.file(path);if(!entry)throw new Error(`프로젝트 아티팩트가 없습니다: ${safeName(path)}`);
    const bytes=await entry.async('uint8array');expandedBytes+=bytes.byteLength;
    if(bytes.byteLength>MAX_IMPORT_BYTES||expandedBytes>512*1024*1024)throw new Error('압축 해제한 프로젝트가 브라우저 메모리 한도를 넘습니다.');
    return new Blob([bytes as Uint8Array<ArrayBuffer>]);
  });
}
async function importEmbeddedManifest(file:File) {
  if(file.size>MAX_IMPORT_BYTES)throw new Error('프로젝트 JSON 파일이 너무 큽니다.');
  const input=JSON.parse(await file.text()) as PackedManifest & {embeddedArtifacts?:Record<string,string>};
  const manifest=validateManifest(input);
  if(!input.embeddedArtifacts)throw new Error('이 매니페스트에는 이미지 바이트가 없습니다. 원본과 버전이 포함된 프로젝트 ZIP을 가져오세요.');
  await restoreProject(manifest,async path=>{
    const data=input.embeddedArtifacts?.[path];
    if(typeof data!=='string'||!/^data:[a-z0-9.+/-]*;base64,/i.test(data))throw new Error('내장 아티팩트 형식이 잘못되었습니다.');
    const bytes=Uint8Array.from(atob(data.slice(data.indexOf(',')+1)),char=>char.charCodeAt(0));
    return new Blob([bytes]);
  });
}
function validateManifest(input:unknown):PackedManifest {
  const manifest=input as PackedManifest;
  if(!manifest||manifest.app!=='asset-studio'||manifest.version!==1||!manifest.snapshot?.project||manifest.snapshot.project.schemaVersion!==SCHEMA_VERSION||!Array.isArray(manifest.snapshot.project.assets)||!Array.isArray(manifest.bundledArtifacts))throw new Error('지원하는 Asset Studio 프로젝트 매니페스트가 아닙니다.');
  if(manifest.snapshot.project.assets.length>2048||manifest.bundledArtifacts.length>10000)throw new Error('프로젝트의 에셋 또는 버전 수가 브라우저 한도를 넘습니다.');
  checkDimensions(manifest.snapshot.project.spec.width,manifest.snapshot.project.spec.height);
  const assetIds=new Set<string>(),paths=new Set<string>();
  for(const asset of manifest.snapshot.project.assets) {
    if(typeof asset.id!=='string'||assetIds.has(asset.id)||!['image','sprite','texture','model'].includes(asset.kind)||!Array.isArray(asset.versions)||!asset.versions.length||asset.versions.length>512)throw new Error('프로젝트 에셋 형식이 잘못되었습니다.');
    assetIds.add(asset.id);
    if(typeof asset.name!=='string'||!asset.versions.some(v=>v.id===asset.activeVersionId))throw new Error('프로젝트 활성 버전이 잘못되었습니다.');
    for(const v of asset.versions){
      if(!Array.isArray(v.artifacts))throw new Error('프로젝트 아티팩트 목록이 잘못되었습니다.');
      for(const a of v.artifacts){if(typeof a.path!=='string'||typeof a.format!=='string'||!['source','output','thumbnail','metadata'].includes(a.role)||!/^([a-f0-9]{64})$/i.test(a.sha256)||!Number.isSafeInteger(a.bytes)||a.bytes<0)throw new Error('아티팩트 검증 정보가 잘못되었습니다.');paths.add(a.path);}
    }
  }
  const mappings=new Set<string>();
  for(const entry of manifest.bundledArtifacts){if(typeof entry.artifactPath!=='string'||typeof entry.zipPath!=='string'||mappings.has(entry.artifactPath))throw new Error('프로젝트 파일 매핑이 잘못되었습니다.');mappings.add(entry.artifactPath);}
  if([...paths].some(path=>!mappings.has(path)))throw new Error('프로젝트에 누락된 원본 또는 버전이 있습니다.');
  return manifest;
}
async function restoreProject(manifest:PackedManifest,read:(path:string)=>Promise<Blob>) {
  const restored=newSession(`${manifest.snapshot.project.name} · imported`);
  restored.snapshot.project={...clone(manifest.snapshot.project),id:restored.snapshot.project.id,name:safeName(manifest.snapshot.project.name),createdAt:now(),updatedAt:now(),jobs:[]};
  const mapping=new Map(manifest.bundledArtifacts.map(entry=>[entry.artifactPath,entry.zipPath]));
  const blobs:StoredBlob[]=[];
  for(const asset of restored.snapshot.project.assets) {
    asset.name=safeName(asset.name);asset.tags=Array.isArray(asset.tags)?asset.tags.filter(tag=>typeof tag==='string'):[];
    for(const v of asset.versions)for(const a of v.artifacts) {
      const blob=await read(mapping.get(a.path)!);
      if(blob.size!==a.bytes||await sha256(blob)!==a.sha256.toLowerCase())throw new Error(`${asset.name}: 원본 바이트 크기 또는 SHA-256 검증에 실패했습니다.`);
      if(isRasterFormat(a.format)&&await sniffRaster(blob)===null)throw new Error(`${asset.name}: 이미지 아티팩트 형식이 잘못되었습니다.`);
      if(a.format==='glb'){const parsed=await parseLocalGlb(blob);try{geometryStats(parsed);}finally{disposeGroup(parsed);}}
      const mime=isRasterFormat(a.format)?`image/${a.format==='jpg'?'jpeg':a.format}`:a.format==='glb'?'model/gltf-binary':a.format==='json'?'application/json':'application/octet-stream';
      a.path=`${restored.snapshot.root}/${asset.id}/${v.id}/${a.id}.${safeName(a.format)}`;
      blobs.push({path:a.path,blob:new Blob([blob],{type:mime})});
    }
  }
  sessions.set(restored.snapshot.root,restored);active=restored;
  await persist(restored,blobs);emit();
}
