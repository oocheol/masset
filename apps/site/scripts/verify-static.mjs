import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pages = [
  { file: 'index.html', language: 'ko', canonical: 'https://treeset.win/', content: ['게임 에셋 제작', '사업자등록 전', '2026년 10월', 'Claude 연동 계획', '/about/'] },
  { file: 'about/index.html', language: 'en', canonical: 'https://treeset.win/about/', content: ['A local workbench', 'October 2026', 'pre-incorporation', 'No external investment', 'not available in the current product', 'id="claude-plan"'] },
];
const reports = [];
for (const page of pages) {
  const html = await fs.readFile(path.join(dist, page.file), 'utf8');
  assert.ok(html.includes(`<html lang="${page.language}">`));
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, 'One primary heading per page');
  assert.equal((html.match(/rel="canonical"/g) ?? []).length, 1, 'One canonical URL');
  assert.ok(html.includes(`rel="canonical" href="${page.canonical}"`));
  assert.ok(html.includes('oocheol@treeset.win') && html.includes('https://github.com/oocheol'));
  assert.ok(html.includes('examples/procedural') && html.includes('releases/'));
  assert.ok(!html.includes('<div id="root"></div>'), 'Body must not depend on JavaScript to appear');
  for (const text of page.content) assert.ok(html.includes(text), `Missing public content: ${text}`);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.ok(/\bsrc="\/assets\/[^"<>]+\.js"/.test(match[1]), 'Only a local browser bundle may execute');
    assert.equal(match[2].trim(), '', 'No inline script requiring a weaker CSP');
  }
  assert.ok(!html.match(/\bstyle\s*=/i), 'No inline style requiring a weaker CSP');
  const localUrls = Array.from(html.matchAll(/\b(?:src|href)="([^"#]+)"/g), match => match[1]);
  let resources = 0;
  for (const url of new Set(localUrls.filter(url => url.startsWith('/assets/') || url.startsWith('/media/') || url === '/favicon.svg'))) {
    const resource = path.resolve(dist, url.slice(1));
    assert.ok(resource.startsWith(dist + path.sep));
    assert.ok((await fs.stat(resource)).size > 0, `Local resource missing: ${url}`);
    resources++;
  }
  reports.push({ page: page.canonical, htmlBytes: Buffer.byteLength(html), localResources: resources });
}
await assert.rejects(fs.stat(path.join(dist, 'entry-server.js')), { code: 'ENOENT' });
await assert.rejects(fs.stat(path.join(dist, '.ssr-build')), { code: 'ENOENT' });
const sitemap = await fs.readFile(path.join(dist, 'sitemap.xml'), 'utf8');
for (const page of pages) assert.ok(sitemap.includes(`<loc>${page.canonical}</loc>`));
console.log(JSON.stringify({ staticContentVerified: true, preservedCsp: true, serverBundlePublic: false, pages: reports }));
