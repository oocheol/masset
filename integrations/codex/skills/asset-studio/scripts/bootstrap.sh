#!/bin/bash
# Stock macOS shell, JXA/Foundation and system curl/unzip/shasum are sufficient.
# No Python, Node.js, GUI installation or administrator rights are required.
set -eu
umask 077
if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  printf '%s\n' '{"event":"needs_attention","code":"unsupported_platform","message":"This entry point supports Apple Silicon macOS only."}'
  exit 1
fi
script_dir="$(cd -P -- "$(/usr/bin/dirname -- "$0")" && /bin/pwd)"
exec /usr/bin/osascript -l JavaScript - "$script_dir" "$@" <<'JXA'
ObjC.import('Foundation');
ObjC.bindFunction('open', ['int', ['char*', 'int', 'int']]);
ObjC.bindFunction('flock', ['int', ['int', 'int']]);
ObjC.bindFunction('renamex_np', ['int', ['char*', 'char*', 'unsigned int']]);
ObjC.bindFunction('exit', ['void', ['int']]);

var fm = $.NSFileManager.defaultManager;
var OWNER = {format: 'asset-studio-cli-bootstrap', schemaVersion: 1};
var MAX_MANIFEST = 2 * 1024 * 1024;
var MAX_ARCHIVE = 512 * 1024 * 1024;
var MAX_FILE = 256 * 1024 * 1024;
var MAX_TOTAL = 1024 * 1024 * 1024;
var MAX_FILES = 4096;

