#!/usr/bin/env node
// Offline by default: reads resolved locks, installed packages and the Rust sysroot.
// It never installs packages, builds executables or contacts an image provider.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args[index + 1];
};
const output = path.resolve(root, option('--out', 'docs/licenses'));
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
const cargo = option('--cargo', path.join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'));
const rustc = option('--rustc', path.join(cargoHome, 'bin', process.platform === 'win32' ? 'rustc.exe' : 'rustc'));
const target = option('--target', 'x86_64-pc-windows-msvc');
const includeTools = args.includes('--include-tools');
if (output === root || !output.startsWith(root + path.sep)) throw new Error('Output must be a dedicated directory inside the repository');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const sorted = values => [...values].sort((a, b) => a.localeCompare(b, 'en'));
const safeUrl = value => {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value.replace(/^git\+/, '').replace(/^git:\/\//, 'https://'));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
};
const isFullLicense = text => /permission is hereby granted|redistribution and use in source|apache license[\s\r\n]+version 2\.0|mozilla public license[\s\r\n]+version 2\.0|permission to use, copy, modify|this software is provided ["']?as.is|copyright and permission notice|this is free and unencumbered software|the above copyright notice|creative commons legal code[\s\S]*CC0 1\.0 Universal/i.test(text);

fs.mkdirSync(path.join(output, 'texts'), { recursive: true });
const textFiles = new Map();
function preserveText(bytes, origin) {
  const digest = sha256(bytes);
  const relative = `texts/${digest}.txt`;
  const destination = path.join(output, relative);
  if (fs.existsSync(destination)) {
    if (sha256(fs.readFileSync(destination)) !== digest) throw new Error('Existing content-addressed license was altered');
  } else fs.writeFileSync(destination, bytes);
  const result = { path: relative, bytes: bytes.length, sha256: digest, origin, fullLicenseBody: isFullLicense(bytes.toString('utf8')) };
  textFiles.set(digest, { path: relative, bytes: bytes.length, sha256: digest });
  return result;
}
function licenseFiles(folder) {
  const found = [];
  function walk(current, depth) {
    if (depth > 5) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'target', 'test', 'tests', 'fixtures', 'examples'].includes(entry.name)) walk(filename, depth + 1);
      } else if (/^(?:licen[sc]e|copying|notice|copyright)(?:[.\-_]|$)/i.test(entry.name) && fs.statSync(filename).size < 2_000_000) found.push(filename);
    }
  }
  walk(folder, 0);
  return sorted(found);
}
function localLicenseTexts(folder, ecosystem, identity) {
  const documents = licenseFiles(folder).map(filename => preserveText(fs.readFileSync(filename), {
    kind: 'installed-package', ecosystem, package: identity, file: slash(path.relative(folder, filename))
  }));
  if (!documents.some(item => item.fullLicenseBody)) {
    for (const name of sorted(fs.readdirSync(folder)).filter(name => /^readme(?:[.\-_]|$)/i.test(name))) {
      const filename = path.join(folder, name);
      if (!fs.statSync(filename).isFile() || fs.statSync(filename).size > 500_000) continue;
      const bytes = fs.readFileSync(filename);
      if (isFullLicense(bytes.toString('utf8'))) documents.push(preserveText(bytes, {
        kind: 'installed-readme-with-license', ecosystem, package: identity, file: name
      }));
    }
  }
  return documents;
}

const overrideFile = path.join(root, 'docs/licenses/upstream/manifest.json');
const overrides = fs.existsSync(overrideFile) ? readJson(overrideFile).packages ?? [] : [];
function addOverrides(record) {
  for (const match of overrides.filter(item => item.ecosystem === record.ecosystem && item.name === record.name && item.version === record.version)) {
    for (const file of match.files) {
      const filename = path.resolve(path.dirname(overrideFile), file.path);
      if (!filename.startsWith(path.dirname(overrideFile) + path.sep)) throw new Error('Override path escapes its directory');
      const bytes = fs.readFileSync(filename);
      if (sha256(bytes) !== file.sha256) throw new Error(`Upstream license SHA-256 differs for ${record.name}`);
      record.documents.push(preserveText(bytes, {
        kind: file.kind || 'pinned-upstream-license', ecosystem: record.ecosystem, package: `${record.name}@${record.version}`,
        file: slash(file.path), upstreamUrl: safeUrl(file.upstreamUrl), commit: file.commit ?? null,
        note: file.note ?? null
      }));
    }
  }
}

