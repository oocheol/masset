import {useEffect, useRef, useState} from 'react';
import type {FormEvent, ReactNode} from 'react';
import {AlertTriangle, Box, Check, FileImage, LoaderCircle, Plus, Sparkles, Trash2, Upload} from 'lucide-react';
import type {Asset, AssetSpec, GameBundleItem, GameBundlePlan, GameBundleReference, ModelParameters, ProjectSnapshot, StyleGuide} from '@local-assets/contracts';
import {artifactUrl} from '../lib/bridge';
import type {planAssets} from '../lib/bridge';
import './GameBundlePanel.css';

const MAX_IMAGES = 20;
const MAX_MODELS = 24;
const MAX_ITEMS = 44;
const MAX_REFERENCES = 5;
const TEXT_PLANNER_MODEL: GameBundlePlan['plannerModel'] = 'gpt-5.5';
const KIND_LABELS: Record<Asset['kind'], string> = {image: '이미지', sprite: '스프라이트', texture: '텍스처', model: '3D 모델'};

// Keep these recipes aligned with the shared enum. Browser model creation uses only the first three.
export const GAME_MODEL_TEMPLATES: ReadonlyArray<{
  id: ModelParameters['template']; name: string; description: string; dimensions: [number, number, number];
}> = [
  {id: 'crate', name: '상자 · 컨테이너', description: '패널과 프레임이 있는 상자', dimensions: [1, 1, 1]},
  {id: 'table', name: '테이블', description: '상판과 네 개의 다리', dimensions: [1.6, .8, .76]},
  {id: 'shelf', name: '선반', description: '측면 프레임과 선반', dimensions: [1, .4, 1.8]},
  {id: 'sword', name: '검', description: '칼날 · 손잡이 · 가드', dimensions: [.18, .06, 1.1]},
  {id: 'rifle', name: '소총', description: '몸체 · 총열 · 개머리판', dimensions: [1.1, .16, .34]},
  {id: 'spaceship', name: '우주선', description: '선체 · 날개 · 추진부', dimensions: [1.6, 2.2, .6]},
  {id: 'barrel', name: '배럴', description: '원통 몸체와 고리', dimensions: [.7, .7, 1]},
  {id: 'rock', name: '바위', description: '각진 바위 실루엣', dimensions: [1.2, 1, .8]},
  {id: 'tree', name: '나무', description: '줄기와 수관', dimensions: [2, 2, 3]},
];

export function bundleModelParameters(template: ModelParameters['template'], name: string, color: string): ModelParameters {
  const recipe = GAME_MODEL_TEMPLATES.find(item => item.id === template) ?? GAME_MODEL_TEMPLATES[0];
  const [width, depth, height] = recipe.dimensions;
  return {template: recipe.id, name, width, depth, height, bevel: Math.min(.02, Math.min(width, depth, height) / 8), color: /^#[a-f0-9]{6}$/i.test(color) ? color : '#799993'};
}

const activeVersion = (asset: Asset) => asset.versions.find(version => version.id === asset.activeVersionId) ?? asset.versions.at(-1);
const nameKey = (name: string) => name.normalize('NFC').trim().toLocaleLowerCase();
const unsafeName = (name: string) => !name.trim() || name.length > 80 || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const safeName = (name: string) => {
  const cleaned = name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 72).replace(/[. ]+$/, '');
  return !cleaned || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `에셋_${cleaned || '새 항목'}` : cleaned;
};

export function uniqueBundleNames(items: GameBundleItem[]): GameBundleItem[] {
  const names = new Set<string>();
  return items.map(item => {
    const base = safeName(item.name);
    let name = base;
    let index = 2;
    while (names.has(nameKey(name))) name = `${base}_${String(index++).padStart(2, '0')}`;
    names.add(nameKey(name));
    return {...item, name, modelParameters: item.modelParameters ? {...item.modelParameters, name} : null};
  });
}

export function bundleCounts(items: GameBundleItem[]) {
  const enabled = items.filter(item => item.enabled);
  const models = enabled.filter(item => item.kind === 'model').length;
  return {images: enabled.length - models, models, total: enabled.length};
}