function fail(code, message) {
  var error = new Error(message); error.bootstrapCode = code; throw error;
}
function emit(event, fields) {
  var value = {event: event};
  Object.keys(fields || {}).forEach(function(key) { value[key] = fields[key]; });
  var data = $(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}
function nil(value) { return value === undefined || value === null || value.isNil(); }
function attributes(path) {
  var error = Ref(); var item = fm.attributesOfItemAtPathError($(path), error);
  if (nil(item)) return null;
  return {type: ObjC.unwrap(item.objectForKey($.NSFileType)),
          bytes: Number(ObjC.unwrap(item.objectForKey($.NSFileSize))),
          mode: Number(ObjC.unwrap(item.objectForKey($.NSFilePosixPermissions)))};
}
function absolute(path) {
  if (typeof path !== 'string' || path.charAt(0) !== '/' || /(^|\/)\.\.(\/|$)/.test(path) || path.indexOf('\0') !== -1) {
    fail('unsafe_path', 'Use an absolute path without parent traversal.');
  }
  // Lexical normalization only: never resolve an existing link into a new target.
  return '/' + path.split('/').filter(function(piece) { return piece && piece !== '.'; }).join('/');
}
function noLinks(path) {
  path = absolute(path);
  var pieces = path.split('/'); var current = '';
  for (var index = 1; index < pieces.length; index++) {
    current += '/' + pieces[index];
    var info = attributes(current);
    if (info && info.type !== 'NSFileTypeRegular' && info.type !== 'NSFileTypeDirectory') {
      fail('unsafe_path', 'Runtime paths cannot contain symbolic links or special files.');
    }
    if (info && index < pieces.length - 1 && info.type !== 'NSFileTypeDirectory') {
      fail('unsafe_path', 'A runtime parent is not a directory.');
    }
  }
}
function ensureDirectory(path) {
  noLinks(path);
  var info = attributes(path);
  if (info) {
    if (info.type !== 'NSFileTypeDirectory') fail('unsafe_path', 'A runtime parent is not a directory.');
    return;
  }
  var error = Ref();
  if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(path), true,
      $({NSFilePosixPermissions: 448}), error)) fail('unsafe_path', 'The private runtime directory could not be created.');
  noLinks(path);
}
function readText(path, maximum) {
  noLinks(path);
  var info = attributes(path);
  if (!info || info.type !== 'NSFileTypeRegular' || info.bytes > maximum) {
    fail('invalid_manifest', 'Runtime metadata must be a bounded regular UTF-8 file.');
  }
  var data = $.NSData.dataWithContentsOfFile($(path));
  var text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  if (nil(text)) fail('invalid_manifest', 'Runtime metadata must be valid UTF-8.');
  return ObjC.unwrap(text);
}
function readJson(path) {
  var value;
  try { value = JSON.parse(readText(path, MAX_MANIFEST)); }
  catch (error) { if (error.bootstrapCode) throw error; fail('invalid_manifest', 'Runtime metadata must be valid UTF-8 JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_manifest', 'Runtime metadata must be a JSON object.');
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function(key) {
    return JSON.stringify(key) + ':' + canonical(value[key]);
  }).join(',') + '}';
  return JSON.stringify(value);
}
function newFile(path) {
  noLinks(path);
  // Darwin O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW; mode 0600.
  var descriptor = $.open(path, 1 | 512 | 2048 | 256, 384);
  if (descriptor < 0) fail('unsafe_path', 'An existing file was preserved without replacement.');
  return $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(descriptor, true);
}
function writeNewJson(path, value) {
  var stream = newFile(path);
  try { stream.writeData($(JSON.stringify(value)).dataUsingEncoding($.NSUTF8StringEncoding)); stream.synchronizeFile; }
  finally { stream.closeFile; }
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || !/^[A-Za-z0-9_.\-/]+$/.test(value) || value.charAt(0) === '/') {
    fail('unsafe_path', 'Runtime inventory needs bounded portable ASCII relative paths.');
  }
  value.split('/').forEach(function(part) {
    if (!part || part === '.' || part === '..' || /\.$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) {
      fail('unsafe_path', 'Runtime paths cannot contain traversal or reserved file names.');
    }
  });
  return value;
}
function parents(name) {
  var result = []; var position = name.lastIndexOf('/');
  while (position >= 0) { name = name.slice(0, position); result.push(name); position = name.lastIndexOf('/'); }
  return result;
}
function integer(value, maximum, allowZero) {
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value || value < 0 || (!allowZero && value === 0) || value > maximum) {
    fail('invalid_inventory', 'Runtime byte counts must be bounded integers.');
  }
  return value;
}
function digest(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('invalid_inventory', 'Runtime checksums must be lowercase SHA-256.');
  return value;
}
function packageSpec(manifest, platform) {
  if (manifest.format !== 'asset-studio-cli-runtime' || manifest.schemaVersion !== 1) fail('invalid_manifest', 'Unsupported native runtime manifest format.');
  var item = manifest.packages && manifest.packages[platform];
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail('runtime_unavailable', 'No verified native CLI package is published for this platform.');
  if (typeof item.version !== 'string' || item.version.length > 64 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(item.version)) {
    fail('invalid_manifest', 'The runtime release needs a fixed version.');
  }
  var prefix = 'https://github.com/oocheol/masset/releases/download/v' + item.version + '/';
  if (typeof item.url !== 'string' || item.url.length > 2048 || item.url.slice(0, prefix.length) !== prefix ||
      !/^[A-Za-z0-9._-]+\.zip$/.test(item.url.slice(prefix.length))) fail('invalid_manifest', 'Only the pinned oocheol/masset GitHub release ZIP is allowed.');
  if (typeof item.license !== 'string' || !item.license.trim() || item.license.length > 1024) fail('invalid_manifest', 'The runtime package must identify its licenses.');
  if (!Array.isArray(item.files) || item.files.length < 1 || item.files.length > MAX_FILES) fail('invalid_inventory', 'A complete bounded file inventory is required.');
  var seen = Object.create(null); var total = 0;
  var files = item.files.map(function(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid_inventory', 'Each inventory entry must be an object.');
    var name = relative(entry.path); var folded = name.toLowerCase();
    if (seen[folded] || folded === 'installation.json') fail('invalid_inventory', 'Inventory paths must be unique, including case and receipt names.');
    seen[folded] = true;
    var bytes = integer(entry.bytes, MAX_FILE, true); total += bytes;
    var executable = entry.executable === undefined ? false : entry.executable;
    if (typeof executable !== 'boolean') fail('invalid_inventory', 'The executable marker must be a boolean.');
    return {path: name, bytes: bytes, sha256: digest(entry.sha256), executable: executable};
  }).sort(function(left, right) { return left.path < right.path ? -1 : left.path > right.path ? 1 : 0; });
  if (total > MAX_TOTAL) fail('invalid_inventory', 'The runtime exceeds its unpacked byte budget.');
  files.forEach(function(entry) { parents(entry.path).forEach(function(parent) {
    if (seen[parent.toLowerCase()]) fail('invalid_inventory', 'A runtime file cannot also be a directory.');
  }); });
  var cli = relative(item.cliPath); var resources = relative(item.resourcePath);
  if (cli !== 'asset-cli' || resources !== 'resources' || !seen[cli] || !seen['resources/workers/blender/worker.py'] || !seen['resources/license']) {
    fail('invalid_inventory', 'The CLI and required resources are missing from the pinned inventory.');
  }
  var cliEntry = files.filter(function(entry) { return entry.path === cli; })[0];
  if (!cliEntry.executable) fail('invalid_inventory', 'The native Mac CLI must be marked executable.');
  return {version: item.version, url: item.url, bytes: integer(item.bytes, MAX_ARCHIVE), sha256: digest(item.sha256),
          license: item.license, cliPath: cli, resourcePath: resources, files: files};
}
function task(path, args, capture) {
  var process = $.NSTask.alloc.init; process.launchPath = $(path); process.arguments = $(args);
  var pipe;
  if (capture) { pipe = $.NSPipe.pipe; process.standardOutput = pipe; process.standardError = pipe; }
  else { process.standardOutput = $.NSFileHandle.fileHandleWithStandardOutput; process.standardError = $.NSFileHandle.fileHandleWithStandardError; }
  process.launch;
  var output = '';
  if (capture) {
    var received = $.NSMutableData.data; var total = 0;
    while (true) {
      var chunk = pipe.fileHandleForReading.readDataOfLength(8192); var length = Number(chunk.length);
      if (!length) break;
      total += length;
      if (total > 65536) { process.terminate; process.waitUntilExit; fail('bootstrap_failed', 'A system tool exceeded its output budget.'); }
      received.appendData(chunk);
    }
    var text = $.NSString.alloc.initWithDataEncoding(received, $.NSUTF8StringEncoding);
    if (nil(text)) fail('bootstrap_failed', 'A system tool returned invalid UTF-8 output.');
    output = ObjC.unwrap(text);
  }
  process.waitUntilExit;
  return {code: Number(process.terminationStatus), output: output};
}
function verifyFile(path, bytes, sha) {
  noLinks(path); var before = attributes(path);
  if (!before || before.type !== 'NSFileTypeRegular' || before.bytes !== bytes) fail('package_mismatch', 'A runtime file does not match its pinned byte count.');
  var result = task('/usr/bin/shasum', ['-a', '256', '--', path], true);
  noLinks(path); var after = attributes(path);
  if (result.code || !after || after.bytes !== bytes || result.output.slice(0, 64) !== sha || !/^\s/.test(result.output.slice(64, 65))) {
    fail('package_mismatch', 'A runtime file failed its pinned SHA-256 verification.');
  }
}
function expectedReceipt(spec, platform, destination) {
  return {format: 'asset-studio-cli-installation', schemaVersion: 1, platform: platform, package: spec,
          cliPath: destination + '/' + spec.cliPath, resourcePath: destination + '/' + spec.resourcePath};
}
function verifyTree(root, spec, receipt) {
  noLinks(root); var rootInfo = attributes(root);
  if (!rootInfo || rootInfo.type !== 'NSFileTypeDirectory') fail('package_mismatch', 'Native runtime installation is not a directory.');
  var expected = Object.create(null); var directories = Object.create(null); var actual = Object.create(null);
  spec.files.forEach(function(entry) { expected[entry.path] = true; parents(entry.path).forEach(function(parent) { directories[parent] = true; }); });
  if (receipt) expected['installation.json'] = true;
  var pending = [root];
  while (pending.length) {
    var directory = pending.pop(); var error = Ref();
    var names = fm.contentsOfDirectoryAtPathError($(directory), error);
    if (nil(names)) fail('package_mismatch', 'The runtime directory could not be verified.');
    ObjC.unwrap(names).forEach(function(name) {
      var path = directory + '/' + name; noLinks(path); var info = attributes(path); var relativePath = path.slice(root.length + 1);
      if (!info) fail('package_mismatch', 'A runtime file disappeared during verification.');
      if (info.type === 'NSFileTypeDirectory') {
        if (!directories[relativePath]) fail('package_mismatch', 'Unknown runtime directories were preserved without changes.');
        pending.push(path);
      } else {
        if (info.type !== 'NSFileTypeRegular' || !expected[relativePath]) fail('package_mismatch', 'Unknown runtime files were preserved without changes.');
        actual[relativePath] = true;
      }
    });
  }
  if (canonical(Object.keys(actual).sort()) !== canonical(Object.keys(expected).sort())) fail('package_mismatch', 'Unknown, missing or edited runtime files were preserved without changes.');
  spec.files.forEach(function(entry) {
    var path = root + '/' + entry.path; verifyFile(path, entry.bytes, entry.sha256);
    if (entry.executable && (attributes(path).mode & 73) !== 73) fail('package_mismatch', 'The native CLI executable permission was changed.');
  });
  if (receipt && canonical(readJson(root + '/installation.json')) !== canonical(receipt)) fail('package_mismatch', 'The installed runtime receipt does not match the pinned release.');
}
function acquireLock(base) {
  noLinks(base);
  if (attributes(base)) {
    if (!attributes(base + '/.bootstrap-owner.json')) {
      var entries = fm.contentsOfDirectoryAtPathError($(base), Ref());
      if (nil(entries) || ObjC.unwrap(entries).length) fail('unmanaged_directory', 'An unknown runtime directory was preserved without changes.');
      writeNewJson(base + '/.bootstrap-owner.json', OWNER);
    }
    if (canonical(readJson(base + '/.bootstrap-owner.json')) !== canonical(OWNER)) {
      fail('unmanaged_directory', 'An unknown runtime directory was preserved without changes.');
    }
  } else { ensureDirectory(base); writeNewJson(base + '/.bootstrap-owner.json', OWNER); }
  var path = base + '/.bootstrap.lock'; noLinks(path);
  // Darwin O_RDWR | O_CREAT | O_NOFOLLOW, then POSIX flock LOCK_EX | LOCK_NB.
  var descriptor = $.open(path, 2 | 512 | 256, 384);
  if (descriptor < 0) fail('unsafe_path', 'The runtime lock could not be opened safely.');
  var stream = $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(descriptor, true);
  if ($.flock(descriptor, 2 | 4) !== 0) { stream.closeFile; fail('bootstrap_busy', 'Another native CLI preparation is running; try again after it finishes.'); }
  try {
    var length = Number(stream.seekToEndOfFile);
    if (length > 1024) fail('unmanaged_directory', 'An unknown lock file was preserved without changes.');
    if (length) {
      stream.seekToFileOffset(0); var value;
      try { value = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(stream.readDataOfLength(length), $.NSUTF8StringEncoding))); }
      catch (error) { fail('unmanaged_directory', 'An unknown lock file was preserved without changes.'); }
      if (!value || value.format !== OWNER.format || value.schemaVersion !== 1) fail('unmanaged_directory', 'An unknown lock file was preserved without changes.');
    }
    stream.seekToFileOffset(0);
    var marker = $(JSON.stringify({format: OWNER.format, schemaVersion: 1, pid: Number($.NSProcessInfo.processInfo.processIdentifier)})).dataUsingEncoding($.NSUTF8StringEncoding);
    stream.writeData(marker); stream.truncateFileAtOffset(Number(marker.length)); stream.synchronizeFile;
    return stream;
  } catch (error) { $.flock(descriptor, 8); stream.closeFile; throw error; }
}
function releaseLock(stream) { $.flock(Number(stream.fileDescriptor), 8); stream.closeFile; }
function uuid() { return ObjC.unwrap($.NSUUID.UUID.UUIDString).replace(/-/g, '').toLowerCase(); }

