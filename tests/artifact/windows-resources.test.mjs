import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertFrozenResourcePlan, copyWindowsResources, planWindowsResources, validateWindowsNotices } from '../../scripts/copy-windows-resources.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const currentConfig = JSON.parse(fs.readFileSync(path.join(repository, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const temporaryRoots = [];
const extras = [
  ['docs/architecture.md', 'docs/architecture.md'],
  ['docs/module-contract.md', 'docs/module-contract.md'],
  ['crates/providers/assets/NOTICE', 'CODEX-CATALOG-NOTICE.txt'],
  ['crates/providers/assets/OPENAI-CODEX-NOTICE', 'CODEX-UPSTREAM-NOTICE.txt'],
  ['crates/providers/assets/OPENAI-CODEX-LICENSE', 'CODEX-CATALOG-LICENSE.txt'],
];

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-winresources-'));
  temporaryRoots.push(temporary);
  const workspace = path.join(temporary, 'repo 한글');
  const configPath = path.join(workspace, 'apps/desktop/src-tauri/tauri.conf.json');
  const config = { version: currentConfig.version, bundle: { resources: { ...currentConfig.bundle.resources } } };
  const expected = new Map();
  const write = (filename, bytes) => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  };
  const seed = (source, target) => {
    const bytes = Buffer.from(`Independent fixture bytes\n${path.relative(workspace, source)}\n\0\xff`, 'utf8');
    write(source, bytes);
    expected.set(target.replace(/\/$/, ''), { source, bytes });
  };
  for (const [relative, target] of Object.entries(config.bundle.resources)) {
    const source = path.resolve(path.dirname(configPath), relative);
    if (relative.endsWith('/')) {
      const children = target === 'examples/'
        ? ['fixture.png', 'model.glb']
        : ['fixture-notice.txt', 'nested/source-notice.txt'];
      for (const child of children) seed(path.join(source, child), target + child);
    } else seed(source, target);
  }
  for (const [relative, target] of extras) {
    const source = path.join(workspace, relative);
    if (!fs.existsSync(source)) seed(source, target);
    else expected.set(target, { source, bytes: fs.readFileSync(source) });
  }
  // These local runtimes, build caches, outputs and tests must never become resources.
  for (const relative of [
    'workers/image3d/.runtime/model.bin',
    'workers/image3d/__pycache__/worker.pyc',
    'workers/image3d/tests/private-proof.json',
    'workers/blender-quality/results/run.glb',
    'workers/blender/__pycache__/worker.pyc',
  ]) write(path.join(workspace, relative), Buffer.from('not redistributable'));
  const saveConfig = () => write(configPath, Buffer.from(JSON.stringify(config, null, 2) + '\n'));
  saveConfig();
  return { temporary, workspace, config, configPath, expected, saveConfig, write, destination: path.join(workspace, 'output/fresh package') };
}

function windowsNoticesFixture(item) {
  const lockFiles = { 'package-lock.json': Buffer.from('{"fixture":"npm lock"}\n'), 'Cargo.lock': Buffer.from('fixture = "Cargo lock"\n') };
  for (const [filename, bytes] of Object.entries(lockFiles)) item.write(path.join(item.workspace, filename), bytes);
  const inventory = {
    schemaVersion: 1,
    target: 'x86_64-pc-windows-msvc',
    inputs: { packageLockSha256: sha256(lockFiles['package-lock.json']), cargoLockSha256: sha256(lockFiles['Cargo.lock']) },
    counts: { missing: 0 },
    licenseTextCollectionComplete: true,
  };
  const save = () => item.write(path.join(item.workspace, 'docs/licenses/dependency-inventory.json'), Buffer.from(JSON.stringify(inventory) + '\n'));
  item.write(path.join(item.workspace, 'docs/licenses/THIRD_PARTY_LICENSES.txt'), Buffer.from('Fixture dependency copyright notice\n'));
  save();
  return { inventory, save };
}

