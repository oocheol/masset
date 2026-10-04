import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {DEFAULT_SPEC, DEFAULT_STYLE} from '@local-assets/contracts';
import type {Asset, GameBundleItem, GameBundlePlan, GameBundleReference, ProjectSnapshot} from '@local-assets/contracts';

// No Tauri runtime, browser adapter, credentials, or provider requests in these tests.
vi.mock('../lib/bridge', () => ({artifactUrl: () => ''}));
import GameBundlePanel, {bundleCounts, bundleModelParameters, bundleReferenceMatchesAsset, GAME_MODEL_TEMPLATES, reviewedBundlePlan, uniqueBundleNames, validateBundleItems} from './GameBundlePanel';

const WEAPONS = ['Laser sword', 'Ion rifle', 'Plasma cannon', 'Rocket launcher', 'Pulse pistol'];
const item = (index: number, kind: GameBundleItem['kind'] = 'image'): GameBundleItem => {
  const name = WEAPONS[index] ?? `Game asset ${index}`;
  return {id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name, kind,
    prompt: `A readable ${name} for a space battle game.`, purpose: 'An individually selectable game weapon',
    referenceAssetIds: [], targetAssetId: null, modelParameters: kind === 'model' ? bundleModelParameters('crate', name, '#799993') : null, enabled: true};
};
const plan = (items: GameBundleItem[] = WEAPONS.map((_, index) => item(index))): GameBundlePlan => ({
  schemaVersion: 1, id: '00000000-0000-4000-8000-000000000099', projectId: 'qa-project', plannerModel: 'gpt-5.5', brief: 'spacewar weapons5',
  output: 'images', mode: 'new', spec: {...DEFAULT_SPEC}, styleGuide: {...DEFAULT_STYLE, palette: [...DEFAULT_STYLE.palette], referenceAssetIds: [], approved: false},
  referenceAssetIds: [], references: [], summary: 'Five separately named game weapons', items, warnings: [],
});
const asset = (id: string, kind: Asset['kind'] = 'image'): Asset => ({
  id, name: `Original ${id}`, kind, folder: 'Imported', tags: [], activeVersionId: `${id}-v1`,
  width: kind === 'model' ? null : 128, height: kind === 'model' ? null : 128,
  mesh: kind === 'model' ? {vertices: 200, triangles: 100, dimensions: [1.1, .16, .34], unit: 'm'} : null,
  versions: [{id: `${id}-v1`, number: 1, createdAt: '2026-10-04T00:00:00Z', prompt: '', source: 'import', requestedModel: null,
    confirmedModel: null, providerVersion: null, artifacts: [], settings: {}, validation: null}],
});
const reference = (source: Asset): GameBundleReference => ({assetId: source.id, versionId: source.activeVersionId, name: source.name, kind: source.kind, width: source.width, height: source.height, mesh: source.mesh});
const image = asset('game-image');
const model = asset('game-model', 'model');
const assets = [image, model];
const withReferences = (): GameBundlePlan => ({...plan(), referenceAssetIds: assets.map(source => source.id), references: assets.map(reference),
  items: plan().items.map(row => ({...row, referenceAssetIds: assets.map(source => source.id)}))});

