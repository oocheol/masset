import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installSkill, statusSkill, resolveLocation, loadBundle, inventoryDigest, RECEIPT_NAME } from '../../integrations/npm/lib/installer.mjs';

const packageSource = fileURLToPath(new URL('../../integrations/npm/', import.meta.url));

async function fixture(t) {
  const temporaryBase = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryBase, 'asset-studio-npm-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), temporaryBase);
    assert.match(path.basename(root), /^asset-studio-npm-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const packageRoot = path.join(root, 'Package with spaces');
  const project = path.join(root, 'Game with spaces');
  await fs.cp(packageSource, packageRoot, { recursive: true });
  await fs.mkdir(project);
  return { root, packageRoot, project, target: path.join(project, '.agents', 'skills', 'asset-studio') };
}

async function reviseManifest(packageRoot, change) {
  const manifestPath = path.join(packageRoot, 'skill-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  change(manifest);
  manifest.inventorySha256 = inventoryDigest(manifest);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
}

test('fresh installation copies exact pinned bytes without running loaders', async t => {
  const f = await fixture(t);
  const result = await installSkill(f.packageRoot, { project: f.project });
  assert.equal(result.operation, 'installed');
  assert.equal(result.state, 'current');
  assert.equal(result.backupPath, null);
  assert.deepEqual(result.runtimeVersions, { 'windows-x64': '0.1.11', 'macos-arm64': '0.1.11' });
  const bundle = await loadBundle(f.packageRoot);
  for (const file of bundle.manifest.files) assert.deepEqual(await fs.readFile(path.join(f.target, file.path)), bundle.contents.get(file.path));
  assert.deepEqual((await fs.readdir(path.join(f.project, '.agents'))).sort(), ['.asset-studio-skill', 'skills']);
});

test('same verified version is unchanged and creates no backup', async t => {
  const f = await fixture(t);
  await installSkill(f.packageRoot, { project: f.project });
  const before = await fs.readFile(path.join(f.target, RECEIPT_NAME));
  const result = await installSkill(f.packageRoot, { project: f.project });
  assert.equal(result.operation, 'unchanged');
  assert.deepEqual(await fs.readFile(path.join(f.target, RECEIPT_NAME)), before);
  assert.equal(result.backupPath, null);
});

test('modified files and additional user files are fully preserved outside discovery', async t => {
  const f = await fixture(t);
  await installSkill(f.packageRoot, { project: f.project });
  await fs.writeFile(path.join(f.target, 'SKILL.md'), 'Personal instructions\r\n');
  await fs.writeFile(path.join(f.target, 'user-notes.txt'), 'Keep this original');
  const status = await statusSkill(f.packageRoot, { project: f.project });
  assert.equal(status.state, 'modified');
  assert.ok(status.modifiedFiles.includes('SKILL.md'));
  assert.ok(status.extraFiles.includes('user-notes.txt'));
  const result = await installSkill(f.packageRoot, { project: f.project });
  assert.equal(result.operation, 'updated');
  assert.equal(await fs.readFile(path.join(result.backupPath, 'SKILL.md'), 'utf8'), 'Personal instructions\r\n');
  assert.equal(await fs.readFile(path.join(result.backupPath, 'user-notes.txt'), 'utf8'), 'Keep this original');
  assert.ok(!result.backupPath.startsWith(path.join(f.project, '.agents', 'skills') + path.sep));
  assert.equal((await statusSkill(f.packageRoot, { project: f.project })).state, 'current');
});

test('unmanaged and malformed receipts are preserved instead of merged or deleted', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.target, { recursive: true });
  await fs.writeFile(path.join(f.target, RECEIPT_NAME), '{broken json');
  await fs.writeFile(path.join(f.target, 'SKILL.md'), 'Legacy original');
  const result = await installSkill(f.packageRoot, { project: f.project });
  assert.equal(result.operation, 'updated');
  assert.equal(await fs.readFile(path.join(result.backupPath, RECEIPT_NAME), 'utf8'), '{broken json');
  assert.equal(await fs.readFile(path.join(result.backupPath, 'SKILL.md'), 'utf8'), 'Legacy original');
});

