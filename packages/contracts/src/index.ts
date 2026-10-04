export const SCHEMA_VERSION = 1;
export type Domain = 'game' | 'product' | 'architecture' | 'education' | 'design';
export type JobStatus = 'pending' | 'ready' | 'running' | 'retry_wait' | 'waiting_user' | 'succeeded' | 'failed' | 'cancelled' | 'external_unknown';
export type AssetKind = 'image' | 'sprite' | 'texture' | 'model';
export interface AssetSpec {
  domain: Domain; width: number; height: number; unit: 'm' | 'cm' | 'mm';
  axis: 'Y-up' | 'Z-up'; pivot: [number, number]; polygonBudget: number;
  pixelArt: boolean; colorSpace: 'sRGB' | 'linear'; normalConvention: 'OpenGL' | 'DirectX';
  naming: string; target: string;
}
export interface StyleGuide {
  id: string; name: string; palette: string[]; lineWeight: number; camera: string;
  lighting: string; detail: string; margin: number; referenceAssetIds: string[];
  approved: boolean;
}
export interface ValidationCheck {code: string; status: 'pass' | 'warn' | 'fail'; message: string; measured?: number | string;}
export interface ValidationReport {id: string; artifactId: string; createdAt: string; checks: ValidationCheck[]; valid: boolean;}
export interface Artifact {id: string; path: string; format: string; sha256: string; bytes: number; role: 'source' | 'output' | 'thumbnail' | 'metadata';}
export interface AssetVersion {
  id: string; number: number; createdAt: string; prompt: string; source: 'import' | 'procedural' | 'codex_subscription' | 'fixture';
  requestedModel: string | null; confirmedModel: string | null; providerVersion: string | null;
  artifacts: Artifact[]; settings: Record<string, unknown>; validation: ValidationReport | null;
}
export interface Asset {
  id: string; name: string; kind: AssetKind; folder: string; tags: string[];
  activeVersionId: string; versions: AssetVersion[]; width: number | null; height: number | null;
  mesh: {vertices: number; triangles: number; dimensions: [number,number,number]; unit: string} | null;
}
export interface Job {
  id: string; projectId: string; assetId: string | null; kind: string; label: string;
  status: JobStatus; dependencies: string[]; resource: 'cpu' | 'blender' | 'external';
  attempts: number; createdAt: string; startedAt: string | null; finishedAt: string | null;
  error: string | null; progress: {stage: string; completed: number | null; total: number | null};
  payload: Record<string, unknown>; cacheKey: string | null;
}
export interface ProviderCapability {
  id: string; name: string; status: 'verified' | 'unverified' | 'blocked'; authentication: string;
  requestedModels: string[]; confirmedModel: string | null; generation: boolean; editing: boolean;
  transparency: boolean; masks: boolean; referenceImageLimit: number | null;
  cancellation: 'remote' | 'local_only' | 'unknown'; concurrency: number | null;
  resolutions: string[]; reason: string; checkedAt: string;
}
export interface ExportPreset {id: string; name: string; domain: Domain; formats: string[]; axis: string; unit: string; target: string;}
export interface Project {
  id: string; name: string; schemaVersion: number; createdAt: string; updatedAt: string;
  spec: AssetSpec; styleGuide: StyleGuide; assets: Asset[]; jobs: Job[];
}
export interface ProjectSnapshot {root: string; project: Project; providers: ProviderCapability[];}
export interface EnvironmentInfo {blenderPath: string | null; blenderVersion: string | null; platform: string; native: boolean;}
export interface ProviderConnection {
  available: boolean; authenticated: boolean; ready: boolean; runtimeVersion: string | null;
  /** Selected planner and catalog membership never establish account inference access. */
  reasoningModel: string | null; catalogSource: 'application_pinned_catalog' | 'unknown'; inferenceAccess: 'unknown';
  requestedModel: string; confirmedModel: string | null; reason: string; usage: unknown; checkedAt: string;
}
export interface AppUpdateStatus {
  supported: boolean; currentVersion: string; latestVersion: string | null;
  state: 'idle' | 'checking' | 'up_to_date' | 'available' | 'downloading' | 'installing' | 'error' | 'unsupported';
  downloadedBytes: number; totalBytes: number | null; sha256: string | null;
  releaseUrl: string | null; message: string; checkedAt: string | null;
}
export interface CodexSetupStatus {
  supported: boolean; runtimeDetected: boolean;
  state: 'idle' | 'downloading' | 'verifying' | 'extracting' | 'ready' | 'cancelled' | 'error';
  version: string; downloadedBytes: number; totalBytes: number; message: string;
  manifest: {
    version: string; target: string; url: string; bytes: number; sha256: string;
    sourceUrl: string; license: string; licenseUrl: string;
  };
}
export type ImageOperation =
  | {type: 'resize'; width: number; height: number; pixelArt: boolean}
  | {type: 'crop'; x: number; y: number; width: number; height: number}
  | {type: 'trim'; padding: number}
  | {type: 'color'; hue: number; saturation: number}
  | {type: 'background'; color: string; tolerance: number}
  | {type: 'mask'; points: [number,number][]; radius: number; mode: 'erase' | 'restore'};
