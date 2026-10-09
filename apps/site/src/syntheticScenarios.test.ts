import { describe, expect, it } from 'vitest';
import fixtures from '../public/examples/synthetic-claude/scenarios.json';
import { parseSyntheticScenarios } from './syntheticScenarios';

describe('publication boundary for synthetic evaluation examples', () => {
  it('keeps six distinct roles as authored examples without observations', () => {
    const set = parseSyntheticScenarios(fixtures);
    expect(new Set(set.cases.map(scenario => scenario.persona.role.en)).size).toBe(6);
    expect(set.cases.every(scenario => scenario.observedResults === null && scenario.metrics === null)).toBe(true);
    expect(set.providerExecuted).toBe(false);
  });
  it('rejects reclassifying fiction as a Claude run or user measurement', () => {
    const provider = structuredClone(fixtures); provider.providerExecuted = true;
    expect(() => parseSyntheticScenarios(provider)).toThrow(/provider execution/);
    const measurements: Record<string, unknown> = structuredClone(fixtures);
    (measurements.cases as Record<string, unknown>[])[0].metrics = { secondsSaved: 12 };
    expect(() => parseSyntheticScenarios(measurements)).toThrow(/observations or measurements/);
  });
  it('rejects executable or path-bearing proposed output names', () => {
    const set = structuredClone(fixtures); set.cases[0].plan.assets[0].filename = '../run.cmd';
    expect(() => parseSyntheticScenarios(set)).toThrow(/proposed output basename/);
  });
  it('rejects plans beyond the requested asset scope and conflicting output names', () => {
    const oversized = structuredClone(fixtures); oversized.cases[0].input.assetLimit = 1;
    expect(() => parseSyntheticScenarios(oversized)).toThrow(/requested scope/);
    const duplicate = structuredClone(fixtures); duplicate.cases[0].plan.assets[1] = structuredClone(duplicate.cases[0].plan.assets[0]);
    expect(() => parseSyntheticScenarios(duplicate)).toThrow(/duplicate asset name/);
  });
  it('requires both languages for instructions and review criteria', () => {
    const set = structuredClone(fixtures); set.cases[0].plan.assets[0].acceptanceChecks[0].en = '';
    expect(() => parseSyntheticScenarios(set)).toThrow(/readable text/);
  });
});
