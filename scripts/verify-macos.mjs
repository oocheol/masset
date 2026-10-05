/** Real macOS DMG/copied-app GUI and separate production-backend acceptance.
 * This launches only isolated opt-in QA processes; it never uses login, live
 * generation, Blender jobs, the updater, signing tools, or executable downloads.
 * asset-cli uses compile-time checkout paths. Input equivalence is verified,
 * but its 2D operations are not reported as copied-app UI operations.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyMacosTrust } from './macos-signing.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = { 'aarch64-apple-darwin': { uname: 'arm64', node: 'arm64', macho: 'arm64' }, 'x86_64-apple-darwin': { uname: 'x86_64', node: 'x64', macho: 'x86_64' } };
const usage = 'Usage: bash scripts/verify-macos.sh <one.dmg> <asset-cli> <fresh-output-directory> [--target aarch64-apple-darwin|x86_64-apple-darwin] [--expected-version <semver>] [--timeout-seconds 900] [--require-notarization --expected-team-id <Apple Team ID>]';
const check = (value, message) => { if (!value) throw new Error(message); };
const slash = value => value.split(sep).join('/');
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const save = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const contained = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

async function fileRecord(path) {
  const info = await lstat(path);
  check(info.isFile(), `Expected a regular file: ${path}`);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return { path, bytes: info.size, sha256: digest.digest('hex') };
}

async function inventory(root, current = root) {
  const entries = [];
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name), info = await lstat(path), key = slash(relative(root, path));
    if (info.isDirectory()) entries.push(...await inventory(root, path));
    else if (info.isSymbolicLink()) {
      const target = await readlink(path);
      check(!isAbsolute(target) && contained(root, await realpath(path)), `External app/resource symlink: ${key}`);
      entries.push({ path: key, kind: 'symlink', target });
    } else {
      const record = await fileRecord(path);
      entries.push({ ...record, path: key, kind: 'file', executable: Boolean(info.mode & 0o111) });
    }
  }
  return entries;
}

export function validateGui(report, ownedPid) {
  check(report.nativeWindow === true && report.platform === 'macos' && report.pid === ownedPid, 'GUI report does not identify the owned macOS process');
  check(report.assets === 12 && report.fixtureAssets === 12 && report.modelAssets === 0 && report.withNativeModel === false && report.models?.length === 0, 'Basic GUI must contain exactly twelve fixture assets and no model');
  check(report.providerLiveGeneration === false, 'Unexpected external generation job');
  const web = report.webview;
  check(web?.domReady === true && web.error == null && Number.isInteger(web.decodedImages) && web.decodedImages >= 8, 'Native WebView DOM/asset decoding failed');
  check(web.ipcEnvironment?.native === true && web.ipcEnvironment.platform === 'macos', 'Real macOS IPC environment missing');
  check(Array.isArray(web.protocols) && web.protocols.includes('asset:'), 'Images were not decoded through the macOS asset protocol');
  check(web.externalProviderCalls === 0 && web.updateNetworkActions === 0, 'QA attempted provider or update network actions');
  check(web.appUpdater?.supported === false && web.appUpdater.state === 'unsupported' && web.appUpdater.networkActions === 0, 'Native QA updater gate failed');
  const fonts = web.readability;
  check(fonts?.smallButtons?.length === 0 && fonts.minimumButtonFont >= 14 && fonts.guideFont >= 16 && fonts.guideOpened === true && fonts.escapeRestoredFocus === true && fonts.horizontalOverflow === false, 'Native readability/guide/focus checks failed');
  check(web.codexOnboarding?.visibleEntry === true && web.codexOnboarding.entryFont >= 14 && web.codexOnboarding.guideSequence === true, 'Native onboarding entry/guide missing');
  check(web.quality3dUi?.passed === true && web.quality3dUi.nativeWebView === true && web.quality3dUi.inputs === 5 && web.quality3dUi.realReconstruction === false && web.quality3dUi.queuedJobs === 0, 'Native quality panel individual-input/UI boundary failed');
  check(web.productionUi?.passed === true && web.productionUi.defaultGenerationHome === true && web.productionUi.nativeRootScan === true && web.productionUi.realGeneration === false && web.productionUi.providerRequests === 0, 'Native generation home/project scan boundary failed');
  return true;
}

export function validateBackend(report) {
  check(report.nativeBackend === true && report.nativeWindow === false && report.environment?.native === true && report.environment.platform === 'macos', 'Backend report is not a native macOS backend');
  check(report.providerLiveGeneration === false && report.confirmedModel == null && report.images === 12, 'Backend fixture/provider boundary failed');
  for (const key of ['reopened', 'concurrentProjectOpenRejected', 'shutdownReleaseVerified', 'explicitCacheReuse']) check(report[key] === true, `Backend ${key} failed`);
  check(report.ownershipCheckScope === 'same-process independent handles', 'Unexpected ownership test scope');
  check(Array.isArray(report.jobs) && report.jobs.length >= 6 && report.jobs.every(job => job.status === 'succeeded' && job.resource === 'cpu'), 'Local CPU jobs did not all succeed');
  check(report.jobs.filter(job => job.kind === 'image_process').length === 2, 'Both real resize operations are required');
  for (const kind of ['normal_map', 'atlas']) check(report.jobs.some(job => job.kind === kind), `Missing ${kind} operation`);
  return true;
}

function parseArgs(args) {
  if (args[0] === '--help' || args[0] === '-h') return null;
  check(args.length >= 3 && args.slice(0, 3).every(value => value && !value.startsWith('--')), usage);
  const options = { dmg: resolve(args[0]), cli: resolve(args[1]), output: resolve(args[2]), timeout: 900 };
  for (let i = 3; i < args.length; i++) {
    const key = args[i];
    if (key === '--require-notarization') { options.requireNotarization = true; continue; }
    const value = args[++i];
    check(value && ['--target', '--expected-version', '--timeout-seconds', '--expected-team-id'].includes(key), usage);
    if (key === '--target') options.target = value;
    if (key === '--expected-version') options.version = value;
    if (key === '--timeout-seconds') options.timeout = Number(value);
    if (key === '--expected-team-id') options.teamId = value;
  }
  check(!options.requireNotarization || /^[A-Z0-9]{10}$/.test(options.teamId ?? ''), 'Release verification requires --expected-team-id with --require-notarization');
  check(!options.teamId || options.requireNotarization, '--expected-team-id requires --require-notarization');
  check(!options.target || TARGETS[options.target], 'Unsupported macOS target');
  check(Number.isInteger(options.timeout) && options.timeout >= 60 && options.timeout <= 3600, 'Timeout must be 60..3600 seconds');
  return options;
}

async function verify(options) {
  check(process.platform === 'darwin', 'This is a macOS runtime test, and cannot run on this host');
  check(options.output !== REPO && !contained(options.output, REPO), 'QA output cannot be a checkout ancestor');
  await mkdir(dirname(options.output), { recursive: true });
  // Non-recursive mkdir refuses existing output; the app likewise requires new GUI/backend directories.
  await mkdir(options.output);
  options.output = await realpath(options.output);
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), passed: false, stage: 'prerequisites', target: null, commands: [], checks: {}, boundaries: { liveProviderVerified: false, blenderVerified: false, appUpdaterVerified: false, copiedAppUi2DProcessingVerified: false, cliUsesRepositoryFixtures: true, gatekeeperVerified: false, notarizationVerified: false, cleanMachineVerified: false }, errors: [] };
  let mounted = false, commandIndex = 0;
  const mount = join(options.output, 'mount');
  const run = async (exe, args, label, { required = true, timeout = 60, childEnvironment = false } = {}) => {
    const prefix = join(options.output, `${String(++commandIndex).padStart(2, '0')}-${label}`), start = Date.now();
    const child = spawn(exe, args, { cwd: REPO, env: childEnvironment ? { ...process.env, CODEX_EXECUTABLE: join(options.output, '__QA_NO_CODEX__.DO_NOT_EXIST'), BLENDER_EXECUTABLE: join(options.output, '__QA_NO_BLENDER__.DO_NOT_EXIST') } : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [], errors = [];
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
    let timedOut = false, launchError, force;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 5000); }, timeout * 1000);
    const result = await new Promise(resolveResult => {
      child.on('error', error => { launchError = error.message; });
      child.on('close', (exitCode, signal) => resolveResult({ exitCode, signal }));
    });
    clearTimeout(timer); clearTimeout(force);
    const stdout = Buffer.concat(output), stderr = Buffer.concat(errors);
    await writeFile(`${prefix}.stdout.log`, stdout, { flag: 'wx' }); await writeFile(`${prefix}.stderr.log`, stderr, { flag: 'wx' });
    const item = { command: exe, arguments: args, pid: child.pid ?? null, ...result, elapsedMs: Date.now() - start, timedOut, launchError: launchError ?? null, stdout: `${prefix}.stdout.log`, stderr: `${prefix}.stderr.log` };
    report.commands.push(item);
    check(!required || (result.exitCode === 0 && !timedOut && !launchError), `${label} failed; inspect retained command logs`);
    return { ...item, text: stdout.toString('utf8'), errorText: stderr.toString('utf8') };
  };
  try {
    const packageInfo = await json(join(REPO, 'package.json'));
    options.version ??= packageInfo.version;
    check(/^\d+\.\d+\.\d+$/.test(options.version) && options.version === packageInfo.version, 'Expected version must equal the checkout release version');
    options.target ??= process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    report.target = options.target; report.expectedVersion = options.version;
    const hostArch = (await run('/usr/bin/uname', ['-m'], 'architecture')).text.trim();
    const translated = await run('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], 'rosetta-status', { required: false });
    const expected = TARGETS[options.target];
    check(hostArch === expected.uname && process.arch === expected.node && translated.text.trim() !== '1', 'Native runner/Node architecture does not match requested target (Rosetta is not accepted)');
    const osVersion = (await run('/usr/bin/sw_vers', [], 'os-version')).text.trim();
    report.platform = { os: 'macos', uname: hostArch, nodeArchitecture: process.arch, nodeVersion: process.version, translated: translated.text.trim() === '1', osVersion };
    const git = await run('git', ['rev-parse', 'HEAD'], 'source-commit');
    report.sourceCommit = git.text.trim();
    report.inputs = { dmg: await fileRecord(options.dmg), cli: await fileRecord(options.cli), cargoLock: await fileRecord(join(REPO, 'Cargo.lock')), packageLock: await fileRecord(join(REPO, 'package-lock.json')) };
    check(/\.dmg$/i.test(options.dmg), 'Input must be a DMG');
    const cliArch = (await run('/usr/bin/lipo', ['-archs', options.cli], 'cli-macho')).text.trim().split(/\s+/);
    check(cliArch.length === 1 && cliArch[0] === expected.macho, 'CLI Mach-O must match the native target');
    report.cliArchitectures = cliArch;
    report.stage = 'DMG mount and copied app';
    await run('/usr/bin/hdiutil', ['verify', options.dmg], 'dmg-verify', { timeout: 120 });
    await mkdir(mount);
    mounted = true;
    const attach = await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, '-plist', options.dmg], 'dmg-attach', { timeout: 120 });
    const plist = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', attach.stdout], 'mount-plist');
    const entities = JSON.parse(plist.text)['system-entities'];
    check(entities?.some(entity => entity['mount-point'] === mount), 'DMG did not mount at the isolated mount point');
    const appNames = [];
    for (const name of await readdir(mount)) if (name.endsWith('.app') && (await lstat(join(mount, name))).isDirectory()) appNames.push(name);
    check(appNames.length === 1, 'DMG must contain exactly one regular app bundle');
    const mountedApp = join(mount, appNames[0]), copiedDir = join(options.output, 'copied');
    await mkdir(copiedDir);
    const copiedApp = join(copiedDir, appNames[0]);
    await run('/usr/bin/ditto', [mountedApp, copiedApp], 'copy-app', { timeout: 120 });
    const mountedFiles = await inventory(mountedApp), copiedFiles = await inventory(copiedApp);
    assert.deepEqual(copiedFiles, mountedFiles, 'Copied .app bytes/symlinks/executable permissions differ from mounted DMG');
    await save(join(options.output, 'app-files.json'), { mountedApp, copiedApp, files: copiedFiles });
    report.checks.copiedAppMatchesDmg = true; report.copiedApp = copiedApp;
    const info = join(copiedApp, 'Contents/Info.plist');
    const plistValue = async (field, label) => (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${field}`, info], label)).text.trim();
    const executable = await plistValue('CFBundleExecutable', 'bundle-executable');
    check(executable && !executable.includes('/') && !executable.includes('\\') && executable !== '.' && executable !== '..', 'Unsafe CFBundleExecutable');
    check(await plistValue('CFBundleIdentifier', 'bundle-identifier') === 'org.localassets.workbench', 'Unexpected bundle identifier');
    check(await plistValue('CFBundleShortVersionString', 'bundle-version') === options.version, 'App bundle version differs from expected release');
    const main = join(copiedApp, 'Contents/MacOS', executable), resources = join(copiedApp, 'Contents/Resources');
    report.inputs.copiedAppExecutable = await fileRecord(main);
    const appArch = (await run('/usr/bin/lipo', ['-archs', main], 'app-macho')).text.trim().split(/\s+/);
    check(appArch.length === 1 && appArch[0] === expected.macho, 'App Mach-O must match the native target');
    report.appArchitectures = appArch;
    report.stage = 'package signing and trust';
    if (options.requireNotarization) {
      report.signing = await verifyMacosTrust(run, { app: copiedApp, dmg: options.dmg, expectedTeamId: options.teamId });
      report.boundaries.gatekeeperVerified = true; report.boundaries.notarizationVerified = true;
    } else {
      const signature = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', copiedApp], 'codesign-verify');
      await run('/usr/bin/codesign', ['-dv', '--verbose=4', copiedApp], 'codesign-description', { required: false });
      report.signing = { codesignVerificationExitCode: signature.exitCode, appBundleSealVerified: true, notarization: 'unverified', gatekeeper: 'unverified' };
    }
    report.stage = 'bundled resources and licenses';
    const examplesSource = join(REPO, 'apps/desktop/public/examples'), sourceExamples = await inventory(examplesSource), bundledExamples = await inventory(join(resources, 'examples'));
    assert.deepEqual(bundledExamples, sourceExamples, 'Bundled examples differ from the checkout examples used by asset-cli');
    const originalPngs = sourceExamples.filter(item => item.kind === 'file' && item.path.endsWith('.png'));
    check(originalPngs.length === 12, 'Expected twelve original fixture PNGs');
    const { PNG } = await import('pngjs');
    const fixturePixels = [];
    for (const entry of originalPngs) {
      const decoded = PNG.sync.read(await readFile(join(resources, 'examples', entry.path)), { checkCRC: true });
      check(decoded.width === 512 && decoded.height === 512 && decoded.data.some((value, i) => i % 4 === 3 && value > 0), `Empty/incorrect fixture PNG: ${entry.path}`);
      fixturePixels.push({ path: entry.path, width: decoded.width, height: decoded.height, sha256: entry.sha256, bytes: entry.bytes });
    }
    const compareResource = async (source, bundled) => {
      const expectedFile = await fileRecord(join(REPO, source)), actual = await fileRecord(join(resources, bundled));
      check(actual.sha256 === expectedFile.sha256 && actual.bytes === expectedFile.bytes, `Bundled resource differs: ${bundled}`);
      return { source, bundled, bytes: actual.bytes, sha256: actual.sha256 };
    };
    const resourcePairs = [ ['workers/blender/worker.py', 'workers/blender/worker.py'], ['workers/blender/LICENSE', 'workers/blender/LICENSE'], ['LICENSE', 'LICENSE'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'], ['crates/providers/assets/NOTICE', 'licenses/CODEX-CATALOG-NOTICE.txt'], ['crates/providers/assets/OPENAI-CODEX-LICENSE', 'licenses/OPENAI-CODEX-LICENSE.txt'], ['crates/providers/assets/OPENAI-CODEX-NOTICE', 'licenses/OPENAI-CODEX-NOTICE.txt'] ];
    for (const name of ['setup.py', 'worker.py', 'status.py', 'runtime_common.py', 'image_input.py', 'image3d_adapter.py', 'glb_color.py', 'runtime_probe.py', 'upstream_patch.py', 'runtime-lock.json', 'runtime-lock-windows.json', 'LICENSE', 'README.md']) resourcePairs.push([`workers/image3d/${name}`, `workers/image3d/${name}`]);
    for (const name of ['worker.py', 'audit.py', 'LICENSE', 'README.md']) resourcePairs.push([`workers/blender-quality/${name}`, `workers/blender-quality/${name}`]);
    resourcePairs.push(['docs/model-quality.md', 'docs/model-quality.md']);
    assert.deepEqual(await inventory(join(resources, 'workers/image3d/licenses')), await inventory(join(REPO, 'workers/image3d/licenses')), 'Pinned image3d licenses differ from the checkout');
    const matched = [];
    for (const pair of resourcePairs) matched.push(await compareResource(...pair));
    const licensesRoot = join(resources, 'docs/licenses');
    assert.deepEqual(await inventory(licensesRoot), await inventory(join(REPO, 'docs/licenses')), 'Bundled license tree differs from the CI collection');
    const licenses = await json(join(licensesRoot, 'dependency-inventory.json'));
    check(licenses.target === options.target && licenses.counts?.missing === 0 && licenses.licenseTextCollectionComplete === true, 'Mac-target strict license collection is missing or incomplete');
    check(licenses.inputs?.cargoLockSha256 === report.inputs.cargoLock.sha256 && licenses.inputs.packageLockSha256 === report.inputs.packageLock.sha256, 'License inventory is stale for the lockfiles');
    check(licenses.packages?.some(item => item.ecosystem === 'cargo' && item.name === 'objc2-web-kit'), 'macOS WebKit runtime license record is absent');
    const licenseIndex = await json(join(licensesRoot, 'license-text-index.json'));
    for (const item of [...licenseIndex.files, ...licenses.packages.flatMap(item => [...item.documents, ...(item.sourceArchive ? [item.sourceArchive] : [])])]) {
      check(typeof item.path === 'string' && !isAbsolute(item.path) && contained(licensesRoot, resolve(licensesRoot, item.path)), 'Unsafe license document path');
      const actual = await fileRecord(join(licensesRoot, item.path));
      check(actual.bytes === item.bytes && actual.sha256 === item.sha256, `License/source archive digest mismatch: ${item.path}`);
    }
    for (const name of ['THIRD_PARTY_LICENSES.txt', 'NPM_RUNTIME_LICENSES.txt', 'RUST-STANDARD-LIBRARY-LICENSES.html']) check((await fileRecord(join(licensesRoot, name))).bytes > 0, `Missing license notice: ${name}`);
    await save(join(options.output, 'resource-verification.json'), { valid: true, target: options.target, matched, examples: sourceExamples, fixturePixels, licenseCounts: licenses.counts });
    report.checks.bundledRepositoryInputsEqual = true; report.checks.macTargetLicensesVerified = true;
    report.stage = 'copied app WebView and IPC';
    const guiRoot = join(options.output, 'gui');
    const guiCommand = await run(main, ['--ui-smoke', guiRoot], 'copied-app-native-window', { timeout: Math.min(options.timeout, 240), childEnvironment: true });
    const gui = await json(join(guiRoot, 'native-window.json'));
    validateGui(gui, guiCommand.pid);
    check(contained(guiRoot, await realpath(gui.project)), 'GUI project escaped isolated output');
    report.gui = { evidence: join(guiRoot, 'native-window.json'), pid: guiCommand.pid, decodedImages: gui.webview.decodedImages, measuredProviderActions: gui.webview.externalProviderCalls, measuredUpdateNetworkActions: gui.webview.updateNetworkActions };
    report.checks.copiedAppGuiVerified = true;
    report.stage = 'separate CLI backend and export';
    const backendRoot = join(options.output, 'backend');
    await run(options.cli, ['--smoke', backendRoot], 'native-backend', { timeout: options.timeout, childEnvironment: true });
    const backend = await json(join(backendRoot, 'smoke.json'));
    validateBackend(backend);
    const exportRoot = await realpath(backend.bundle), projectRoot = await realpath(backend.project);
    check(contained(backendRoot, exportRoot) && contained(backendRoot, projectRoot), 'Backend project/export escaped isolated output');
    const { verifyArtifacts } = await import('./verify-artifacts.mjs');
    const artifacts = await verifyArtifacts(exportRoot);
    await save(join(options.output, 'export-verification.json'), artifacts);
    check(artifacts.valid && artifacts.files.every(item => item.valid), 'Independent artifact verification failed');
    const pngs = artifacts.files.filter(item => item.image);
    check(pngs.length >= 16 && pngs.filter(item => item.image.width === 256 && item.image.height === 256).length >= 2, 'Expected original, resize, normal-map and atlas PNGs');
    check(artifacts.atlases.some(item => item.status === 'source-pixels-verified' && item.sourceFramesVerified === 2), 'Atlas source pixels were not independently verified');
    check(!artifacts.files.some(item => ['glb', 'blend'].includes(item.format?.toLowerCase())), 'Unexpected Blender output in 2D-only acceptance');
    const manifest = await json(join(exportRoot, 'manifest.json'));
    const exportedDigests = new Set(manifest.assets.flatMap(asset => asset.versions.filter(version => version.source === 'fixture').flatMap(version => version.artifacts.filter(artifact => artifact.format?.toLowerCase() === 'png').map(artifact => artifact.sha256))));
    check(originalPngs.every(entry => exportedDigests.has(entry.sha256)), 'Exported originals do not match all twelve bundled/repository fixture hashes');
    assert.deepEqual(await inventory(examplesSource), sourceExamples, 'Repository fixtures changed during acceptance');
    report.backend = { evidence: join(backendRoot, 'smoke.json'), productionBackend: true, inputLocation: examplesSource, copiedAppResourcesUsedByCli: false, equivalentBundledInputHashesVerified: true, independentExport: join(options.output, 'export-verification.json'), jobs: backend.jobs.length, pngs: pngs.length, reopened: true, leaseScope: backend.ownershipCheckScope };
    report.checks.nativeBackend2DVerified = true; report.checks.repositoryOriginalsPreserved = true;
    report.stage = 'complete';
    report.passed = true;
  } catch (error) {
    report.errors.push({ stage: report.stage, message: error.message });
    report.passed = false;
  } finally {
    if (mounted) {
      try { await run('/usr/bin/hdiutil', ['detach', mount], 'dmg-detach', { timeout: 60 }); report.checks.ownDmgDetached = true; }
      catch (error) { report.errors.push({ stage: 'detach isolated DMG', message: error.message }); report.passed = false; }
    }
    report.completedAt = new Date().toISOString();
    await save(join(options.output, 'verification.json'), report);
  }
  console.log(JSON.stringify({ passed: report.passed, target: report.target, report: join(options.output, 'verification.json'), errors: report.errors }));
  return report.passed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options) console.log(usage);
    else process.exitCode = await verify(options) ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
