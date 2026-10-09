import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'vite';
import './package-workshop.mjs';
import './verify-synthetic.mjs';

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
  { pathname: '/terms/', language: 'ko', title: 'Treeset — Asset Studio | 이용약관', description: 'Treeset 공개 도구·예제·다운로드의 이용 조건, 라이선스, 외부 서비스와 가상 기록의 범위.', requiredContent: ['id="document-main"', '이용약관', 'JEONG WOOCHEOL'] },
  { pathname: '/terms/en/', language: 'en', title: 'Treeset — Asset Studio | Terms of use', description: 'Terms for the Treeset public tools, examples and contact channel, with separate software licenses and external-provider conditions.', requiredContent: ['id="document-main"', 'Terms of use', 'JEONG WOOCHEOL'] },
  { pathname: '/privacy/', language: 'ko', title: 'Treeset — Asset Studio | 개인정보처리방침', description: '브라우저 저장, 문의, 로컬 앱과 외부 제공자에서 처리하는 정보를 구분한 Treeset 개인정보 안내.', requiredContent: ['id="document-main"', '개인정보처리방침', 'treeset.workshop.layout.v1'] },
  { pathname: '/privacy/en/', language: 'en', title: 'Treeset — Asset Studio | Privacy notice', description: 'How Treeset distinguishes site information, browser storage, contact email, local app data and optional external-provider connections.', requiredContent: ['id="document-main"', 'Privacy notice', 'treeset.workshop.layout.v1'] },
  { pathname: '/research/claude-scenarios/', language: 'ko', title: 'Treeset — Asset Studio | 가상 테스트 예시', description: '여섯 가상 제작 역할의 요청·작성된 계획·검수 기준. 실제 고객, Claude 실행 또는 실측 성능을 주장하지 않는 개발 예시.', requiredContent: ['id="research-main"', 'Claude를 호출하지 않았습니다', 'SIM-06'] },
  { pathname: '/research/claude-scenarios/en/', language: 'en', title: 'Treeset — Asset Studio | Synthetic evaluation examples', description: 'Six fictional asset-production roles with authored requests, illustrative plans and evaluation targets. No real participants or Claude execution.', requiredContent: ['id="research-main"', 'Claude was not called', 'SIM-06'] },
  { pathname: '/play/workshop/', language: 'ko', title: 'Treeset — Asset Studio | 작은 작업장 웹 데모', description: '실제 로컬 GLB로 만든 작은 작업장을 설치 없이 체험하세요. 이동·셀 수집·소품 배치·장면 JSON 저장과 다시 열기.', requiredContent: ['id="workshop-main"', '데모 시작', '/examples/workshop-starter.zip'] },
  { pathname: '/play/workshop/en/', language: 'en', title: 'Treeset — Asset Studio | Playable workshop example', description: 'Try a developer-made workshop using actual local Blender GLBs. Move, collect cells, arrange props and save an editable scene, with no installation.', requiredContent: ['id="workshop-main"', 'Start the demo', '/examples/workshop-starter.zip'] },
  { pathname: '/devlog/workshop/', language: 'en', title: 'Treeset — Asset Studio | From GLBs to a playable workshop', description: 'Inspect the developer example: three real local props, a playable web scene, editable layout, original source files and SHA-256 records.', requiredContent: ['id="story-main"', 'From three GLBs', 'Live Claude execution remains pending'] },
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
    .replace('<html lang="ko">', `<html lang="${page.language ?? 'en'}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${page.title}</title>`)
    .replace(/(<meta name="description" content=")[^"]*("\s*\/?>)/, `$1${page.description}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*("\s*\/?>)/, `$1${canonical}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*("\s*\/?>)/, `$1${canonical}$2`)
    .replace(/(<meta property="og:locale" content=")[^"]*("\s*\/?>)/, `$1${page.language === 'ko' ? 'ko_KR' : 'en_US'}$2`)
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