test('a newer npm installer may retain the same pinned native runtime', async t => {
  const f = await fixture(t);
  await installSkill(f.packageRoot, { project: f.project });
  const packageJson = path.join(f.packageRoot, 'package.json');
  const descriptor = JSON.parse(await fs.readFile(packageJson, 'utf8'));
  descriptor.version = '0.1.12';
  await fs.writeFile(packageJson, JSON.stringify(descriptor));
  await reviseManifest(f.packageRoot, manifest => { manifest.packageVersion = '0.1.12'; });
  const result = await installSkill(f.packageRoot, { project: f.project });
  assert.equal(result.packageVersion, '0.1.12');
  assert.equal(result.runtimeVersions['windows-x64'], '0.1.11');
  assert.ok(result.backupPath);
});

test('tampered bundled bytes fail before any project folders are written', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.packageRoot, 'skill', 'SKILL.md'), '\nTampered');
  await assert.rejects(installSkill(f.packageRoot, { project: f.project }), /size does not match|hash does not match/);
  await assert.rejects(fs.stat(path.join(f.project, '.agents')), { code: 'ENOENT' });
});

test('extra bundle files cannot be silently published or installed', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.packageRoot, 'skill', 'private.txt'), 'not part of the release');
  await assert.rejects(loadBundle(f.packageRoot), /Unexpected file/);
});

test('traversal, Windows reserved names and case collisions are rejected', async t => {
  for (const replacement of ['../escape.txt', 'C:/escape.txt', 'scripts/CON.txt', 'scripts/filename.']) {
    const f = await fixture(t);
    await reviseManifest(f.packageRoot, manifest => { manifest.files[0].path = replacement; });
    await assert.rejects(loadBundle(f.packageRoot), /Unsafe/);
  }
  const f = await fixture(t);
  await reviseManifest(f.packageRoot, manifest => { manifest.files.push({ ...manifest.files[0], path: manifest.files[0].path.toUpperCase() }); });
  await assert.rejects(loadBundle(f.packageRoot), /Duplicate/);
});

test('junction or symlink parent cannot redirect writes outside the project', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'Outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.project, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installSkill(f.packageRoot, { project: f.project }), /symbolic link or junction/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a linked active skill is refused without changing its source', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'Original skill');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'SKILL.md'), 'original');
  await fs.mkdir(path.dirname(f.target), { recursive: true });
  await fs.symlink(outside, f.target, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installSkill(f.packageRoot, { project: f.project }), /symbolic link or junction/);
  assert.equal(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8'), 'original');
});

test('an exclusive install lock prevents overlapping writes', async t => {
  const f = await fixture(t);
  const location = await resolveLocation({ project: f.project });
  await fs.mkdir(location.control, { recursive: true });
  const lock = path.join(location.control, 'install.lock');
  await fs.writeFile(lock, 'another installer');
  await assert.rejects(installSkill(f.packageRoot, { project: f.project }), /in progress/);
  assert.equal(await fs.readFile(lock, 'utf8'), 'another installer');
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});

test('final rename failure restores the entire original directory', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.target, { recursive: true });
  await fs.writeFile(path.join(f.target, 'SKILL.md'), 'Recover this original');
  const rename = async (from, to) => {
    if (path.basename(from).startsWith('stage-')) throw new Error('Simulated finalization failure');
    await fs.rename(from, to);
  };
  await assert.rejects(installSkill(f.packageRoot, { project: f.project, rename }), /Simulated finalization failure/);
  assert.equal(await fs.readFile(path.join(f.target, 'SKILL.md'), 'utf8'), 'Recover this original');
  const location = await resolveLocation({ project: f.project });
  assert.deepEqual(await fs.readdir(location.control), ['backups']);
});

