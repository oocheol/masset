import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// The Tauri map is the common resource contract for NSIS and portable builds.
// These five explicit compatibility copies preserve the older portable layout.
const compatibilityResources = Object.freeze([
  ['docs/architecture.md', 'docs/architecture.md'],
  ['docs/module-contract.md', 'docs/module-contract.md'],
  ['crates/providers/assets/NOTICE', 'CODEX-CATALOG-NOTICE.txt'],
  ['crates/providers/assets/OPENAI-CODEX-NOTICE', 'CODEX-UPSTREAM-NOTICE.txt'],
  ['crates/providers/assets/OPENAI-CODEX-LICENSE', 'CODEX-CATALOG-LICENSE.txt'],
]);

const slash = value => value.split(path.sep).join('/');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const key = value => value.normalize('NFC').toLowerCase();
const exists = filename => {
  try { return fs.lstatSync(filename); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));

function assertWithin(root, filename, label) {
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside its root: ${filename}`);
  }
  return relative;
}

function assertNoLinks(root, filename, label) {
  const relative = assertWithin(root, filename, label);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const entry = exists(current);
    if (entry?.isSymbolicLink()) throw new Error(`${label} contains a link: ${current}`);
    if (entry && !entry.isFile() && !entry.isDirectory()) throw new Error(`${label} is not a regular file or directory: ${current}`);
  }
}

function targetName(value) {
  if (typeof value !== 'string' || !value || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    throw new Error('Resource target must be a relative Windows path');
  }
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' ||
    /[\x00-\x1f<>:"|?*]/.test(segment) || /[. ]$/.test(segment) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error(`Unsafe Windows resource target: ${value}`);
  }
  return normalized;
}

export function validateWindowsNotices({ workspace }) {
  const root = fs.realpathSync(workspace);
  const inventoryPath = path.join(root, 'docs/licenses/dependency-inventory.json');
  assertNoLinks(root, inventoryPath, 'Windows license inventory');
  const inventoryBytes = fs.readFileSync(inventoryPath);
  const inventory = JSON.parse(inventoryBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (inventory.schemaVersion !== 1 || inventory.target !== 'x86_64-pc-windows-msvc') {
    throw new Error('Windows notices must be collected for x86_64-pc-windows-msvc using the current inventory schema');
  }
  if (inventory.licenseTextCollectionComplete !== true || inventory.counts?.missing !== 0) {
    throw new Error('Windows license inventory has unresolved records');
  }
  const inputs = {};
  for (const [filename, field] of [['package-lock.json', 'packageLockSha256'], ['Cargo.lock', 'cargoLockSha256']]) {
    const source = path.join(root, filename);
    assertNoLinks(root, source, 'License inventory lockfile');
    inputs[field] = digest(fs.readFileSync(source));
    if (inventory.inputs?.[field] !== inputs[field]) throw new Error(`Windows license inventory does not match ${filename}`);
  }
  const licenseText = path.join(root, 'docs/licenses/THIRD_PARTY_LICENSES.txt');
  assertNoLinks(root, licenseText, 'Windows license text');
  if (!fs.statSync(licenseText).isFile()) throw new Error('Windows dependency license texts are required');
  return { target: inventory.target, inventorySha256: digest(inventoryBytes), inputs, missing: 0 };
}

export function assertFrozenResourcePlan(expected, actual) {
  if (!expected || !Array.isArray(expected.files) || !expected.files.length || !Array.isArray(expected.directories)) {
    throw new Error('A complete frozen resource plan is required');
  }
  for (const field of ['schemaVersion', 'appVersion', 'tauriConfigSha256']) {
    if (expected[field] === undefined || expected[field] !== actual[field]) throw new Error(`Frozen resource metadata changed: ${field}`);
  }
  const expectedFiles = new Map();
  for (const file of expected.files) {
    if (!file || typeof file.path !== 'string' || typeof file.source !== 'string' ||
      !['tauri', 'portable-compatibility'].includes(file.origin) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/.test(file.sha256 ?? '')) {
      throw new Error('Invalid file record in frozen resource plan');
    }
    const identity = key(targetName(file.path));
    if (expectedFiles.has(identity)) throw new Error(`Duplicate frozen resource: ${file.path}`);
    expectedFiles.set(identity, file);
  }
  for (const file of actual.files) {
    const identity = key(file.path);
    const original = expectedFiles.get(identity);
    if (!original) throw new Error(`Resource added after the plan was frozen: ${file.path}`);
    for (const field of ['path', 'source', 'origin', 'bytes', 'sha256']) {
      if (original[field] !== file[field]) throw new Error(`Frozen resource changed: ${file.path} (${field})`);
    }
    expectedFiles.delete(identity);
  }
  if (expectedFiles.size) throw new Error(`Resource removed after the plan was frozen: ${expectedFiles.values().next().value.path}`);
  const directoryList = directories => {
    if (directories.some(directory => typeof directory !== 'string')) throw new Error('Invalid frozen resource directories');
    return JSON.stringify([...directories].sort());
  };
  if (directoryList(expected.directories) !== directoryList(actual.directories)) throw new Error('Resource directory set changed after the plan was frozen');
  for (const field of ['resourceMappings', 'tauriFiles', 'compatibilityFiles']) {
    if (!Number.isSafeInteger(expected[field]) || expected[field] !== actual[field]) throw new Error(`Frozen resource metadata changed: ${field}`);
  }
}

export function planWindowsResources({ workspace, expectedPlan, checkWindowsNotices = false }) {
  const root = fs.realpathSync(workspace);
  const windowsNotices = checkWindowsNotices ? validateWindowsNotices({ workspace: root }) : undefined;
  const configPath = path.join(root, 'apps/desktop/src-tauri/tauri.conf.json');
  assertNoLinks(root, configPath, 'Tauri configuration');
  const configBytes = fs.readFileSync(configPath);
  const config = JSON.parse(configBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const resources = config.bundle?.resources;
  if (!resources || Array.isArray(resources) || typeof resources !== 'object' || !Object.keys(resources).length) {
    throw new Error('Tauri bundle.resources must be a nonempty explicit source/target map');
  }

  const files = [];
  const directories = new Set();
  const used = new Map();
  function add(source, target, origin) {
    const relative = assertWithin(root, source, 'Resource source');
    assertNoLinks(root, source, 'Resource source');
    const entry = fs.lstatSync(source);
    const portablePath = targetName(target);
    if (entry.isDirectory()) {
      directories.add(portablePath);
      for (const child of fs.readdirSync(source).sort()) add(path.join(source, child), `${portablePath}/${child}`, origin);
      return;
    }
    if (!entry.isFile()) throw new Error(`Resource source is not a regular file: ${source}`);
    const identity = key(portablePath);
    if (used.has(identity)) throw new Error(`Duplicate Windows resource target: ${portablePath}`);
    const bytes = fs.readFileSync(source);
    const record = { source: slash(relative), path: portablePath, bytes: bytes.length, sha256: digest(bytes), origin };
    files.push(record);
    used.set(identity, record);
    let parent = path.posix.dirname(portablePath);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
  }

  for (const [source, target] of Object.entries(resources)) {
    if (!source || /[\x00*?{}]/.test(source)) throw new Error('Tauri resource sources must be literal paths');
    add(path.resolve(path.dirname(configPath), source), target, 'tauri');
  }
  for (const [source, target] of compatibilityResources) {
    // If the shared map later includes an old alias, it needs only one copy.
    const existing = used.get(key(target));
    if (existing) {
      if (existing.source !== source) throw new Error(`Compatibility resource conflicts with the Tauri map: ${target}`);
      continue;
    }
    add(path.join(root, source), target, 'portable-compatibility');
  }
  for (const directory of directories) {
    if (used.has(key(directory))) throw new Error(`Resource target is both a file and directory: ${directory}`);
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const plan = {
    schemaVersion: 1,
    appVersion: config.version,
    tauriConfigSha256: digest(configBytes),
    resourceMappings: Object.keys(resources).length,
    tauriFiles: files.filter(file => file.origin === 'tauri').length,
    compatibilityFiles: files.filter(file => file.origin === 'portable-compatibility').length,
    directories: [...directories].sort((a, b) => a.length - b.length || a.localeCompare(b, 'en')),
    files,
    copiedBytesVerified: false,
    expectedPlanVerified: false,
    ...(windowsNotices ? { windowsNotices } : {}),
  };
  if (expectedPlan) {
    assertFrozenResourcePlan(expectedPlan, plan);
    plan.expectedPlanVerified = true;
  }
  return plan;
}

export function copyWindowsResources({ workspace, destination, expectedPlan, checkWindowsNotices = false }) {
  const root = fs.realpathSync(workspace);
  const plan = planWindowsResources({ workspace: root, expectedPlan, checkWindowsNotices });
  const outputRoot = path.join(root, 'output');
  const targetRoot = path.resolve(destination);
  assertWithin(outputRoot, targetRoot, 'Fresh package directory');
  assertNoLinks(root, targetRoot, 'Fresh package directory');
  const targetEntry = exists(targetRoot);
  if (targetEntry && !targetEntry.isDirectory()) throw new Error('Fresh package target must be a directory');

  // The caller may already have copied the executable into its new directory.
  // Anything else indicates a reused package or user data, rather than a fresh target.
  if (targetEntry) {
    const entries = fs.readdirSync(targetRoot);
    if (entries.some(entry => entry !== 'asset-desktop.exe' || !fs.lstatSync(path.join(targetRoot, entry)).isFile())) {
      throw new Error('Resource copying requires a fresh package directory (only asset-desktop.exe may already exist)');
    }
  }
  for (const directory of plan.directories) {
    const filename = path.join(targetRoot, ...directory.split('/'));
    assertNoLinks(root, filename, 'Resource destination');
    const entry = exists(filename);
    if (entry && !entry.isDirectory()) throw new Error(`Resource directory already contains a file: ${directory}`);
  }
  for (const file of plan.files) {
    const filename = path.join(targetRoot, ...file.path.split('/'));
    assertNoLinks(root, filename, 'Resource destination');
    if (exists(filename)) throw new Error(`Refusing to overwrite an existing resource: ${file.path}`);
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  for (const directory of plan.directories) {
    const filename = path.join(targetRoot, ...directory.split('/'));
    assertNoLinks(root, filename, 'Resource destination');
    fs.mkdirSync(filename, { recursive: true });
  }
  for (const file of plan.files) {
    const source = path.join(root, ...file.source.split('/'));
    const target = path.join(targetRoot, ...file.path.split('/'));
    assertNoLinks(root, source, 'Resource source');
    assertNoLinks(root, target, 'Resource destination');
    // Exclusive creation preserves every existing input/output on failure.
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    const actual = fs.readFileSync(target);
    if (actual.length !== file.bytes || digest(actual) !== file.sha256) {
      throw new Error(`Resource changed after the copy plan was frozen: ${file.path}`);
    }
  }
  // Re-read the entire source set too: additions/removals cannot hide behind an unchanged config.
  planWindowsResources({ workspace: root, expectedPlan: expectedPlan ?? plan, checkWindowsNotices });
  return { ...plan, directory: targetRoot, copiedBytesVerified: true };
}

function main() {
  const values = {};
  for (let i = 2; i < process.argv.length; i++) {
    const argument = process.argv[i];
    if (argument === '--plan') values.plan = true;
    else if (argument === '--check-windows-notices') values.checkWindowsNotices = true;
    else if (['--workspace', '--destination', '--expected-plan'].includes(argument) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
      if (values[argument.slice(2)]) throw new Error(`Duplicate argument: ${argument}`);
      values[argument.slice(2)] = process.argv[++i];
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (!values.workspace || (!values.plan && !values.destination) || (values.plan && values.destination)) {
    throw new Error('Usage: node scripts/copy-windows-resources.mjs --workspace <repo> (--plan | --destination <fresh repo/output/package>) [--expected-plan <frozen plan or build report>] [--check-windows-notices]');
  }
  if (values['expected-plan']) {
    const frozen = readJson(values['expected-plan']);
    values.expectedPlan = frozen.resourceManifest ?? frozen;
  }
  const report = values.plan ? planWindowsResources(values) : copyWindowsResources(values);
  process.stdout.write(JSON.stringify(report) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    process.stderr.write(`Windows resource copy failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
