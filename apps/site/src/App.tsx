import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, BookOpen, Box, Check, ChevronDown, Copy, Expand, FileImage, FolderOpen, Github, Layers, Mail, Monitor, ShieldCheck, Terminal, Workflow, X } from 'lucide-react';
import { macInstallCommand, macReleases, release } from './release';
import { faqs, models, npmInstallCommand, projectFacts, skillDownloadUrl, skillInstallCommand, skillPackageVersion, skillUpdateCommand, skillVersion, sourceUrl, statuses } from './content';
import { claudePublicationStatus, claudeWorkflowPath } from './claudeProof';
import WorkshopTeaser from './workshop/WorkshopTeaser';
import SiteFooterLinks from './SiteFooterLinks';
import { ResearchTeaser } from './ResearchExamples';

const releaseUrl = sourceUrl + '/releases/tag/v' + release.version;
const latestReleaseUrl = sourceUrl + '/releases/latest';
const downloadUrl = sourceUrl + '/releases/download/v' + release.version + '/' + release.filename;
const portableUrl = sourceUrl + '/releases/download/v' + release.version + '/' + release.portableFilename;
const mac = macReleases[0];
type Preview = { title: string; src: string; alt: string; caption: string; kind: 'render' | 'screen' };

export function TreesetMark({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 44 44" fill="none" aria-hidden="true">
    <path d="M22 37V22M22 22 9 14M22 22l13-8M9 14V7m26 7V7M22 22V7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m4 10 5-3 5 3M30 10l5-3 5 3M17 10l5-3 5 3" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m15 37 7 4 7-4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

function CopyText({ text, label, compact = false }: { text: string; label: string; compact?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const content = useRef<HTMLElement>(null);
  const statusId = useId();
  async function copy() {
    try { await navigator.clipboard.writeText(text); setState('copied'); }
    catch {
      if (content.current) {
        const range = document.createRange();
        range.selectNodeContents(content.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setState('failed');
    }
  }
  return <div className={'copy-block' + (compact ? ' copy-block-compact' : '')}>
    <div className="copy-heading"><span>{label}</span><button type="button" onClick={copy} aria-label={label + ' 복사'} aria-describedby={statusId}>
      {state === 'copied' ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
      {state === 'copied' ? '복사됨' : '복사'}
    </button></div>
    <pre><code ref={content}>{text}</code></pre>
    <p id={statusId} className="copy-status" role="status" aria-live="polite">{state === 'copied' ? '복사했습니다. 터미널이나 검증 도구에 붙여 넣으세요.' : state === 'failed' ? '텍스트를 선택했습니다. Ctrl+C 또는 ⌘C로 직접 복사하세요.' : ''}</p>
  </div>;
}

function SourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="text-link" href={href}>{children}<ArrowUpRight size={17} aria-hidden="true" /></a>;
}

export default function App() {
  const claudeStatus = claudePublicationStatus();
  const [activeModel, setActiveModel] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewDialog = useRef<HTMLDialogElement>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const model = models[activeModel];

  useEffect(() => {
    if (preview && previewDialog.current && !previewDialog.current.open) previewDialog.current.showModal();
    document.body.classList.toggle('modal-open', Boolean(preview));
    return () => document.body.classList.remove('modal-open');
  }, [preview]);

  function openPreview(item: Preview, trigger: HTMLButtonElement) {
    previewTrigger.current = trigger;
    setPreview(item);
  }
  function renderPreview(index: number): Preview {
    const item = models[index];
    return { title: item.name + ' / ' + item.type, src: item.src, alt: item.name + '를 Blender 절차형 작업자로 제작한 실제 3D 렌더', caption: '고정 레시피로 만든 실제 GLB·Blender 원본의 렌더입니다. GPT 생성이나 이미지→3D 결과 예시가 아닙니다.', kind: 'render' };
  }

  return <>
    <a className="skip-link" href="#main">본문으로 이동</a>
    <header className="site-header"><div className="page-width header-inner">
      <a className="wordmark" href="#top" aria-label="Treeset 첫 화면"><TreesetMark /><span>Treeset</span></a>
      <nav className="main-nav" aria-label="주요 메뉴"><a href="#product">Asset Studio</a><a href="/play/workshop/">웹 데모</a><a href="#outputs">결과 예시</a><a href="#guide">사용 가이드</a><a href="/about/" lang="en">Project overview</a></nav>
      <a className="header-start" href="#start">시작하기<ArrowDownToLine size={17} aria-hidden="true" /></a>
    </div></header>

    <main id="main">
      <section id="top" className="hero page-width" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="product-name"><span className="product-symbol"><Layers size={21} aria-hidden="true" /></span>Asset Studio</p>
          <h1 id="hero-title">게임 에셋 제작,<br />이미지에서 3D까지.</h1>
          <p className="hero-description">인디 게임 개발자와 소규모 제작팀을 위한 작업대입니다. Codex로 이미지를 만들고, 로컬에서 3D 모델·스프라이트를 다듬어 내보내세요.</p>
          <p className="hero-english" lang="en">A local-first game asset workspace for indie developers and small teams.</p>
          <div className="hero-actions"><a className="button button-primary" href="#download-skill"><Terminal size={19} aria-hidden="true" />Codex에서 시작</a><a className="button button-secondary" href="#desktop"><ArrowDownToLine size={19} aria-hidden="true" />앱 다운로드</a></div>
          <p className="hero-platforms">Windows x64 / Apple Silicon Mac</p>
          <div className="hero-principle"><ShieldCheck size={18} aria-hidden="true" /><span>원본은 그대로. 결과는 새 버전으로.</span></div>
          <div className="hero-evidence"><a className="text-link" href="/play/workshop/">설치 없이 웹 데모 체험<ArrowUpRight size={17} aria-hidden="true" /></a><SourceLink href={releaseUrl}>공개 릴리스 {release.version}</SourceLink></div>
        </div>
        <figure className="hero-artifact">
          <div className="artifact-topline"><span><Box size={17} aria-hidden="true" />로컬 제작 예시</span><span>Blender 렌더</span></div>
          <div className="artifact-stage">
            <svg className="artifact-routes" viewBox="0 0 500 390" fill="none" aria-hidden="true"><path d="M250 12v38m0 292v34M26 196h42m364 0h42M80 64h54M366 64h54M80 328h54M366 328h54" stroke="currentColor" strokeWidth="1" /><path d="m24 92 38-22h68m240 0h68l38 22M24 292l38 22h68m240 0h68l38-22" stroke="currentColor" strokeWidth="1" /><circle cx="250" cy="16" r="4" /><circle cx="250" cy="374" r="4" /></svg>
            <img src={model.src} width="512" height="512" alt={model.name + '의 실제 Blender 작업자 3D 렌더'} fetchPriority="high" />
            <div className="artifact-coordinate"><span>{model.type}</span><span>{model.material}</span></div>
          </div>
          <div className="artifact-output"><span><Check size={16} aria-hidden="true" />산출물</span><span>model.glb</span><span>source.blend</span></div>
          <div className="artifact-picker" role="group" aria-label="실제 렌더 예시 선택">{models.map((item, index) => <button key={item.type} type="button" aria-pressed={index === activeModel} onClick={() => setActiveModel(index)}><img src={item.src} width="38" height="38" alt="" /><span>{item.name}</span>{index === activeModel && <Check size={16} aria-hidden="true" />}</button>)}</div>
          <figcaption>절차형 소품 작업자의 실제 결과. 입력 이미지 기반 3D 예시와 구분합니다.</figcaption>
        </figure>
      </section>

      <WorkshopTeaser />
      <ResearchTeaser />
      <div className="capability-strip"><div className="page-width"><p><FileImage size={20} aria-hidden="true" />2D 이미지</p><p><Box size={20} aria-hidden="true" />3D 모델</p><p><Workflow size={20} aria-hidden="true" />개별 제작·작업 큐</p><p><FolderOpen size={20} aria-hidden="true" />내 프로젝트에 저장</p></div></div>

      <section id="product" className="product-section section-space page-width" aria-labelledby="product-title">
        <div className="section-heading"><div><h2 id="product-title">제작에서 검수까지,<br />한 작업대에서.</h2></div><p>무엇이 필요한지 정하고, 결과를 살펴보고,<br className="wide-break" /> 마음에 드는 파일을 프로젝트에 남기세요.</p></div>
        <figure className="workspace-figure">
          <div className="workspace-bar"><span><Layers size={19} aria-hidden="true" />Asset Studio 작업 공간</span><span>브라우저 UI 미리보기</span></div>
          <button className="workspace-preview" type="button" aria-label="Asset Studio 작업 공간 화면 확대" onClick={event => openPreview({ title: 'Asset Studio 작업 공간', src: '/media/workstation-browser-013.png', alt: '에셋 라이브러리와 편집 도구, 개별 결과와 작업 큐가 보이는 Asset Studio 브라우저 미리보기', caption: '브라우저 UI 미리보기입니다. 네이티브 앱의 실행·생성 검증은 플랫폼별 기록에서 확인하세요.', kind: 'screen' }, event.currentTarget)}>
            <img src="/media/workstation-browser-013.png" width="1500" height="960" alt="Asset Studio 브라우저 UI 미리보기. 에셋 라이브러리, 이미지 캔버스, 3D 뷰포트, 버전 비교와 작업 큐." loading="lazy" />
            <span className="expand-label"><Expand size={17} aria-hidden="true" />화면 확대</span>
          </button>
          <figcaption><span>라이브러리, 편집 도구, 버전 비교와 제작 큐를 연결합니다.</span><a href="#verification">실제 검증 범위<ChevronDown size={16} aria-hidden="true" /></a></figcaption>
        </figure>
        <div className="product-tools">
          <article><FileImage size={25} aria-hidden="true" /><h3>이미지에서 게임 에셋으로</h3><p>로컬 편집부터 스프라이트·아틀라스까지. 각 이미지와 메타데이터를 독립 파일로 내보냅니다.</p><span>PNG / 스프라이트 / 아틀라스</span></article>
          <article><Box size={25} aria-hidden="true" /><h3>이미지에서 입체로</h3><p>로컬 이미지→3D와 Blender 소품 제작. 형태와 UV를 다듬고 게임 엔진에서 사용할 결과를 검수합니다.</p><span>GLB / LOD / .blend / 텍스처</span></article>
          <article><Layers size={25} aria-hidden="true" /><h3>하나씩 만들고, 함께 관리</h3><p>작업 큐에서 개별 에셋의 진행과 결과를 확인합니다. 이전 결과를 보존하고 필요한 항목을 다시 제작합니다.</p><span>작업 큐 / 버전 비교 / 개별 내보내기</span></article>
        </div>
      </section>

      <section className="workflow-section" aria-labelledby="workflow-title"><div className="page-width workflow-layout">
        <div><Workflow size={28} className="section-icon" aria-hidden="true" /><h2 id="workflow-title">설명은 하나.<br />결과는 에셋마다.</h2><p>게임 프로젝트에서 필요한 파일을 정리하고, 제작 목록을 확인한 뒤 시작합니다.</p><SourceLink href={sourceUrl + '/blob/master/docs/game-production.md'}>프로젝트 제작 흐름</SourceLink></div>
        <ol className="workflow-steps">
          <li><span className="step-number">1</span><div><h3>프로젝트와 방향을 연결</h3><p>게임 폴더, 장르, 배경, 스타일과 참고 자료를 정합니다.</p></div></li>
          <li><span className="step-number">2</span><div><h3>필요한 제작 목록을 검수</h3><p>이름과 설명이 다른 개별 이미지·3D 모델을 확인하고 작업 큐에 제출합니다.</p></div></li>
          <li><span className="step-number">3</span><div><h3>결과를 확인하고 내보내기</h3><p>형태·텍스처·크기를 검수하고 필요한 파일만 저장합니다. 원본은 보존합니다.</p></div></li>
        </ol>
      </div></section>

      <section id="outputs" className="outputs-section section-space page-width" aria-labelledby="outputs-title">
        <div className="section-heading"><div><h2 id="outputs-title">파일로 남는 결과.</h2><p className="heading-description">실제 Blender 작업자가 만든 기본 소품을 살펴보세요.</p></div><SourceLink href={sourceUrl + '/tree/master/examples/procedural'}>원본·GLB·검증 기록</SourceLink></div>
        <div className="model-gallery">{models.map((item, index) => <figure key={item.type}>
          <button className="model-preview" type="button" aria-label={item.name + ' 3D 렌더 확대'} onClick={event => openPreview(renderPreview(index), event.currentTarget)}><img src={item.src} alt={item.name + '의 실제 절차형 Blender 렌더'} width="512" height="512" loading="lazy" /><span><Expand size={18} aria-hidden="true" /></span></button>
          <figcaption><div><h3>{item.name}</h3><span>{item.type}</span></div><p>{item.description}</p><span className="output-format">GLB + .blend</span></figcaption>
        </figure>)}</div>
        <div className="output-context"><ShieldCheck size={22} aria-hidden="true" /><p>세 예시는 고정 레시피로 만든 소품입니다. 이미지→3D는 한 장에서 형태를 추정하며, 게임에서의 최종 검수가 필요합니다.</p><SourceLink href={sourceUrl + '/blob/master/docs/model-quality.md'}>3D 결과 안내</SourceLink></div>
      </section>

      <section id="start" className="start-section section-space" aria-labelledby="start-title"><div className="page-width">
        <div className="section-heading"><div><h2 id="start-title">작업하는 방식으로 시작하세요.</h2><p className="heading-description">Codex 스킬로 연결하거나, 데스크톱 앱을 열어 직접 제작하세요.</p></div><nav className="start-nav" aria-label="시작 방법"><a href="#download-skill">Codex 스킬</a><a href="#download-windows">Windows</a><a href="#download-mac">Mac</a></nav></div>
        <section id="download-skill" className="skill-panel" aria-labelledby="skill-title">
          <div className="skill-intro"><Terminal size={30} aria-hidden="true" /><h3 id="skill-title">Codex에 제작 도구를 더하세요.</h3><p>스킬만 설치해도 사용할 수 있습니다.<br />Asset Studio 앱을 따로 설치하거나 열 필요가 없습니다.</p><p className="skill-requirements">Codex / Node.js 22.20 이상<br />Windows x64 / Apple Silicon Mac</p></div>
          <div className="skill-command"><CopyText label="최신 양쪽 CLI를 위한 설치 명령" text={skillInstallCommand} /><p className="command-description">GitHub 공용 설치 패키지 {skillPackageVersion}이 Windows·Mac CLI {skillVersion}을 준비합니다. 첫 도구 다운로드는 동의를 받습니다.</p><div className="skill-links"><SourceLink href={sourceUrl + '/blob/master/docs/skill-first-setup.md'}>설치·요청 안내</SourceLink><SourceLink href="https://www.npmjs.com/package/@oocheol/asset-studio">npm 패키지</SourceLink><a className="text-link" href={skillDownloadUrl}><ArrowDownToLine size={16} aria-hidden="true" />스킬 ZIP {skillVersion}</a></div></div>
          <div className="skill-first-request"><span>설치한 뒤, 새 Codex 작업에서</span><code>$asset-studio 숲을 탐험하는 게임에 쓸 소품을 만들어줘.</code></div>
          <details className="skill-alternatives"><summary>npm의 짧은 설치 명령·업데이트·ZIP 설치</summary><div className="alternative-grid"><div><CopyText label="npm 레지스트리에서 설치" text={npmInstallCommand} compact /><p>현재 npm latest는 0.1.13입니다. 최신 Mac CLI까지 사용하려면 위의 GitHub 설치 패키지를 사용하세요.</p><p>전역 설치는 <code>npm install -g @oocheol/asset-studio</code> 후 <code>asset-studio-skill install</code>로 등록합니다.</p></div><div><CopyText label="설치한 스킬 업데이트" text={skillUpdateCommand} compact /><p>Node.js 없이 시작하려면 ZIP의 <code>skills/asset-studio</code> 폴더를 <code>~/.agents/skills</code>에 넣고 새 Codex 작업을 여세요.</p></div></div></details>
        </section>

        <div id="desktop" className="desktop-downloads">
          <section id="download-windows" className="desktop-platform" aria-labelledby="windows-title">
            <div className="platform-heading"><Monitor size={25} aria-hidden="true" /><span>Windows x64</span><span className="version-pill">v{release.version}</span></div><h3 id="windows-title">나의 Windows 작업대.</h3><p>제작 목록과 결과를 직접 다루는 데스크톱 앱.<br />Microsoft WebView2 Runtime이 필요합니다.</p><a className="button button-primary platform-download" href={downloadUrl}><ArrowDownToLine size={20} aria-hidden="true" />Windows 설치 파일</a><a className="portable-link" href={portableUrl}>포터블 ZIP<ArrowUpRight size={16} aria-hidden="true" /></a><p className="platform-caution">Windows 코드 서명이 없어 첫 실행 경고가 나타날 수 있습니다.</p>
            <details className="installation-details"><summary>설치 조건·용량·파일 검증<ChevronDown size={18} aria-hidden="true" /></summary><dl className="download-properties"><div><dt>앱 실행</dt><dd>Windows x64 / WebView2 Runtime</dd></div><div><dt>이미지→3D</dt><dd>16GB RAM / Blender 5.2.1 / Visual C++ x64 런타임</dd></div><div><dt>첫 3D 준비</dt><dd>동의 후 약 1.89GiB / Python 자동 준비</dd></div><div><dt>설치 파일</dt><dd>{release.filename}</dd></div><div><dt>용량</dt><dd>{release.bytes.toLocaleString('en-US')} bytes / {(release.bytes / 1_048_576).toFixed(2)} MiB</dd></div><div><dt>포터블</dt><dd>{release.portableBytes.toLocaleString('en-US')} bytes / {(release.portableBytes / 1_048_576).toFixed(2)} MiB</dd></div></dl><CopyText label="Windows 설치 파일 SHA-256" text={release.sha256} compact /><CopyText label="Windows 포터블 SHA-256" text={release.portableSha256} compact /><SourceLink href={releaseUrl}>공식 릴리스 기록</SourceLink></details>
          </section>
          {mac && <section id="download-mac" className="desktop-platform" aria-labelledby="mac-title">
            <div className="platform-heading"><Monitor size={25} aria-hidden="true" /><span>Apple Silicon Mac</span><span className="version-pill">v{mac.version}</span></div><h3 id="mac-title">나의 Mac 작업대.</h3><p>M 시리즈 Mac용 앱과 독립 CLI를 제공합니다.<br />Intel Mac 패키지는 제공하지 않습니다.</p><a className="button button-primary platform-download" href={mac.downloadUrl}><ArrowDownToLine size={20} aria-hidden="true" />Mac DMG 다운로드</a><a className="portable-link" href={sourceUrl + '/blob/master/docs/macos-quickstart.md'}>Mac 설치 안내<ArrowUpRight size={16} aria-hidden="true" /></a><p className="platform-caution">Apple 공증이 없어 최초 실행 허용이 필요합니다.</p>
            <details className="installation-details"><summary>Mac 설치 방법·터미널 설치·파일 검증<ChevronDown size={18} aria-hidden="true" /></summary><div className="mac-install-guide"><h4>DMG로 설치</h4><ol><li>홈 폴더의 Applications 안에 Asset Studio {mac.version} 폴더를 만드세요.</li><li>DMG를 열고 앱을 해당 폴더에 복사하세요. DMG 안에서 직접 실행하지 마세요.</li><li>첫 실행 경고를 닫고 시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기를 선택하세요.</li></ol><p>macOS 12는 앱 설정의 최소값입니다. GPT 연결은 공식 Codex의 운영체제 요구 사항도 따릅니다. 3D에는 메모리 16GB 이상과 Blender가 필요합니다.</p><h4>검증하고 터미널에서 설치</h4><p>기존 앱을 닫고 명령을 실행하세요. 스크립트와 DMG를 검증한 뒤 <code>y</code>로 동의하면 사용자 Applications에 새 사본을 설치합니다. 기존 앱·프로젝트를 보존하고 관리자 암호를 요청하지 않습니다.</p><CopyText label="Mac 설치 명령" text={macInstallCommand} compact /><h4>다음 버전부터 앱에서 업데이트</h4><p>Mac 0.1.4 이상은 앱에서 출처·버전·크기·해시를 확인한 뒤 업데이트합니다. 이전 앱은 백업합니다. 0.1.3 이하는 최신 설치본을 한 번 설치하세요. 시스템 전체 Gatekeeper를 끌 필요는 없습니다.</p><dl className="download-properties"><div><dt>파일</dt><dd>{mac.filename}</dd></div><div><dt>용량</dt><dd>{mac.bytes.toLocaleString('en-US')} bytes / {(mac.bytes / 1_048_576).toFixed(2)} MiB</dd></div></dl><CopyText label="Mac DMG SHA-256" text={mac.sha256} compact /><SourceLink href={sourceUrl + '/blob/master/docs/releases/v' + mac.version + '-macos.md'}>Mac 배포·검증 기록</SourceLink></div></details>
          </section>}
        </div>
      </div></section>

      <section id="guide" className="guide-section section-space page-width" aria-labelledby="guide-title"><div className="section-heading"><div><BookOpen size={28} className="section-icon" aria-hidden="true" /><h2 id="guide-title">처음 시작한다면.</h2></div><SourceLink href={sourceUrl + '/blob/master/docs/skill-first-setup.md'}>전체 사용 가이드</SourceLink></div>
        <div className="guide-columns"><article><h3>Codex에서 시작</h3><ol><li><strong>스킬을 설치하세요.</strong><span>위 명령을 터미널에 붙여 넣거나 ZIP으로 설치합니다.</span></li><li><strong>새 Codex 작업을 여세요.</strong><span>공식 Codex의 기존 로그인을 그대로 사용합니다.</span></li><li><strong><code>$asset-studio</code>로 요청하세요.</strong><span>제작 도구는 다운로드 동의를 받은 뒤 준비합니다.</span></li></ol></article><article><h3>앱에서 시작</h3><ol><li><strong>플랫폼에 맞는 앱을 설치하세요.</strong><span>공식 릴리스에서 파일을 받고 설치 안내를 확인합니다.</span></li><li><strong>프로젝트를 만들고 방향을 정하세요.</strong><span>게임 폴더와 설명, 스타일, 참고 자료를 연결합니다.</span></li><li><strong>제작 목록과 결과를 검수하세요.</strong><span>GPT 제작은 구독 연결이 필요합니다. 로컬 편집은 계정 없이 사용합니다.</span></li></ol></article></div>
        <div className="guide-note"><Box size={23} aria-hidden="true" /><div><strong>3D는 필요한 때 준비합니다.</strong><p>Blender와 로컬 이미지→3D 모델은 첫 3D 사용 시 준비합니다. 16GB RAM 이상이 필요하며, 다운로드 출처·용량·라이선스를 확인하고 동의할 수 있습니다.</p></div></div>
      </section>

      <section id="verification" className="verification-section page-width" aria-labelledby="verification-title"><div><ShieldCheck size={26} aria-hidden="true" /><h2 id="verification-title">무엇을 확인했는지 기록합니다.</h2><p>브라우저 UI, 실제 제작 파일, 네이티브 실행은 각각 확인합니다.</p></div><details className="verification-details"><summary>플랫폼별 기능·검증 범위 보기<ChevronDown size={20} aria-hidden="true" /></summary><dl className="status-list">{statuses.map(item => <div className="status-item" key={item.feature}><dt><strong>{item.feature}</strong><span className={'status-label ' + item.tone}>{item.tone === 'verified' && <Check size={14} aria-hidden="true" />}{item.status}</span></dt><dd><p>{item.detail}</p><SourceLink href={item.link}>검증 기록</SourceLink></dd></div>)}</dl></details></section>

      <section className="faq-section section-space page-width" aria-labelledby="faq-title"><div><h2 id="faq-title">궁금한 점이 있나요?</h2><p>설치, 계정 연결과 결과 파일에 대해.</p><a className="contact-link" href="mailto:oocheol@treeset.win"><Mail size={18} aria-hidden="true" />oocheol@treeset.win</a></div><div className="faq-list">{faqs.map(item => <details key={item.question}><summary>{item.question}<span className="faq-indicator" aria-hidden="true" /></summary><div className="faq-answer"><p>{item.answer}</p>{item.link && <SourceLink href={item.link}>{item.label}</SourceLink>}</div></details>)}</div></section>

      <section id="about" className="about-section" aria-labelledby="about-title"><div className="page-width about-layout"><div className="about-brand"><TreesetMark /><h2 id="about-title">Treeset</h2><p>게임을 만드는 사람을 위한<br />제작 도구를 만듭니다.</p><SourceLink href="/about/">Project overview (English)</SourceLink></div><div className="about-copy"><p>Treeset은 인디 게임 개발자와 소규모 제작팀을 위한 독립 개발 프로젝트입니다. 첫 제품 Asset Studio는 게임에 필요한 에셋 목록을 정리하고, 이미지·3D를 제작·검수·내보내는 흐름을 연결합니다.</p><p className="about-developer">개발자 JEONG WOOCHEOL은 Java 개발 경력 5년 차이며, GitHub에서 oocheol로 Asset Studio를 개발·관리합니다. 공개 코드, 릴리스와 예제 파일에서 현재 작업을 확인할 수 있습니다.</p><dl className="project-facts">{projectFacts.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.href ? <a href={item.href}>{item.value}<ArrowUpRight size={16} aria-hidden="true" /></a> : item.value}</dd></div>)}</dl><p className="project-facts-note">2026년 10월은 프로젝트 시작 시점이며, 법인 설립일을 의미하지 않습니다.</p><div className="about-evidence" aria-label="공개 프로젝트 자료"><SourceLink href={sourceUrl}>소스와 제작 구조</SourceLink><SourceLink href="/about/#local-workflow">로컬 에셋 제작 사례</SourceLink><SourceLink href={latestReleaseUrl}>공개 릴리스</SourceLink></div><div className="claude-plan"><div><h3>{claudeStatus.titleKo}</h3><span className="status-label limited">{claudeStatus.statusKo}</span></div><p>{claudeStatus.detailKo} 현재 공개된 0.1.13 설치 파일에는 이 기능이 포함되지 않습니다. Claude는 작업 지시를 정리하며 이미지·3D 제작은 별도 도구에서 검수 후 진행합니다.</p><SourceLink href={claudeWorkflowPath}>Inspect the prototype (English)</SourceLink></div><div className="about-links"><a className="text-link" href="https://github.com/oocheol"><Github size={18} aria-hidden="true" />JEONG WOOCHEOL · oocheol</a><a className="text-link" href="mailto:oocheol@treeset.win"><Mail size={18} aria-hidden="true" />oocheol@treeset.win</a></div></div></div></section>
    </main>

    <footer className="site-footer"><div className="page-width footer-inner"><a className="wordmark" href="#top" aria-label="Treeset 첫 화면"><TreesetMark /><span>Treeset</span></a><p>Asset Studio / Windows · Apple Silicon Mac · Codex</p><nav aria-label="프로젝트 링크"><a href="#about">프로젝트·개발자</a><a href="/about/" lang="en">Project overview</a><SiteFooterLinks /><a href={sourceUrl}><Github size={17} aria-hidden="true" />GitHub</a><a href={latestReleaseUrl}>릴리스</a><a href={sourceUrl + '/issues'}>오류 제보</a><a href="/third-party-notices.txt">라이선스</a></nav></div></footer>

    <dialog className={'preview-dialog' + (preview?.kind === 'render' ? ' render-dialog' : '')} ref={previewDialog} aria-labelledby="preview-title" onClose={() => { setPreview(null); previewTrigger.current?.focus(); }} onClick={event => { if (event.target === event.currentTarget) previewDialog.current?.close(); }}><div className="dialog-header"><h2 id="preview-title">{preview?.title}</h2><button type="button" autoFocus aria-label="확대 화면 닫기" onClick={() => previewDialog.current?.close()}><X size={23} aria-hidden="true" /></button></div>{preview && <img src={preview.src} alt={preview.alt} width={preview.kind === 'render' ? '512' : '1500'} height={preview.kind === 'render' ? '512' : '960'} />}<p>{preview?.caption}</p></dialog>
  </>;
}