export function validateBundleItems(plan: GameBundlePlan, assets: Asset[]): string[] {
  const problems: string[] = [];
  const counts = bundleCounts(plan.items);
  if (!counts.total) problems.push('제작할 항목을 하나 이상 포함하세요.');
  if (counts.images > MAX_IMAGES || counts.models > MAX_MODELS || plan.items.length > MAX_ITEMS) problems.push('이미지 최대 20개, 모델 최대 24개, 전체 행 최대 44개입니다.');
  const allowedReferences = new Set(plan.referenceAssetIds);
  if (plan.referenceAssetIds.length > MAX_REFERENCES || allowedReferences.size !== plan.referenceAssetIds.length) problems.push('참고 자료는 중복 없이 최대 5개까지 선택하세요.');
  if (plan.mode === 'improve' && plan.output !== 'images') problems.push('기존 에셋 개선은 2D 이미지 출력으로 요청하세요. 모델은 새 에셋으로 제작합니다.');
  const names = new Set<string>();
  const targets = new Set<string>();
  for (const item of plan.items.filter(item => item.enabled)) {
    const label = item.name.trim() || '이름 없는 항목';
    if (unsafeName(item.name)) problems.push(`${label}: 80자 이내의 파일 이름을 입력하세요. / \\ : * ? " < > | 및 예약 이름은 사용할 수 없습니다.`);
    if (names.has(nameKey(item.name))) problems.push(`${label}: 항목 이름이 중복됩니다. 서로 다른 이름을 지정하세요.`);
    names.add(nameKey(item.name));
    if (!item.prompt.trim()) problems.push(`${label}: 개별 에셋 설명을 입력하세요.`);
    if ((plan.output === 'images' && item.kind === 'model') || (plan.output === 'models' && item.kind !== 'model')) problems.push(`${label}: 에셋 유형이 구성안의 출력 종류와 다릅니다.`);
    if (item.referenceAssetIds.some(id => !allowedReferences.has(id))) problems.push(`${label}: 위에서 선택한 참고 자료만 사용할 수 있습니다.`);
    if (item.kind === 'model') {
      if (plan.mode === 'improve') problems.push('기존 에셋 개선은 이미지·스프라이트·텍스처에 사용할 수 있습니다.');
      const parameters = item.modelParameters;
      if (!parameters || !GAME_MODEL_TEMPLATES.some(recipe => recipe.id === parameters.template)) problems.push(`${label}: 카탈로그의 모델 레시피를 선택하세요.`);
      else {
        const dimensions = [parameters.width, parameters.depth, parameters.height];
        if (dimensions.some(value => !Number.isFinite(value) || value < .03 || value > 100)) problems.push(`${label}: 모델 치수는 미터 기준 0.03~100으로 입력하세요.`);
        if (!Number.isFinite(parameters.bevel) || parameters.bevel < 0 || parameters.bevel > .25 || parameters.bevel > Math.min(...dimensions) / 4) problems.push(`${label}: 베벨은 0~0.25m, 가장 짧은 치수의 1/4 이하여야 합니다.`);
        if (!/^#[a-f0-9]{6}$/i.test(parameters.color)) problems.push(`${label}: 재질 색상은 #RRGGBB로 입력하세요.`);
      }
      if (item.targetAssetId) problems.push(`${label}: 모델은 새 독립 에셋으로 제작합니다.`);
    } else if (plan.mode === 'improve') {
      const target = assets.find(asset => asset.id === item.targetAssetId);
      if (!target || target.kind === 'model' || !allowedReferences.has(target.id) || !item.referenceAssetIds.includes(target.id)) problems.push(`${label}: 선택한 2D 참고 자료를 새 버전의 대상 에셋으로 지정하세요.`);
      if (item.targetAssetId && targets.has(item.targetAssetId)) problems.push(`${label}: 같은 원본을 여러 개선 행의 대상으로 지정할 수 없습니다. 원본마다 개선 항목 하나를 포함하세요.`);
      if (item.targetAssetId) targets.add(item.targetAssetId);
    } else if (item.targetAssetId) problems.push(`${label}: 새 에셋 제작에서는 원본 교체 대상을 사용하지 않습니다.`);
  }
  return [...new Set(problems)];
}

// This visible per-row rule is also sent with each image job, even after prompt editing.
const singleAssetRule = (name: string) => `이 파일에는 "${name}" 에셋 하나만 제작합니다. 여러 에셋을 함께 배치한 콜라주, 연락판, 스프라이트 시트는 만들지 않습니다.`;
export function reviewedBundlePlan(plan: GameBundlePlan, assets: Asset[], referenceUploadApproved: boolean, approved: boolean): GameBundlePlan {
  if (!approved) throw new Error('개별 항목, 규격과 스타일을 검토한 뒤 제작을 승인하세요.');
  if (plan.referenceAssetIds.length && !referenceUploadApproved) throw new Error('선택한 참고 자료를 공식 Codex에 전송하는 데 동의하세요.');
  const problems = validateBundleItems(plan, assets);
  if (problems.length) throw new Error(problems[0]);
  const counts = bundleCounts(plan.items);
  const output = counts.images && counts.models ? 'mixed' : counts.models ? 'models' : 'images';
  return {
    ...plan, output,
    styleGuide: {...plan.styleGuide, referenceAssetIds: [...plan.referenceAssetIds], approved: true},
    items: plan.items.map(item => ({
      ...item, name: item.name.trim(), prompt: item.kind === 'model' ? item.prompt.trim() : `${item.prompt.trim()}\n\n${singleAssetRule(item.name.trim())}`,
      modelParameters: item.kind === 'model' && item.modelParameters ? {...item.modelParameters, name: item.name.trim()} : null,
    })),
  };
}

const meshKey = (mesh: Asset['mesh']) => mesh ? JSON.stringify([mesh.vertices, mesh.triangles, mesh.dimensions, mesh.unit]) : 'null';
export function bundleReferenceMatchesAsset(reference: GameBundleReference, asset: Asset | undefined): boolean {
  return !!asset && reference.assetId === asset.id && reference.versionId === asset.activeVersionId && reference.name === asset.name && reference.kind === asset.kind && reference.width === asset.width && reference.height === asset.height && meshKey(reference.mesh) === meshKey(asset.mesh);
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/https?:\/\/|(?:access|refresh)[_-]?token|authorization|bearer|api[_-]?key|sk-[a-z0-9]|eyJ[a-z0-9_-]{20}/i.test(message)) return '요청을 처리하지 못했습니다. 공식 연결 상태를 확인한 뒤 다시 시도하세요.';
  return message.slice(0, 700);
}

