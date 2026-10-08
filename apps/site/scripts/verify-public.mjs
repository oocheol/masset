import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = new URL(process.argv[2] ?? 'https://treeset.win');
assert.ok(base.protocol === 'https:' || base.hostname === '127.0.0.1');
const requiredPages = [
  ['/', '설치 없이 웹 데모 체험'], ['/about/', 'Play without installing'],
  ['/play/workshop/', '작은 세계를 켜보세요'], ['/play/workshop/en/', 'playable world'],
  ['/devlog/workshop/', 'From three GLBs'], ['/workflows/claude-asset-brief/', 'live verification pending'],
];
const urls = new Set(['/examples/workshop/scene.json', '/examples/workshop/manifest.json', '/examples/workshop/README.md', '/examples/workshop-starter.zip', '/robots.txt', '/sitemap.xml']);
const pages = await Promise.all(requiredPages.map(async ([pathname, text]) => {
  const response = await fetch(new URL(pathname, base), { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, pathname);
  const html = await response.text(); assert.ok(html.includes(text), pathname);
  assert.ok(html.includes(`rel="canonical" href="https://treeset.win${pathname}"`));
  assert.ok(!html.includes('<div id="root"></div>'));
  if (base.protocol === 'https:') assert.ok(response.headers.get('content-security-policy')?.includes("script-src 'self'"), 'Production CSP');
  for (const match of html.matchAll(/\b(?:src|href)="([^"#]+)"/g)) if (/^\/(assets|media|examples)\//.test(match[1])) urls.add(match[1]);
  return { pathname, status: response.status, htmlBytes: Buffer.byteLength(html), canonical: `https://treeset.win${pathname}`, csp: response.headers.get('content-security-policy') };
}));
// The Three.js chunk is lazy and therefore not a static HTML script element.
for (const filename of await fs.readdir(path.join(root, 'dist/assets'))) if (filename.endsWith('.js')) urls.add(`/assets/${filename}`);
const resources = await Promise.all(Array.from(urls).map(async pathname => {
  const response = await fetch(new URL(pathname, base), { signal: AbortSignal.timeout(25000) });
  assert.equal(response.status, 200, pathname);
  const bytes = Buffer.from(await response.arrayBuffer()), local = await fs.readFile(path.join(root, 'dist', pathname.slice(1)));
  assert.ok(bytes.equals(local), `Public bytes differ: ${pathname}`);
  return { pathname, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'dist/examples/workshop-starter.zip')));
const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
for (const file of manifest.files) {
  const bytes = await zip.file(file.file).async('nodebuffer');
  assert.equal(bytes.length, file.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}
const { importScene } = await import('../src/workshop/state.ts');
assert.equal(importScene(await zip.file('scene.json').async('string')).length, 3);
const receipt = { checkedAt: new Date().toISOString(), baseUrl: base.origin, scope: 'HTTP initial HTML, CSP, exact public bytes, ZIP inventory and scene format; browser interaction checked separately', pages, resources, archiveFilesMatched: manifest.files.length, providerRequests: 0 };
if (process.argv[3]) await fs.writeFile(process.argv[3], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ baseUrl: receipt.baseUrl, pages: pages.length, exactPublicResources: resources.length, archiveFilesMatched: manifest.files.length, allPassed: true }));
