import {useEffect, useId, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {AlertTriangle, Ban, Box, Check, Download, FileImage, Layers, LoaderCircle, RefreshCw, X} from 'lucide-react';
import type {Artifact, Asset, Local3DStatus, ProjectSnapshot, Quality3DRequest} from '@local-assets/contracts';
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
const INVALID_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/;
const STATE_LABELS: Record<Local3DStatus['state'], string> = {
  missing: '준비 필요', preparing: '준비 중', ready: '준비 완료', error: '준비 오류',
  cancelled: '준비 취소됨', unsupported: '사용 불가',
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
  const [height, setHeight] = useState('1');
  const [triangles, setTriangles] = useState(() => String(Math.min(snapshot.project.spec.polygonBudget, 10000)));
  const [textureResolution, setTextureResolution] = useState<Quality3DRequest['textureResolution']>(1024);
  const [preserveMaterials, setPreserveMaterials] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Local3DStatus | null>(null);
  const [loading, setLoading] = useState(native && isNative);
  const [operation, setOperation] = useState<'refresh' | 'prepare' | 'cancel' | null>(null);
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
  const memoryReady = !!status && Number.isFinite(status.memoryMb) && Number.isFinite(status.minimumMemoryMb) && status.minimumMemoryMb > 0 && status.memoryMb >= status.minimumMemoryMb;
  const memoryError = status && !memoryReady ? `로컬 이미지 재구성에는 최소 ${Number.isFinite(status.minimumMemoryMb) && status.minimumMemoryMb > 0 ? (status.minimumMemoryMb / 1024).toLocaleString('ko-KR') : '16'} GB 메모리가 필요합니다. 현재 기기의 메모리가 부족하거나 확인되지 않았습니다.` : '';
  const working = busy || submitting;
  const setupBlocked = working || loading || operation !== null || preparing || !!status?.busy;
  const setupAllowed = desktop && !!status?.supported && memoryReady && !runtimeReady && !setupBlocked && downloadConsent;
  const selectionError = !inputIds.length ? '프로젝트에서 입력 에셋을 1~5개 선택하세요.'
    : inputIds.length > MAX_INPUTS ? '한 번에 최대 5개까지 선택할 수 있습니다. 선택을 줄이세요.'
    : selected.some(input => !input) ? '선택한 입력의 현재 파일을 사용할 수 없습니다. 다른 에셋을 선택하세요.'
    : selected.some(input => input?.mode !== mode) ? '이미지와 GLB는 나누어 선택하세요. 제작 방식을 선택하면 해당 형식만 남습니다.' : '';
  const heightMeters = Number(height);
  const maxTriangles = Number(triangles);
  const triangleLimit = Math.min(100000, snapshot.project.spec.polygonBudget);
  const projectBudgetError = !Number.isFinite(triangleLimit) || triangleLimit < 1000
    ? '프로젝트 삼각형 예산은 1,000 이상이어야 합니다. 프로젝트 규격을 먼저 수정하세요.' : '';
  const fieldError = projectBudgetError || (!name.trim() || Array.from(name.trim()).length > MAX_NAME_LENGTH ? '결과 이름을 1~72자로 입력하세요.'
    : INVALID_NAME_CHARACTERS.test(name.trim()) || ['.', '..'].includes(name.trim()) ? '결과 이름에는 경로 문자나 제어 문자를 사용할 수 없습니다.'
    : !height.trim() || !Number.isFinite(heightMeters) || heightMeters < .03 || heightMeters > 100 ? '높이는 0.03~100 m 범위로 입력하세요.'
    : !triangles.trim() || !Number.isInteger(maxTriangles) || maxTriangles < 1000 || maxTriangles > triangleLimit ? `삼각형 예산은 1,000~${triangleLimit.toLocaleString('ko-KR')} 범위의 정수로 입력하세요.` : '');
  const browserMessage = mode === 'image' ? '브라우저에서는 사용할 수 없습니다. 이미지에서3D는 Apple Silicon Mac 데스크톱 앱에서 실행하세요.' : '브라우저에서는 사용할 수 없습니다. 모델다듬기는 Blender가 준비된 데스크톱 앱에서 실행하세요.';
  const environmentError = !desktop ? browserMessage
    : !blenderReady ? 'Blender 준비가 필요합니다. 환경 정보에서 설치 상태를 확인하세요.'
    : preparing || operation === 'prepare' || operation === 'cancel' ? '로컬 모델 준비가 끝난 뒤 작업을 시작하세요.'
    : status?.busy ? '로컬 3D 작업이 사용 중입니다. 현재 작업이 끝난 뒤 시작하세요.'
    : mode === 'image' && (loading || operation === 'refresh') ? '로컬 모델 준비 상태를 확인 중입니다.'
    : mode === 'image' && statusError ? '로컬 모델 준비 상태를 다시 확인하세요.'
    : mode === 'image' && memoryError ? memoryError
    : mode === 'image' && !runtimeReady ? '이미지에서 3D를 만들려면 로컬 TripoSR 모델을 먼저 준비하세요.' : '';
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
    setInputIds(ids => ids.includes(assetId) ? ids.filter(item => item !== assetId) : ids.length < MAX_INPUTS ? [...ids, assetId] : ids);
    setSubmitError('');
  }

  async function updateStatus(action: 'quality3d_status' | 'quality3d_prepare' | 'quality3d_cancel_setup') {
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
        : '로컬 모델 준비 요청을 처리하지 못했습니다. 상태를 다시 확인하세요.');
    } finally {
      if (operationPending.current === epoch) operationPending.current = null;
      if (statusEpoch.current === epoch) {
        setOperation(null);
        if (action === 'quality3d_prepare') setDownloadConsent(false);
      }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || submitPending.current) return;
    submitPending.current = true;
    setSubmitting(true);
    setSubmitError('');
    const request: Quality3DRequest = {assetIds: [...inputIds], name: name.trim(), quality, heightMeters, maxTriangles, textureResolution, preserveMaterials};
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
      <div className="quality3d-columns">
        <section className="quality3d-input-section" aria-labelledby={`${id}-inputs`}>
          <div className="quality3d-section-heading"><h4 id={`${id}-inputs`}>프로젝트 입력</h4><span>{inputIds.length} / {MAX_INPUTS}개</span></div>
          <p className="quality3d-help">{mode === 'image' ? '배경이 투명한 PNG·WebP에 물체 하나를 담아 주세요. 불투명 이미지와 JPEG는 2D 편집기에서 배경을 제거하고 PNG로 저장한 뒤 사용하세요.' : '현재 버전에 GLB 원본 또는 결과 파일이 있는 모델을 선택하세요. 보존된 고해상도 형상이 있으면 우선 사용합니다.'}</p>
          <label className="quality3d-search"><span className="quality3d-sr-only">프로젝트 입력 검색</span><input type="search" placeholder="에셋 이름 검색" value={search} disabled={working} onChange={event => setSearch(event.target.value)}/></label>
          <div className="quality3d-input-grid" role="group" aria-label="프로젝트 에셋 선택">
            {available.map(input => {
              const checked = inputIds.includes(input.asset.id);
              return <button type="button" className={`quality3d-input ${checked ? 'selected' : ''}`} key={input.asset.id} aria-label={`${input.asset.name} 선택`} aria-pressed={checked} disabled={working || (!checked && inputIds.length >= MAX_INPUTS)} onClick={() => toggleInput(input.asset.id)}>
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
        <div className="quality3d-section-heading"><h4 id={`${id}-runtime`}>{mode === 'image' ? '로컬 TripoSR 준비' : 'Blender 준비'}</h4><span className={`quality3d-state ${desktop && (mode === 'model' ? blenderReady : runtimeReady) ? 'ready' : ''}`}>
          {!desktop ? '데스크톱 전용' : mode === 'model' ? blenderReady ? '준비 완료' : '준비 필요' : loading ? '확인 중' : statusError || (status?.state === 'ready' && !runtimeReady) ? '확인 필요' : status ? STATE_LABELS[status.state] : '확인 필요'}</span></div>
        {mode === 'image' ? <>
          <p className="quality3d-help">이미지 재구성은 현재 Apple Silicon Mac에서 지원하며 최소 메모리 16 GB가 필요합니다. 최초 한 번 약 1.68 GB의 가중치와 의존성을 다운로드합니다. CPython 3.9와 Blender가 필요하며, 이 Mac의 시스템 Python 3.9.6에서 검증했습니다.</p>
          {runtimeReady && <p className="quality3d-help">준비 완료는 로컬 설치가 검증되었다는 뜻입니다. 생성된 형상과 텍스처 품질은 결과를 보고 확인하세요.</p>}
          {desktop && status && <p className="quality3d-runtime-message" role="status">{preparing && <LoaderCircle size={15} className="quality3d-spin"/>}{safeStatusText(status.message, STATE_LABELS[status.state])}</p>}
          {desktop && preparing && status.stage && <p className="quality3d-runtime-phase" role="status">현재 단계: {safeStatusText(status.stage, '준비 중', 120)}</p>}
          {memoryError && <p className="quality3d-warning">{memoryError}</p>}
          {statusError && <p className="quality3d-warning" role="alert">{statusError}</p>}
          {!runtimeReady && !preparing && <label className="quality3d-check quality3d-consent"><input type="checkbox" checked={downloadConsent} disabled={!desktop || !status?.supported || !memoryReady || setupBlocked} onChange={event => setDownloadConsent(event.target.checked)}/><span>TripoSR 가중치(약 1.68 GB)와 의존성의 1회 다운로드에 동의합니다.</span></label>}
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
        {mode === 'image' && <p>실제 로컬 TripoSR은 구형 단일 이미지 모델입니다. 최신 Tripo Studio H3.1이나 8K 품질과 동등하지 않습니다. 투명 배경의 단일 물체를 권장하며, 보이지 않는 뒷면은 추정합니다. CPU 처리에는 몇 분 이상 걸릴 수 있습니다.</p>}
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
