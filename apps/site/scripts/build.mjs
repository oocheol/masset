import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
// Server code stays outside the public output. The deployment receives only
// static HTML and browser assets; the build never invokes an AI provider.
const serverOutput = path.join(root, '.ssr-build');
await build({ root });
await build({ root, build: { ssr: path.join(root, 'src/entry-server.tsx'), outDir: serverOutput, emptyOutDir: true } });
const { render } = await import(pathToFileURL(path.join(serverOutput, 'entry-server.js')).href);
const template = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
const rootSlot = '<div id="root"></div>';
if (template.split(rootSlot).length !== 2) throw new Error('Static render requires exactly one root placeholder');
const home = template.replace(rootSlot, () => `<div id="root">${render('/')}</div>`);
await fs.writeFile(path.join(dist, 'index.html'), home);

const pages = [
  {
    pathname: '/about/',
    title: 'Treeset — Asset Studio | Project overview',
    description: 'Meet JEONG WOOCHEOL, a Java developer in his fifth year maintaining Treeset and Asset Studio. Inspect real local outputs, published releases and the Claude asset-planning source prototype.',
    requiredContent: ['id="claude-plan"', 'id="developer"', 'id="local-workflow"'],
  },
  {
    pathname: '/workflows/claude-asset-brief/',
    title: 'Treeset — Asset Studio | Claude asset-planning prototype',
    description: 'Inspect the Asset Studio source prototype for game briefs, individual asset instructions and review checks. Its development status and provider verification scope are separate from published 0.1.13 installers.',
    requiredContent: ['id="workflow-main"', 'id="input"', 'id="scope"', 'Published 0.1.13 installers do not include'],
  },
];
const htmlBytes = { '/': Buffer.byteLength(home) };
for (const page of pages) {
  const canonical = `https://treeset.win${page.pathname}`;
  const html = template
    .replace('<html lang="ko">', '<html lang="en">')
    .replace(/<title>[^<]*<\/title>/, `<title>${page.title}</title>`)
    .replace(/(<meta name="description" content=")[^"]*("\s*\/?>)/, `$1${page.description}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*("\s*\/?>)/, `$1${canonical}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*("\s*\/?>)/, `$1${canonical}$2`)
    .replace(/(<meta property="og:locale" content=")[^"]*("\s*\/?>)/, '$1en_US$2')
    .replace(/(<meta (?:property="og:title"|name="twitter:title") content=")[^"]*("\s*\/?>)/g, `$1${page.title}$2`)
    .replace(/(<meta (?:property="og:description"|name="twitter:description") content=")[^"]*("\s*\/?>)/g, `$1${page.description}$2`)
    .replace(rootSlot, () => `<div id="root">${render(page.pathname)}</div>`);
  if (page.requiredContent.some(content => !html.includes(content))) throw new Error(`Public content missing from static render: ${page.pathname}`);
  const outputDirectory = path.join(dist, page.pathname.slice(1));
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, 'index.html'), html);
  htmlBytes[page.pathname] = Buffer.byteLength(html);
}
if (!home.includes('oocheol@treeset.win')) throw new Error('Public contact missing from static home render');
console.log(JSON.stringify({ staticPages: ['/', ...pages.map(page => page.pathname)], providerRequests: 0, serverBundlePublic: false, htmlBytes }));
