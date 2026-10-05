import {useEffect, useId, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {AlertTriangle, ArrowRight, Box, Check, CheckCircle2, Download, FileImage, FolderOpen, Layers, Link2, LoaderCircle, RefreshCw, Sparkles, Square} from 'lucide-react';
import type {Artifact, Asset, GameProjectScan, Local3DStatus, ProductionItemResult, ProductionPlan, ProductionRun, ProductionState, ProjectSnapshot, ProviderConnection} from '@local-assets/contracts';
import {artifactUrl, chooseFolder, chooseImports, command, isNative} from '../lib/bridge';
import './ProductionHome.css';

export interface ProductionHomeProps {
  snapshot: ProjectSnapshot;
  native: boolean;
  connection: ProviderConnection | null;
  providerChecking: boolean;
  busy: boolean;
  onProvider: () => void;
  onSnapshot: (snapshot: ProjectSnapshot) => void;
  onInspect: (asset: Asset) => void;
  onAdvanced: () => void;
}

type Output = ProductionPlan['output'];
type ProductionResponse = {snapshot: ProjectSnapshot; state: ProductionState};
type Reference = {asset: Asset; preview?: Artifact};
const EMPTY_STATE: ProductionState = {connection: null, plan: null, runs: []};
const IMAGE_FORMATS = ['png', 'webp', 'jpg', 'jpeg'];
const KIND_LABELS = {image: '이미지', sprite: '스프라이트', texture: '텍스처', model: '3D 모델'};
const STATUS_LABELS: Record<ProductionItemResult['status'], string> = {
  pending: '제작 대기', running: '제작 중', completed: '제작 완료', needs_attention: '확인 필요', cancelled: '취소됨',
};
const LOCAL_LABELS: Record<Local3DStatus['state'], string> = {
  missing: '준비 필요', preparing: '준비 중', ready: '준비 완료', error: '준비 오류', cancelled: '준비 취소됨', unsupported: '사용 불가',
};
const ENGINE_LABELS = {godot: 'Godot', unity: 'Unity', unreal: 'Unreal', unknown: '엔진 미확인'};

// Never render bridge exceptions. Server-provided descriptions can also contain
// provider diagnostics, so discard sensitive strings rather than partially masking them.
function safeText(value: string | null | undefined, fallback: string, limit = 600): string {
  if (!value || /https?:\/\/|bearer|authorization|(?:access|refresh)[_-]?token|api[_-]?key|credential|password|secret|\bsk-[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/i.test(value)) return fallback;
  return Array.from(value).slice(0, limit).join('');
}

function safeError(cause: unknown, fallback: string): string {
  const message = (cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '').trim();
  if (/^permission denied\b|\(os error (?:13|5)\)/i.test(message)) return '폴더에 접근할 권한이 없습니다. 접근 권한을 확인하거나 다른 폴더를 선택하세요.';
  // Native errors intended for the user are concise Korean messages. Avoid
  // rendering arbitrary process output, stack traces or opaque credential values.
  if (!/[가-힣]/.test(message) || /\n|[A-Za-z0-9_+/=-]{48,}/.test(message)) return fallback;
  return safeText(message, fallback);
}

function currentFiles(asset: Asset) {
  const version = asset.versions.find(candidate => candidate.id === asset.activeVersionId);
  const formats = asset.kind === 'model' ? ['glb', 'gltf'] : IMAGE_FORMATS;
  const eligible = version?.artifacts.filter(file => formats.includes(file.format.toLowerCase()) && file.bytes > 0 && file.path.trim());
  const output = eligible?.find(file => file.role === 'output') ?? eligible?.find(file => file.role === 'source');
  const preview = version?.artifacts.find(file => file.role === 'thumbnail' && IMAGE_FORMATS.includes(file.format.toLowerCase()) && file.bytes > 0 && file.path.trim())
    ?? (asset.kind === 'model' ? undefined : output);
  return {version, output, preview};
}

function referenceAssets(snapshot: ProjectSnapshot): Reference[] {
  return snapshot.project.assets.flatMap(asset => {
    const files = currentFiles(asset);
    return files.version && files.version.source !== 'fixture' && files.output && /^[a-f0-9]{64}$/i.test(files.output.sha256)
      ? [{asset, preview: files.preview}] : [];
  });
}

function inputKey(snapshot: ProjectSnapshot, scan: GameProjectScan | null, brief: string, output: Output, referenceIds: string[]) {
  return JSON.stringify({project: snapshot.project.id, root: snapshot.root, gameRoot: scan?.root, fingerprint: scan?.fingerprint,
    brief: brief.trim(), output, references: [...referenceIds].sort().map(id => {
      const asset = snapshot.project.assets.find(candidate => candidate.id === id);
      const version = asset?.versions.find(candidate => candidate.id === asset.activeVersionId);
      return {id, version: asset?.activeVersionId, name: asset?.name, kind: asset?.kind, width: asset?.width, height: asset?.height,
        mesh: asset?.mesh, source: version?.source, artifacts: version?.artifacts};
    })});
}

function matchesPlan(plan: ProductionPlan, scan: GameProjectScan | null, snapshot: ProjectSnapshot, brief: string, output: Output, referenceIds: string[]) {
  return plan.projectId === snapshot.project.id && !!scan && plan.gameRoot === scan.root && plan.fingerprint === scan.fingerprint
    && plan.brief.trim() === brief.trim() && plan.output === output
    && referenceIds.length <= 5 && new Set(referenceIds).size === referenceIds.length
    && JSON.stringify([...plan.referenceAssetIds].sort()) === JSON.stringify([...referenceIds].sort())
    && plan.references.length === referenceIds.length && plan.references.every(reference => {
      const source = referenceAssets(snapshot).find(candidate => candidate.asset.id === reference.assetId);
      const asset = source?.asset;
      return !!asset && referenceIds.includes(asset.id) && reference.versionId === asset.activeVersionId
        && reference.name === asset.name && reference.kind === asset.kind && reference.width === asset.width
        && reference.height === asset.height && JSON.stringify(reference.mesh) === JSON.stringify(asset.mesh);
    });
}

function activeRun(run: ProductionRun) {
  return run.status === 'pending' || run.status === 'running' || run.items.some(item => item.status === 'pending' || item.status === 'running');
}

function Thumbnail({snapshot, asset, preview, kind}: {snapshot: ProjectSnapshot; asset?: Asset; preview?: Artifact; kind: Asset['kind']}) {
  const file = preview ?? (asset ? currentFiles(asset).preview : undefined);
  const url = artifactUrl(snapshot, file);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className="production-thumbnail" aria-hidden="true">
    {url && failedUrl !== url ? <img src={url} alt="" loading="lazy" onError={() => setFailedUrl(url)}/>
      : kind === 'model' ? <Box size={36} strokeWidth={1.4}/> : <FileImage size={36} strokeWidth={1.4}/>}
  </span>;
}

export default function ProductionHome({snapshot, native, connection, providerChecking, busy, onProvider, onSnapshot, onInspect, onAdvanced}: ProductionHomeProps) {
  const desktop = native && isNative;
  const scope = `${snapshot.project.id}\n${snapshot.root}\n${desktop}`;
  const jobsKey = JSON.stringify(snapshot.project.jobs.map(job => [job.id, job.status, job.assetId, job.finishedAt, job.progress.stage, job.progress.completed, job.progress.total]));
  const [state, setState] = useState<ProductionState>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [brief, setBrief] = useState('');
  const [output, setOutput] = useState<Output>('mixed');
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [uploadApproved, setUploadApproved] = useState(false);
  const [acceptedPlan, setAcceptedPlan] = useState<{id: string; key: string} | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [localStatus, setLocalStatus] = useState<Local3DStatus | null>(null);
  const [localError, setLocalError] = useState('');
  const [localLoading, setLocalLoading] = useState(false);
  const [downloadApproved, setDownloadApproved] = useState(false);
  const id = useId();
  const latest = useRef({scope, snapshot, brief, output, referenceIds});
  latest.current = {scope, snapshot, brief, output, referenceIds};
  const mounted = useRef(false);
  const pending = useRef<string | null>(null);
  const readEpoch = useRef(0);
  const stateFlight = useRef<Promise<void> | null>(null);
  const localEpoch = useRef(0);
  const localFlight = useRef<Promise<void> | null>(null);
  const stateRef = useRef(state);
  const initialRead = useRef(true);
  const draftRevision = useRef(0);
  const requestIds = useRef(new Map<string, string>());
  const referenceSection = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; ++readEpoch.current; ++localEpoch.current;};
  }, []);

  function acceptState(next: ProductionState) {
    stateRef.current = next;
    setState(next);
  }

  useEffect(() => {
    ++readEpoch.current;
    ++localEpoch.current;
    pending.current = null;
    initialRead.current = true;
    draftRevision.current = 0;
    requestIds.current.clear();
    acceptState(EMPTY_STATE);
    setLoaded(false);
    setBrief(''); setOutput('mixed'); setReferenceIds([]); setUploadApproved(false);
    setAcceptedPlan(null); setOperation(null); setError(''); setLoadError(''); setNotice('');
    setLocalStatus(null); setLocalError(''); setLocalLoading(false); setDownloadApproved(false);
  }, [scope]);

  // This is the only automatic production action: read persisted state. A read
  // waits for an older read, and mutations invalidate responses already in flight.
  useEffect(() => {
    if (!desktop || operation) return;
    let active = true;
    let timer: number | undefined;
    const epoch = ++readEpoch.current;
    const valid = () => active && mounted.current && latest.current.scope === scope && readEpoch.current === epoch && !pending.current;
    async function read() {
      if (stateFlight.current) await stateFlight.current;
      if (!valid()) return;
      const task = command<ProductionState>({action: 'production_state'}).then(next => {
        if (!valid()) return;
        acceptState(next);
        setLoaded(true);
        setLoadError('');
        if (initialRead.current) {
          initialRead.current = false;
          const current = latest.current;
          const saved = next.plan;
          if (draftRevision.current === 0 && saved && matchesPlan(saved, next.connection, current.snapshot, saved.brief, saved.output, saved.referenceAssetIds)) {
            setBrief(saved.brief); setOutput(saved.output); setReferenceIds(saved.referenceAssetIds);
            setAcceptedPlan({id: saved.id, key: inputKey(current.snapshot, next.connection, saved.brief, saved.output, saved.referenceAssetIds)});
          } else if (saved) setNotice('저장된 계획의 입력을 다시 확인하고 필요한 에셋을 분석하세요.');
        }
      }).catch(cause => {
        if (valid()) setLoadError(safeError(cause, '제작 상태를 불러오지 못했습니다. 상태를 다시 확인하세요.'));
      });
      stateFlight.current = task;
      await task;
      if (stateFlight.current === task) stateFlight.current = null;
      if (valid() && stateRef.current.runs.some(activeRun)) timer = window.setTimeout(() => void read(), 1000);
    }
    void read();
    return () => {active = false; window.clearTimeout(timer);};
  }, [desktop, scope, jobsKey, operation, refresh]);

  const references = referenceAssets(snapshot);
  const key = inputKey(snapshot, state.connection, brief, output, referenceIds);
  const plan = state.plan && acceptedPlan?.id === state.plan.id && acceptedPlan.key === key
    && matchesPlan(state.plan, state.connection, snapshot, brief, output, referenceIds) ? state.plan : null;
  const items = plan?.items.filter(item => item.enabled) ?? [];
  const hasModels = items.some(item => item.kind === 'model');
  const needsLocal = output !== 'images' || hasModels || state.runs.some(run => run.items.some(item => item.kind === 'model'));
  const modelUnavailable = desktop && localStatus?.supported === false;
  const incompatiblePlan = modelUnavailable && !!state.plan
    && (state.plan.output !== 'images' || state.plan.items.some(item => item.enabled && item.kind === 'model'));

  useEffect(() => {
    // Wait for saved state before choosing a platform default. Never replace a
    // saved plan or a draft that the user has already edited.
    if (desktop && loaded && localStatus?.supported === false && !state.plan && draftRevision.current === 0 && output === 'mixed') setOutput('images');
  }, [desktop, loaded, localStatus?.supported, state.plan, output]);

  useEffect(() => {
    if (acceptedPlan && acceptedPlan.key !== key) {
      setAcceptedPlan(null); setUploadApproved(false);
      setNotice('참고 자료나 프로젝트 정보가 바뀌었습니다. 필요한 에셋을 다시 분석하세요.');
    }
  }, [key, acceptedPlan]);

  // Read platform support even for saved image plans. Preparation still needs
  // its separate consent; poll only while the native runtime says preparing.
  useEffect(() => {
    if (!desktop || operation?.startsWith('local:')) return;
    let active = true;
    let timer: number | undefined;
    const epoch = ++localEpoch.current;
    const valid = () => active && mounted.current && latest.current.scope === scope && localEpoch.current === epoch;
    setLocalLoading(true);
    async function read() {
      if (localFlight.current) await localFlight.current;
      if (!valid()) return;
      const task = command<Local3DStatus>({action: 'quality3d_status'}).then(next => {
        if (!valid()) return;
        setLocalStatus(next); setLocalError('');
        if (next.state === 'preparing') timer = window.setTimeout(() => void read(), 1000);
      }).catch(cause => {
        if (valid()) setLocalError(safeError(cause, '로컬 3D 준비 상태를 확인하지 못했습니다. 다시 확인하세요.'));
      }).finally(() => {if (valid()) setLocalLoading(false);});
      localFlight.current = task;
      await task;
      if (localFlight.current === task) localFlight.current = null;
    }
    void read();
    return () => {active = false; window.clearTimeout(timer);};
  }, [desktop, scope, operation]);

  const working = busy || operation !== null;
  const providerReady = desktop && !!connection?.available && !!connection.authenticated && connection.ready && !providerChecking;
  const memoryReady = !!localStatus && Number.isFinite(localStatus.minimumMemoryMb) && Number.isFinite(localStatus.memoryMb)
    && localStatus.minimumMemoryMb > 0 && localStatus.memoryMb >= localStatus.minimumMemoryMb;
  const localReady = !!localStatus?.supported && localStatus.installed && localStatus.state === 'ready' && !localStatus.busy
    && localStatus.blenderReady && memoryReady && !localError && !localLoading;
  const selectionValid = referenceIds.length <= 5 && referenceIds.every(assetId => references.some(reference => reference.asset.id === assetId));
  const running = state.runs.some(activeRun);
  const alreadyStarted = !!plan && state.runs.some(run => run.planId === plan.id);
  const canAnalyze = providerReady && loaded && !loadError && !!state.connection && !!brief.trim() && selectionValid && uploadApproved && !working && !running
    && (output === 'images' || localStatus?.supported === true);
  const canStart = canAnalyze && !!plan && items.length > 0 && plan.items.length <= 120 && !alreadyStarted && (!hasModels || localReady);
  const draftsDisabled = busy || (!!operation && operation !== 'plan');

  function invalidateDraft() {
    ++draftRevision.current;
    setAcceptedPlan(null); setUploadApproved(false); setError('');
    if (state.plan) setNotice('설명·종류·참고가 바뀌었습니다. 필요한 에셋을 다시 분석하세요.');
  }

  function switchToImagePlan() {
    if (!desktop || working || running) return;
    invalidateDraft();
    setOutput('images');
    setNotice('설명과 참고 자료는 유지했습니다. 전송 범위에 다시 동의하고 필요한 에셋 분석을 눌러 이미지 전용 계획을 만드세요.');
  }

  function begin(name: string) {
    if (!desktop || busy || pending.current) return false;
    pending.current = name;
    ++readEpoch.current;
    setOperation(name); setError('');
    return true;
  }
  function currentScope(captured: string) {return mounted.current && latest.current.scope === captured;}
  function finish(captured: string, name: string) {
    if (currentScope(captured) && pending.current === name) {pending.current = null; setOperation(null);}
  }

  async function connectGame() {
    const name = 'connect';
    if (running || !begin(name)) return;
    const captured = scope;
    try {
      const root = await chooseFolder('게임 프로젝트 루트 연결');
      if (!root || !currentScope(captured)) return;
      const next = await command<ProductionState>({action: 'game_connect', root});
      if (!currentScope(captured)) return;
      invalidateDraft(); acceptState(next); setLoaded(true); setLoadError('');
      setNotice('게임 프로젝트를 연결했습니다. 게임을 설명하고 필요한 에셋을 분석하세요.');
    } catch (cause) {if (currentScope(captured)) setError(safeError(cause, '게임 프로젝트를 연결하지 못했습니다. 폴더를 확인하고 다시 시도하세요.'));}
    finally {finish(captured, name);}
  }

  async function importReferences() {
    if (!begin('import')) return;
    const captured = scope;
    try {
      const next = await chooseImports();
      if (!next || !currentScope(captured) || next.project.id !== latest.current.snapshot.project.id || next.root !== latest.current.snapshot.root) return;
      onSnapshot(next);
      if (referenceSection.current) referenceSection.current.open = true;
    } catch (cause) {if (currentScope(captured)) setError(safeError(cause, '참고 파일을 가져오지 못했습니다. 파일을 확인하고 다시 시도하세요.'));}
    finally {finish(captured, 'import');}
  }

  async function analyze(event: FormEvent) {
    event.preventDefault();
    if (!canAnalyze || !begin('plan')) return;
    const captured = scope;
    const revision = draftRevision.current;
    const requested = {snapshot, brief, output, referenceIds: [...referenceIds], root: state.connection?.root};
    setAcceptedPlan(null); setNotice('');
    try {
      const next = await command<ProductionState>({action: 'production_plan', brief: brief.trim(), output, referenceAssetIds: [...referenceIds], uploadApproved: true});
      if (!currentScope(captured)) return;
      acceptState(next);
      const current = latest.current;
      const saved = next.plan;
      const savedKey = inputKey(current.snapshot, next.connection, current.brief, current.output, current.referenceIds);
      if (saved && draftRevision.current === revision && next.connection?.root === requested.root
        && inputKey(requested.snapshot, next.connection, requested.brief, requested.output, requested.referenceIds) === savedKey
        && matchesPlan(saved, next.connection, current.snapshot, current.brief, current.output, current.referenceIds)) {
        setAcceptedPlan({id: saved.id, key: savedKey});
      } else setNotice('입력이 바뀌었거나 저장된 계획이 일치하지 않습니다. 필요한 에셋을 다시 분석하세요.');
    } catch (cause) {if (currentScope(captured)) setError(safeError(cause, '필요한 에셋을 분석하지 못했습니다. 연결과 입력을 확인한 뒤 다시 시도하세요.'));}
    finally {finish(captured, 'plan');}
  }

  function acceptResult(next: ProductionResponse, captured: string) {
    if (!currentScope(captured) || next.snapshot.project.id !== latest.current.snapshot.project.id || next.snapshot.root !== latest.current.snapshot.root) return;
    acceptState(next.state);
    onSnapshot(next.snapshot);
  }

  async function start() {
    if (!canStart || !plan || !begin('start')) return;
    const captured = scope;
    try {
      let requestId = requestIds.current.get(plan.id);
      if (!requestId) {requestId = crypto.randomUUID(); requestIds.current.set(plan.id, requestId);}
      const next = await command<ProductionResponse>({action: 'production_start', planId: plan.id, requestId, uploadApproved: true});
      acceptResult(next, captured);
    } catch (cause) {
      if (currentScope(captured)) {
        const message = safeError(cause, '제작 요청의 결과를 확인하지 못했습니다. 상태를 확인한 뒤 같은 계획으로 다시 시도하세요.');
        setError(message);
        if (/게임 프로젝트가 분석 후 변경|구성안이 바뀌|참고 자료가 바뀌|공통 제작 기준이 바뀌/.test(message)) {setAcceptedPlan(null); setUploadApproved(false);}
      }
    }
    finally {finish(captured, 'start');}
  }

  function improveResult(run: ProductionRun, item: ProductionItemResult, asset: Asset) {
    if (!desktop || working || running) return;
    invalidateDraft();
    setBrief(`게임 기준: ${run.brief}\n이번 제작 범위: "${item.name}" ${KIND_LABELS[item.kind]} 에셋 하나만 새로 개선해 주세요. 기존 결과를 참고해 형상과 디테일을 개선하고, 같은 게임 스타일을 유지하세요. 다른 에셋은 유지합니다.`);
    setOutput(item.kind === 'model' ? 'models' : 'images');
    setReferenceIds(references.some(reference => reference.asset.id === asset.id) ? [asset.id] : []);
    setNotice('선택한 결과의 개선 요청을 준비했습니다. 설명과 전송 범위를 확인하고 분석하세요.');
    document.querySelector<HTMLTextAreaElement>('.production-brief textarea')?.focus();
  }

  async function runAction(action: 'production_review' | 'production_retry' | 'production_cancel', run: ProductionRun, item?: ProductionItemResult) {
    const name = `${action}:${run.id}:${item?.id ?? ''}`;
    const asset = item?.assetId ? snapshot.project.assets.find(candidate => candidate.id === item.assetId) : undefined;
    if (action === 'production_review' && (!item || item.status !== 'completed' || item.review === 'approved' || !asset || !currentFiles(asset).output)) return;
    if (action === 'production_retry' && (!item || !['needs_attention', 'cancelled'].includes(item.status) || (item.kind === 'model' && !localReady))) return;
    if (action === 'production_cancel' && !activeRun(run)) return;
    if (!begin(name)) return;
    const captured = scope;
    try {
      if (action === 'production_review') {
        const next = await command<ProductionState>({action, runId: run.id, itemId: item!.id, approved: true});
        if (currentScope(captured)) acceptState(next);
      } else {
        const next = await command<ProductionResponse>(item ? {action, runId: run.id, itemId: item.id} : {action, runId: run.id});
        acceptResult(next, captured);
      }
    } catch (cause) {if (currentScope(captured)) setError(safeError(cause, action === 'production_review' ? '검수 승인을 저장하지 못했습니다. 다시 시도하세요.'
      : action === 'production_retry' ? '다시 제작 요청을 확인하지 못했습니다. 현재 상태를 다시 확인하세요.' : '제작 취소를 확인하지 못했습니다. 현재 상태를 다시 확인하세요.'));}
    finally {finish(captured, name);}
  }

  async function prepareLocal(action: 'quality3d_status' | 'quality3d_prepare' | 'quality3d_cancel_setup') {
    if (action === 'quality3d_prepare' && (!downloadApproved || !localStatus?.supported || !memoryReady || localStatus.busy || localStatus.state === 'preparing' || localReady || localLoading)) return;
    if (action === 'quality3d_cancel_setup' && localStatus?.state !== 'preparing') return;
    const name = `local:${action}`;
    if (!begin(name)) return;
    ++localEpoch.current;
    const captured = scope;
    setLocalError('');
    try {
      const next = await command<Local3DStatus>(action === 'quality3d_prepare' ? {action, confirmed: true} : {action});
      if (currentScope(captured)) {setLocalStatus(next); setLocalLoading(false); if (action === 'quality3d_prepare') setDownloadApproved(false);}
    } catch (cause) {if (currentScope(captured)) setLocalError(safeError(cause, '로컬 3D 준비 요청을 확인하지 못했습니다. 준비 상태를 다시 확인하세요.'));}
    finally {finish(captured, name);}
  }

  const readyLabel = !desktop ? '데스크톱 전용' : providerChecking ? '연결 확인 중' : providerReady ? '연결 준비됨' : '연결 필요';
  return <section className="production-home" aria-label="에셋 제작 홈">
    <div className="production-home-inner">
      <header className="production-hero">
        <div><p className="production-eyebrow"><Sparkles size={18}/> ASSET STUDIO</p><h1>게임에 필요한 에셋을 한 번에</h1><p className="production-lead">만들고 싶은 게임을 설명하세요.<br/>필요한 이미지와 3D 모델을 계획하고, 제작한 결과를 검수합니다.</p></div>
        <aside className="production-provider" aria-label="GPT 연결 상태"><div className="production-heading"><strong><Link2 size={18}/> GPT 구독 연결</strong><span className={`production-badge ${providerReady ? 'ready' : ''}`} role="status">{readyLabel}</span></div>
          <p>{providerReady ? '연결이 준비됐습니다. 실제 생성 결과는 수신 파일에서 확인합니다.' : '계정 연결 상태를 확인한 뒤 분석과 제작을 시작하세요.'}</p>
          <button className="production-button" type="button" onClick={onProvider} disabled={!desktop || working || providerChecking}>{providerChecking ? <LoaderCircle className="production-spin" size={18}/> : <Link2 size={18}/>} {providerReady ? 'GPT 연결 확인' : 'GPT 연결하기'}<ArrowRight size={16}/></button>
        </aside>
      </header>

      <ol className="production-steps" aria-label="제작 순서"><li><span>1</span>프로젝트 연결</li><li><span>2</span>게임 설명</li><li><span>3</span>제작하고 검수</li></ol>
      {!desktop && <p className="production-message" role="status">분석과 제작은 데스크톱 앱에서 연결 상태를 확인한 뒤 사용할 수 있습니다.</p>}
      {loadError && <p className="production-message warning" role="alert">{loadError}</p>}
      {error && <p className="production-message warning" role="alert">{error}</p>}
      {notice && <p className="production-message" role="status">{notice}</p>}

      <section className="production-project production-surface" aria-labelledby={`${id}-project`}>
        <div><h2 id={`${id}-project`}><FolderOpen size={21}/>게임 프로젝트 연결</h2>
          {state.connection ? <><p className="production-project-name"><span>{safeText(state.connection.projectName, '연결된 게임 프로젝트')}</span><span className="production-badge">{ENGINE_LABELS[state.connection.engine]}</span></p><p className="production-path">{safeText(state.connection.root, '게임 프로젝트 루트 연결됨', 1200)}</p><p className="production-muted">에셋 {state.connection.assetCount.toLocaleString('ko-KR')}개 · 누락된 참조 {state.connection.missingReferences.length.toLocaleString('ko-KR')}개</p></>
            : <p className="production-muted">게임 폴더를 연결하면 에셋 파일 목록과 누락된 참조를 살펴봅니다.</p>}
        </div>
        <div className="production-project-actions"><button className="production-button" type="button" onClick={() => void connectGame()} disabled={!desktop || working || running}><FolderOpen size={18}/>{operation === 'connect' ? '폴더 연결 중' : state.connection ? '게임 프로젝트 변경' : '게임 프로젝트 루트 연결'}</button>
          <button className="production-text-button" type="button" disabled={!desktop || working} onClick={() => {setLoadError(''); setRefresh(value => value + 1);}}><RefreshCw size={16}/>제작 상태 다시 확인</button>
        </div>
        {!!state.connection?.warnings.length && <ul className="production-warnings">{state.connection.warnings.map((warning, index) => <li key={index}>{safeText(warning, '프로젝트 연결 정보를 확인하세요.')}</li>)}</ul>}
      </section>

      <div className="production-compose">
        <form className="production-brief production-surface" onSubmit={event => void analyze(event)} aria-labelledby={`${id}-describe`}>
          <div className="production-heading"><h2 id={`${id}-describe`}>어떤 게임을 만들고 있나요?</h2><span className="production-muted">게임 설명</span></div>
          <label className="production-sr-only" htmlFor={`${id}-brief`}>게임 설명</label>
          <textarea id={`${id}-brief`} value={brief} rows={6} disabled={draftsDisabled || !desktop} onChange={event => {invalidateDraft(); setBrief(event.target.value);}} placeholder="예: 작은 섬을 탐험하는 따뜻한 판타지 게임. 숲과 마을, 나무와 바위, 도구와 수집 아이템이 필요해요. 부드러운 색감의 이미지와 단순한 3D 모델을 함께 만들고 싶어요." aria-describedby={`${id}-description-help`}/>
          <p id={`${id}-description-help`} className="production-muted">장르, 배경, 필요한 물체와 원하는 분위기를 자유롭게 적어주세요.</p>
          <fieldset className="production-output" disabled={draftsDisabled || !desktop} aria-describedby={modelUnavailable ? `${id}-model-limit` : undefined}><legend>만들 에셋</legend>
            {([{value: 'images', label: '이미지', icon: <FileImage size={20}/>}, {value: 'models', label: '3D 모델', icon: <Box size={20}/>}, {value: 'mixed', label: '이미지 + 3D', icon: <Layers size={20}/>} ] as const).map(choice => <label key={choice.value} className={output === choice.value ? 'selected' : ''}><input type="radio" name={`${id}-output`} value={choice.value} checked={output === choice.value} disabled={choice.value !== 'images' && desktop && localStatus?.supported !== true} onChange={() => {invalidateDraft(); setOutput(choice.value);}}/>{choice.icon}<span>{choice.label}</span></label>)}
          </fieldset>
          {modelUnavailable && <p id={`${id}-model-limit`} className="production-message warning" role="status">이 제작 화면의 이미지→3D는 현재 Mac 전용입니다. 이 환경에서는 이미지 제작을 이용하세요.</p>}
          <div className="production-reference-actions"><button className="production-button" type="button" onClick={() => void importReferences()} disabled={!desktop || working}><Download size={17}/>{operation === 'import' ? '참고 파일 가져오는 중' : '참고 이미지·모델 추가'}</button><span className="production-muted">선택 사항</span></div>
          <details className="production-references" ref={referenceSection}><summary>참고 에셋 선택 <span>선택 사항 · {referenceIds.length}/5</span></summary>
            <p className="production-muted">가져오거나 실제 제작한 에셋 중 최대 5개를 선택하세요. 미리보기 없는 모델은 메타데이터만 참고합니다.</p>
            <div className="production-reference-grid" role="group" aria-label="참고 에셋 선택">
              {references.map(reference => <button key={reference.asset.id} type="button" className={`production-reference ${referenceIds.includes(reference.asset.id) ? 'selected' : ''}`} aria-label={`${safeText(reference.asset.name, '참고 에셋')} 참고 선택`} aria-pressed={referenceIds.includes(reference.asset.id)} disabled={!desktop || draftsDisabled || (referenceIds.length >= 5 && !referenceIds.includes(reference.asset.id))} onClick={() => {invalidateDraft(); setReferenceIds(ids => ids.includes(reference.asset.id) ? ids.filter(value => value !== reference.asset.id) : ids.length < 5 ? [...ids, reference.asset.id] : ids);}}>
                <Thumbnail snapshot={snapshot} preview={reference.preview} kind={reference.asset.kind}/><span>{safeText(reference.asset.name, '참고 에셋')}</span><small>{reference.preview ? KIND_LABELS[reference.asset.kind] : '3D 모델 · 메타데이터 참고'}</small>{referenceIds.includes(reference.asset.id) && <Check className="production-reference-check" size={18}/>}</button>)}
              {!references.length && <p className="production-muted">선택할 참고 에셋이 없습니다. 참고 없이도 분석할 수 있습니다.</p>}
            </div>
            {!selectionValid && <p className="production-message warning" role="status">선택한 참고의 현재 미리보기를 사용할 수 없습니다. 선택을 해제하거나 다시 가져오세요.</p>}
            {!!referenceIds.filter(assetId => !references.some(reference => reference.asset.id === assetId)).length && <button type="button" className="production-text-button" disabled={draftsDisabled || !desktop} onClick={() => {invalidateDraft(); setReferenceIds(ids => ids.filter(assetId => references.some(reference => reference.asset.id === assetId)));}}>사용할 수 없는 참고 선택 해제</button>}
          </details>
          <div className="production-consent"><label><input type="checkbox" checked={uploadApproved} aria-describedby={`${id}-upload-scope`} disabled={!desktop || working} onChange={event => setUploadApproved(event.target.checked)}/><span>분석·제작을 위한 외부 전송에 동의합니다.</span></label>
            <p id={`${id}-upload-scope`}>전송 범위: 게임 설명, 에셋의 상대 파일 이름과 누락된 참조 정보, 직접 선택한 참고 에셋의 메타데이터와 미리보기(있는 경우). 소스 파일 내용은 전송하지 않습니다.</p>
          </div>
          <footer className="production-analyze"><p className="production-muted">{!state.connection ? '게임 프로젝트를 먼저 연결하세요.' : !providerReady ? 'GPT 연결 상태를 확인하세요.' : running ? '진행 중인 제작이 끝난 뒤 새 계획을 분석할 수 있습니다.' : '먼저 제작 목록을 확인한 뒤 제작을 시작합니다.'}</p><button className="production-button primary" type="submit" disabled={!canAnalyze}>{operation === 'plan' ? <LoaderCircle className="production-spin" size={18}/> : <Sparkles size={18}/>} {operation === 'plan' ? '필요한 에셋 분석 중' : '필요한 에셋 분석'}</button></footer>
        </form>

        <section className="production-plan production-surface" aria-labelledby={`${id}-plan`}>
          <div className="production-heading"><h2 id={`${id}-plan`}>제작할 에셋</h2>{plan && <span className="production-badge">{items.length}개</span>}</div>
          {plan ? <><p className="production-plan-summary">{safeText(plan.summary, '게임 설명을 바탕으로 제작 목록을 준비했습니다.')}</p>
            <ul className="production-checklist" aria-label="제작 계획">{items.map(item => <li key={item.id}><CheckCircle2 size={18}/><div><strong>{safeText(item.name, '새 에셋')}</strong><p>{safeText(item.purpose, '게임에 사용할 에셋')}</p></div><span className="production-badge">{KIND_LABELS[item.kind]}</span></li>)}</ul>
            {!items.length && <p className="production-message warning">제작할 에셋이 없습니다. 게임 설명을 보완하고 다시 분석하세요.</p>}
            {!!plan.warnings.length && <ul className="production-warnings">{plan.warnings.map((warning, index) => <li key={index}>{safeText(warning, '제작 계획을 확인하세요.')}</li>)}</ul>}
            <p className="production-limit"><AlertTriangle size={16}/>한 계획에서 최대 120개까지 제작합니다. 더 많은 에셋은 나누어 요청하세요.</p>
            {plan.items.length > 120 && <p className="production-message warning" role="alert">120개를 초과한 계획입니다. 범위를 줄이고 다시 분석하세요.</p>}
          </> : <div className="production-plan-empty"><Layers size={36} strokeWidth={1.4}/><h3>{operation === 'plan' ? '제작 목록을 정리하고 있어요' : '설명에서 제작 목록으로'}</h3><p>게임 설명을 분석하면 에셋의 이름, 종류와 용도를 여기에서 확인할 수 있습니다.</p></div>}
          {modelUnavailable && (output !== 'images' || incompatiblePlan) && <div className="production-message warning" role="status"><p>기존 계획과 입력은 보존합니다. 이 환경에서 제작할 이미지 전용 계획으로 전환한 뒤 다시 분석하세요.</p><button className="production-button" type="button" disabled={working || running} onClick={switchToImagePlan}>이미지 전용으로 전환</button></div>}
          {needsLocal && !modelUnavailable && <section className="production-local" aria-labelledby={`${id}-local`}><div className="production-heading"><h3 id={`${id}-local`}><Box size={18}/>3D 제작 준비</h3><span className="production-badge" role="status">{!desktop ? '데스크톱 전용' : localLoading ? '확인 중' : localError ? '확인 필요' : localStatus ? localReady ? '준비 완료' : LOCAL_LABELS[localStatus.state] === '준비 완료' ? '준비 확인 필요' : LOCAL_LABELS[localStatus.state] : '확인 필요'}</span></div>
            <p>GPT로 개념 이미지를 만든 뒤, 로컬 TripoSR로 3D 모델을 재구성합니다. 형상과 텍스처는 제작 결과에서 확인하세요.</p>
            {desktop && localStatus && <p role="status">{safeText(localStatus.message, '이 기기의 로컬 3D 준비 상태를 확인하세요.')}</p>}
            {desktop && localStatus && !memoryReady && <p className="production-message warning">기기의 메모리가 로컬 모델의 요구량을 충족하는지 확인하세요.</p>}
            {desktop && localStatus?.state === 'ready' && !localStatus.blenderReady && <p className="production-message warning">3D 결과를 준비하려면 Blender 연결이 필요합니다. 에셋 작업실에서 환경을 확인하세요.</p>}
            {localError && <p className="production-message warning" role="alert">{localError}</p>}
            {!localReady && localStatus?.state !== 'preparing' && <label className="production-download-consent"><input type="checkbox" checked={downloadApproved} disabled={!desktop || working || localLoading || !localStatus?.supported || !memoryReady || localStatus.busy} onChange={event => setDownloadApproved(event.target.checked)}/><span>TripoSR 가중치와 의존성 다운로드에 동의합니다.{localStatus && localStatus.weightBytes > 0 ? ` (가중치 약 ${(localStatus.weightBytes / 1_000_000_000).toLocaleString('ko-KR', {maximumFractionDigits: 2})} GB)` : ''}</span></label>}
            <div className="production-local-actions">{!localReady && localStatus?.state !== 'preparing' && <button className="production-button" type="button" disabled={!desktop || working || localLoading || !downloadApproved || !localStatus?.supported || !memoryReady || localStatus.busy} onClick={() => void prepareLocal('quality3d_prepare')}><Download size={16}/>로컬 3D 준비</button>}
              {localStatus?.state === 'preparing' && <button className="production-button" type="button" disabled={!desktop || working} onClick={() => void prepareLocal('quality3d_cancel_setup')}><Square size={16}/>준비 취소</button>}
              <button className="production-text-button" type="button" disabled={!desktop || working || localLoading} onClick={() => void prepareLocal('quality3d_status')}><RefreshCw size={16}/>3D 상태 다시 확인</button>
            </div>
          </section>}
          <div className="production-start"><button className="production-button primary" type="button" disabled={!canStart} onClick={() => void start()}>{operation === 'start' ? <LoaderCircle className="production-spin" size={18}/> : <Sparkles size={18}/>}필요한 에셋 모두 제작</button>
            <p className="production-muted">{alreadyStarted ? '이 계획의 제작 요청이 저장되었습니다. 아래에서 결과를 확인하세요.' : modelUnavailable && (hasModels || output !== 'images') ? '이 계획의 3D 제작은 이 환경에서 지원하지 않습니다. 이미지 전용으로 전환하고 다시 분석하세요.' : hasModels && !localReady ? '3D가 포함된 계획은 로컬 준비를 마친 뒤 제작할 수 있습니다.' : '결과는 게임 폴더의 AssetStudioGenerated 아래 새 제작 폴더에 저장합니다.'}</p>
          </div>
        </section>
      </div>

      <section className="production-results" aria-labelledby={`${id}-results`}><div className="production-heading"><div><h2 id={`${id}-results`}>제작 결과와 검수</h2><p className="production-muted">저장된 제작 기록은 앱을 다시 열어도 여기에서 이어서 확인합니다.</p></div><button className="production-text-button" type="button" onClick={onAdvanced} disabled={working}>에셋 작업실<ArrowRight size={16}/></button></div>
        {!state.runs.length && <p className="production-results-empty">{!desktop ? '데스크톱 앱에서 제작한 결과를 확인하세요.' : loadError ? '제작 기록을 확인하려면 상태를 다시 불러오세요.' : !loaded ? '저장된 제작 기록을 불러오는 중입니다.' : '제작을 시작하면 실제 결과 파일이 여기에 모입니다.'}</p>}
        {state.runs.map(run => <article key={run.id} className="production-run production-surface" aria-label={`제작 기록 ${safeText(run.brief, '게임 에셋 제작', 100)}`}><header className="production-heading"><div><h3>{safeText(run.brief, '게임 에셋 제작', 180)}</h3><p className="production-muted">{STATUS_LABELS[run.status]} · 제작 완료 {run.items.filter(item => item.status === 'completed').length}/{run.items.length}개 · 검수 승인 {run.items.filter(item => item.review === 'approved').length}개</p></div>
          {activeRun(run) && <button type="button" className="production-button" disabled={!desktop || working} onClick={() => void runAction('production_cancel', run)}><Square size={16}/>제작 취소</button>}</header>
          <p className="production-saved-folder"><FolderOpen size={17}/><span>저장 폴더<span className="production-path">{safeText(run.outputRoot, '저장 위치를 확인하세요.', 1200)}</span></span></p>
          <div className="production-gallery">{run.items.map(item => {
            const asset = snapshot.project.assets.find(candidate => candidate.id === item.assetId);
            const files = asset ? currentFiles(asset) : undefined;
            const inspectable = !!asset && !!files?.output;
            const task = snapshot.project.jobs.find(job => item.jobIds.includes(job.id) && ['running', 'ready', 'retry_wait', 'pending'].includes(job.status));
            const progress = task?.progress;
            const counts = progress && typeof progress.completed === 'number' && typeof progress.total === 'number'
              && Number.isFinite(progress.completed) && Number.isFinite(progress.total) && progress.completed >= 0 && progress.total > 0
              ? `${progress.completed.toLocaleString('ko-KR')}/${progress.total.toLocaleString('ko-KR')}` : '';
            return <article className="production-result" key={item.id} aria-label={`${safeText(item.name, '제작 에셋')} 제작 결과`}>
              <button type="button" className="production-result-preview" aria-label={`${safeText(item.name, '제작 에셋')} 결과 살펴보기`} disabled={!inspectable || working} onClick={() => {if (asset && inspectable) onInspect(asset);}}><Thumbnail snapshot={snapshot} asset={inspectable ? asset : undefined} kind={item.kind}/><span>결과 살펴보기<ArrowRight size={16}/></span></button>
              <div className="production-result-info"><div className="production-heading"><strong>{safeText(item.name, '제작 에셋')}</strong><span className="production-badge">{KIND_LABELS[item.kind]}</span></div><p className="production-item-status" role="status">{item.review === 'approved' ? <CheckCircle2 size={16}/> : item.status === 'running' ? <LoaderCircle size={16} className="production-spin"/> : null}{STATUS_LABELS[item.status]}{item.review === 'approved' ? ' · 검수 승인됨' : item.status === 'completed' ? ' · 검수 대기' : ''}</p>
                {progress && ['pending', 'running'].includes(item.status) && <p className="production-job-progress production-muted" role="status">{/[가-힣]/.test(progress.stage) ? safeText(progress.stage, '제작 진행 중', 160) : '제작 진행 중'}{counts ? ` · ${counts}` : ''}</p>}
                {files?.version?.validation?.valid && files.output && <p className="production-muted">파일 검증 완료</p>}
                {item.status === 'completed' && !inspectable && <p className="production-muted">결과 파일을 확인하는 중입니다. 상태를 다시 확인하세요.</p>}
                {item.error && <p className="production-item-error">{safeText(item.error, '이 에셋의 제작에 확인이 필요합니다. 현재 상태를 확인한 뒤 다시 시도하세요.')}</p>}
                <div className="production-result-actions">{item.status === 'completed' && item.review !== 'approved' && <button type="button" className="production-button" disabled={!desktop || working || !inspectable} onClick={() => void runAction('production_review', run, item)}><Check size={16}/>검수 승인</button>}
                  {item.status === 'completed' && <button type="button" className="production-button" disabled={!desktop || working || running || !inspectable} onClick={() => {if (asset && inspectable) improveResult(run, item, asset);}}><Sparkles size={16}/>이 에셋 개선하기</button>}
                  {['needs_attention', 'cancelled'].includes(item.status) && <button type="button" className="production-button" disabled={!desktop || working || (item.kind === 'model' && !localReady)} onClick={() => void runAction('production_retry', run, item)}><RefreshCw size={16}/>이 에셋 다시 제작</button>}</div>
              </div>
            </article>;
          })}</div>
        </article>)}
      </section>
    </div>
  </section>;
}