describe('reviewed game asset bundles', () => {
  it('turns five named rows into five distinct single-asset image descriptions', () => {
    const proposal = plan();
    const original = structuredClone(proposal);
    const reviewed = reviewedBundlePlan(proposal, [], false, true);

    expect(bundleCounts(reviewed.items)).toEqual({images: 5, models: 0, total: 5});
    expect(reviewed.items.map(row => row.name)).toEqual(WEAPONS);
    expect(new Set(reviewed.items.map(row => row.prompt)).size).toBe(5);
    for (const row of reviewed.items) {
      expect(row.prompt).toContain(`"${row.name}" 에셋 하나만`);
      expect(row.prompt).toContain('콜라주, 연락판, 스프라이트 시트는 만들지 않습니다.');
      expect(row.prompt).not.toContain(proposal.brief);
      expect(row.modelParameters).toBeNull();
    }
    expect(reviewed.plannerModel).toBe('gpt-5.5');
    expect(reviewed.styleGuide.approved).toBe(true);
    expect(proposal).toEqual(original);
  });

  it('keeps an edited row and excludes unchecked rows from generation counts', () => {
    const proposal = plan();
    const edited = {...proposal, items: proposal.items.map((row, index) => index === 0 ? {...row, name: 'Laser sword Mk II', prompt: 'A curved cyan blade with a silver hilt.'} : index === 1 ? {...row, enabled: false} : row)};
    const reviewed = reviewedBundlePlan(edited, [], false, true);

    expect(bundleCounts(reviewed.items)).toEqual({images: 4, models: 0, total: 4});
    expect(reviewed.items.filter(row => row.enabled).map(row => row.id)).not.toContain(proposal.items[1].id);
    expect(reviewed.items[0].prompt).toContain('A curved cyan blade with a silver hilt.');
    expect(reviewed.items[0].prompt).toContain('"Laser sword Mk II" 에셋 하나만');
    expect(proposal.items[0].name).toBe('Laser sword');
    expect(() => reviewedBundlePlan(edited, [], false, false)).toThrow('제작을 승인');
  });

  it('rejects duplicate or unsafe names and can repair names without losing rows', () => {
    const duplicate = plan([{...item(0), name: 'Laser sword'}, {...item(1), name: 'laser SWORD'}]);
    expect(() => reviewedBundlePlan(duplicate, [], false, true)).toThrow('중복');
    expect(() => reviewedBundlePlan(plan([{...item(0), name: '../source.png'}]), [], false, true)).toThrow('파일 이름');
    expect(() => reviewedBundlePlan(plan([{...item(0), name: 'NUL.png'}]), [], false, true)).toThrow('파일 이름');

    const repaired = uniqueBundleNames([{...item(0, 'model'), name: 'same'}, {...item(1, 'model'), name: 'same'}, {...item(2), name: 'bad/name:'}]);
    expect(repaired).toHaveLength(3);
    expect(new Set(repaired.map(row => row.name.toLowerCase())).size).toBe(3);
    expect(repaired.filter(row => row.kind === 'model').every(row => row.modelParameters?.name === row.name)).toBe(true);
    expect(validateBundleItems({...plan(repaired), output: 'mixed'}, [])).toEqual([]);
  });

  it('requires separate reference upload consent and keeps per-row references within the approved selection', () => {
    const proposal = withReferences();
    expect(() => reviewedBundlePlan(proposal, assets, false, true)).toThrow('공식 Codex에 전송');
    const reviewed = reviewedBundlePlan(proposal, assets, true, true);
    expect(reviewed.styleGuide.referenceAssetIds).toEqual(proposal.referenceAssetIds);
    expect(reviewed.references).toEqual(proposal.references);
    expect(Object.keys(reviewed.references[0]).sort()).toEqual(['assetId', 'height', 'kind', 'mesh', 'name', 'versionId', 'width']);
    const unexpected = {...proposal, items: [{...proposal.items[0], referenceAssetIds: ['unselected-fixture']}]};
    expect(() => reviewedBundlePlan(unexpected, assets, true, true)).toThrow('위에서 선택한 참고 자료');
  });

  it('accepts 20 images plus 24 models and rejects either per-kind overflow', () => {
    const images = Array.from({length: 20}, (_, index) => item(index));
    const models = Array.from({length: 24}, (_, index) => item(index + 20, 'model'));
    const atLimit = {...plan([...images, ...models]), output: 'mixed' as const};
    expect(validateBundleItems(atLimit, [])).toEqual([]);
    expect(bundleCounts(reviewedBundlePlan(atLimit, [], false, true).items)).toEqual({images: 20, models: 24, total: 44});
    expect(() => reviewedBundlePlan({...plan([...images, item(44)]), output: 'images'}, [], false, true)).toThrow('최대 20개');
    expect(() => reviewedBundlePlan({...plan([...models, item(45, 'model')]), output: 'models'}, [], false, true)).toThrow('최대 24개');
    expect(() => reviewedBundlePlan(plan([{...item(0), enabled: false}]), [], false, true)).toThrow('하나 이상');
  });

  it('rejects kinds that disagree with output and keeps model production in new mode', () => {
    expect(() => reviewedBundlePlan(plan([item(0, 'model')]), [], false, true)).toThrow('출력 종류');
    expect(() => reviewedBundlePlan({...plan([item(0)]), output: 'models'}, [], false, true)).toThrow('출력 종류');
    const improvingModels = {...plan([item(0, 'model')]), mode: 'improve' as const, output: 'models' as const};
    expect(() => reviewedBundlePlan(improvingModels, [], false, true)).toThrow('2D 이미지 출력');
    expect(() => reviewedBundlePlan({...plan([item(0, 'model')]), output: 'models', items: [{...item(0, 'model'), targetAssetId: image.id}]}, assets, true, true)).toThrow('새 독립 에셋');
  });

  it('maps each 2D improvement to one selected source and retains all originals', () => {
    const sprite = asset('game-sprite', 'sprite');
    const originals = [image, sprite];
    const before = structuredClone(originals);
    const proposal: GameBundlePlan = {...plan(), mode: 'improve', referenceAssetIds: originals.map(source => source.id), references: originals.map(reference),
      items: originals.map((source, index) => ({...item(index), kind: source.kind, targetAssetId: source.id, referenceAssetIds: [source.id]}))};
    const reviewed = reviewedBundlePlan(proposal, originals, true, true);
    expect(reviewed.items.map(row => row.targetAssetId)).toEqual(originals.map(source => source.id));
    expect(originals).toEqual(before);
    const duplicate = {...proposal, items: proposal.items.map(row => ({...row, targetAssetId: image.id, referenceAssetIds: [image.id]}))};
    expect(() => reviewedBundlePlan(duplicate, originals, true, true)).toThrow('같은 원본');
    expect(() => reviewedBundlePlan({...proposal, items: [{...proposal.items[0], targetAssetId: null}]}, originals, true, true)).toThrow('새 버전의 대상');
    expect(() => reviewedBundlePlan({...proposal, items: [{...proposal.items[0], targetAssetId: model.id, referenceAssetIds: [model.id]}], referenceAssetIds: [model.id]}, assets, true, true)).toThrow('2D 참고 자료');
  });

  it('invalidates changed reference metadata even when the active version ID stays the same', () => {
    expect(bundleReferenceMatchesAsset(reference(model), model)).toBe(true);
    expect(bundleReferenceMatchesAsset({...reference(model), versionId: 'older-version'}, model)).toBe(false);
    expect(bundleReferenceMatchesAsset({...reference(model), mesh: {...model.mesh!, dimensions: [2, .16, .34]}}, model)).toBe(false);
    expect(bundleReferenceMatchesAsset({...reference(image), width: 256}, image)).toBe(false);
    expect(bundleReferenceMatchesAsset(reference(image), undefined)).toBe(false);
  });

  it('offers exactly nine fixed recipes with the verified rifle and spaceship dimensions', () => {
    expect(GAME_MODEL_TEMPLATES.map(recipe => recipe.id)).toEqual(['crate', 'table', 'shelf', 'sword', 'rifle', 'spaceship', 'barrel', 'rock', 'tree']);
    const rifle = bundleModelParameters('rifle', 'Rifle', '#799993');
    const ship = bundleModelParameters('spaceship', 'Ship', '#799993');
    expect([rifle.width, rifle.depth, rifle.height]).toEqual([1.1, .16, .34]);
    expect([ship.width, ship.depth, ship.height]).toEqual([1.6, 2.2, .6]);
    for (const recipe of GAME_MODEL_TEMPLATES) {
      const row = {...item(0, 'model'), modelParameters: bundleModelParameters(recipe.id, 'Asset', '#799993')};
      expect(validateBundleItems({...plan([row]), output: 'models'}, [])).toEqual([]);
    }
  });

  it('disables browser planning and never silently selects the primary fixture or saved style references', () => {
    const proposal = withReferences();
    const snapshot: ProjectSnapshot = {root: 'qa', project: {id: proposal.projectId, name: 'QA', schemaVersion: 1, createdAt: '2026-10-04', updatedAt: '2026-10-04',
      spec: proposal.spec, styleGuide: {...proposal.styleGuide, referenceAssetIds: [image.id]}, assets, jobs: []}, providers: []};
    const onPlan = vi.fn(async () => proposal);
    const onSubmit = vi.fn(async () => {});
    const markup = renderToStaticMarkup(<GameBundlePanel snapshot={snapshot} spec={snapshot.project.spec} styleGuide={snapshot.project.styleGuide} selectedAssetIds={[image.id]}
      native={false} busy={false} providerReady providerChecking={false} providerPanel={<span>Mock provider</span>} initialBrief="spacewar weapons5" initialCount={5}
      onImport={async () => {}} onPlan={onPlan} onSubmit={onSubmit}/>);
    expect(markup).toContain('0 / 5 선택');
    expect(markup).toContain('gpt-5.5');
    expect(markup).toContain('이 단계에서는 이미지를 생성하지 않습니다.');
    expect(markup).toContain('브라우저에서는');
    expect(markup).toMatch(/<button\b[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*구성안 만들기<\/button>/);
    expect(markup).not.toContain(' checked=""');
    expect(onPlan).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
