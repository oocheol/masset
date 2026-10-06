// Build a standalone, pinned CLI package. No GUI, account files or model weights.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planWindowsResources } from './copy-windows-resources.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return args[i + 1];
}
// ZIP32 with fixed timestamp and Unix mode; the loaders reject links and ZIP64.
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function zipFiles(files) {
  if (!files.length || files.length > 10000) throw new Error('Invalid package file count');
  const local = [], central = [];
  let offset = 0;
  const seen = new Set();
  for (const file of files) {
    if (!/^[A-Za-z0-9_./-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').some(s => !s || s === '.' || s === '..')) throw new Error('Unsafe ZIP filename');
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate ZIP filename');
    seen.add(key);
    const name = Buffer.from(file.path), bytes = file.content;
    const packed = zlib.deflateRawSync(bytes, { level: 9 });
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(0x2821, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, packed);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(0x0314, 4);
    index.writeUInt16LE(20, 6); index.writeUInt16LE(8, 10); index.writeUInt16LE(0x2821, 14);
    index.writeUInt32LE(crc, 16); index.writeUInt32LE(packed.length, 20);
    index.writeUInt32LE(bytes.length, 24); index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(((file.executable ? 0o100755 : 0o100644) * 65536) >>> 0, 38);
    index.writeUInt32LE(offset, 42); central.push(index, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...local, directory, end]);
  if (archive.length > 256 * 1024 * 1024) throw new Error('CLI archive exceeds loader bound');
  return archive;
}

export function packageCli({ platform, binary, destination }) {
  if (!['windows-x64', 'macos-arm64'].includes(platform)) throw new Error('Unsupported CLI platform');
  if (!path.isAbsolute(binary) || !path.isAbsolute(destination)) throw new Error('Use absolute build paths');
  if (!fs.lstatSync(binary).isFile() || fs.lstatSync(binary).isSymbolicLink()) throw new Error('Native CLI must be a regular file');
  const version = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8')).version;
  const nativeVersion = JSON.parse(execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true }));
  if (nativeVersion.version !== version) throw new Error('CLI and package versions differ');
  if (fs.existsSync(destination)) throw new Error('Package destination must be new');
  fs.mkdirSync(destination, { recursive: true });
  const cliPath = platform === 'windows-x64' ? 'asset-cli.exe' : 'asset-cli';
  const files = [{ path: cliPath, content: fs.readFileSync(binary), executable: true }];
  const plan = planWindowsResources({ workspace });
  for (const file of plan.files) {
    // The skill carries the hash of this archive; including it would be circular.
    if (file.path.startsWith('integrations/codex/')) continue;
    const content = fs.readFileSync(path.join(workspace, file.source));
    if (sha(content) !== file.sha256) throw new Error('Resource changed while packaging');
    files.push({ path: `resources/${file.path}`, content });
  }
  const inventory = files.map(file => ({ path: file.path, bytes: file.content.length, sha256: sha(file.content), ...(file.executable ? { executable: true } : {}) }));
  const filename = `AssetStudioCLI-${version}-${platform}.zip`;
  const archive = zipFiles(files);
  const pkg = { version, url: `https://github.com/oocheol/masset/releases/download/v${version}/${filename}`, bytes: archive.length, sha256: sha(archive), license: 'Apache-2.0; third-party notices in resources/docs/licenses', cliPath, resourcePath: 'resources', files: inventory };
  fs.writeFileSync(path.join(destination, filename), archive, { flag: 'wx' });
  const manifest = { schemaVersion: 1, format: 'asset-studio-cli-runtime', packages: { [platform]: pkg } };
  fs.writeFileSync(path.join(destination, `native-cli-${platform}.json`), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ platform, version, filename, bytes: archive.length, sha256: pkg.sha256, files: files.length }));
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageCli({ platform: option('--platform'), binary: path.resolve(option('--binary')), destination: path.resolve(option('--destination')) });
}
