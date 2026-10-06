import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const PACKAGE_NAME = '@oocheol/asset-studio';
export const SKILL_NAME = 'asset-studio';
export const RECEIPT_NAME = '.asset-studio-npm.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export function inventoryDigest(manifest) {
  return sha256(JSON.stringify({
    schemaVersion: manifest.schemaVersion, packageName: manifest.packageName,
    packageVersion: manifest.packageVersion, skillName: manifest.skillName,
    runtimeVersions: manifest.runtimeVersions, files: manifest.files,
  }));
}

function assertInventory(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 64) throw new Error('Invalid skill inventory');
  const seen = new Set();
  for (const file of files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.split('/').some(segment =>
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment) || segment.endsWith('.') ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment))) throw new Error('Unsafe skill inventory path');
    const folded = file.path.toLowerCase();
    if (seen.has(folded)) throw new Error('Duplicate skill inventory path');
    seen.add(folded);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 4_194_304 ||
      !/^[0-9a-f]{64}$/.test(file.sha256) || ![0o644, 0o755].includes(file.mode)) throw new Error('Invalid skill file metadata');
  }
  if (!seen.has('skill.md') || !seen.has('references/native-runtime.json')) throw new Error('Incomplete skill inventory');
}

async function statIfPresent(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function assertSafePath(file) {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  const segments = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const stat = await statIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`Refusing a symbolic link or junction: ${current}`);
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
  }
}

async function ensureDirectory(directory) {
  await assertSafePath(directory);
  await fs.mkdir(directory, { recursive: true });
  await assertSafePath(directory);
}

export async function loadBundle(packageRoot) {
  await assertSafePath(packageRoot);
  const descriptor = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const manifestPath = path.join(packageRoot, 'skill-manifest.json');
  await assertSafePath(manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (descriptor.name !== PACKAGE_NAME || !semver.test(descriptor.version) ||
    manifest.schemaVersion !== 1 || manifest.format !== 'asset-studio-skill-bundle' ||
    manifest.packageName !== PACKAGE_NAME || manifest.packageVersion !== descriptor.version ||
    manifest.skillName !== SKILL_NAME) throw new Error('Package and skill manifest do not match');
  assertInventory(manifest.files);
  if (inventoryDigest(manifest) !== manifest.inventorySha256) throw new Error('Skill inventory hash does not match');
  const actualFiles = await listFiles(path.join(packageRoot, 'skill'));
  if (JSON.stringify(actualFiles) !== JSON.stringify(manifest.files.map(file => file.path).sort())) throw new Error('Unexpected file in skill bundle');
  const contents = new Map();
  for (const file of manifest.files) {
    const source = path.join(packageRoot, 'skill', ...file.path.split('/'));
    await assertSafePath(source);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.size !== file.bytes) throw new Error(`Skill file size does not match: ${file.path}`);
    const bytes = await fs.readFile(source);
    if (sha256(bytes) !== file.sha256) throw new Error(`Skill file hash does not match: ${file.path}`);
    contents.set(file.path, bytes);
  }
  const runtimes = JSON.parse(contents.get('references/native-runtime.json').toString('utf8'));
  for (const platform of ['windows-x64', 'macos-arm64']) {
    if (!semver.test(manifest.runtimeVersions?.[platform]) ||
      runtimes.packages?.[platform]?.version !== manifest.runtimeVersions[platform]) throw new Error('Pinned runtime versions do not match');
  }
  return { manifest, contents };
}

export async function resolveLocation({ project, home = homedir() } = {}) {
  if (project && !path.isAbsolute(project)) throw new Error('--project must be an absolute existing folder');
  const base = path.resolve(project || home);
  await assertSafePath(base);
  if (!(await fs.stat(base)).isDirectory()) throw new Error('Installation base is not a directory');
  const modern = path.join(base, '.agents', 'skills', SKILL_NAME);
  const legacy = path.join(base, '.codex', 'skills', SKILL_NAME);
  await assertSafePath(modern);
  if (!project) await assertSafePath(legacy);
  const modernExists = Boolean(await statIfPresent(modern));
  const legacyExists = !project && Boolean(await statIfPresent(legacy));
  // Reuse a single existing Codex location rather than creating a duplicate skill.
  const target = legacyExists && !modernExists ? legacy : modern;
  // One lock per installation base, including while a legacy target is being moved.
  const control = path.join(base, '.agents', '.asset-studio-skill');
  return { target, control, scope: project ? 'project' : 'user',
    duplicatePaths: modernExists && legacyExists ? [modern, legacy] : [] };
}