function referenceDetails(reference: Pick<GameBundleReference, 'kind' | 'width' | 'height' | 'mesh'>) {
  if (reference.kind !== 'model') return `${KIND_LABELS[reference.kind]} · ${reference.width ?? '—'} × ${reference.height ?? '—'} px`;
  const mesh = reference.mesh;
  return mesh ? `3D · ${mesh.dimensions.map(value => Number(value.toFixed(3))).join(' × ')} ${mesh.unit} · ${mesh.triangles.toLocaleString()} 삼각형` : '3D · 메시 메타데이터 확인 필요';
}

interface GameBundlePanelProps {
  snapshot: ProjectSnapshot;
  spec: AssetSpec;
  styleGuide: StyleGuide;
  selectedAssetIds: string[];
  native: boolean;
  busy: boolean;
  providerReady: boolean;
  providerChecking: boolean;
  providerPanel: ReactNode;
  initialBrief?: string;
  initialOutput?: GameBundlePlan['output'];
  initialCount?: number;
  imageDialog?: boolean;
  onImport: () => Promise<void>;
  onPlan: typeof planAssets;
  onSubmit: (plan: GameBundlePlan, referenceUploadApproved: boolean, approved: boolean) => Promise<void>;
}

export default function GameBundlePanel({snapshot, spec, styleGuide, selectedAssetIds, native, busy, providerReady, providerChecking, providerPanel, initialBrief = '', initialOutput = 'images', initialCount, imageDialog = false, onImport, onPlan, onSubmit}: GameBundlePanelProps) {
  const [brief, setBrief] = useState(initialBrief);
  const [output, setOutput] = useState<GameBundlePlan['output']>(initialOutput);
  const [mode, setMode] = useState<GameBundlePlan['mode']>('new');
  const [count, setCount] = useState(initialCount == null ? '' : String(initialCount));
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [referenceUploadApproved, setReferenceUploadApproved] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState('');
  const [plan, setPlan] = useState<GameBundlePlan | null>(null);
  const [reviewApproved, setReviewApproved] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  const initialAssetIds = useRef(new Set(snapshot.project.assets.map(asset => asset.id)));
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const assets = snapshot.project.assets;
  const referenceAssets = referenceIds.map(id => assets.find(asset => asset.id === id)).filter((asset): asset is Asset => !!asset);
  const imageReferences = referenceAssets.filter(asset => asset.kind !== 'model');
  const selectedCandidates = [...new Set(selectedAssetIds.filter(id => assets.some(asset => asset.id === id)))];
  const visibleReferences = assets.filter(asset => !referenceQuery || `${asset.name} ${asset.tags.join(' ')}`.toLocaleLowerCase().includes(referenceQuery.toLocaleLowerCase())).slice().reverse();
  const referenceKey = JSON.stringify([snapshot.project.id, referenceIds.map(id => {const asset = assets.find(asset => asset.id === id); return asset ? [id, asset.activeVersionId, asset.name, asset.kind, asset.width, asset.height, meshKey(asset.mesh)] : [id, 'missing'];})]);
  const previousReferenceKey = useRef(referenceKey);
  const basisKey = JSON.stringify({spec, styleGuide});
  const previousBasisKey = useRef(basisKey);
  const currentBasisKey = useRef(basisKey);
  const plannedBasisKey = useRef('');
  currentBasisKey.current = basisKey;
  const blocked = busy || planning || submitting;
  const countInvalid = output !== 'models' && count !== '' && (!Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > MAX_IMAGES);
  const canPlan = native && !blocked && !providerChecking && providerReady && !!brief.trim() && !countInvalid && (!referenceIds.length || referenceUploadApproved) && (mode !== 'improve' || imageReferences.length > 0);
  const counts = bundleCounts(plan?.items ?? []);
  const staleReferences = !!plan && (plan.projectId !== snapshot.project.id || plan.references.some(reference => !bundleReferenceMatchesAsset(reference, assets.find(asset => asset.id === reference.assetId))));
  const staleBasis = !!plan && plannedBasisKey.current !== basisKey;
  const problems = plan ? validateBundleItems(plan, assets) : [];
  const canSubmit = native && !!plan && !blocked && !providerChecking && providerReady && reviewApproved && !problems.length && !staleReferences && !staleBasis && (!referenceIds.length || referenceUploadApproved);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (previousReferenceKey.current === referenceKey) return;
    previousReferenceKey.current = referenceKey;
    setReferenceUploadApproved(false);
    setReviewApproved(false);
    setPlan(null);
  }, [referenceKey]);
  useEffect(() => { if (plan) reviewHeading.current?.focus(); }, [plan?.id]);
  useEffect(() => {
    if (previousBasisKey.current === basisKey) return;
    previousBasisKey.current = basisKey;
    setPlan(null);
    setReviewApproved(false);
  }, [basisKey]);

  function invalidatePlan() {
    setPlan(null);
    setReviewApproved(false);
    setError('');
  }
  function selectReferences(ids: string[]) {
    if (ids.length > MAX_REFERENCES) { setError('참고 자료는 최대 5개까지 선택하세요.'); return; }
    setReferenceIds(ids);
    setReferenceUploadApproved(false);
    invalidatePlan();
  }
  function replaceItems(items: GameBundleItem[]) {
    if (!plan) return;
    const nextCounts = bundleCounts(items);
    const nextOutput = nextCounts.images && nextCounts.models ? 'mixed' : nextCounts.models ? 'models' : nextCounts.images ? 'images' : plan.output;
    setPlan({...plan, output: nextOutput, items});
    setOutput(nextOutput);
    setReviewApproved(false);
    setError('');
  }
  function editItem(id: string, patch: Partial<GameBundleItem>) {
    if (!plan) return;
    replaceItems(plan.items.map(item => {
      if (item.id !== id) return item;
      const next = {...item, ...patch};
      if (next.modelParameters) next.modelParameters = {...next.modelParameters, name: next.name};
      return next;
    }));
  }
  function editModel(item: GameBundleItem, patch: Partial<ModelParameters>) {
    editItem(item.id, {modelParameters: {...(item.modelParameters ?? bundleModelParameters('crate', item.name, plan?.styleGuide.palette[0] ?? '#799993')), ...patch, name: item.name}});
  }
  function changeKind(item: GameBundleItem, kind: Asset['kind']) {
    editItem(item.id, {kind, targetAssetId: kind === 'model' || mode === 'new' ? null : item.targetAssetId,
      modelParameters: kind === 'model' ? bundleModelParameters('crate', item.name, plan?.styleGuide.palette[0] ?? '#799993') : null});
  }
  function addItem(kind: 'image' | 'model') {
    if (!plan || plan.items.length >= MAX_ITEMS) return;
    const name = kind === 'model' ? '새 모델' : '새 이미지';
    replaceItems(uniqueBundleNames([...plan.items, {id: crypto.randomUUID(), name, kind, prompt: '', purpose: '', enabled: true,
      referenceAssetIds: [], targetAssetId: null, modelParameters: kind === 'model' ? bundleModelParameters('crate', name, plan.styleGuide.palette[0] ?? '#799993') : null}]));
  }

  async function createPlan(event: FormEvent) {
    event.preventDefault();
    if (!canPlan || pending.current) return;
    pending.current = true;
    setPlanning(true);
    setError('');
    setPlan(null);
    setReviewApproved(false);
    try {
      const next = await onPlan({action: 'plan_assets', brief: brief.trim(), output, mode,
        ...(output !== 'models' && count !== '' ? {count: Number(count)} : {}), referenceAssetIds: [...referenceIds], referenceUploadApproved});
      if (!mounted.current) return;
      if (currentBasisKey.current !== basisKey) throw new Error('구성안을 작성하는 동안 규격이나 스타일이 바뀌었습니다. 현재 기준으로 다시 요청하세요.');
      if (next.schemaVersion !== 1 || next.projectId !== snapshot.project.id || next.mode !== mode || next.plannerModel !== TEXT_PLANNER_MODEL || !next.items.length || next.items.length > MAX_ITEMS) throw new Error('구성안의 프로젝트·텍스트 모델·제작 방식·항목 수를 확인하지 못했습니다. 다시 구성안을 요청하세요.');
      if (next.referenceAssetIds.length !== referenceIds.length || next.referenceAssetIds.some(id => !referenceIds.includes(id)) || next.references.length !== referenceIds.length || next.references.some(reference => !referenceIds.includes(reference.assetId) || !bundleReferenceMatchesAsset(reference, assets.find(asset => asset.id === reference.assetId)))) throw new Error('구성안의 참고 자료가 선택한 자료와 다릅니다. 선택을 확인한 뒤 다시 요청하세요.');
      if (mode === 'improve' && next.items.some(item => item.kind === 'model')) throw new Error('기존 에셋 개선은 2D 이미지의 새 버전으로 요청하세요. 모델은 새 에셋으로 제작할 수 있습니다.');
      if (count !== '' && output !== 'models' && bundleCounts(next.items).images !== Number(count)) throw new Error(`요청한 이미지 ${count}개와 구성안의 개별 이미지 행 수가 다릅니다. 구성안을 다시 요청하세요.`);
      const normalized = {...next, styleGuide: {...next.styleGuide, referenceAssetIds: [...referenceIds]}, items: uniqueBundleNames(next.items)};
      plannedBasisKey.current = basisKey;
      setPlan(normalized);
      setOutput(normalized.output);
    } catch (failure) { if (mounted.current) setError(safeError(failure)); }
    finally { pending.current = false; if (mounted.current) setPlanning(false); }
  }
  async function submitPlan() {
    if (!plan || !canSubmit || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError('');
    try { await onSubmit(reviewedBundlePlan(plan, assets, referenceUploadApproved, reviewApproved), referenceUploadApproved, reviewApproved); }
    catch (failure) { if (mounted.current) setError(safeError(failure)); }
    finally { pending.current = false; if (mounted.current) setSubmitting(false); }
  }

  return <div className="game-bundle-panel" aria-busy={planning || submitting}>
    <div className="bundle-steps" aria-label="에셋 묶음 제작 순서"><span className={!plan ? 'current' : ''}>1. 게임 설명 · 참고 자료</span><span className={plan ? 'current' : ''}>2. 개별 항목 검토</span><span>3. 승인 후 큐 제출</span></div>
    <p className="bundle-single-notice"><strong>한 행은 에셋 하나입니다.</strong> 이미지 5행을 승인하면 서로 다른 이름의 이미지 파일 5개와 작업 5개를 요청합니다.</p>
    {!native && <div className="inline-note bundle-browser-note"><AlertTriangle size={18}/><span>구성안 작성은 데스크톱의 공식 Codex 구독 연결에서 사용할 수 있습니다. 브라우저에서는 <strong>3D 만들기</strong>의 상자·테이블·선반 로컬 제작을 사용할 수 있습니다.</span></div>}
    <form onSubmit={createPlan}>
      <label className="field"><span>{imageDialog ? '이미지 설명' : '게임 설명 · 테마'}</span><textarea aria-label={imageDialog ? '이미지 설명' : '게임 설명 · 테마'} rows={4} value={brief} disabled={blocked} onChange={event => {setBrief(event.target.value); invalidatePlan();}} placeholder="예: spacewar weapons5 — 우주 전쟁 게임의 무기 5종. 레이저 검, 소총, 플라즈마 대포 등 서로 다른 이름과 실루엣이 필요합니다." required/><small>게임 분위기, 필요한 아이템, 용도와 각 에셋의 차이를 설명하세요.</small></label>
      <div className="bundle-form-grid">
        <label className="field"><span>출력 구성</span><select value={output} disabled={blocked || mode === 'improve'} onChange={event => {setOutput(event.target.value as GameBundlePlan['output']); invalidatePlan();}}><option value="images">2D 이미지</option><option value="models">3D 모델</option><option value="mixed">이미지 + 3D 모델</option></select></label>
        <label className="field"><span>제작 방식</span><select value={mode} disabled={blocked} onChange={event => {const next = event.target.value as GameBundlePlan['mode']; setMode(next); if (next === 'improve') setOutput('images'); invalidatePlan();}}><option value="new">새 게임 에셋 제작</option><option value="improve">기존 2D 에셋 개선 · 새 버전</option></select></label>
        {output !== 'models' && <label className="field"><span>{imageDialog ? '이미지 수' : '요청 이미지 수 (선택)'}</span><input aria-label={imageDialog ? '이미지 수' : '요청 이미지 수 (선택)'} type="number" min={1} max={MAX_IMAGES} step={1} value={count} disabled={blocked} onChange={event => {setCount(event.target.value); invalidatePlan();}} placeholder="설명에 맞춰 제안"/><small>{count === '' ? '비워 두면 설명에 맞는 개별 항목 수를 제안합니다.' : `${count}개의 단일 이미지 항목을 구성안으로 요청합니다.`}</small></label>}
      </div>
      {mode === 'improve' && <p className="bundle-help">개선할 이미지·스프라이트·텍스처를 아래에서 참고 자료로 선택하세요. 각 원본에 개선 결과를 새 버전으로 저장합니다.</p>}
      <section className="bundle-reference-section" aria-labelledby="bundle-reference-heading">
        <div className="bundle-section-heading"><h3 id="bundle-reference-heading">게임 예제 · 모델 참고 자료</h3><span>{referenceIds.length} / 5 선택</span></div>
        <p className="bundle-help">참고 자료를 직접 선택하세요. 가져온 원본과 현재 라이브러리 선택은 이 목록에서 확인할 수 있습니다.</p>
        <div className="bundle-reference-actions">
          <button type="button" className="button" disabled={blocked || !native} onClick={async () => {setError(''); try {await onImport();} catch (failure) {if (mounted.current) setError(safeError(failure));}}}><Upload size={16}/>참고 이미지·GLB 가져오기</button>
          <button type="button" className="button" disabled={blocked || !selectedCandidates.length || selectedCandidates.length > MAX_REFERENCES} onClick={() => selectReferences(selectedCandidates)}>현재 선택 {selectedCandidates.length}개를 참고 자료로 사용</button>
          {!!referenceIds.length && <button type="button" className="button quiet" disabled={blocked} onClick={() => selectReferences([])}>참고 선택 해제</button>}
        </div>
        {selectedCandidates.length > MAX_REFERENCES && <p className="bundle-help">라이브러리에서 5개 이하를 선택하거나 아래 목록에서 직접 고르세요.</p>}
        <label className="field bundle-reference-search"><span>참고 자료 검색</span><input type="search" value={referenceQuery} onChange={event => setReferenceQuery(event.target.value)} placeholder="라이브러리 이름 · 태그"/></label>
        <div className="bundle-reference-list">
          {visibleReferences.map(asset => {
            const version = activeVersion(asset);
            const thumbnail = version?.artifacts.find(artifact => artifact.role === 'thumbnail') ?? version?.artifacts.find(artifact => ['png', 'webp', 'jpeg', 'jpg'].includes(artifact.format.toLowerCase()));
            const thumbnailUrl = artifactUrl(snapshot, thumbnail);
            const checked = referenceIds.includes(asset.id);
            return <label key={asset.id} className={`bundle-reference-option ${checked ? 'selected' : ''}`}>
              <input type="checkbox" checked={checked} disabled={blocked || (!checked && referenceIds.length >= MAX_REFERENCES)} onChange={() => selectReferences(checked ? referenceIds.filter(id => id !== asset.id) : [...referenceIds, asset.id])}/>
              {thumbnailUrl ? <img src={thumbnailUrl} alt="" loading="lazy"/> : <Box size={30} aria-hidden="true"/>}
              <span><strong>{asset.name}</strong><small>{referenceDetails(asset)} · v{version?.number ?? '—'}</small>{!initialAssetIds.current.has(asset.id) && version?.source === 'import' && <small className="bundle-new-import">새로 가져옴 · 선택해서 사용</small>}</span>
              {checked && <Check size={17} aria-hidden="true"/>}
            </label>;
          })}
          {!visibleReferences.length && <p className="bundle-help">{assets.length ? '검색한 이름의 자료가 없습니다.' : '참고할 게임 예제나 모델을 가져오세요. 참고 자료 없이 새 에셋 구성안을 요청할 수도 있습니다.'}</p>}
        </div>
        <label className="check-row bundle-reference-consent"><input type="checkbox" checked={referenceUploadApproved} disabled={blocked || !native || !referenceIds.length} onChange={event => {setReferenceUploadApproved(event.target.checked); setReviewApproved(false);}}/><span>선택한 참고 자료의 이미지·미리보기·모델 메시와 치수 메타데이터를 공식 Codex에 전송하는 데 동의합니다.</span></label>
        <p className="bundle-help">원본 파일은 보존됩니다. 3D 참고 자료는 검증된 메시 정보와 미리보기로 사용하며, 새 모델은 고정된 절차적 레시피로 제작합니다.</p>
      </section>
      <div className="bundle-planning-notice"><Sparkles size={18}/><span>구성안 요청 모델: <strong>GPT-5.5 ({TEXT_PLANNER_MODEL})</strong> · 공식 Codex의 텍스트 응답만 요청합니다. 이 단계에서는 이미지를 생성하지 않습니다. 설명과 승인한 참고 자료를 전달하며 외부 구독 사용량이 발생할 수 있습니다. 이미지 제작은 연결 패널의 이미지 런타임을 사용합니다.</span></div>
      {countInvalid && <p className="bundle-error" role="alert">이미지 수는 1~20 사이의 정수로 입력하거나 비워 두세요.</p>}
      {mode === 'improve' && !imageReferences.length && <p className="bundle-help">개선 대상인 2D 참고 자료를 하나 이상 선택하세요.</p>}
      <div className="bundle-plan-action"><button className="button primary" type="submit" disabled={!canPlan}>{planning ? <LoaderCircle size={17} className="spin"/> : <Sparkles size={17}/>} {planning ? '구성안 작성 중' : plan ? '구성안 다시 만들기' : '구성안 만들기'}</button><span>이미지 ≤ 20 · 모델 ≤ 24 · 전체 ≤ 44</span></div>
    </form>
    {error && <div className="bundle-error" role="alert"><AlertTriangle size={18}/><span>{error}</span></div>}
    {plan && <section className="bundle-review" aria-labelledby="bundle-review-heading">
      <div className="bundle-section-heading"><h3 id="bundle-review-heading" ref={reviewHeading} tabIndex={-1}>개별 에셋 구성안 검토</h3><span>{counts.total}개 포함 / {plan.items.length}행</span></div>
      <p className="bundle-summary">{plan.summary}</p>
      <p className="bundle-help">이 구성안의 텍스트 요청 모델: <strong>{plan.plannerModel}</strong> · 항목을 승인한 뒤 별도의 이미지·모델 제작 작업을 제출합니다.</p>
      <div className="bundle-counts" role="status" aria-live="polite"><strong>이미지 {counts.images}개</strong><strong>3D 모델 {counts.models}개</strong><span>전체 {counts.total}개 · 묶음 전체를 한 번에 제출</span></div>
      <p className="bundle-help">각 행의 이름, 개별 설명과 참고 자료를 검토하세요. 행을 추가·삭제하거나 제외하면 실제 제출 수에 반영됩니다.{count !== '' && ` 최초 요청 이미지 수: ${count}개.`}</p>
      {!!plan.references.length && <details className="bundle-details"><summary>전송할 참고 자료와 버전 {plan.references.length}개</summary>{plan.references.map(reference => <p key={reference.assetId}><strong>{reference.name}</strong> · {referenceDetails(reference)} · 버전 {reference.versionId}</p>)}</details>}
      <div className="bundle-basis"><div><strong>{plan.styleGuide.name}</strong><div className="mini-palette">{plan.styleGuide.palette.map((color, index) => <span key={index} style={{background: color}} title={color}/>)}</div><p>{plan.styleGuide.camera} · {plan.styleGuide.lighting}</p><p>{plan.styleGuide.detail}</p></div><div><strong>{plan.spec.width} × {plan.spec.height} px · {plan.spec.target}</strong><p>이름 규칙: {plan.spec.naming}</p><p>{plan.spec.colorSpace} · {plan.spec.pixelArt ? '픽셀아트' : '일반 이미지'} · 여백 {plan.styleGuide.margin}px</p><p>모델 파라미터는 실제 미터(m) 기준 · GLB Y-up · 폴리곤 예산 {plan.spec.polygonBudget.toLocaleString()}</p></div></div>
      <ol className="bundle-item-list">
        {plan.items.map((item, index) => {
          const parameters = item.modelParameters;
          return <li key={item.id} className={`bundle-item ${item.enabled ? '' : 'excluded'}`}>
            <div className="bundle-item-heading"><label className="check-row"><input type="checkbox" checked={item.enabled} disabled={blocked} onChange={event => editItem(item.id, {enabled: event.target.checked})}/><span>{index + 1}. {item.name || '이름 없는 항목'} {item.enabled ? '포함' : '제외'}</span></label><button className="button quiet" type="button" disabled={blocked} aria-label={`${index + 1}번 항목 삭제`} onClick={() => replaceItems(plan.items.filter(row => row.id !== item.id))}><Trash2 size={16}/>삭제</button></div>
            <div className="bundle-item-fields">
              <label className="field"><span>에셋 이름</span><input maxLength={80} value={item.name} disabled={blocked} onChange={event => editItem(item.id, {name: event.target.value})} aria-label={`${index + 1}번 에셋 이름`}/></label>
              <label className="field"><span>파일 출력</span><select value={item.kind === 'model' ? 'model' : 'image'} disabled={blocked || mode === 'improve'} aria-label={`${index + 1}번 파일 출력`} onChange={event => changeKind(item, event.target.value as 'image' | 'model')}><option value="image">이미지 · 개별 PNG</option><option value="model">3D 모델 · GLB</option></select></label>
              <label className="field"><span>에셋 유형</span><select value={item.kind} disabled={blocked || item.kind === 'model'} aria-label={`${index + 1}번 에셋 유형`} onChange={event => changeKind(item, event.target.value as Asset['kind'])}>{item.kind === 'model' ? <option value="model">3D 모델</option> : <><option value="image">이미지</option><option value="sprite">스프라이트</option><option value="texture">텍스처</option></>}</select></label>
            </div>
            <label className="field"><span>개별 에셋 설명</span><textarea rows={3} value={item.prompt} disabled={blocked} aria-label={`${index + 1}번 개별 에셋 설명`} onChange={event => editItem(item.id, {prompt: event.target.value})}/></label>
            {item.kind !== 'model' && <p className="bundle-item-rule"><FileImage size={16}/>{singleAssetRule(item.name || '이 행의 에셋')}</p>}
            <label className="field"><span>게임 안에서의 용도</span><input value={item.purpose} disabled={blocked} aria-label={`${index + 1}번 에셋 용도`} onChange={event => editItem(item.id, {purpose: event.target.value})}/></label>
            {mode === 'improve' && item.kind !== 'model' && <label className="field"><span>새 버전을 저장할 원본</span><select value={item.targetAssetId ?? ''} disabled={blocked} aria-label={`${index + 1}번 개선 대상`} onChange={event => {const id = event.target.value; editItem(item.id, {targetAssetId: id || null, referenceAssetIds: id ? [...new Set([...item.referenceAssetIds, id])] : item.referenceAssetIds});}}><option value="">선택한 2D 참고 자료에서 지정</option>{imageReferences.map(asset => <option key={asset.id} value={asset.id}>{asset.name} · 원본 보존 / 새 버전</option>)}</select></label>}
            {item.kind === 'model' && <div className="bundle-model-fields">
              <p className="bundle-model-note"><Box size={17}/>고정 레시피로 새 독립 모델을 만듭니다. 참고 메시를 임의로 재구성하는 기능은 제공하지 않습니다.</p>
              <label className="field"><span>모델 레시피</span><select value={parameters?.template ?? 'crate'} disabled={blocked} aria-label={`${index + 1}번 모델 레시피`} onChange={event => editModel(item, {template: event.target.value as ModelParameters['template']})}>{GAME_MODEL_TEMPLATES.map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}</select></label>
              <div className="bundle-dimensions">{(['width', 'depth', 'height', 'bevel'] as const).map(key => <label key={key} className="field"><span>{({width: '너비', depth: '깊이', height: '높이', bevel: '베벨'})[key]} (m)</span><input type="number" min={key === 'bevel' ? 0 : .03} max={key === 'bevel' ? .25 : 100} step="any" value={parameters && Number.isFinite(parameters[key]) ? parameters[key] : ''} disabled={blocked} aria-label={`${index + 1}번 모델 ${key} m`} onChange={event => editModel(item, {[key]: event.target.value === '' ? NaN : Number(event.target.value)})}/></label>)}</div>
              <label className="field"><span>모델 재질 색상</span><div className="bundle-model-color"><input type="color" value={parameters && /^#[a-f0-9]{6}$/i.test(parameters.color) ? parameters.color : '#799993'} disabled={blocked} aria-label={`${index + 1}번 모델 재질 색상 선택`} onChange={event => editModel(item, {color: event.target.value})}/><input value={parameters?.color ?? ''} maxLength={7} disabled={blocked} aria-label={`${index + 1}번 모델 재질 색상`} onChange={event => editModel(item, {color: event.target.value})}/></div></label>
            </div>}
            <fieldset className="bundle-row-references" disabled={blocked}><legend>이 항목의 참고 자료</legend>{referenceAssets.length ? referenceAssets.map(asset => <label key={asset.id} className="check-row"><input type="checkbox" checked={item.referenceAssetIds.includes(asset.id)} disabled={mode === 'improve' && item.targetAssetId === asset.id} onChange={event => editItem(item.id, {referenceAssetIds: event.target.checked ? [...new Set([...item.referenceAssetIds, asset.id])] : item.referenceAssetIds.filter(id => id !== asset.id)})}/><span>{asset.name}</span></label>) : <span>선택한 참고 자료 없음</span>}</fieldset>
          </li>;
        })}
      </ol>
      <div className="bundle-add-actions"><button type="button" className="button" disabled={blocked || plan.items.length >= MAX_ITEMS || counts.images >= MAX_IMAGES} onClick={() => addItem('image')}><Plus size={16}/>이미지 항목 추가</button>{mode === 'new' && <button type="button" className="button" disabled={blocked || plan.items.length >= MAX_ITEMS || counts.models >= MAX_MODELS} onClick={() => addItem('model')}><Plus size={16}/>모델 항목 추가</button>}<button type="button" className="button quiet" disabled={blocked} onClick={() => replaceItems(uniqueBundleNames(plan.items))}>이름 중복 · 파일 이름 정리</button></div>
      {!!plan.warnings.length && <div className="bundle-warnings"><strong>구성안 참고 사항</strong><ul>{plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      {!!problems.length && <div className="bundle-error" role="alert"><AlertTriangle size={18}/><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div>}
      {staleReferences && <p className="bundle-error" role="alert">참고 버전 또는 프로젝트가 바뀌었습니다. 구성안을 다시 작성하세요.</p>}
      {staleBasis && <p className="bundle-error" role="alert">규격이나 스타일이 바뀌었습니다. 구성안을 다시 작성하세요.</p>}
      <label className="check-row bundle-review-approval"><input type="checkbox" checked={reviewApproved} disabled={blocked || !counts.total || !!problems.length || staleReferences || staleBasis} onChange={event => setReviewApproved(event.target.checked)}/><span>위의 개별 항목 {counts.total}개, 규격과 스타일을 검토했고 제작 기준으로 승인합니다.</span></label>
      <div className="bundle-quota-note"><AlertTriangle size={18}/><span>이미지 {counts.images}개는 각각 공식 런타임 요청이며 구독 사용량과 외부 한도가 적용됩니다. 수신 파일의 크기·투명도·스타일과 실제 모델 지원 여부는 결과에서 확인합니다. 원본은 보존하고 새 에셋 또는 새 버전으로 저장합니다.</span></div>
      <div className="dialog-actions bundle-submit-actions"><div><strong>이미지 {counts.images}개 + 모델 {counts.models}개</strong><span>포함한 {counts.total}개 항목을 한 번에 제출</span></div><button type="button" className="button primary" disabled={!canSubmit} onClick={() => void submitPlan()}>{submitting ? <LoaderCircle size={17} className="spin"/> : <Sparkles size={17}/>} {submitting ? '묶음 요청 제출 중' : '검토한 에셋 묶음 제작'}</button></div>
    </section>}
    <details className="bundle-provider-details" open={!providerReady}><summary>공식 Codex 연결 · 사용량 · 수신 파일 확인</summary>{providerPanel}</details>
    {!plan && <div className="bundle-basis bundle-current-basis"><div><strong>현재 제작 기준: {styleGuide.name}</strong><p>{styleGuide.camera} · {styleGuide.lighting}</p><p>{styleGuide.detail}</p></div><div><strong>{spec.width} × {spec.height} px · {spec.target}</strong><p>구성안에서 각 항목과 함께 검토한 뒤 승인합니다.</p></div></div>}
  </div>;
}