export interface ModelParameters {template: 'crate' | 'table' | 'shelf' | 'sword' | 'rifle' | 'spaceship' | 'barrel' | 'rock' | 'tree'; name: string; width: number; depth: number; height: number; color: string; bevel: number;}
export interface GameBundleReference {
  assetId: string; versionId: string; name: string; kind: AssetKind;
  width: number | null; height: number | null; mesh: Asset['mesh'];
}
export interface GameBundleItem {
  id: string; name: string; kind: AssetKind; prompt: string; purpose: string;
  referenceAssetIds: string[]; targetAssetId: string | null;
  modelParameters: ModelParameters | null; enabled: boolean;
}
export interface GameBundlePlan {
  schemaVersion: 1; id: string; projectId: string; plannerModel: 'gpt-5.5'; brief: string;
  output: 'images' | 'models' | 'mixed'; mode: 'new' | 'improve';
  spec: AssetSpec; styleGuide: StyleGuide; referenceAssetIds: string[];
  references: GameBundleReference[]; summary: string;
  items: GameBundleItem[]; warnings: string[];
}
export interface AtlasOptions {width: number; height: number; padding: number;}
export const DEFAULT_SPEC: AssetSpec = {domain:'game',width:512,height:512,unit:'m',axis:'Y-up',pivot:[0.5,0.5],polygonBudget:10000,pixelArt:false,colorSpace:'sRGB',normalConvention:'OpenGL',naming:'{name}_v{version}',target:'Unity / Godot'};
export const DEFAULT_STYLE: StyleGuide = {id:'default',name:'차분한 판타지',palette:['#799993','#d4bd8a','#7192bc','#c78272'],lineWeight:2,camera:'orthographic 3/4',lighting:'soft studio',detail:'clean readable silhouette',margin:24,referenceAssetIds:[],approved:true};
export const EXPORT_PRESETS: ExportPreset[] = [
  {id:'game',name:'게임 · Unity / Godot',domain:'game',formats:['png','glb','json'],axis:'Y-up',unit:'m',target:'Unity / Godot'},
  {id:'product',name:'제품 시각화',domain:'product',formats:['png','webp','glb','json'],axis:'Y-up',unit:'m',target:'Blender / glTF viewer'},
  {id:'architecture',name:'건축 · 인테리어',domain:'architecture',formats:['png','glb','json'],axis:'Y-up',unit:'m',target:'Visualization mesh, not CAD'},
  {id:'education',name:'교육 · 시뮬레이션',domain:'education',formats:['png','glb','json'],axis:'Y-up',unit:'m',target:'glTF-compatible tools'},
  {id:'design',name:'웹 · 앱 디자인',domain:'design',formats:['png','webp','jpeg','json'],axis:'Y-up',unit:'m',target:'Figma / browser'},
];
