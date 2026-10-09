import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseSyntheticScenarios } from '../src/syntheticScenarios.ts';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/examples/synthetic-claude');
const bytes = await fs.readFile(path.join(directory, 'scenarios.json'));
const examples = parseSyntheticScenarios(JSON.parse(bytes.toString('utf8')));
const receipt = {
  schemaVersion: 1,
  type: 'local-synthetic-fixture-verification',
  sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  scope: 'Local checks of authored JSON provenance, bilingual fields, bounded plans, safe proposed filenames and null observations; not a Claude or user evaluation.',
  providerExecuted: false, realParticipants: 0, outputFilesGenerated: 0,
  observedMetrics: null,
  cases: examples.cases.map(scenario => ({ id: scenario.id, illustrativeAssets: scenario.plan.assets.length, checked: ['fictional-provenance', 'no-observed-results', 'bilingual-fields', 'bounded-asset-count', 'safe-proposed-filenames', 'review-criteria-present'], fixtureChecksPassed: true })),
};
await fs.writeFile(path.join(directory, 'static-verification.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ syntheticFixtureCases: receipt.cases.length, illustrativeAssets: receipt.cases.reduce((sum, scenario) => sum + scenario.illustrativeAssets, 0), providerExecuted: false, fixtureChecksPassed: true }));