async function listFiles(directory, prefix = '', entries = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Linked file in existing skill: ${relative}`);
    if (entries.length > 2_048) throw new Error('Existing skill contains too many files to verify');
    if (entry.isDirectory()) await listFiles(path.join(directory, entry.name), relative, entries);
    else if (entry.isFile()) entries.push(relative);
    else throw new Error(`Unsupported file in existing skill: ${relative}`);
  }
  return entries.sort();
}

async function inspectInstalled(bundle, location) {
  await assertSafePath(location.target);
  const stat = await statIfPresent(location.target);
  const base = { packageName: PACKAGE_NAME, packageVersion: bundle.manifest.packageVersion,
    runtimeVersions: bundle.manifest.runtimeVersions, skillPath: location.target,
    scope: location.scope, duplicatePaths: location.duplicatePaths };
  if (!stat) return { ...base, state: 'not-installed', installedVersion: null };
  if (!stat.isDirectory()) throw new Error(`The skill path is not a directory: ${location.target}`);
  const receiptPath = path.join(location.target, RECEIPT_NAME);
  await assertSafePath(receiptPath);
  let receipt;
  try {
    if ((await fs.stat(receiptPath)).size > 65_536) throw new Error('Oversized receipt');
    receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    if (receipt.format !== 'asset-studio-skill-installation' || receipt.schemaVersion !== 1 ||
      receipt.packageName !== PACKAGE_NAME || !semver.test(receipt.packageVersion)) throw new Error('Unknown receipt');
  } catch { return { ...base, state: 'legacy', installedVersion: null }; }
  const modifiedFiles = [];
  for (const file of bundle.manifest.files) {
    const installed = path.join(location.target, ...file.path.split('/'));
    await assertSafePath(installed);
    const fileStat = await statIfPresent(installed);
    if (!fileStat?.isFile() || fileStat.size !== file.bytes || sha256(await fs.readFile(installed)) !== file.sha256) modifiedFiles.push(file.path);
  }
  const expected = new Set([...bundle.manifest.files.map(file => file.path), RECEIPT_NAME]);
  const extraFiles = (await listFiles(location.target)).filter(file => !expected.has(file));
  const receiptMatches = receipt.packageVersion === bundle.manifest.packageVersion && receipt.inventorySha256 === bundle.manifest.inventorySha256;
  const current = receiptMatches && modifiedFiles.length === 0 && extraFiles.length === 0;
  return { ...base, state: current ? 'current' : receipt.packageVersion === bundle.manifest.packageVersion ? 'modified' : 'different-version',
    installedVersion: receipt.packageVersion, modifiedFiles, extraFiles };
}

export async function statusSkill(packageRoot, options = {}) {
  return inspectInstalled(await loadBundle(packageRoot), await resolveLocation(options));
}

export async function installSkill(packageRoot, options = {}) {
  const bundle = await loadBundle(packageRoot);
  const initialLocation = await resolveLocation(options);
  await ensureDirectory(initialLocation.control);
  const lockPath = path.join(initialLocation.control, 'install.lock');
  await assertSafePath(lockPath);
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another skill installation is in progress: ${lockPath}`); throw error; }
  const stage = path.join(initialLocation.control, `stage-${randomUUID()}`);
  const rename = options.rename || fs.rename;
  const removeStage = options.removeStage || (directory => fs.rm(directory, { recursive: true, force: true }));
  let backup = null;
  let movedOriginal = false;
  let primaryError;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const location = await resolveLocation(options);
    await ensureDirectory(path.dirname(location.target));
    const before = await inspectInstalled(bundle, location);
    if (before.state === 'current') return { ...before, operation: 'unchanged', backupPath: null };
    const original = await statIfPresent(location.target);
    await fs.mkdir(stage, { mode: 0o700 });
    for (const file of bundle.manifest.files) {
      const destination = path.join(stage, ...file.path.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bundle.contents.get(file.path), { flag: 'wx', mode: file.mode });
    }
    const receipt = { schemaVersion: 1, format: 'asset-studio-skill-installation',
      packageName: PACKAGE_NAME, packageVersion: bundle.manifest.packageVersion,
      inventorySha256: bundle.manifest.inventorySha256, runtimeVersions: bundle.manifest.runtimeVersions,
      installedAt: new Date().toISOString() };
    await fs.writeFile(path.join(stage, RECEIPT_NAME), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if ((await inspectInstalled(bundle, { ...location, target: stage })).state !== 'current') throw new Error('Staged skill did not pass verification');
    await assertSafePath(location.target);
    const latest = await statIfPresent(location.target);
    if (Boolean(original) !== Boolean(latest) || original && (original.ino !== latest.ino || original.dev !== latest.dev)) throw new Error('The skill folder changed during installation');
    if (original) {
      const backups = path.join(location.control, 'backups');
      await ensureDirectory(backups);
      backup = path.join(backups, `before-${bundle.manifest.packageVersion}-${Date.now()}-${randomUUID()}`);
      await rename(location.target, backup);
      movedOriginal = true;
    }
    let activated = false;
    try {
      await rename(stage, location.target);
      activated = true;
      const verified = await inspectInstalled(bundle, location);
      if (verified.state !== 'current') throw new Error('Installed skill did not pass verification');
      return { ...verified, operation: original ? 'updated' : 'installed', backupPath: backup };
    }
    catch (error) {
      try {
        if (activated) {
          await assertSafePath(location.target);
          const failed = path.join(location.control, `failed-${randomUUID()}`);
          await rename(location.target, failed);
          error.message += `; failed installation preserved at ${failed}`;
        }
        if (movedOriginal) { await rename(backup, location.target); movedOriginal = false; }
      } catch {
        throw new Error(`Installation failed; the original is preserved at ${backup || location.target}`, { cause: error });
      }
      throw error;
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try {
      // Only remove our exclusive random staging directory; backups are never deleted.
      const relative = path.relative(path.resolve(initialLocation.control), path.resolve(stage));
      if (/^stage-[0-9a-f-]{36}$/.test(relative) && !relative.includes(path.sep)) {
        await assertSafePath(stage);
        await removeStage(stage);
      }
    } catch (error) { cleanupErrors.push(error); }
    finally {
      try { await lock.close(); } catch (error) { cleanupErrors.push(error); }
      finally {
        try { await assertSafePath(initialLocation.control); await fs.unlink(lockPath); }
        catch (error) { cleanupErrors.push(error); }
      }
    }
    if (cleanupErrors.length) {
      const message = `Installer cleanup needs attention: ${cleanupErrors.map(error => error.message).join('; ')}`;
      if (primaryError) primaryError.message += `; ${message}`;
      else throw new Error(message, { cause: cleanupErrors[0] });
    }
  }
}