// Only small ZIP metadata chunks enter JavaScript memory. Artifact bodies stream
// through NSFileHandle; no base64 copy of the complete native package is made.
function byteArray(data) {
  var text = ObjC.unwrap(data.base64EncodedStringWithOptions(0)); var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var output = new Uint8Array(Number(data.length)); var at = 0;
  for (var index = 0; index < text.length; index += 4) {
    var a = alphabet.indexOf(text.charAt(index)); var b = alphabet.indexOf(text.charAt(index + 1));
    var c = alphabet.indexOf(text.charAt(index + 2)); var d = alphabet.indexOf(text.charAt(index + 3));
    if (at < output.length) output[at++] = (a << 2) | (b >> 4);
    if (at < output.length) output[at++] = ((b & 15) << 4) | (c >> 2);
    if (at < output.length) output[at++] = ((c & 3) << 6) | d;
  }
  return output;
}
function zipBytes(stream, offset, length) {
  if (length < 0 || length > MAX_MANIFEST) fail('unsafe_archive', 'ZIP metadata exceeds its bounded size.');
  stream.seekToFileOffset(offset); var data = stream.readDataOfLength(length);
  if (Number(data.length) !== length) fail('unsafe_archive', 'The ZIP metadata is truncated.');
  return byteArray(data);
}
function u16(bytes, index) { return bytes[index] | (bytes[index + 1] << 8); }
function u32(bytes, index) { return (bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16) | (bytes[index + 3] << 24)) >>> 0; }
function zipName(bytes) {
  var name = '';
  for (var index = 0; index < bytes.length; index++) {
    if (bytes[index] < 32 || bytes[index] > 126) fail('unsafe_archive', 'ZIP file names must be portable ASCII.');
    name += String.fromCharCode(bytes[index]);
  }
  return name;
}
function zipExtras(bytes) {
  var offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) fail('unsafe_archive', 'The ZIP extra metadata is truncated.');
    var type = u16(bytes, offset); var length = u16(bytes, offset + 2); offset += 4;
    if (offset + length > bytes.length || type === 1 || type === 0x7075 || type === 0x000d) {
      fail('unsafe_archive', 'ZIP64, alternate path names and Unix link metadata are not supported.');
    }
    offset += length;
  }
}
function verifyZip(path, spec) {
  verifyFile(path, spec.bytes, spec.sha256);
  var stream = $.NSFileHandle.fileHandleForReadingAtPath($(path));
  if (nil(stream)) fail('unsafe_archive', 'The pinned ZIP could not be opened.');
  try {
    var tailLength = Math.min(spec.bytes, 65557); var tail = zipBytes(stream, spec.bytes - tailLength, tailLength); var end = -1;
    for (var index = tail.length - 22; index >= 0; index--) {
      if (u32(tail, index) === 0x06054b50 && index + 22 + u16(tail, index + 20) === tail.length) { end = index; break; }
    }
    if (end < 0 || u16(tail, end + 4) || u16(tail, end + 6) || u16(tail, end + 8) !== u16(tail, end + 10)) fail('unsafe_archive', 'The ZIP end record is missing or spans multiple disks.');
    var count = u16(tail, end + 10); var centralSize = u32(tail, end + 12); var centralStart = u32(tail, end + 16);
    if (!count || count > MAX_FILES * 2 || count === 65535 || centralSize > MAX_MANIFEST ||
        centralStart + centralSize !== spec.bytes - tailLength + end) fail('unsafe_archive', 'The ZIP central directory exceeds its budget or uses ZIP64.');
    var expected = Object.create(null); var directories = Object.create(null); var actual = Object.create(null); var seen = Object.create(null); var regions = [];
    spec.files.forEach(function(entry) { expected[entry.path] = entry; parents(entry.path).forEach(function(parent) { directories[parent] = true; }); });
    var offset = centralStart;
    for (var entryIndex = 0; entryIndex < count; entryIndex++) {
      var record = zipBytes(stream, offset, 46);
      if (u32(record, 0) !== 0x02014b50) fail('unsafe_archive', 'A ZIP central record is malformed.');
      var flags = u16(record, 8); var method = u16(record, 10); var crc = u32(record, 16);
      var compressed = u32(record, 20); var bytes = u32(record, 24); var nameLength = u16(record, 28); var extraLength = u16(record, 30); var commentLength = u16(record, 32);
      var attrs = u32(record, 38); var localOffset = u32(record, 42); var kind = (attrs >>> 16) & 0xf000;
      if (!nameLength || nameLength > 241 || extraLength > 4096 || commentLength > 4096 || (flags & 0x49) ||
          (method !== 0 && method !== 8) || (kind !== 0 && kind !== 0x8000 && kind !== 0x4000) || (attrs & 1024) || u16(record, 34)) {
        fail('unsafe_archive', 'The ZIP contains encrypted, linked, special, streaming or unsupported entries.');
      }
      var name = zipName(zipBytes(stream, offset + 46, nameLength)); var isDirectory = name.slice(-1) === '/';
      var safeName = relative(isDirectory ? name.slice(0, -1) : name); var folded = safeName.toLowerCase();
      if (seen[folded]) fail('unsafe_archive', 'The ZIP contains duplicate or case-colliding paths.');
      seen[folded] = true;
      zipExtras(zipBytes(stream, offset + 46 + nameLength, extraLength));
      if (isDirectory) {
        if (!directories[safeName] || bytes || compressed || kind === 0x8000) fail('unsafe_archive', 'The ZIP has an unexpected directory entry.');
      } else {
        var entry = expected[safeName];
        if (!entry || bytes !== entry.bytes || kind === 0x4000 || (bytes > 1024 * 1024 && bytes > Math.max(1, compressed) * 1000) ||
            (method === 0 && compressed !== bytes)) fail('unsafe_archive', 'The ZIP inventory differs from the pinned release or exceeds its compression budget.');
        actual[safeName] = true;
      }
      if (localOffset + 30 > centralStart) fail('unsafe_archive', 'A ZIP local record is outside its data region.');
      var local = zipBytes(stream, localOffset, 30); var localNameLength = u16(local, 26); var localExtraLength = u16(local, 28);
      if (u32(local, 0) !== 0x04034b50 || u16(local, 6) !== flags || u16(local, 8) !== method ||
          u32(local, 14) !== crc || u32(local, 18) !== compressed || u32(local, 22) !== bytes || localNameLength !== nameLength || localExtraLength > 4096 ||
          zipName(zipBytes(stream, localOffset + 30, localNameLength)) !== name) fail('unsafe_archive', 'ZIP central and local records disagree.');
      zipExtras(zipBytes(stream, localOffset + 30 + localNameLength, localExtraLength));
      var localEnd = localOffset + 30 + localNameLength + localExtraLength + compressed;
      if (localEnd > centralStart) fail('unsafe_archive', 'ZIP file data overlaps its central directory.');
      regions.push({start: localOffset, end: localEnd});
      offset += 46 + nameLength + extraLength + commentLength;
      if (offset > centralStart + centralSize) fail('unsafe_archive', 'The ZIP central directory is truncated.');
    }
    if (offset !== centralStart + centralSize || canonical(Object.keys(actual).sort()) !== canonical(Object.keys(expected).sort())) fail('unsafe_archive', 'The ZIP file inventory is incomplete.');
    regions.sort(function(left, right) { return left.start - right.start; });
    for (var regionIndex = 1; regionIndex < regions.length; regionIndex++) {
      if (regions[regionIndex].start < regions[regionIndex - 1].end) fail('unsafe_archive', 'ZIP local records overlap.');
    }
  } finally { stream.closeFile; }
}
function download(spec, path) {
  var output = newFile(path); var url = spec.url; var started = Date.now();
  try {
    for (var redirects = 0; redirects <= 5; redirects++) {
      if (!/^https:\/\/(github\.com|release-assets\.githubusercontent\.com|objects\.githubusercontent\.com)\//.test(url) || /[\r\n#]/.test(url)) {
        fail('unsafe_redirect', 'The release download redirected outside the official HTTPS asset hosts.');
      }
      var headerPath = path + '.headers-' + redirects;
      var process = $.NSTask.alloc.init; process.launchPath = '/usr/bin/curl';
      process.arguments = $(['--silent', '--show-error', '--fail', '--proto', '=https', '--connect-timeout', '30', '--max-time', '900',
          '--max-filesize', String(spec.bytes), '--range', '0-' + spec.bytes, '--dump-header', headerPath, '--output', '-', url]);
      var pipe = $.NSPipe.pipe; process.standardOutput = pipe; process.standardError = $.NSPipe.pipe;
      output.seekToFileOffset(0); output.truncateFileAtOffset(0); process.launch; var count = 0;
      try {
        while (true) {
          var data = pipe.fileHandleForReading.readDataOfLength(Math.min(1024 * 1024, spec.bytes - count + 1));
          var length = Number(data.length); if (!length) break; count += length;
          if (count > spec.bytes || Date.now() - started > 900000) { process.terminate; fail('package_mismatch', 'The download exceeded its pinned byte count or time budget.'); }
          output.writeData(data);
        }
        process.waitUntilExit;
        if (Number(process.terminationStatus)) fail('download_failed', 'The fixed GitHub runtime ZIP could not be downloaded; no CLI was executed.');
      } finally { if (process.running) { process.terminate; process.waitUntilExit; } }
      var status = 0; var location = ''; var contentLength = null; var contentRange = '';
      readText(headerPath, 65536).split(/\r?\n/).forEach(function(line) {
        var match = /^HTTP\/[0-9.]+\s+([0-9]{3})/.exec(line);
        if (match) { status = Number(match[1]); location = ''; contentLength = null; contentRange = ''; }
        else if (/^location:/i.test(line)) location = line.slice(line.indexOf(':') + 1).trim();
        else if (/^content-length:/i.test(line)) contentLength = Number(line.slice(line.indexOf(':') + 1).trim());
        else if (/^content-range:/i.test(line)) contentRange = line.slice(line.indexOf(':') + 1).trim();
      });
      if ([301, 302, 303, 307, 308].indexOf(status) >= 0) {
        if (!location || redirects === 5) fail('unsafe_redirect', 'The release download exceeded its redirect limit.');
        if (location.charAt(0) === '/') location = url.match(/^https:\/\/[^/]+/)[0] + location;
        url = location; continue;
      }
      if ((status !== 200 && status !== 206) || count !== spec.bytes || (contentLength !== null && contentLength !== spec.bytes) ||
          (status === 206 && contentRange !== 'bytes 0-' + (spec.bytes - 1) + '/' + spec.bytes)) fail('package_mismatch', 'The download does not match its pinned response and byte count.');
      output.synchronizeFile; output.closeFile; output = null;
      verifyFile(path, spec.bytes, spec.sha256); return;
    }
  } finally { if (output) output.closeFile; }
}
function install(spec, platform, base, options) {
  var destination = base + '/' + spec.version + '-' + platform + '-' + spec.sha256.slice(0, 16);
  var receipt = expectedReceipt(spec, platform, destination); noLinks(destination);
  if (attributes(destination)) { verifyTree(destination, spec, receipt); return {destination: destination, receipt: receipt, unchanged: true}; }
  if (!options.consent) {
    emit('needs_consent', {code: 'runtime_download_consent_required', platform: platform, version: spec.version,
      downloads: [{url: spec.url, bytes: spec.bytes, sha256: spec.sha256, license: spec.license}],
      message: 'Native CLI download requires --consent-downloads; no files were downloaded or installed.'});
    return null;
  }
  var lock = acquireLock(base);
  try {
    if (attributes(destination)) { verifyTree(destination, spec, receipt); return {destination: destination, receipt: receipt, unchanged: true}; }
    emit('download_plan', {platform: platform, version: spec.version, url: spec.url, bytes: spec.bytes, sha256: spec.sha256, license: spec.license});
    var archive;
    if (options.package) archive = absolute(options.package);
    else {
      if (options.test) fail('test_download_refused', 'Test mode requires a local package and never accesses the network.');
      archive = base + '/.download-' + uuid() + '.zip'; download(spec, archive);
    }
    verifyZip(archive, spec);
    var stage = base + '/.stage-' + uuid(); ensureDirectory(stage);
    if (task('/usr/bin/unzip', ['-qq', archive, '-d', stage], true).code) fail('unsafe_archive', 'The verified native ZIP could not be extracted.');
    spec.files.forEach(function(entry) {
      noLinks(stage + '/' + entry.path);
      if (task('/bin/chmod', [entry.executable ? '755' : '644', stage + '/' + entry.path], true).code) fail('unsafe_archive', 'The runtime file permissions could not be prepared.');
    });
    verifyTree(stage, spec, null); writeNewJson(stage + '/installation.json', receipt); verifyTree(stage, spec, receipt);
    noLinks(destination);
    // Darwin RENAME_EXCL rejects a racing file or empty directory atomically.
    if ($.renamex_np(stage, destination, 4) !== 0) fail('package_mismatch', 'An existing runtime was preserved without replacement.');
    verifyTree(destination, spec, receipt);
    return {destination: destination, receipt: receipt, unchanged: false};
  } finally { releaseLock(lock); }
}
function optionsFrom(argv) {
  var options = {consent: false, needs3d: false, login: false, local: false, print: false, test: false};
  var booleanFlags = {'--consent-downloads': 'consent', '--needs-3d': 'needs3d', '--login-if-needed': 'login', '--local-only': 'local', '--print-command': 'print', '--test-mode': 'test'};
  var valueFlags = {'--data-dir': 'data', '--package': 'package', '--manifest': 'manifest', '--runtime-root': 'root'};
  if (argv.length && argv[0] === 'ensure') argv.shift();
  for (var index = 0; index < argv.length; index++) {
    var name = argv[index];
    if (booleanFlags[name]) options[booleanFlags[name]] = true;
    else if (valueFlags[name]) {
      if (++index >= argv.length || argv[index].slice(0, 2) === '--') fail('invalid_arguments', 'A native bootstrap option is missing its absolute path.');
      options[valueFlags[name]] = argv[index];
    } else fail('invalid_arguments', 'Unknown native bootstrap option.');
  }
  if (!options.test && (options.package || options.manifest || options.root)) fail('test_only_option', 'Local package, manifest and runtime-root overrides require --test-mode.');
  if (options.local && options.login) fail('invalid_arguments', '--local-only cannot be combined with --login-if-needed.');
  return options;
}
function main(argv) {
  var scriptDir = argv.shift(); var options = optionsFrom(argv);
  var architecture = task('/usr/bin/uname', ['-m'], true);
  if (architecture.code || architecture.output.trim() !== 'arm64') {
    var silicon = task('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], true);
    if (silicon.code || silicon.output.trim() !== '1') fail('unsupported_platform', 'This entry point supports Apple Silicon macOS only.');
  }
  var platform = 'macos-arm64';
  var manifest = options.manifest ? absolute(options.manifest) : absolute(ObjC.unwrap($(scriptDir).stringByDeletingLastPathComponent) + '/references/native-runtime.json');
  var spec = packageSpec(readJson(manifest), platform);
  var home = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('HOME'));
  var base = options.root ? absolute(options.root) : absolute(home + '/Library/Application Support/AssetStudioCLI/runtimes');
  if (options.data) { options.data = absolute(options.data); noLinks(options.data); }
  var ready = install(spec, platform, base, options);
  if (!ready) return 3;
  var receipt = ready.receipt;
  var prepare = [receipt.cliPath, 'prepare', '--resources', receipt.resourcePath];
  if (options.needs3d) prepare.push('--needs-3d');
  if (options.consent) prepare.push('--consent-downloads');
  if (options.login) prepare.push('--login-if-needed');
  if (options.local) prepare.push('--local-only');
  if (options.data) prepare.push('--data-dir', options.data);
  var doctor = [receipt.cliPath, 'doctor', '--resources', receipt.resourcePath];
  if (!options.local) doctor.push('--check-gpt');
  if (options.data) doctor.push('--data-dir', options.data);
  emit('runtime_ready', {platform: platform, version: spec.version, cliPath: receipt.cliPath, resourcePath: receipt.resourcePath,
    runtimePath: ready.destination, installed: true, unchanged: ready.unchanged, prepareCommand: prepare, doctorCommand: doctor});
  if (options.print || options.test) return 0;
  verifyTree(ready.destination, spec, receipt);
  var prepared = task(receipt.cliPath, prepare.slice(1), false); if (prepared.code) return prepared.code;
  verifyTree(ready.destination, spec, receipt);
  return task(receipt.cliPath, doctor.slice(1), false).code;
}
function run(argv) {
  var code = 1;
  try { code = main(argv); }
  catch (error) {
    var testMode = argv.indexOf('--test-mode') !== -1;
    emit('needs_attention', {code: error.bootstrapCode || 'bootstrap_failed',
      message: error.bootstrapCode ? error.message : 'Native CLI preparation failed; existing files and download evidence were preserved.'});
    if (testMode && !error.bootstrapCode) emit('test_diagnostic', {message: String(error)});
  }
  $.exit(code);
}
JXA
