import {useEffect, useId, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {AlertTriangle, Ban, Box, Check, Download, FileImage, Layers, LoaderCircle, RefreshCw, X} from 'lucide-react';
import type {Artifact, Asset, Image3DEngine, Local3DStatus, ProjectSnapshot, Quality3DRequest} from '@local-assets/contracts';
import {artifactUrl, command, isNative} from '../lib/bridge';
import './Quality3DPanel.css';

export interface Quality3DPanelProps {
  snapshot: ProjectSnapshot;
  selectedIds: string[];
  native: boolean;
  blenderReady: boolean;
  busy: boolean;
  onSubmit: (request: Quality3DRequest) => Promise<void>;
  onClose: () => void;
}

type Mode = 'image' | 'model';
type Input = {asset: Asset; mode: Mode; artifact: Artifact; thumbnail?: Artifact; highDetail: boolean};
const IMAGE_FORMATS = ['png', 'webp', 'jpeg', 'jpg'];
const MAX_INPUTS = 5;
const MAX_NAME_LENGTH = 72;
const MAX_SEED = 2147483647;
const TRELLIS_MINIMUM_VRAM_MB = 24576;
const TRELLIS_JOB_MINIMUM_MEMORY_MB = 32768;
const INVALID_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/;
const DOWNLOAD_MANIFEST_URL = 'https://github.com/oocheol/masset/blob/master/workers/image3d/runtime-lock-windows.json';
const STATE_LABELS: Record<Local3DStatus['state'], string> = {
  missing: '준비 필요', preparing: '준비 중', ready: '준비 완료', error: '준비 오류',
  cancelled: '준비 취소됨', unsupported: '사용 불가',
};
const ENGINE_STATE_LABELS: Record<string, string> = {
  ready: '구성 확인됨', missing: '준비 필요', requires_setup: '준비 필요',
  experimental: '실험적', unsupported: '사용 불가',
};

function projectInputs(snapshot: ProjectSnapshot): Input[] {
  return snapshot.project.assets.flatMap(asset => {
    // A thumbnail or an old version alone is never a reconstruction input.
    const version = asset.versions.find(item => item.id === asset.activeVersionId);
    const mode: Mode = asset.kind === 'model' ? 'model' : 'image';
    const formats = mode === 'model' ? ['glb'] : IMAGE_FORMATS;
    const eligible = version?.artifacts.filter(item => item.path.trim() && item.bytes > 0 && formats.includes(item.format.toLowerCase()));
    const qualityFiles = version?.settings.quality3dFiles as {high?: unknown} | undefined;
    const high = mode === 'model' && typeof qualityFiles?.high === 'string'
      ? eligible?.find(item => item.id === qualityFiles.high && item.role === 'source') : undefined;
    const artifact = high ?? eligible?.find(item => item.role === 'output') ?? eligible?.find(item => item.role === 'source');
    if (!artifact) return [];
    const thumbnail = version?.artifacts.find(item => item.role === 'thumbnail' && item.path.trim() && IMAGE_FORMATS.includes(item.format.toLowerCase()))
      ?? (mode === 'image' ? artifact : undefined);
    return [{asset, mode, artifact, thumbnail, highDetail: !!high}];
  }).sort((left, right) => Number(right.artifact.format.toLowerCase() === 'png') - Number(left.artifact.format.toLowerCase() === 'png'));
}

function InputThumbnail({input, snapshot}: {input: Input; snapshot: ProjectSnapshot}) {
  const url = artifactUrl(snapshot, input.thumbnail);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className="quality3d-thumbnail" aria-hidden="true">
    {url && url !== failedUrl
      ? <img src={url} alt="" loading="lazy" onError={() => setFailedUrl(url)}/>
      : input.mode === 'model' ? <Box size={30} strokeWidth={1.4}/> : <FileImage size={30} strokeWidth={1.4}/>}
  </span>;
}

// Display known status descriptions, never raw exception text or download URLs.
function safeStatusText(value: string, fallback: string, limit = 400) {
  if (!value || /https?:\/\/|bearer|authorization|(?:access|refresh)[_-]?token|api[_-]?key|[\u0000-\u001f\u007f-\u009f]/i.test(value)) return fallback;
  return Array.from(value).slice(0, limit).join('');
}
function defaultName(assetName?: string) {
  return assetName ? `${Array.from(assetName).slice(0, MAX_NAME_LENGTH - 3).join('')} 3D` : '새 3D 에셋';
}

export default function Quality3DPanel({snapshot, selectedIds, native, blenderReady, busy, onSubmit, onClose}: Quality3DPanelProps) {
  const inputs = projectInputs(snapshot);
  const initialInputs = [...new Set(selectedIds)].map(id => inputs.find(input => input.asset.id === id)).filter((input): input is Input => !!input);
  const [mode, setMode] = useState<Mode>(() => initialInputs[0]?.mode ?? 'image');
  const [inputIds, setInputIds] = useState<string[]>(() => initialInputs.map(input => input.asset.id));
  const [name, setName] = useState(() => defaultName(initialInputs[0]?.asset.name));
  const [nameEdited, setNameEdited] = useState(false);
  const [quality, setQuality] = useState<Quality3DRequest['quality']>('high');
  const [engine, setEngine] = useState<Image3DEngine>('triposr');
  const [seed, setSeed] = useState('0');
  const [runtimeRoot, setRuntimeRoot] = useState('');
  const [distribution, setDistribution] = useState('Ubuntu');
  const [runtimeEdited, setRuntimeEdited] = useState(false);
  const [height, setHeight] = useState('1');
  const [triangles, setTriangles] = useState(() => String(Math.min(snapshot.project.spec.polygonBudget, 10000)));
  const [textureResolution, setTextureResolution] = useState<Quality3DRequest['textureResolution']>(1024);
  const [preserveMaterials, setPreserveMaterials] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Local3DStatus | null>(null);
  const [loading, setLoading] = useState(native && isNative);
  const [operation, setOperation] = useState<'refresh' | 'prepare' | 'cancel' | 'configure' | null>(null);
  const [downloadConsent, setDownloadConsent] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const statusEpoch = useRef(0);
  const operationPending = useRef<number | null>(null);
  const submitPending = useRef(false);
  const mounted = useRef(false);
  const id = useId();
  const desktop = native && isNative;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const epoch = ++statusEpoch.current;
    operationPending.current = null;
    setStatus(null);
    setStatusError('');
    setDownloadConsent(false);
    setOperation(null);
    setLoading(desktop);
    if (desktop) void command<Local3DStatus>({action: 'quality3d_status'}).then(next => {
      if (statusEpoch.current === epoch) setStatus(next);
    }).catch(() => {
      if (statusEpoch.current === epoch) setStatusError('로컬 모델 준비 상태를 확인하지 못했습니다. 다시 확인하세요.');
    }).finally(() => {
      if (statusEpoch.current === epoch) setLoading(false);
    });
    return () => { ++statusEpoch.current; };
  }, [desktop]);

  useEffect(() => {
    if (!desktop || status?.state !== 'preparing' || operation || statusError) return;
    const epoch = statusEpoch.current;
    let active = true;
    // Schedule the next read after the previous read completes: no overlapping polling.
    const timer = window.setTimeout(() => {
      void command<Local3DStatus>({action: 'quality3d_status'}).then(next => {
        if (active && statusEpoch.current === epoch) setStatus(next);
      }).catch(() => {
        if (active && statusEpoch.current === epoch) setStatusError('준비 진행 상태를 확인하지 못했습니다. 다시 확인하세요.');
      });
    }, 1000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [desktop, status, operation, statusError]);

  const selected = inputIds.map(assetId => inputs.find(input => input.asset.id === assetId));
  const firstName = selected[0]?.asset.name;
  useEffect(() => {
    if (!nameEdited) setName(defaultName(firstName));
  }, [firstName, nameEdited]);

  const preparing = status?.state === 'preparing';
  const runtimeReady = !!status?.supported && status.installed && status.state === 'ready' && !statusError;
  const trellisSelected = mode === 'image' && engine === 'trellis2_local';
  const trellis = status?.engines?.find(item => item.id === 'trellis2_local' && item.execution === 'local' && item.requiresImageUpload === false);
  const trellisGpuEligible = typeof trellis?.vramMb === 'number' && Number.isFinite(trellis.vramMb) && trellis.vramMb >= TRELLIS_MINIMUM_VRAM_MB;
  const trellisReady = !!trellis?.available && trellisGpuEligible && ['ready', 'experimental'].includes(trellis.state) && !statusError;
  const inputLimit = trellisSelected ? 1 : MAX_INPUTS;
  useEffect(() => {
    if (runtimeEdited) return;
    if (trellis?.runtimeRoot) setRuntimeRoot(trellis.runtimeRoot);
    if (trellis?.distribution) setDistribution(trellis.distribution);
  }, [trellis?.runtimeRoot, trellis?.distribution, runtimeEdited]);
  const minimumMemoryMb = trellisSelected ? Math.max(TRELLIS_JOB_MINIMUM_MEMORY_MB, status?.minimumMemoryMb ?? TRELLIS_JOB_MINIMUM_MEMORY_MB) : status?.minimumMemoryMb;
  const memoryReady = !!status && typeof minimumMemoryMb === 'number' && Number.isFinite(status.memoryMb) && Number.isFinite(minimumMemoryMb) && minimumMemoryMb > 0 && status.memoryMb >= minimumMemoryMb;
  const minimumMemoryGb = typeof minimumMemoryMb === 'number' && Number.isFinite(minimumMemoryMb) && minimumMemoryMb > 0 ? (minimumMemoryMb / 1024).toLocaleString('ko-KR') : trellisSelected ? '32' : '16';
  const memoryError = status && !memoryReady ? trellisSelected
    ? `TRELLIS.2는 앱 작업 예산 때문에 시스템 메모리 ${minimumMemoryGb} GB 이상이 필요합니다. 현재 기기의 메모리가 부족하거나 확인되지 않았습니다.`
    : `로컬 이미지 재구성에는 최소 ${minimumMemoryGb} GB 메모리가 필요합니다. 현재 기기의 메모리가 부족하거나 확인되지 않았습니다.` : '';
  const working = busy || submitting;
  const setupBlocked = working || loading || operation !== null || preparing || !!status?.busy;
  const setupAllowed = desktop && !trellisSelected && !!status?.supported && memoryReady && !runtimeReady && !setupBlocked && downloadConsent;
  const showRuntimeConfiguration = desktop && trellisSelected && trellis?.state === 'requires_setup' && trellisGpuEligible;
  const runtimeConfigurationError = !runtimeRoot.trim().startsWith('/') || runtimeRoot.trim().length > 512 || /[\u0000-\u001f\u007f-\u009f\\]/.test(runtimeRoot)
    ? 'Linux 실행 환경 폴더의 절대 경로를 입력하세요. 예: /home/user/trellis2-runtime'
    : !distribution.trim() || distribution.trim().length > 128 || /[\u0000-\u001f\u007f-\u009f/\\]/.test(distribution) ? '준비한 WSL 배포판 이름을 입력하세요. 예: Ubuntu' : '';
  const canConfigureRuntime = showRuntimeConfiguration && !setupBlocked && !runtimeConfigurationError;
  const download = status?.download && Number.isSafeInteger(status.download.totalBytes) && status.download.totalBytes > 0 ? status.download : null;
  const downloadSize = download ? `${(download.totalBytes / (1024 ** 3)).toLocaleString('ko-KR', {minimumFractionDigits: 2, maximumFractionDigits: 2})} GiB` : null;
  const selectionError = !inputIds.length ? trellisSelected ? '프로젝트에서 입력 이미지 1개를 선택하세요.' : '프로젝트에서 입력 에셋을 1~5개 선택하세요.'
    : inputIds.length > inputLimit ? trellisSelected ? 'TRELLIS.2는 한 번에 이미지 1개를 처리합니다. 나머지 선택을 해제하세요.' : '한 번에 최대 5개까지 선택할 수 있습니다. 선택을 줄이세요.'
    : selected.some(input => !input) ? '선택한 입력의 현재 파일을 사용할 수 없습니다. 다른 에셋을 선택하세요.'
    : selected.some(input => input?.mode !== mode) ? '이미지와 GLB는 나누어 선택하세요. 제작 방식을 선택하면 해당 형식만 남습니다.' : '';
  const heightMeters = Number(height);
  const numericSeed = Number(seed);
  const maxTriangles = Number(triangles);
  const triangleLimit = Math.min(100000, snapshot.project.spec.polygonBudget);
  const projectBudgetError = !Number.isFinite(triangleLimit) || triangleLimit < 1000
    ? '프로젝트 삼각형 예산은 1,000 이상이어야 합니다. 프로젝트 규격을 먼저 수정하세요.' : '';
  const fieldError = projectBudgetError || (!name.trim() || Array.from(name.trim()).length > MAX_NAME_LENGTH ? '결과 이름을 1~72자로 입력하세요.'
    : INVALID_NAME_CHARACTERS.test(name.trim()) || ['.', '..'].includes(name.trim()) ? '결과 이름에는 경로 문자나 제어 문자를 사용할 수 없습니다.'
    : !height.trim() || !Number.isFinite(heightMeters) || heightMeters < .03 || heightMeters > 100 ? '높이는 0.03~100 m 범위로 입력하세요.'
    : !triangles.trim() || !Number.isInteger(maxTriangles) || maxTriangles < 1000 || maxTriangles > triangleLimit ? `삼각형 예산은 1,000~${triangleLimit.toLocaleString('ko-KR')} 범위의 정수로 입력하세요.`
    : trellisSelected && (!seed.trim() || !Number.isInteger(numericSeed) || numericSeed < 0 || numericSeed > MAX_SEED) ? '시드는 0~2,147,483,647 범위의 정수로 입력하세요.' : '');
  const browserMessage = mode === 'image' ? '이미지에서3D는 Windows x64 또는 Apple Silicon Mac 데스크톱 앱에서 실행하세요.' : '모델다듬기는 Blender가 준비된 데스크톱 앱에서 실행하세요.';
  const environmentError = !desktop ? browserMessage
    : mode === 'image' && !trellisSelected && status?.supported === false ? '이 기기에서는 이미지→3D를 지원하지 않습니다. Windows x64 또는 Apple Silicon Mac 앱에서 사용하세요.'
    : !blenderReady ? 'Blender 준비가 필요합니다. 환경 정보에서 설치 상태를 확인하세요.'
    : operation === 'configure' ? '로컬 실행 환경 연결이 끝난 뒤 작업을 시작하세요.'
    : preparing || operation === 'prepare' || operation === 'cancel' ? '로컬 모델 준비가 끝난 뒤 작업을 시작하세요.'
    : status?.busy ? '로컬 3D 작업이 사용 중입니다. 현재 작업이 끝난 뒤 시작하세요.'
    : mode === 'image' && (loading || operation === 'refresh') ? '로컬 모델 준비 상태를 확인 중입니다.'
    : mode === 'image' && statusError ? '로컬 모델 준비 상태를 다시 확인하세요.'
    : mode === 'image' && memoryError ? memoryError
    : trellisSelected && trellis?.available && !trellisGpuEligible ? '로컬 TRELLIS.2에는 확인된 NVIDIA VRAM 24 GB 이상이 필요합니다. GPU 사양을 다시 확인하세요.'
    : trellisSelected && !trellisReady ? safeStatusText(trellis?.reason ?? '', '로컬 TRELLIS.2 실행 환경과 GPU 사양을 확인해야 합니다. 준비 상태를 다시 확인하세요.')
    : mode === 'image' && !trellisSelected && !runtimeReady ? '이미지에서 3D를 만들려면 로컬 TripoSR 모델을 먼저 준비하세요.' : '';
  const canSubmit = !working && !selectionError && !fieldError && !environmentError;
  const available = inputs.filter(input => input.mode === mode && input.asset.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  function chooseMode(next: Mode) {
    if (working) return;
    setMode(next);
    setInputIds(ids => ids.filter(assetId => inputs.some(input => input.asset.id === assetId && input.mode === next)));
    setSearch('');
    setSubmitError('');
  }
  function toggleInput(assetId: string) {
    if (working) return;
    setInputIds(ids => ids.includes(assetId) ? ids.filter(item => item !== assetId) : ids.length < inputLimit ? [...ids, assetId] : ids);
    setSubmitError('');
  }
  function chooseEngine(next: Image3DEngine) {
    if (working || next === engine) return;
    setEngine(next);
    setDownloadConsent(false);
    setSubmitError('');
  }

  async function updateStatus(action: 'quality3d_status' | 'quality3d_prepare' | 'quality3d_cancel_setup' | 'quality3d_open_download_info' | 'quality3d_open_runtime_guide') {
    if (!desktop || operationPending.current !== null || working) return;
    if (action === 'quality3d_prepare' && !setupAllowed) return;
    if (action === 'quality3d_cancel_setup' && !preparing) return;
    const epoch = ++statusEpoch.current;
    operationPending.current = epoch;
    setOperation(action === 'quality3d_prepare' ? 'prepare' : action === 'quality3d_cancel_setup' ? 'cancel' : 'refresh');
    setStatusError('');
    try {
      const next = await command<Local3DStatus>(action === 'quality3d_prepare' ? {action, confirmed: true} : {action});
      if (statusEpoch.current === epoch) setStatus(next);
    } catch {
      if (statusEpoch.current === epoch) setStatusError(action === 'quality3d_cancel_setup'
        ? '준비 취소를 확인하지 못했습니다. 현재 상태를 다시 확인하세요.'
        : action === 'quality3d_open_download_info' || action === 'quality3d_open_runtime_guide' ? '안내 페이지를 열지 못했습니다. 기본 브라우저 설정을 확인하세요.'
        : '로컬 모델 준비 요청을 처리하지 못했습니다. 상태를 다시 확인하세요.');
    } finally {
      if (operationPending.current === epoch) operationPending.current = null;
      if (statusEpoch.current === epoch) {
        setOperation(null);
        if (action === 'quality3d_prepare') setDownloadConsent(false);
      }
    }
  }
  async function configureRuntime() {
    if (!canConfigureRuntime || operationPending.current !== null) return;
    const epoch = ++statusEpoch.current;
    operationPending.current = epoch;
    setOperation('configure');
    setStatusError('');
    try {
      const next = await command<Local3DStatus>({action: 'quality3d_trellis_configure', runtimeRoot: runtimeRoot.trim(), distribution: distribution.trim()});
      if (statusEpoch.current === epoch) setStatus(next);
    } catch {
      if (statusEpoch.current === epoch) setStatusError('로컬 실행 환경 연결을 확인하지 못했습니다. 준비 상태를 다시 확인하세요.');
    } finally {
      if (operationPending.current === epoch) operationPending.current = null;
      if (statusEpoch.current === epoch) setOperation(null);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || submitPending.current) return;
    submitPending.current = true;
    setSubmitting(true);
    setSubmitError('');
    const request: Quality3DRequest = {assetIds: [...inputIds], name: name.trim(), quality, heightMeters, maxTriangles, textureResolution, preserveMaterials,
      ...(trellisSelected ? {engine: 'trellis2_local' as const, seed: numericSeed} : {})};
    try { await onSubmit(request); }
    catch { if (mounted.current) setSubmitError('정밀3D 작업을 제출하지 못했습니다. 입력과 환경을 확인한 뒤 다시 시도하세요.'); }
    finally {
      submitPending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  return <section className="quality3d-panel" aria-labelledby={`${id}-title`}>
    <header className="quality3d-heading">
      <div><h3 id={`${id}-title`}><Box size={20}/>정밀3D</h3><p>프로젝트의 로컬 입력으로 만들고, 원본과 결과를 함께 보관합니다.</p></div>
      <span className="quality3d-local-tag">로컬 처리 · 이미지 외부 전송 없음</span>
    </header>
    {!desktop && <p className="quality3d-notice" role="status">{browserMessage}</p>}
    <form onSubmit={submit} noValidate>
      <div className="quality3d-modes" role="group" aria-label="제작 방식">
        <button type="button" aria-pressed={mode === 'image'} disabled={working} onClick={() => chooseMode('image')}>
          <FileImage size={20}/><span><strong>이미지에서3D</strong><small>PNG · JPEG · WebP, 이미지마다 하나의 모델</small></span>{mode === 'image' && <Check size={16}/>}</button>
        <button type="button" aria-pressed={mode === 'model'} disabled={working} onClick={() => chooseMode('model')}>
          <Layers size={20}/><span><strong>모델다듬기</strong><small>기존 GLB를 보존하며 새 버전 제작</small></span>{mode === 'model' && <Check size={16}/>}</button>
      </div>
      {mode === 'image' && <section className="quality3d-engine-section" aria-labelledby={`${id}-engine`}>
        <div className="quality3d-section-heading"><h4 id={`${id}-engine`}>이미지→3D 엔진</h4><span>기본은 로컬 CPU</span></div>
        <div className="quality3d-engines" role="group" aria-label="이미지→3D 엔진 선택">
          <button type="button" aria-pressed={engine === 'triposr'} disabled={working} onClick={() => chooseEngine('triposr')}>
            <span><strong>TripoSR · 로컬 CPU</strong><small>Windows x64 · Apple Silicon Mac<br/>메모리 16 GB · GPU 없이 사용</small></span>{engine === 'triposr' && <Check size={17}/>}
          </button>
          <button type="button" aria-pressed={engine === 'trellis2_local'} disabled={working} onClick={() => chooseEngine('trellis2_local')}>
            <span><strong>TRELLIS.2 · 로컬 GPU</strong><small>NVIDIA VRAM 24 GB 이상<br/>앱 작업 예산: 시스템 메모리 32 GB 이상<br/>Windows WSL2 경로는 실험적</small></span>{engine === 'trellis2_local' && <Check size={17}/>}
          </button>
        </div>
        <p className="quality3d-help">두 경로 모두 입력 이미지를 외부로 전송하지 않습니다. 선택한 엔진이 실패해도 다른 모델로 자동 전환하지 않습니다.</p>
      </section>}
      <div className="quality3d-columns">
        <section className="quality3d-input-section" aria-labelledby={`${id}-inputs`}>
          <div className="quality3d-section-heading"><h4 id={`${id}-inputs`}>프로젝트 입력</h4><span>{inputIds.length} / {inputLimit}개</span></div>
          <p className="quality3d-help">{mode === 'image' ? '배경이 투명한 PNG·WebP에 물체 하나를 담아 주세요. 불투명 이미지와 JPEG는 2D 편집기에서 배경을 제거하고 PNG로 저장한 뒤 사용하세요.' : '현재 버전에 GLB 원본 또는 결과 파일이 있는 모델을 선택하세요. 보존된 고해상도 형상이 있으면 우선 사용합니다.'}</p>
          <label className="quality3d-search"><span className="quality3d-sr-only">프로젝트 입력 검색</span><input type="search" placeholder="에셋 이름 검색" value={search} disabled={working} onChange={event => setSearch(event.target.value)}/></label>
          <div className="quality3d-input-grid" role="group" aria-label="프로젝트 에셋 선택">
            {available.map(input => {
              const checked = inputIds.includes(input.asset.id);
              return <button type="button" className={`quality3d-input ${checked ? 'selected' : ''}`} key={input.asset.id} aria-label={`${input.asset.name} 선택`} aria-pressed={checked} disabled={working || (!checked && inputIds.length >= inputLimit)} onClick={() => toggleInput(input.asset.id)}>
                <InputThumbnail input={input} snapshot={snapshot}/>
                <span className="quality3d-input-info"><strong>{input.asset.name}</strong><small>{input.artifact.format.toUpperCase()} · {input.mode === 'image' ? `${input.asset.width ?? '—'} × ${input.asset.height ?? '—'} px` : input.highDetail ? '고해상도 형상' : `${input.asset.mesh?.triangles?.toLocaleString('ko-KR') ?? '—'} triangles`}</small></span>
                <span className="quality3d-selection-check" aria-hidden="true">{checked && <Check size={12}/>}</span>
              </button>;
            })}
            {!available.length && <p className="quality3d-empty">{search ? '검색 결과가 없습니다.' : mode === 'image' ? '사용 가능한 PNG·JPEG·WebP가 없습니다. 프로젝트에 이미지를 가져온 뒤 다시 열어 주세요.' : '사용 가능한 GLB가 없습니다. 프로젝트에 모델을 가져온 뒤 다시 열어 주세요.'}</p>}
          </div>
          <div className="quality3d-chips" role="group" aria-label="선택한 입력">
            {inputIds.map(assetId => {
              const input = inputs.find(item => item.asset.id === assetId);
              return <button type="button" key={assetId} aria-label={`${input?.asset.name ?? '사용 불가 입력'} 선택 해제`} disabled={working} onClick={() => toggleInput(assetId)}>
                {input && <InputThumbnail input={input} snapshot={snapshot}/>}<span>{input?.asset.name ?? '사용 불가 입력'}</span><small>{input?.mode === 'model' ? 'GLB' : '이미지'}</small><X size={13}/>
              </button>;
            })}
          </div>
          {selectionError && <p className="quality3d-help quality3d-warning" role="status">{selectionError}</p>}
        </section>
        <fieldset className="quality3d-settings" disabled={working}>
          <legend>결과 설정</legend>
          <div className="quality3d-field"><label htmlFor={`${id}-name`}>결과 이름</label><input id={`${id}-name`} aria-describedby={`${id}-name-help`} value={name} required onChange={event => {setNameEdited(true); setName(event.target.value);}}/><small id={`${id}-name-help`}>1~72자 · 여러 입력은 이름에 접미사를 붙여 구분합니다.</small></div>
          {mode === 'image' && <div className="quality3d-field"><label htmlFor={`${id}-quality`}>형상 추정 품질</label><select id={`${id}-quality`} aria-describedby={`${id}-quality-help`} value={quality} onChange={event => setQuality(event.target.value as Quality3DRequest['quality'])}>
            <option value="draft">초안 · Draft</option><option value="standard">표준 · Standard</option><option value="high">높음 · High</option>
          </select><small id={`${id}-quality-help`}>초안은 빠르게 형상을 확인하고, 높음은 더 오래 걸리며 세부 형상을 추정합니다.</small></div>}
          {trellisSelected && <div className="quality3d-field"><label htmlFor={`${id}-seed`}>생성 시드</label><input id={`${id}-seed`} aria-describedby={`${id}-seed-help`} type="number" value={seed} required min={0} max={MAX_SEED} step={1} onChange={event => setSeed(event.target.value)}/><small id={`${id}-seed-help`}>0~2,147,483,647 · 같은 입력·설정의 결과 비교에 사용합니다.</small></div>}
          <div className="quality3d-settings-pair">
            <div className="quality3d-field"><label htmlFor={`${id}-height`}>높이 (m)</label><input id={`${id}-height`} aria-describedby={`${id}-height-help`} type="number" value={height} required min={.03} max={100} step="any" onChange={event => setHeight(event.target.value)}/><small id={`${id}-height-help`}>0.03~100 m</small></div>
            <div className="quality3d-field"><label htmlFor={`${id}-triangles`}>삼각형 예산</label><input id={`${id}-triangles`} aria-describedby={`${id}-triangles-help`} type="number" value={triangles} required min={1000} max={triangleLimit} step={1} onChange={event => setTriangles(event.target.value)}/><small id={`${id}-triangles-help`}>{projectBudgetError ? '프로젝트 예산 수정 필요' : `1,000~${triangleLimit.toLocaleString('ko-KR')} · 프로젝트 예산 이내`}</small></div>
          </div>
          <div className="quality3d-field"><label htmlFor={`${id}-texture`}>텍스처 크기</label><select id={`${id}-texture`} value={textureResolution} onChange={event => setTextureResolution(Number(event.target.value) as Quality3DRequest['textureResolution'])}>
            <option value={512}>512 × 512</option><option value={1024}>1024 × 1024</option><option value={2048}>2048 × 2048</option>
          </select></div>
          <label className="quality3d-check"><input type="checkbox" checked={preserveMaterials} onChange={event => setPreserveMaterials(event.target.checked)}/><span>원본 재질·색상 보존</span></label>
          {fieldError && <p className="quality3d-warning" role="status">{fieldError}</p>}
        </fieldset>
      </div>
      <section className="quality3d-runtime" aria-labelledby={`${id}-runtime`}>
        <div className="quality3d-section-heading"><h4 id={`${id}-runtime`}>{mode === 'model' ? 'Blender 준비' : trellisSelected ? '로컬 TRELLIS.2 준비' : '로컬 TripoSR 준비'}</h4><span className={`quality3d-state ${desktop && (mode === 'model' ? blenderReady : trellisSelected ? trellisReady : runtimeReady) ? 'ready' : ''}`}>
          {!desktop ? '데스크톱 전용' : mode === 'model' ? blenderReady ? '준비 완료' : '준비 필요' : loading ? '확인 중' : statusError ? '확인 필요' : trellisSelected ? ENGINE_STATE_LABELS[trellis?.state ?? 'missing'] ?? '확인 필요' : status?.state === 'ready' && !runtimeReady ? '확인 필요' : status ? STATE_LABELS[status.state] : '확인 필요'}</span></div>
        {trellisSelected ? <>
          <p className="quality3d-help">공식 로컬 실행 환경은 Linux와 NVIDIA GPU이며 최소 VRAM 24 GB가 필요합니다. Windows WSL2 연결은 실험적입니다. Apple Silicon Mac의 CUDA 실행을 지원한다고 표시하지 않습니다.</p>
          <p className="quality3d-help">로컬 Blender와 앱 작업 예산에 따른 시스템 메모리 32 GB 이상이 필요합니다. 별도로 준비한 TRELLIS.2 실행 환경·모델을 확인한 뒤 사용하며, TripoSR 설치 여부와는 별개입니다.</p>
          {desktop && trellis?.gpuName && <p className="quality3d-help">확인된 GPU: {safeStatusText(trellis.gpuName, 'GPU 정보 확인 필요', 120)}{typeof trellis.vramMb === 'number' && Number.isFinite(trellis.vramMb) ? ` · VRAM ${(trellis.vramMb / 1024).toLocaleString('ko-KR', {maximumFractionDigits: 1})} GB` : ''}</p>}
          {desktop && trellis && <p className="quality3d-runtime-message" role="status">{safeStatusText(trellis.reason, 'TRELLIS.2 실행 환경을 확인하세요.')}</p>}
          {trellis?.state === 'experimental' && <p className="quality3d-runtime-phase" role="status">로컬 실행 환경 연결 · 실행 전 모델 해시 검사 · 실제 생성 미검증</p>}
          <p className="quality3d-help">추가 의존성의 이용 조건을 검토해야 하는 실험적 경로입니다. 구성 확인은 실제 생성 품질·상업적 이용 권리를 검증했다는 뜻이 아닙니다.</p>
          {showRuntimeConfiguration && <fieldset className="quality3d-runtime-configuration" disabled={setupBlocked}>
            <legend>준비한 WSL 실행 환경 연결</legend>
            <p className="quality3d-help">Linux 안에 모델과 의존성을 준비한 폴더를 입력하세요. 이 연결은 파일을 내려받거나 Python을 설치하지 않습니다.</p>
            <div className="quality3d-settings-pair">
              <div className="quality3d-field"><label htmlFor={`${id}-distribution`}>WSL 배포판</label><input id={`${id}-distribution`} value={distribution} placeholder="Ubuntu" onChange={event => {setRuntimeEdited(true); setDistribution(event.target.value);}}/></div>
              <div className="quality3d-field"><label htmlFor={`${id}-runtime-root`}>Linux 실행 환경 폴더</label><input id={`${id}-runtime-root`} aria-describedby={`${id}-runtime-root-help`} value={runtimeRoot} placeholder="/home/user/trellis2-runtime" onChange={event => {setRuntimeEdited(true); setRuntimeRoot(event.target.value);}}/><small id={`${id}-runtime-root-help`}>이 폴더의 venv/bin/python을 확인합니다.</small></div>
            </div>
            {runtimeEdited && runtimeConfigurationError && <p className="quality3d-warning" role="status">{runtimeConfigurationError}</p>}
            <button className="quality3d-button" type="button" disabled={!canConfigureRuntime} onClick={() => void configureRuntime()}>{operation === 'configure' && <LoaderCircle size={15} className="quality3d-spin"/>}로컬 런타임 연결</button>
          </fieldset>}
          {memoryError && <p className="quality3d-warning">{memoryError}</p>}
          {statusError && <p className="quality3d-warning" role="alert">{statusError}</p>}
          <div className="quality3d-runtime-actions"><button className="quality3d-button" type="button" disabled={!desktop || working || loading || operation !== null || (preparing && !statusError)} onClick={() => void updateStatus('quality3d_status')}><RefreshCw size={15}/>준비 상태 다시 확인</button></div>
        </> : mode === 'image' ? <>
          <p className="quality3d-help">Windows x64 · Apple Silicon Mac에서 로컬 CPU로 처리합니다. 최소 메모리 16 GB와 Blender가 필요합니다.</p>
          <p className="quality3d-help">{download ? `Python·모델·의존성을 처음 한 번 총 약 ${downloadSize} 준비합니다. Python을 따로 설치할 필요가 없습니다.` : '처음 한 번 모델 가중치(약 1.68 GB)와 의존성을 준비합니다. 아래 상태 안내를 확인하고 다운로드에 동의하세요.'}</p>
          {runtimeReady && <p className="quality3d-help">준비 완료는 로컬 설치가 검증되었다는 뜻입니다. 생성된 형상과 텍스처 품질은 결과를 보고 확인하세요.</p>}
          {desktop && status && <p className="quality3d-runtime-message" role="status">{preparing && <LoaderCircle size={15} className="quality3d-spin"/>}{safeStatusText(status.message, STATE_LABELS[status.state])}</p>}
          {desktop && preparing && status.stage && <p className="quality3d-runtime-phase" role="status">현재 단계: {safeStatusText(status.stage, '준비 중', 120)}</p>}
          {memoryError && <p className="quality3d-warning">{memoryError}</p>}
          {statusError && <p className="quality3d-warning" role="alert">{statusError}</p>}
          {download && <details className="quality3d-limits quality3d-download-info"><summary>다운로드 정보</summary>
            <p>실행 환경: {safeStatusText(download.runtime, '실행 환경 정보 확인 필요')}</p>
            <p>전체 용량: {download.totalBytes.toLocaleString('ko-KR')} 바이트 (약 {downloadSize})</p>
            <p>공식 출처: {download.sources.map(source => safeStatusText(source, '출처 확인 필요', 120)).join(' · ')}</p>
            <p>라이선스: {download.licenses.map(license => safeStatusText(license, '라이선스 확인 필요', 120)).join(' · ')}</p>
            <p>Microsoft Visual C++ x64 실행 라이브러리 필요</p>
            <button className="quality3d-button" type="button" disabled={!desktop || working || loading || operation !== null} onClick={() => void updateStatus('quality3d_open_runtime_guide')}>Windows 실행 라이브러리 안내</button>
            {download.manifestUrl === DOWNLOAD_MANIFEST_URL && (desktop
              ? <button className="quality3d-button" type="button" disabled={working || loading || operation !== null} onClick={() => void updateStatus('quality3d_open_download_info')}>파일별 버전·출처·SHA-256 보기</button>
              : <a className="quality3d-button" href={DOWNLOAD_MANIFEST_URL} target="_blank" rel="noopener noreferrer">파일별 버전·출처·SHA-256 보기</a>)}
          </details>}
          {!runtimeReady && !preparing && <label className="quality3d-check quality3d-consent"><input type="checkbox" checked={downloadConsent} disabled={!desktop || !status?.supported || !memoryReady || setupBlocked} onChange={event => setDownloadConsent(event.target.checked)}/><span>{download ? `Python·TripoSR 모델·의존성(총 약 ${downloadSize})의 1회 다운로드에 동의합니다.` : 'TripoSR 가중치(약 1.68 GB)와 의존성의 1회 다운로드에 동의합니다.'}</span></label>}
          <div className="quality3d-runtime-actions">
            {!runtimeReady && !preparing && <button className="quality3d-button" type="button" disabled={!setupAllowed} onClick={() => void updateStatus('quality3d_prepare')}>{operation === 'prepare' ? <LoaderCircle size={15} className="quality3d-spin"/> : <Download size={15}/>}로컬 모델 준비</button>}
            {preparing && <button className="quality3d-button" type="button" disabled={!desktop || working || operation !== null} onClick={() => void updateStatus('quality3d_cancel_setup')}>{operation === 'cancel' ? <LoaderCircle size={15} className="quality3d-spin"/> : <Ban size={15}/>}준비 취소</button>}
            <button className="quality3d-button" type="button" disabled={!desktop || working || loading || operation !== null || (preparing && !statusError)} onClick={() => void updateStatus('quality3d_status')}><RefreshCw size={15}/>준비 상태 다시 확인</button>
          </div>
        </> : <p className="quality3d-help">기존 GLB 다듬기는 TripoSR 설치가 필요 없습니다. Blender로 기존 형상과 색상을 보존하며 UV·텍스처 베이크, LOD·노멀 맵을 준비합니다. 원본 GLB는 유지하고 새 버전으로 저장합니다.</p>}
      </section>
      <div className="quality3d-output-summary"><Box size={20}/><div><strong>{inputIds.length ? mode === 'image' ? `이미지 ${inputIds.length}개 → 개별 3D 에셋 ${inputIds.length}개` : `GLB ${inputIds.length}개 → 각각 새 다듬기 버전` : '입력마다 독립적인 결과'}</strong><p>GLB · .blend · 텍스처 · LOD · 턴테이블</p></div></div>
      <details className="quality3d-limits">
        <summary><AlertTriangle size={15}/>결과와 처리 시간 안내</summary>
        {mode === 'image' && (trellisSelected
          ? <p>TRELLIS.2도 단일 이미지에 보이지 않는 뒷면과 가려진 부분을 추정합니다. 형상·PBR 재질을 로컬 Blender로 다듬고, 생성 결과의 파일 검증과 게임 활용성을 확인하세요. GPU 사양과 품질 설정에 따라 처리 시간과 메모리 사용량이 달라집니다.</p>
          : <p>실제 로컬 TripoSR은 구형 단일 이미지 모델입니다. 최신 Tripo Studio H3.1이나 8K 품질과 동등하지 않습니다. 투명 배경의 단일 물체를 권장하며, 보이지 않는 뒷면은 추정합니다. CPU 처리에는 몇 분 이상 걸릴 수 있습니다.</p>)}
        <p>유료 API를 사용하지 않으며 입력 이미지를 외부로 전송하지 않습니다. 다운로드 동의는 모델·의존성 준비에만 적용됩니다.</p>
        <p>자동 리깅, 쿼드 리토폴로지, 새로운 사실적 디테일 생성을 제공하지 않습니다. 원본 입력을 보존하고 결과를 새 에셋 또는 새 버전으로 저장합니다.</p>
      </details>
      {environmentError && desktop && <p className="quality3d-warning" role="status">{environmentError}</p>}
      {submitError && <p className="quality3d-warning" role="alert">{submitError}</p>}
      <footer className="quality3d-actions"><button type="button" className="quality3d-button" disabled={working} onClick={onClose}>닫기</button><button type="submit" className="quality3d-button primary" disabled={!canSubmit}>
        {submitting ? <LoaderCircle size={16} className="quality3d-spin"/> : <Box size={16}/>}<span>{submitting ? '요청 제출 중' : mode === 'image' ? '이미지에서3D 만들기' : '모델다듬기 새 버전 만들기'}</span>
      </button></footer>
    </form>
  </section>;
}