const lockBytes = fs.readFileSync(path.join(root, 'package-lock.json'));
const npmLock = JSON.parse(lockBytes.toString('utf8'));
const records = [];
const localPackages = [];
for (const [relative, locked] of Object.entries(npmLock.packages ?? {}).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  if (!relative.startsWith('node_modules/')) continue;
  if (locked.link) { localPackages.push({ ecosystem: 'npm', path: relative, target: locked.resolved }); continue; }
  if (locked.dev && !includeTools) continue;
  const folder = path.join(root, relative);
  if (!fs.existsSync(path.join(folder, 'package.json'))) throw new Error(`Installed package missing: ${relative}`);
  const manifest = readJson(path.join(folder, 'package.json'));
  if (locked.version !== manifest.version) throw new Error(`Installed version differs from package-lock: ${manifest.name}`);
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const record = {
    ecosystem: 'npm', name: manifest.name, version: manifest.version,
    scope: locked.dev ? ['development-tool'] : ['frontend-runtime-dependency'],
    licenseExpression: typeof manifest.license === 'string' ? manifest.license : locked.license ?? 'UNKNOWN',
    upstream: safeUrl(repository) || `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`,
    lockIntegrity: locked.integrity ?? null,
    documents: localLicenseTexts(folder, 'npm', `${manifest.name}@${manifest.version}`)
  };
  addOverrides(record); records.push(record);
}

const cargoLockBytes = fs.readFileSync(path.join(root, 'Cargo.lock'));
const cargoChecksums = new Map();
for (const block of cargoLockBytes.toString('utf8').split(/^\[\[package\]\]\s*$/m).slice(1)) {
  const field = name => block.match(new RegExp(`^${name} = "([^"\\r\\n]+)"`, 'm'))?.[1];
  cargoChecksums.set(`${field('name')}@${field('version')}`, field('checksum') ?? null);
}
const metadata = JSON.parse(execFileSync(cargo, ['metadata', '--format-version', '1', '--locked', '--offline', '--filter-platform', target], {
  cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true
}));
const packages = new Map(metadata.packages.map(item => [item.id, item]));
const nodes = new Map(metadata.resolve.nodes.map(item => [item.id, item]));
const desktop = metadata.packages.find(item => item.name === 'asset-desktop');
if (!desktop) throw new Error('asset-desktop is not present in locked Cargo metadata');
const scopes = new Map();
const queue = [[desktop.id, 'native-runtime-dependency']];
while (queue.length) {
  const [id, scope] = queue.shift();
  const known = scopes.get(id) || new Set();
  if (known.has(scope)) continue;
  known.add(scope); scopes.set(id, known);
  for (const dependency of nodes.get(id)?.deps ?? []) {
    const isMacro = packages.get(dependency.pkg)?.targets.some(item => item.kind.includes('proc-macro'));
    for (const kind of dependency.dep_kinds) {
      if (kind.kind === 'dev') continue;
      if (kind.kind === 'build' && !includeTools) continue;
      const nextScope = kind.kind === 'build' ? 'host-build-tool' : isMacro ? 'host-proc-macro-dependency' : scope;
      queue.push([dependency.pkg, nextScope]);
    }
  }
}
for (const [id, scopeSet] of scopes) {
  const pkg = packages.get(id);
  if (!pkg.source) {
    localPackages.push({ ecosystem: 'cargo', name: pkg.name, version: pkg.version, licenseExpression: pkg.license, path: slash(path.relative(root, pkg.manifest_path)) });
    continue;
  }
  const folder = path.dirname(pkg.manifest_path);
  const identity = `${pkg.name}@${pkg.version}`;
  const vcsPath = path.join(folder, '.cargo_vcs_info.json');
  const vcs = fs.existsSync(vcsPath) ? readJson(vcsPath) : null;
  const record = {
    ecosystem: 'cargo', name: pkg.name, version: pkg.version, scope: sorted(scopeSet),
    licenseExpression: pkg.license || 'UNKNOWN', upstream: safeUrl(pkg.repository),
    crateDownload: `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`,
    lockSha256: cargoChecksums.get(identity) ?? null,
    upstreamCommit: vcs?.git?.sha1 ?? null, upstreamSubdirectory: vcs?.path_in_vcs ?? null,
    documents: localLicenseTexts(folder, 'cargo', identity)
  };
  if (pkg.license_file) {
    const filename = path.resolve(folder, pkg.license_file);
    if (!filename.startsWith(folder + path.sep)) throw new Error('Cargo license-file escapes the installed package');
    if (fs.existsSync(filename)) record.documents.push(preserveText(fs.readFileSync(filename), {
      kind: 'installed-license-file', ecosystem: 'cargo', package: identity, file: slash(pkg.license_file)
    }));
  }
  addOverrides(record);
  // MPL source copies are unmodified registry archives, pinned by Cargo.lock.
  if (pkg.license === 'MPL-2.0') {
    const registryName = path.basename(path.dirname(folder));
    const archive = path.join(cargoHome, 'registry/cache', registryName, `${pkg.name}-${pkg.version}.crate`);
    if (fs.existsSync(archive)) {
      const bytes = fs.readFileSync(archive);
      const digest = sha256(bytes);
      if (!record.lockSha256 || digest !== record.lockSha256) throw new Error(`Cached source checksum differs: ${identity}`);
      const sourcePath = `sources/${pkg.name}-${pkg.version}.crate`;
      fs.mkdirSync(path.join(output, 'sources'), { recursive: true });
      const destination = path.join(output, sourcePath);
      if (fs.existsSync(destination) && sha256(fs.readFileSync(destination)) !== digest) throw new Error('Existing source copy was altered');
      fs.writeFileSync(destination, bytes);
      record.sourceArchive = { path: sourcePath, bytes: bytes.length, sha256: digest, unmodified: true };
    } else record.sourceArchiveMissing = true;
  }
  records.push(record);
}

