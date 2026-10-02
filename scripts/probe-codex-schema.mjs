/**
 * Legacy read-only public schema extractor; current image target is GPT Image 2.
 * Schema inspection does not connect an account, submit inference, verify
 * production controls or prove an image round trip. Production provider:
 * crates/providers/src/runtime.rs. Writes unique evidence and preserves the
 * original historical codex-schema-summary.json; removes only verified temp.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const scope = resolve(root, 'tests/provider');
const evidenceScope = join(scope, 'legacy-readonly');
const out = join(evidenceScope, `codex-schema-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
const exe = process.env.CODEX_PROBE_EXECUTABLE || 'C:/Users/PC/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe';
await mkdir(scope, { recursive: true });
const temp = await mkdtemp(join(scope, '.codex-schema-'));
const env = { ...process.env };
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
try {
  const generated = spawnSync(exe, ['app-server', 'generate-json-schema', '--experimental', '--out', temp], {
    windowsHide: true, env, encoding: 'utf8', timeout: 30_000,
  });
  if (generated.status !== 0) throw new Error('Codex schema generation failed; raw runtime output discarded');
  const read = async (name) => JSON.parse(await readFile(join(temp, name), 'utf8'));
  const requests = await read('ClientRequest.json');
  const threadStart = await read('v2/ThreadStartParams.json');
  const turnStart = await read('v2/TurnStartParams.json');
  const itemCompleted = await read('v2/ItemCompletedNotification.json');
  const capability = await read('v2/ModelProviderCapabilitiesReadResponse.json');
  const imageItem = itemCompleted.definitions.ThreadItem.oneOf.find((entry) => entry.title === 'ImageGenerationThreadItem');
  const relevantMethods = requests.oneOf.flatMap((entry) => entry.properties?.method?.enum || [])
    .filter((method) => /image|account\/read|model\/list|capabilities\/read/i.test(method));
  const imageModelControls = ['thread/start', 'turn/start'].flatMap((rpc, index) => {
    const schema = index === 0 ? threadStart : turnStart;
    return Object.keys(schema.properties).filter((field) => /image.*model|model.*image/i.test(field)).map((field) => `${rpc}.${field}`);
  });
  const summary = {
    probeScope: 'legacy_read_only_schema',
    productionImplementation: 'crates/providers/src/runtime.rs',
    productionControlsVerified: false,
    requestedImageModel: 'gpt-image-2',
    confirmedImageModel: null,
    generationAttempted: false,
    checkedAt: new Date().toISOString(),
    codexVersion: spawnSync(exe, ['--version'], { env, encoding: 'utf8', windowsHide: true }).stdout.trim(),
    experimentalSchema: true,
    relevantMethods,
    capabilityFields: Object.keys(capability.properties),
    nativeImageGenerationItem: imageItem,
    nativeImageModelSelectionField: imageModelControls.length ? imageModelControls : null,
    nativeImageConfirmedModelField: Object.keys(imageItem.properties).find((key) => /model/i.test(key)) || null,
    threadStartFields: Object.keys(threadStart.properties),
    turnStartFields: Object.keys(turnStart.properties),
    sourceSchemaSha256: createHash('sha256').update(await readFile(join(temp, 'codex_app_server_protocol.schemas.json'))).digest('hex'),
    limitation: 'An ImageGeneration schema item and capability field describe the documented GPT Image 2 route. Neither proves authenticated inference eligibility, the confirmed image model, image receipt/decode or project save/reopen. This legacy schema probe does not verify production Rust transport, planner or feature pins.',
  };
  await mkdir(evidenceScope, { recursive: true });
  await writeFile(out, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  const actual = await realpath(temp);
  const actualScope = await realpath(scope);
  if (!actual.startsWith(actualScope + sep) || !actual.startsWith(join(actualScope, '.codex-schema-'))) {
    throw new Error('Refusing cleanup outside verified provider probe scope');
  }
  await rm(actual, { recursive: true, force: true });
}
