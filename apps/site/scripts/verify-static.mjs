import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pages = [
  { file: 'index.html', language: 'ko', canonical: 'https://treeset.win/', content: ['게임 에셋 제작', '사업자등록 전', '2026년 10월', 'JEONG WOOCHEOL', 'Java 개발 경력 5년 차', '0.1.13 설치 파일에는', '/about/'] },
  { file: 'about/index.html', language: 'en', canonical: 'https://treeset.win/about/', content: ['A local workbench', 'October 2026', 'pre-incorporation', 'No external investment', 'JEONG WOOCHEOL', 'Java developer in his fifth year', '0.1.13 installers do not include', 'id="claude-plan"', 'id="developer"', 'id="local-workflow"'] },
  { file: 'workflows/claude-asset-brief/index.html', language: 'en', canonical: 'https://treeset.win/workflows/claude-asset-brief/', content: ['A game brief, ready', 'individual asset instructions', 'Published 0.1.13 installers do not include', 'id="input"', 'id="output"', 'id="scope"', 'no paid API fallback'] },
];
const reports = [];
for (const page of pages) {
  const html = await fs.readFile(path.join(dist, page.file), 'utf8');
  assert.ok(html.includes(`<html lang="${page.language}">`));
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, 'One primary heading per page');
  assert.equal((html.match(/rel="canonical"/g) ?? []).length, 1, 'One canonical URL');
  assert.ok(html.includes(`rel="canonical" href="${page.canonical}"`));
  assert.ok(html.includes('oocheol@treeset.win') && html.includes('https://github.com/oocheol'));
  if (page.file === 'workflows/claude-asset-brief/index.html') assert.ok(html.includes('/about/#local-workflow') && html.includes('/#desktop'));
  else assert.ok(html.includes('examples/procedural') && html.includes('releases/'));
  assert.ok(!html.includes('<div id="root"></div>'), 'Body must not depend on JavaScript to appear');
  for (const text of page.content) assert.ok(html.includes(text), `Missing public content: ${text}`);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.ok(/\bsrc="\/assets\/[^"<>]+\.js"/.test(match[1]), 'Only a local browser bundle may execute');
    assert.equal(match[2].trim(), '', 'No inline script requiring a weaker CSP');
  }
  assert.ok(!html.match(/\bstyle\s*=/i), 'No inline style requiring a weaker CSP');
  const localUrls = Array.from(html.matchAll(/\b(?:src|href)="([^"#]+)"/g), match => match[1]);
  let resources = 0;
  for (const url of new Set(localUrls.filter(url => url.startsWith('/assets/') || url.startsWith('/media/') || url.startsWith('/examples/') || url === '/favicon.svg'))) {
    const resource = path.resolve(dist, url.slice(1));
    assert.ok(resource.startsWith(dist + path.sep));
    assert.ok((await fs.stat(resource)).size > 0, `Local resource missing: ${url}`);
    resources++;
  }
  reports.push({ page: page.canonical, htmlBytes: Buffer.byteLength(html), localResources: resources });
}
const { claudeDevelopmentEvidence, claudeProof, claudePrototypeImplemented, localWorkflowProof } = await import(pathToFileURL(path.join(root, '.ssr-build/entry-server.js')).href);
const artifactReports = [];
async function verifyArtifact(artifact, prefix) {
  assert.ok(artifact.label && typeof artifact.label === 'string');
  assert.ok(artifact.href.startsWith(prefix) && /^\/[a-zA-Z0-9/_\-.]+$/.test(artifact.href), 'Evidence must be an explicit local public artifact');
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/, 'Evidence must record a SHA-256');
  const absolute = path.resolve(dist, artifact.href.slice(1));
  assert.ok(absolute.startsWith(dist + path.sep), 'Evidence must stay in the public output');
  const bytes = await fs.readFile(absolute);
  assert.ok(bytes.length > 0);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256, `Evidence hash mismatch: ${artifact.href}`);
  if (artifact.href.endsWith('.json')) JSON.parse(bytes.toString('utf8'));
  artifactReports.push({ file: artifact.href, bytes: bytes.length });
}
function verifyChecks(checks) {
  assert.ok(Array.isArray(checks) && checks.length > 0, 'Evidence must state its actual verification scope');
  for (const check of checks) {
    assert.ok(check.label && check.detail);
    assert.ok(['passed', 'limited'].includes(check.result));
  }
}
if (claudeProof) {
  assert.equal(claudePrototypeImplemented, true, 'A live example requires a checked implementation');
  assert.equal(claudeProof.schemaVersion, 1);
  assert.ok(claudeProof.platform && claudeProof.cliVersion && Number.isFinite(Date.parse(claudeProof.verifiedAt)));
  assert.ok(claudeProof.input.brief && claudeProof.input.artDirection);
  assert.ok(claudeProof.plan.assets.length >= 1 && claudeProof.plan.assets.length <= 12);
  assert.equal(new Set(claudeProof.plan.assets.map(asset => asset.name)).size, claudeProof.plan.assets.length);
  for (const asset of claudeProof.plan.assets) {
    assert.ok(asset.name && asset.purpose && asset.prompt);
    assert.ok(['sprite', 'texture', 'model', 'image'].includes(asset.kind));
    assert.ok(asset.acceptanceChecks.length > 0 && asset.acceptanceChecks.every(check => typeof check === 'string' && check.trim()));
  }
  assert.ok(claudeProof.plan.reviewChecklist.length > 0);
  verifyChecks(claudeProof.checks);
  for (const name of ['input.json', 'plan.json', 'verification.json']) assert.ok(claudeProof.artifacts.some(artifact => artifact.href.endsWith(`/${name}`)));
  for (const artifact of claudeProof.artifacts) await verifyArtifact(artifact, '/examples/claude-brief/');
} else {
  const workflowHtml = await fs.readFile(path.join(dist, 'workflows/claude-asset-brief/index.html'), 'utf8');
  assert.ok(workflowHtml.includes('live verification pending'));
  assert.ok(workflowHtml.includes('There is no Claude output to download yet'));
  assert.ok(!workflowHtml.includes('/examples/claude-brief/plan.json'), 'Pending verification cannot publish a generated plan');
}
if (claudeDevelopmentEvidence) {
  assert.equal(claudePrototypeImplemented, true, 'A local prototype record requires a checked implementation');
  assert.equal(claudeDevelopmentEvidence.schemaVersion, 1);
  assert.equal(claudeDevelopmentEvidence.authStatus, 'subscription-unavailable');
  assert.ok(claudeDevelopmentEvidence.platform && claudeDevelopmentEvidence.cliVersion && Number.isFinite(Date.parse(claudeDevelopmentEvidence.checkedAt)));
  assert.ok(claudeDevelopmentEvidence.input.brief && claudeDevelopmentEvidence.input.artDirection);
  verifyChecks(claudeDevelopmentEvidence.checks);
  for (const name of ['input.json', 'verification.json']) assert.ok(claudeDevelopmentEvidence.artifacts.some(artifact => artifact.href.endsWith(`/${name}`)));
  for (const artifact of claudeDevelopmentEvidence.artifacts) {
    assert.ok(!artifact.href.endsWith('/plan.json'), 'A blocked request cannot have a generated plan');
    await verifyArtifact(artifact, '/examples/claude-brief/');
  }
}
if (localWorkflowProof) {
  assert.equal(localWorkflowProof.schemaVersion, 1);
  assert.ok(localWorkflowProof.platform && localWorkflowProof.runtime && Number.isFinite(Date.parse(localWorkflowProof.verifiedAt)));
  assert.ok(localWorkflowProof.input.brief && localWorkflowProof.input.artDirection);
  assert.ok(localWorkflowProof.outputs.length > 0 && localWorkflowProof.outputs.length <= 12);
  verifyChecks(localWorkflowProof.checks);
  for (const output of localWorkflowProof.outputs) {
    assert.ok(output.name && output.parameters && output.preview.startsWith('/examples/local-prop-kit/'));
    assert.ok(output.files.length > 0);
    for (const file of output.files) await verifyArtifact(file, '/examples/local-prop-kit/');
  }
  for (const name of ['input.json', 'verification.json']) assert.ok(localWorkflowProof.artifacts.some(artifact => artifact.href.endsWith(`/${name}`)));
  for (const artifact of localWorkflowProof.artifacts) await verifyArtifact(artifact, '/examples/local-prop-kit/');
}
await assert.rejects(fs.stat(path.join(dist, 'entry-server.js')), { code: 'ENOENT' });
await assert.rejects(fs.stat(path.join(dist, '.ssr-build')), { code: 'ENOENT' });
const sitemap = await fs.readFile(path.join(dist, 'sitemap.xml'), 'utf8');
for (const page of pages) assert.ok(sitemap.includes(`<loc>${page.canonical}</loc>`));
console.log(JSON.stringify({ staticContentVerified: true, preservedCsp: true, serverBundlePublic: false, claudeLiveProof: Boolean(claudeProof), claudeLocalProbe: Boolean(claudeDevelopmentEvidence), localWorkflowProof: Boolean(localWorkflowProof), evidenceArtifacts: artifactReports, pages: reports }));
