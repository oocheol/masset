// Read-only check of Tauri's intentional portable -> NSIS bundle stamp.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
assert.equal(process.argv.length,4,'Usage: verify-windows-bundle-marker.mjs <portable.exe> <installed.exe>');
const source=readFileSync(process.argv[2]),installed=readFileSync(process.argv[3]);
const marker=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const offset=source.indexOf(marker);
assert.ok(offset>=0,'Portable Tauri marker missing');
assert.equal(source.indexOf(marker,offset+1),-1,'Portable marker must be unique');
const expected=Buffer.from(source);
Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS').copy(expected,offset);
assert.ok(expected.equals(installed),'Installed bytes differ beyond the exact Tauri NSIS stamp');
const hash=data=>createHash('sha256').update(data).digest('hex');
console.log(JSON.stringify({verified:true,sourceSha256:hash(source),installedSha256:hash(installed),
  bytes:installed.length,markerOffset:offset,onlyChange:'__TAURI_BUNDLE_TYPE_VAR_UNK -> __TAURI_BUNDLE_TYPE_VAR_NSS',
  scope:'Exact byte comparison with one official Tauri bundle-type stamp; no execution or source modification'},null,2));
