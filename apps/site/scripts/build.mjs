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

const aboutTitle = 'Treeset — Asset Studio | Project overview';
const aboutDescription = 'Treeset is an independent, pre-incorporation creative-tools project developing Asset Studio, an open-source game asset workbench. Meet the maintainer, inspect real outputs, download releases and read the Claude integration roadmap.';
let about = template
  .replace('<html lang="ko">', '<html lang="en">')
  .replace(/<title>[^<]*<\/title>/, `<title>${aboutTitle}</title>`)
  .replace(/(<meta name="description" content=")[^"]*("\s*\/?>)/, `$1${aboutDescription}$2`)
  .replace(/(<link rel="canonical" href=")[^"]*("\s*\/?>)/, '$1https://treeset.win/about/$2')
  .replace(/(<meta property="og:url" content=")[^"]*("\s*\/?>)/, '$1https://treeset.win/about/$2')
  .replace(/(<meta property="og:locale" content=")[^"]*("\s*\/?>)/, '$1en_US$2')
  .replace(/(<meta (?:property="og:title"|name="twitter:title") content=")[^"]*("\s*\/?>)/g, `$1${aboutTitle}$2`)
  .replace(/(<meta (?:property="og:description"|name="twitter:description") content=")[^"]*("\s*\/?>)/g, `$1${aboutDescription}$2`)
  .replace(rootSlot, () => `<div id="root">${render('/about/')}</div>`);
if (!about.includes('id="claude-plan"') || !home.includes('oocheol@treeset.win')) throw new Error('Public project content missing from static render');
await fs.mkdir(path.join(dist, 'about'), { recursive: true });
await fs.writeFile(path.join(dist, 'about/index.html'), about);
console.log(JSON.stringify({ staticPages: ['/', '/about/'], providerRequests: 0, serverBundlePublic: false, htmlBytes: { home: Buffer.byteLength(home), about: Buffer.byteLength(about) } }));