// The Rust standard library is linked into the native executable; the compiler is not distributed.
const sysroot = execFileSync(rustc, ['--print', 'sysroot'], { encoding: 'utf8', windowsHide: true }).trim();
const rustVersion = execFileSync(rustc, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
const libraryCopyright = path.join(sysroot, 'share/doc/rust/COPYRIGHT-library.html');
const rustLibrary = { ecosystem: 'rust-sysroot', name: 'Rust standard library', version: rustVersion, scope: ['native-runtime-dependency'], documents: [] };
if (fs.existsSync(libraryCopyright)) {
  const bytes = fs.readFileSync(libraryCopyright);
  fs.writeFileSync(path.join(output, 'RUST-STANDARD-LIBRARY-LICENSES.html'), bytes);
  rustLibrary.documents.push({ path: 'RUST-STANDARD-LIBRARY-LICENSES.html', bytes: bytes.length, sha256: sha256(bytes), origin: { kind: 'installed-rust-library-copyright', file: 'share/doc/rust/COPYRIGHT-library.html' }, fullLicenseBody: true });
}
records.push(rustLibrary);

// Preserve the bundled SQLite public-domain header separately from the Rust wrapper's MIT license.
const sqlite = metadata.packages.find(item => item.name === 'libsqlite3-sys' && scopes.has(item.id));
if (sqlite) {
  const filename = path.join(path.dirname(sqlite.manifest_path), 'sqlite3/sqlite3.c');
  if (fs.existsSync(filename)) {
    const prefix = fs.readFileSync(filename).subarray(0, 32_768).toString('utf8');
    const header = [...prefix.matchAll(/\/\*[\s\S]*?\*\//g)].map(match => match[0]).find(text => /public domain|author disclaims copyright/i.test(text));
    if (header) records.push({
      ecosystem: 'vendored-native-source', name: 'SQLite', version: `bundled by libsqlite3-sys ${sqlite.version}`,
      scope: ['native-runtime-dependency'], licenseExpression: 'Public domain',
      upstream: 'https://www.sqlite.org/copyright.html',
      documents: [preserveText(Buffer.from(header), { kind: 'exact-source-header', file: 'sqlite3/sqlite3.c', package: `libsqlite3-sys@${sqlite.version}` })]
    });
  }
}

// The Microsoft SDK loader shipped inside webview2-com-sys has its own notice.
// Its Rust wrapper's MIT license does not substitute for the vendor notice.
const webviewSys = metadata.packages.find(item => item.name === 'webview2-com-sys' && scopes.has(item.id));
if (webviewSys) {
  const known = overrides.find(item => item.ecosystem === 'vendored-native-source' && item.name === 'Microsoft WebView2 SDK loader' && item.container?.name === webviewSys.name && item.container.version === webviewSys.version);
  const record = {
    ecosystem: 'vendored-native-source', name: 'Microsoft WebView2 SDK loader',
    version: known?.version ?? 'UNKNOWN', scope: ['native-runtime-dependency'],
    licenseExpression: known?.licenseExpression ?? 'UNKNOWN',
    container: { name: webviewSys.name, version: webviewSys.version, lockSha256: cargoChecksums.get(`${webviewSys.name}@${webviewSys.version}`) },
    resolvedFeatures: nodes.get(webviewSys.id)?.features ?? [],
    upstream: known?.files[0]?.upstreamUrl ?? 'https://www.nuget.org/packages/Microsoft.Web.WebView2/',
    nativeArtifacts: [], documents: []
  };
  for (const file of known?.nativeArtifacts ?? []) {
    const folder = path.dirname(webviewSys.manifest_path);
    const filename = path.resolve(folder, file.path);
    if (!filename.startsWith(folder + path.sep)) throw new Error('Vendor artifact escapes its installed package');
    const bytes = fs.readFileSync(filename);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('Vendor SDK bytes differ from pinned license provenance');
    record.nativeArtifacts.push(file);
  }
  addOverrides(record);
  records.push(record);
}

records.sort((a, b) => `${a.ecosystem}:${a.name}:${a.version}`.localeCompare(`${b.ecosystem}:${b.name}:${b.version}`, 'en'));
for (const record of records) record.hasFullLicenseText = record.documents.some(item => item.fullLicenseBody) || record.licenseExpression === 'Public domain';
const missing = records.filter(item => !item.hasFullLicenseText || item.sourceArchiveMissing).map(item => ({
  ecosystem: item.ecosystem, name: item.name, version: item.version, licenseExpression: item.licenseExpression ?? 'see library copyright document',
  scope: item.scope, upstream: item.upstream ?? null, upstreamCommit: item.upstreamCommit ?? null,
  missingLicenseText: !item.hasFullLicenseText, missingMplSourceArchive: Boolean(item.sourceArchiveMissing)
}));
const inventory = {
  schemaVersion: 1, target, includeTools,
  inputs: { packageLockSha256: sha256(lockBytes), cargoLockSha256: sha256(cargoLockBytes) },
  collection: 'Installed npm/Cargo source and pinned local upstream overrides; no installation or build performed',
  scope: 'Conservative locked dependency graph with separately labeled host macros/tools and vendor components; does not assert every package survives linking',
  packages: records, localPackages,
  counts: {
    npm: records.filter(item => item.ecosystem === 'npm').length,
    cargo: records.filter(item => item.ecosystem === 'cargo').length,
    licenseTexts: textFiles.size,
    missing: missing.length,
    mplSourceArchives: records.filter(item => item.sourceArchive).length
  },
  licenseTextCollectionComplete: missing.length === 0,
  remainingReview: ['Compliance with selected alternative/combined SPDX terms', 'Output/imported-asset and external-service rights', 'Optional future redistributables and clean-machine runtime prerequisites']
};
const writeJson = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
writeJson('dependency-inventory.json', inventory);
writeJson('missing-license-texts.json', { schemaVersion: 1, missing });
writeJson('license-text-index.json', { schemaVersion: 1, files: [...textFiles.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')) });
const combined = [Buffer.from('Asset Studio third-party license and copyright notices\n\nExact upstream document bytes follow each SHA-256 header. Individual original files and dependency/provenance mappings are preserved alongside this document. Host procedural-macro dependencies are included conservatively; the compiler is not distributed. Rust standard-library notices are in RUST-STANDARD-LIBRARY-LICENSES.html. MPL matching source archives are in sources/.\n')];
for (const document of [...textFiles.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
  const references = records.filter(item => item.documents.some(file => file.sha256 === document.sha256)).map(item => `${item.ecosystem}: ${item.name} ${item.version}`);
  combined.push(Buffer.from(`\n\n================ SHA-256 ${document.sha256} ================\nOriginal file: ${document.path}\nReferenced by: ${references.join('; ')}\nOriginal bytes: ${document.bytes}\n---------------- Begin unmodified document ----------------\n`));
  combined.push(fs.readFileSync(path.join(output, document.path)));
  combined.push(Buffer.from('\n---------------- End unmodified document ----------------\n'));
}
fs.writeFileSync(path.join(output, 'THIRD_PARTY_LICENSES.txt'), Buffer.concat(combined));
const npmRuntime = records.filter(item => item.ecosystem === 'npm' && item.scope.includes('frontend-runtime-dependency'));
const npmDigests = new Set(npmRuntime.flatMap(item => item.documents.map(file => file.sha256)));
const npmCombined = [Buffer.from('Asset Studio frontend third-party license and copyright notices\n\nOnly locked npm runtime dependencies are included. They conservatively cover the desktop frontend and public website. Exact upstream document bytes follow each SHA-256 header. Development tools, Rust and the compiler are excluded.\n')];
for (const document of [...textFiles.values()].filter(item => npmDigests.has(item.sha256)).sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
  const references = npmRuntime.filter(item => item.documents.some(file => file.sha256 === document.sha256)).map(item => `${item.name} ${item.version}`);
  npmCombined.push(Buffer.from(`\n\n================ SHA-256 ${document.sha256} ================\nReferenced by: ${references.join('; ')}\nOriginal bytes: ${document.bytes}\n---------------- Begin unmodified document ----------------\n`));
  npmCombined.push(fs.readFileSync(path.join(output, document.path)));
  npmCombined.push(Buffer.from('\n---------------- End unmodified document ----------------\n'));
}
fs.writeFileSync(path.join(output, 'NPM_RUNTIME_LICENSES.txt'), Buffer.concat(npmCombined));
const table = records.map(item => `| ${item.ecosystem} | ${item.name} ${item.version} | ${item.licenseExpression ?? 'see library copyright'} | ${item.scope.join(', ')} | ${item.hasFullLicenseText ? 'collected' : 'missing'} |`).join('\n');
fs.writeFileSync(path.join(output, 'README.md'), `# Third-party license collection\n\nGenerated by \`node scripts/collect-third-party-notices.mjs\` from the installed, locked dependency set. Target: \`${target}\`. It performs offline metadata reads and preserves license/NOTICE bytes by SHA-256. Pinned upstream supplements are committed under \`upstream/\`; generation never fetches them. Re-run after either lockfile changes. \`--include-tools\` additionally collects development/build dependencies.\n\nThe inventory conservatively follows normal dependencies and distinguishes host procedural-macro dependencies from native runtime dependencies. Frontend dependencies are the non-dev external packages in package-lock. These labels do not claim every byte survived bundler/linker removal. The Rust compiler and Windows SDK development tools are not distributed. The Microsoft WebView2 SDK loader incorporated by webview2-com-sys has a separate BSD-3-Clause vendor notice; that notice does not license the separately installed WebView2 Runtime. The Blender executable and external Codex service are not distributed. Rust standard-library license/copyright text is included separately.\n\n${inventory.counts.npm} npm packages; ${inventory.counts.cargo} external Rust crates; ${inventory.counts.licenseTexts} distinct exact license/NOTICE/README texts; ${missing.length} unresolved records. See [dependency-inventory.json](dependency-inventory.json), [missing-license-texts.json](missing-license-texts.json) and [license-text-index.json](license-text-index.json). Original document bytes live in \`texts/\`.\n\nMPL-2.0 crates are unmodified. Their complete matching source archives are provided in \`sources/\`, verified against Cargo.lock SHA-256; exact-version official download locations also appear in the inventory. Recipients may obtain and modify that source under MPL-2.0. Apache/MIT/BSD/ISC/Unicode/Zlib notices retain upstream text and attribution. Multiple expressions with AND preserve both components; alternative licenses remain documented rather than silently relabeled.\n\nThe separately distributed Blender worker has its own source and GPL-3.0-or-later license under \`workers/blender\`. The pinned Codex catalog already carries its upstream license/NOTICE in the distribution root. Application Apache-2.0 terms do not grant rights to those external services or to arbitrary user assets. A complete text inventory is evidence for redistribution review, not a legal clearance certificate.\n\n| Ecosystem | Package | Declared license | Scope | Text |\n| --- | --- | --- | --- | --- |\n${table}\n`);
console.log(JSON.stringify({ output: slash(path.relative(root, output)), target, ...inventory.counts, licenseTextCollectionComplete: inventory.licenseTextCollectionComplete }));
if (args.includes('--strict') && missing.length) process.exitCode = 2;