afterEach(() => {
  for (const temporary of temporaryRoots.splice(0)) {
    const resolved = path.resolve(temporary);
    const expectedParent = fs.realpathSync(os.tmpdir());
    if (fs.realpathSync(path.dirname(resolved)) !== expectedParent || !path.basename(resolved).startsWith('asset-winresources-')) {
      throw new Error('Refusing to clean a path outside this test fixture');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('Windows resources use the shared Tauri distribution map', () => {
  it('copies every mapped byte, new worker/license/docs and legacy aliases, while excluding caches and local runtimes', () => {
    const item = fixture();
    item.write(path.join(item.destination, 'asset-desktop.exe'), Buffer.from('caller-owned executable'));
    const report = copyWindowsResources(item);
    expect(report.copiedBytesVerified).toBe(true);
    expect(report.resourceMappings).toBe(Object.keys(currentConfig.bundle.resources).length);
    expect(report.tauriConfigSha256).toBe(sha256(fs.readFileSync(item.configPath)));
    expect(report.files).toHaveLength(item.expected.size);
    for (const required of [
      'workers/image3d/setup.py', 'workers/image3d/worker.py', 'workers/image3d/glb_color.py',
      'workers/image3d/runtime-lock.json', 'workers/image3d/LICENSE',
      'workers/image3d/licenses/fixture-notice.txt',
      'workers/blender-quality/worker.py', 'workers/blender-quality/audit.py', 'workers/blender-quality/LICENSE',
      'docs/game-asset-bundles.md', 'docs/game-production.md', 'docs/model-quality.md',
      'docs/architecture.md', 'docs/module-contract.md', 'CODEX-CATALOG-LICENSE.txt',
      'licenses/OPENAI-CODEX-LICENSE.txt', 'docs/licenses/nested/source-notice.txt',
    ]) expect(report.files.some(file => file.path === required), required).toBe(true);
    for (const record of report.files) {
      const expected = item.expected.get(record.path);
      expect(expected, record.path).toBeDefined();
      const copied = fs.readFileSync(path.join(item.destination, record.path));
      expect(copied, record.path).toEqual(expected.bytes);
      expect(record.bytes, record.path).toBe(expected.bytes.length);
      expect(record.sha256, record.path).toBe(sha256(expected.bytes));
      expect(fs.readFileSync(expected.source), 'source remains unchanged').toEqual(expected.bytes);
    }
    expect(fs.readFileSync(path.join(item.destination, 'asset-desktop.exe'), 'utf8')).toBe('caller-owned executable');
    expect(fs.existsSync(path.join(item.destination, 'workers/image3d/.runtime'))).toBe(false);
    expect(fs.existsSync(path.join(item.destination, 'workers/image3d/__pycache__'))).toBe(false);
    expect(fs.existsSync(path.join(item.destination, 'workers/image3d/tests'))).toBe(false);
    expect(fs.existsSync(path.join(item.destination, 'workers/blender-quality/results'))).toBe(false);
  });

  it('supports the PowerShell caller CLI with plan-only output and an exclusive copy report', () => {
    const item = fixture();
    const executable = path.join(repository, 'scripts/copy-windows-resources.mjs');
    const options = { encoding: 'utf8', windowsHide: true };
    const plan = JSON.parse(execFileSync(process.execPath, [executable, '--workspace', item.workspace, '--plan'], options));
    expect(plan.copiedBytesVerified).toBe(false);
    expect(fs.existsSync(item.destination)).toBe(false);
    const frozenPath = path.join(item.temporary, 'resources-frozen.json');
    item.write(frozenPath, Buffer.from(JSON.stringify(plan)));
    const rechecked = JSON.parse(execFileSync(process.execPath, [executable, '--workspace', item.workspace, '--plan', '--expected-plan', frozenPath], options));
    expect(rechecked.expectedPlanVerified).toBe(true);
    // The public packaging caller supplies the build report, not the raw plan.
    item.write(frozenPath, Buffer.from(JSON.stringify({ resourceManifest: plan })));
    const copied = JSON.parse(execFileSync(process.execPath, [executable, '--workspace', item.workspace, '--destination', item.destination, '--expected-plan', frozenPath], options));
    expect(copied.files).toEqual(plan.files);
    expect(copied.copiedBytesVerified).toBe(true);
    expect(copied.expectedPlanVerified).toBe(true);
  });

  it.each(['../escape', 'docs/../escape', '/absolute', 'C:\\absolute', '\\\\server\\share', 'docs/file:stream', 'docs/NUL.txt', 'docs/trailing.', 'docs/trailing ', 'docs//file'])('rejects unsafe Windows destination %s before creating the package', target => {
    const item = fixture();
    item.config.bundle.resources['../../../workers/image3d/worker.py'] = target;
    item.saveConfig();
    expect(() => copyWindowsResources(item)).toThrow(/relative Windows path|Unsafe Windows resource target/);
    expect(fs.existsSync(item.destination)).toBe(false);
  });

  it('rejects sources outside the repository without reading or copying them', () => {
    const item = fixture();
    item.write(path.join(item.temporary, 'outside/private.txt'), Buffer.from('preserved original'));
    item.config.bundle.resources['../../../../outside/private.txt'] = 'outside.txt';
    item.saveConfig();
    expect(() => copyWindowsResources(item)).toThrow(/Resource source must stay inside/);
    expect(fs.existsSync(item.destination)).toBe(false);
    expect(fs.readFileSync(path.join(item.temporary, 'outside/private.txt'), 'utf8')).toBe('preserved original');
  });

  it('rejects source directory links even when they point inside the repository', () => {
    const item = fixture();
    const link = path.join(item.workspace, 'linked-worker');
    fs.symlinkSync(path.join(item.workspace, 'workers/image3d'), link, 'junction');
    item.config.bundle.resources['../../../linked-worker/'] = 'linked-worker/';
    item.saveConfig();
    expect(() => copyWindowsResources(item)).toThrow(/contains a link/);
    expect(fs.existsSync(item.destination)).toBe(false);
  });

  it('rejects case-insensitive duplicate targets and file/directory target collisions', () => {
    const item = fixture();
    item.config.bundle.resources['../../../docs/game-production.md'] = 'WORKERS/IMAGE3D/WORKER.PY';
    item.saveConfig();
    expect(() => copyWindowsResources(item)).toThrow(/Duplicate Windows resource target/);
    item.config.bundle.resources['../../../docs/game-production.md'] = 'docs';
    item.saveConfig();
    expect(() => copyWindowsResources(item)).toThrow(/both a file and directory/);
    expect(fs.existsSync(item.destination)).toBe(false);
  });

  it('refuses reused output and preserves all old bytes rather than overwriting', () => {
    const item = fixture();
    const original = path.join(item.destination, 'workers/image3d/worker.py');
    item.write(original, Buffer.from('user original'));
    expect(() => copyWindowsResources(item)).toThrow(/fresh package directory|overwrite/);
    expect(fs.readFileSync(original, 'utf8')).toBe('user original');
    expect(fs.existsSync(path.join(item.destination, 'LICENSE'))).toBe(false);
  });

  it('rejects a linked output ancestor and an output path outside the fresh output tree', () => {
    const item = fixture();
    const external = path.join(item.temporary, 'outside-package');
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(item.workspace, 'output'), 'junction');
    expect(() => copyWindowsResources(item)).toThrow(/contains a link/);
    expect(fs.readdirSync(external)).toEqual([]);
    expect(() => copyWindowsResources({ ...item, destination: path.join(item.workspace, 'docs') })).toThrow(/Fresh package directory must stay inside/);
  });

  it('rejects missing resource files before creating any partial package', () => {
    const item = fixture();
    item.config.bundle.resources['../../../missing-worker.py'] = 'workers/image3d/missing.py';
    item.saveConfig();
    expect(() => planWindowsResources(item)).toThrow(/ENOENT/);
    expect(fs.existsSync(item.destination)).toBe(false);
  });

  it.each(['workers/image3d/worker.py', 'docs/game-production.md', 'workers/image3d/licenses/fixture-notice.txt'])('rejects changed bytes in %s with the exact same config and file length', source => {
    const item = fixture();
    const frozen = planWindowsResources(item);
    const originalConfig = fs.readFileSync(item.configPath);
    const filename = path.join(item.workspace, source);
    const changed = fs.readFileSync(filename);
    changed[0] ^= 0xff;
    fs.writeFileSync(filename, changed);
    expect(fs.readFileSync(item.configPath)).toEqual(originalConfig);
    expect(() => planWindowsResources({ ...item, expectedPlan: frozen })).toThrow(/Frozen resource changed:.*sha256/);
    expect(() => copyWindowsResources({ ...item, expectedPlan: frozen })).toThrow(/Frozen resource changed:.*sha256/);
    expect(fs.existsSync(item.destination)).toBe(false);
  });

  it('rejects a file added to a directory resource while the Tauri config stays unchanged', () => {
    const item = fixture();
    const frozen = planWindowsResources(item);
    item.write(path.join(item.workspace, 'workers/image3d/licenses/added.txt'), Buffer.from('new notice'));
    expect(planWindowsResources(item).tauriConfigSha256).toBe(frozen.tauriConfigSha256);
    expect(() => planWindowsResources({ ...item, expectedPlan: frozen })).toThrow(/Resource added after the plan was frozen/);
    expect(() => copyWindowsResources({ ...item, expectedPlan: frozen })).toThrow(/Resource added after the plan was frozen/);
    expect(fs.existsSync(item.destination)).toBe(false);
  });

  it('rejects a removed directory-resource file while the Tauri config stays unchanged', () => {
    const item = fixture();
    const frozen = planWindowsResources(item);
    fs.unlinkSync(path.join(item.workspace, 'workers/image3d/licenses/fixture-notice.txt'));
    expect(planWindowsResources(item).tauriConfigSha256).toBe(frozen.tauriConfigSha256);
    expect(() => planWindowsResources({ ...item, expectedPlan: frozen })).toThrow(/Resource removed after the plan was frozen/);
    expect(() => copyWindowsResources({ ...item, expectedPlan: frozen })).toThrow(/Resource removed after the plan was frozen/);
    expect(fs.existsSync(item.destination)).toBe(false);
  });

  it.each(['path', 'source', 'origin', 'bytes', 'sha256'])('compares the frozen record field %s, not just the configuration hash', field => {
    const item = fixture();
    const actual = planWindowsResources(item);
    const frozen = structuredClone(actual);
    const original = frozen.files.find(file => file.path === 'workers/image3d/worker.py');
    if (field === 'path') original.path = original.path.toUpperCase();
    if (field === 'source') original.source = 'workers/image3d/another.py';
    if (field === 'origin') original.origin = 'portable-compatibility';
    if (field === 'bytes') original.bytes += 1;
    if (field === 'sha256') original.sha256 = (original.sha256[0] === '0' ? '1' : '0') + original.sha256.slice(1);
    expect(() => assertFrozenResourcePlan(frozen, actual)).toThrow(new RegExp(`Frozen resource changed:.*\\(${field}\\)`));
  });

  it('accepts only complete Windows notices bound to the current npm and Cargo lock bytes', () => {
    const item = fixture();
    const { inventory } = windowsNoticesFixture(item);
    const validation = validateWindowsNotices(item);
    expect(validation.target).toBe('x86_64-pc-windows-msvc');
    expect(validation.inputs).toEqual(inventory.inputs);
    const frozen = planWindowsResources({ ...item, checkWindowsNotices: true });
    const copied = copyWindowsResources({ ...item, expectedPlan: frozen, checkWindowsNotices: true });
    expect(copied.windowsNotices).toEqual(validation);
    expect(copied.expectedPlanVerified).toBe(true);
  });

  it('rejects Apple Silicon notices even when both lock hashes match', () => {
    const item = fixture();
    const { inventory, save } = windowsNoticesFixture(item);
    inventory.target = 'aarch64-apple-darwin';
    save();
    expect(() => planWindowsResources({ ...item, checkWindowsNotices: true })).toThrow(/notices must be collected for x86_64-pc-windows-msvc/);
    expect(fs.existsSync(item.destination)).toBe(false);
  });

  it.each(['package-lock.json', 'Cargo.lock'])('rejects stale Windows notices when %s changes', filename => {
    const item = fixture();
    windowsNoticesFixture(item);
    item.write(path.join(item.workspace, filename), Buffer.from('changed locked dependencies'));
    expect(() => validateWindowsNotices(item)).toThrow(`Windows license inventory does not match ${filename}`);
    expect(fs.existsSync(item.destination)).toBe(false);
  });

  it('rejects incomplete license collection and nonzero missing counts', () => {
    const item = fixture();
    const { inventory, save } = windowsNoticesFixture(item);
    inventory.counts.missing = 1;
    save();
    expect(() => validateWindowsNotices(item)).toThrow(/unresolved records/);
    inventory.counts.missing = 0;
    inventory.licenseTextCollectionComplete = false;
    save();
    expect(() => validateWindowsNotices(item)).toThrow(/unresolved records/);
  });
});