test('failed final verification restores the original rather than reporting success', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.target, { recursive: true });
  await fs.writeFile(path.join(f.target, 'SKILL.md'), 'Original before verification');
  const rename = async (from, to) => {
    if (path.basename(from).startsWith('stage-')) await fs.writeFile(path.join(from, 'SKILL.md'), 'Corrupted before activation');
    await fs.rename(from, to);
  };
  await assert.rejects(installSkill(f.packageRoot, { project: f.project, rename }), /did not pass verification/);
  assert.equal(await fs.readFile(path.join(f.target, 'SKILL.md'), 'utf8'), 'Original before verification');
});

test('cleanup failure still releases the lock and preserves the primary failure', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.target, { recursive: true });
  await fs.writeFile(path.join(f.target, 'SKILL.md'), 'Recover after cleanup error');
  const rename = async (from, to) => {
    if (path.basename(from).startsWith('stage-')) throw new Error('Primary activation error');
    await fs.rename(from, to);
  };
  const removeStage = async () => { throw new Error('Cleanup error'); };
  await assert.rejects(installSkill(f.packageRoot, { project: f.project, rename, removeStage }), /Primary activation error.*Cleanup error/);
  assert.equal(await fs.readFile(path.join(f.target, 'SKILL.md'), 'utf8'), 'Recover after cleanup error');
  const location = await resolveLocation({ project: f.project });
  await assert.rejects(fs.stat(path.join(location.control, 'install.lock')), { code: 'ENOENT' });
  assert.equal((await installSkill(f.packageRoot, { project: f.project })).state, 'current');
});

test('one shared lock prevents a second global installer selecting a temporarily missing legacy skill', async t => {
  const f = await fixture(t);
  const legacy = path.join(f.project, '.codex', 'skills', 'asset-studio');
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, 'SKILL.md'), 'Legacy original');
  let attemptedSecondInstall = false;
  const rename = async (from, to) => {
    await fs.rename(from, to);
    if (from === legacy) {
      attemptedSecondInstall = true;
      await assert.rejects(installSkill(f.packageRoot, { home: f.project }), /in progress/);
    }
  };
  const result = await installSkill(f.packageRoot, { home: f.project, rename });
  assert.equal(result.skillPath, legacy);
  assert.equal(attemptedSecondInstall, true);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});

test('a single legacy user location is reused without creating duplicate skills', async t => {
  const f = await fixture(t);
  const legacy = path.join(f.project, '.codex', 'skills', 'asset-studio');
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, 'SKILL.md'), 'Legacy user skill');
  const result = await installSkill(f.packageRoot, { home: f.project });
  assert.equal(result.skillPath, legacy);
  assert.equal(await fs.readFile(path.join(result.backupPath, 'SKILL.md'), 'utf8'), 'Legacy user skill');
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});

test('two existing user locations are reported without deleting either original', async t => {
  const f = await fixture(t);
  const legacy = path.join(f.project, '.codex', 'skills', 'asset-studio');
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, 'SKILL.md'), 'Keep older skill');
  await installSkill(f.packageRoot, { project: f.project });
  const status = await statusSkill(f.packageRoot, { home: f.project });
  assert.equal(status.duplicatePaths.length, 2);
  assert.equal(await fs.readFile(path.join(legacy, 'SKILL.md'), 'utf8'), 'Keep older skill');
});

test('CLI accepts an absolute project with spaces and emits useful JSON', async t => {
  const f = await fixture(t);
  const cli = path.join(f.packageRoot, 'bin', 'asset-studio-skill.mjs');
  const run = spawnSync(process.execPath, [cli, 'install', '--project', f.project, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).state, 'current');
  const status = spawnSync(process.execPath, [cli, 'status', '--project', f.project, '--json'], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).skillPath, f.target);
});

test('invalid CLI options and relative project paths write nothing', async t => {
  const f = await fixture(t);
  const cli = path.join(f.packageRoot, 'bin', 'asset-studio-skill.mjs');
  for (const args of [['install', '--unknown'], ['install', '--project'], ['install', '--project', 'relative/path']]) {
    const run = spawnSync(process.execPath, [cli, ...args], { cwd: f.project, encoding: 'utf8' });
    assert.equal(run.status, 1);
  }
  assert.deepEqual(await fs.readdir(f.project), []);
});
