/**
 * Legacy read-only feasibility probe retained for historical reproduction.
 * Current target: GPT Image 2. Does not verify production transport/planner/
 * feature pins, select an inference model, or submit an inference turn.
 * Production provider: crates/providers/src/runtime.rs.
 * Never reads authentication files. Each run writes fresh evidence.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const exe = process.env.CODEX_PROBE_EXECUTABLE || 'C:/Users/PC/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe';
const evidenceScope = resolve(root, 'tests/provider/legacy-readonly');
const out = resolve(evidenceScope, `codex-probe-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
const env = { ...process.env };
// Credentials stay owned by the official runtime. Never opt into API-key billing.
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
const version = spawnSync(exe, ['--version'], { env, encoding: 'utf8', windowsHide: true });
if (version.status !== 0) throw new Error('Official Codex executable unavailable');
const safeVersion = version.stdout.trim();
if (!/^codex-cli \d+\.\d+\.\d+$/.test(safeVersion)) throw new Error('Unrecognized Codex version; raw output discarded');
const proc = spawn(exe, ['app-server', '--listen', 'stdio://', '-c', 'model_provider="openai"'], {
  env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let nextId = 1;
const pending = new Map();
let stderrBytes = 0;
proc.stderr.on('data', (data) => { stderrBytes += data.length; });
const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) {
    const code = Number.isInteger(message.error.code) ? message.error.code : 'unknown';
    entry.reject(new Error(`RPC ${entry.method}: ${code}`));
  }
  else entry.resolve(message.result);
});
proc.on('exit', () => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('Codex app-server exited before completing read-only probe'));
  }
  pending.clear();
});
function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolveRpc, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC ${method}: timeout`));
    }, 25_000);
    pending.set(id, { method, resolve: resolveRpc, reject, timer });
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const report = {
  schemaVersion: 1,
  probeScope: 'legacy_read_only_feasibility',
  productionImplementation: 'crates/providers/src/runtime.rs',
  productionControlsVerified: false,
  officialProviderVerified: false,
  inferenceReadiness: 'not_verified_by_this_probe',
  checkedAt: new Date().toISOString(),
  clientDate: '2026-10-02',
  codexVersion: safeVersion,
  providerRequested: 'openai',
  requestedImageModel: 'gpt-image-2',
  confirmedImageModel: null,
  generationAttempted: false,
  paidApiCalls: 0,
  imageFilesReceived: 0,
  imageDecode: 'not_reached',
  projectSave: 'not_reached',
  projectReopen: 'not_reached',
  endpointsCalled: ['initialize', 'account/read', 'modelProvider/capabilities/read', 'model/list'],
};
try {
  await rpc('initialize', { clientInfo: { name: 'asset_studio_feasibility', title: 'Asset Studio feasibility', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  proc.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const account = await rpc('account/read', { refreshToken: false });
  report.auth = {
    accountType: ['chatgpt', 'apiKey'].includes(account.account?.type) ? account.account.type : null,
    authenticated: account.account != null,
    planType: ['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'education', 'edu'].includes(account.account?.planType) ? account.account.planType : null,
    requiresOpenaiAuth: typeof account.requiresOpenaiAuth === 'boolean' ? account.requiresOpenaiAuth : null,
  };
  // Do not retain account IDs, email addresses, tokens, headers, or full RPC payloads.
  const bounds = await rpc('modelProvider/capabilities/read');
  report.runtimeCapabilities = Object.fromEntries(['namespaceTools', 'imageGeneration', 'webSearch'].map((key) => [key, typeof bounds[key] === 'boolean' ? bounds[key] : null]));
  const models = await rpc('model/list', { includeHidden: true });
  const safeModelId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,256}$/.test(value) ? value : null;
  report.models = (models.data || []).map((model) => ({
    id: safeModelId(model.id), model: safeModelId(model.model),
    inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities.filter((value) => ['text', 'image', 'audio'].includes(value)) : null,
    isDefault: typeof model.isDefault === 'boolean' ? model.isDefault : null,
  }));
  report.subscriptionGenerationStatus = 'unverified_read_only_legacy_probe';
  report.reason = 'The user selected the documented native GPT Image 2 target. This legacy probe observes account, catalog and capability only; inherited endpoint and planner settings are not verified. Use the production Rust provider for its fixed planner/OpenAI controls and the separate live artifact proof. No paid API fallback is authorized.';
} catch (error) {
  report.probeError = error.message;
  report.subscriptionGenerationStatus = 'unverified_runtime_probe_failed';
} finally {
  report.stderrBytesDiscarded = stderrBytes;
  rl.close();
  proc.stdin.end();
  proc.kill();
}
await mkdir(evidenceScope, { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
if (report.probeError) process.exitCode = 1;
