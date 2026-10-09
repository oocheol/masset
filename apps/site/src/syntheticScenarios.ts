import type { Localized } from './policies';

export type SyntheticAsset = { name: string; kind: 'sprite' | 'texture' | 'model' | 'image'; purpose: Localized; instruction: Localized; format: 'PNG' | 'GLB'; filename: string; acceptanceChecks: Localized[]; triangleLimit?: number };
export type SyntheticScenario = {
  id: string; title: Localized; persona: { role: Localized; context: Localized };
  input: { brief: Localized; artDirection: Localized; assetLimit: number };
  dialogue: { speaker: 'simulated-user' | 'illustrative-plan' | 'simulated-follow-up'; text: Localized }[];
  plan: { assets: SyntheticAsset[]; reviewChecklist: Localized[] };
  concerns: Localized[]; evaluationCriteria: Localized[]; revisionNote: Localized;
  status: 'illustrative-not-executed'; observedResults: null; metrics: null;
};
export type SyntheticScenarioSet = { schemaVersion: 1; type: 'synthetic-design-evaluation'; synthetic: true; providerExecuted: false; authoredOn: string; author: string; notice: Localized; cases: SyntheticScenario[] };

function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Synthetic examples: ${message}`); }
function object(value: unknown, path: string): Record<string, unknown> { requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${path} must be an object`); return value as Record<string, unknown>; }
function localized(value: unknown, path: string) { const text = object(value, path); for (const lang of ['ko', 'en']) requireValue(typeof text[lang] === 'string' && text[lang].trim().length > 0 && text[lang].length <= 12000, `${path}.${lang} must have readable text`); }
function localizedList(value: unknown, path: string) { requireValue(Array.isArray(value) && value.length > 0 && value.length <= 20, `${path} must be a bounded nonempty list`); value.forEach((item, index) => localized(item, `${path}[${index}]`)); }

/** Validate authored examples. This never invokes a provider or executes a plan. */
export function parseSyntheticScenarios(input: unknown): SyntheticScenarioSet {
  const data = object(input, 'root');
  requireValue(data.schemaVersion === 1 && data.type === 'synthetic-design-evaluation', 'unsupported provenance');
  requireValue(data.synthetic === true && data.providerExecuted === false, 'fiction must not be relabeled as provider execution');
  requireValue(typeof data.authoredOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.authoredOn), 'authored date missing');
  requireValue(typeof data.author === 'string' && data.author.trim(), 'author missing');
  localized(data.notice, 'notice');
  requireValue(Array.isArray(data.cases) && data.cases.length === 6, 'exactly six authored scenarios required');
  const ids = new Set<string>();
  for (const [index, raw] of data.cases.entries()) {
    const scenario = object(raw, `cases[${index}]`);
    requireValue(scenario.id === `SIM-${String(index + 1).padStart(2, '0')}` && !ids.has(String(scenario.id)), 'stable unique scenario IDs required'); ids.add(String(scenario.id));
    requireValue(scenario.status === 'illustrative-not-executed' && scenario.observedResults === null && scenario.metrics === null, 'an illustrative record cannot claim observations or measurements');
    localized(scenario.title, 'title'); const persona = object(scenario.persona, 'persona'); localized(persona.role, 'persona.role'); localized(persona.context, 'persona.context');
    const brief = object(scenario.input, 'input'); localized(brief.brief, 'input.brief'); localized(brief.artDirection, 'input.artDirection');
    requireValue(Number.isInteger(brief.assetLimit) && Number(brief.assetLimit) >= 1 && Number(brief.assetLimit) <= 12, 'assetLimit must be from 1 to 12');
    requireValue(Array.isArray(scenario.dialogue) && scenario.dialogue.length === 3, 'three authored dialogue turns required');
    const speakers = ['simulated-user', 'illustrative-plan', 'simulated-follow-up'];
    scenario.dialogue.forEach((turn, turnIndex) => { const value = object(turn, 'dialogue'); requireValue(value.speaker === speakers[turnIndex], 'dialogue provenance missing'); localized(value.text, 'dialogue.text'); });
    const plan = object(scenario.plan, 'plan');
    requireValue(Array.isArray(plan.assets) && plan.assets.length > 0 && plan.assets.length <= Number(brief.assetLimit), 'plan exceeds its requested scope');
    const names = new Set<string>(), filenames = new Set<string>();
    for (const rawAsset of plan.assets) {
      const asset = object(rawAsset, 'asset');
      requireValue(typeof asset.name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(asset.name) && !names.has(asset.name), 'unsafe or duplicate asset name'); names.add(asset.name);
      requireValue(['sprite', 'texture', 'model', 'image'].includes(String(asset.kind)), 'unsupported asset kind');
      requireValue(asset.format === (asset.kind === 'model' ? 'GLB' : 'PNG'), 'format must match asset kind');
      requireValue(asset.filename === `${asset.name}.${asset.format === 'GLB' ? 'glb' : 'png'}` && !filenames.has(String(asset.filename)), 'filename must be a unique proposed output basename'); filenames.add(String(asset.filename));
      localized(asset.purpose, 'asset.purpose'); localized(asset.instruction, 'asset.instruction'); localizedList(asset.acceptanceChecks, 'asset.acceptanceChecks');
      if (asset.triangleLimit !== undefined) requireValue(asset.kind === 'model' && Number.isInteger(asset.triangleLimit) && Number(asset.triangleLimit) > 0 && Number(asset.triangleLimit) <= 1000000, 'invalid triangle target');
    }
    localizedList(plan.reviewChecklist, 'plan.reviewChecklist'); localizedList(scenario.concerns, 'concerns'); localizedList(scenario.evaluationCriteria, 'evaluationCriteria'); localized(scenario.revisionNote, 'revisionNote');
  }
  return input as SyntheticScenarioSet;
}
