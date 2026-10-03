import { useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, BookOpen, Box, Check, Copy, Expand, Github, Image, Layers, PackageOpen, RefreshCw, X } from 'lucide-react';

import { release } from './release';

const sourceUrl = 'https://github.com/oocheol/masset';
const releaseUrl = `${sourceUrl}/releases/tag/v${release.version}`;
const downloadUrl = `${sourceUrl}/releases/download/v${release.version}/${release.filename}`;
const portableUrl = `${sourceUrl}/releases/download/v${release.version}/${release.portableFilename}`;
const sizeMiB = (release.bytes / 1_048_576).toFixed(2);

function Mark() {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="m7 13 13-7 13 7v15l-13 7-13-7V13Z M7 13l13 7 13-7 M20 20v15 M13.5 9.5l13 7" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
}

function DownloadLink({ secondary = false }: { secondary?: boolean }) {
  return <a className={`button ${secondary ? 'button-light' : 'button-primary'}`} href={downloadUrl}>
    <ArrowDownToLine size={19} aria-hidden="true" /> Windows 다운로드
  </a>;
}

const features = [
  { icon: Image, title: '원본에서 새 버전으로', text: 'PNG·JPEG·WebP를 가져와 크기, 색, 잘라내기, 배경 마스크를 조정합니다. 변경 결과는 새 버전으로 남고 원본은 보존됩니다.' },
  { icon: Layers, title: '스프라이트를 한 장에', text: '이미지를 프레임으로 분할하고, 여러 애셋을 아틀라스로 묶습니다. 좌표·피벗·재생 속도를 기록한 JSON을 함께 내보냅니다.' },
  { icon: Box, title: '치수로 만드는 3D 소품', text: '상자·테이블·선반의 치수와 색을 정하면 Blender가 실제 모델을 만듭니다. GLB와 편집 가능한 .blend 파일이 함께 남습니다.' },
  { icon: PackageOpen, title: '다음 작업까지 이어지는 기록', text: '프로젝트와 작업 큐를 로컬에 저장합니다. 이미지와 3D 작업을 자원별로 처리하고 취소·복구·캐시로 반복 작업을 관리합니다.' },
  { icon: BookOpen, title: '큰 글씨와 단계별 가이드', text: '주요 버튼과 입력란의 글씨를 키우고 긴 설명을 접었습니다. 상단 사용 가이드에서 가져오기부터 내보내기까지 순서대로 확인하세요.' },
  { icon: RefreshCw, title: '새 버전은 앱에서 바로', text: '시작할 때와 10분마다 새 버전을 확인합니다. 파일 정보를 검토하고 업데이트를 누르면 서명 검사 후 설치합니다. 진행 중인 제작은 완료를 기다립니다.' },
];

const models = [
  { name: '상자', type: 'Crate', src: '/media/crate.png', text: '판재와 테두리의 형태를 갖춘 기본 상자.' },
  { name: '테이블', type: 'Table', src: '/media/table.png', text: '상판과 네 다리를 갖춘 기본 테이블.' },
  { name: '선반', type: 'Shelf', src: '/media/shelf.png', text: '여러 층으로 구성한 기본 수납 선반.' },
];

const statuses = [
  { feature: '로컬 이미지 편집·스프라이트·아틀라스', status: 'Windows 실제 확인', tone: 'verified', detail: '원본 보존과 새 버전 저장, 출력 이미지와 JSON을 확인했습니다.' },
  { feature: 'Blender 기본 소품 생성·3D 미리보기', status: 'Windows 실제 확인', tone: 'verified', detail: '네이티브 앱에서 생성과 렌더를 확인하고, 새 Blender 프로세스에서 산출물을 4회 다시 열어 검사했습니다.' },
  { feature: '밝기 기반 노멀맵', status: '실험 기능', tone: 'experimental', detail: '이미지 밝기에서 표면 방향을 근사합니다. 실제 표면 구조를 복원하는 기능은 아닙니다.' },
  { feature: 'GPT-6.1 Sol 추론·GPT Image2 구독 요청', status: '생성 실증 미완료', tone: 'pending', detail: '공식 Codex 연결과 고정 모델을 표시합니다. 계정의 모델 이용 권한과 이미지 수신은 미확인입니다. 기존 오류 후 자동 재요청이나 유료 API 전환은 하지 않습니다.' },
  { feature: 'macOS 배포 패키지', status: '준비 중', tone: 'pending', detail: '현재 다운로드는 Windows x64용입니다. macOS 패키지와 실행 검증은 아직 제공하지 않습니다.' },
];

const faqs = [
  { question: '개발 도구를 설치해야 하나요?', answer: '아니요. 설치 파일을 실행하고 안내를 따르면 됩니다. Node.js나 Rust는 앱 사용에 필요하지 않습니다. Windows WebView2 Runtime은 필요하며 자동 다운로드하지 않습니다. 3D 소품을 만들 때는 Blender 5.2.1을 별도로 설치해 주세요.' },
  { question: '기존 버전은 어떻게 업데이트하나요?', answer: '기존 0.1.0 포터블 사용자는 이번 설치 파일을 한 번 설치하세요. 이후부터 앱의 업데이트 버튼으로 새 버전을 받을 수 있습니다. 버전·출처·용량·SHA-256을 검토하고 동의하면 서명 검사 후 설치하며, 프로젝트와 원본은 보존합니다.' },
  { question: 'AI 계정 없이도 사용할 수 있나요?', answer: '네. 로컬 이미지 편집, 스프라이트·아틀라스 제작, Blender 기본 소품 생성에는 외부 AI 계정이 필요하지 않습니다. GPT Image2 구독 연결은 별도 기능이며 실제 이미지 생성은 아직 검증되지 않았습니다. 유료 API로 자동 대체하지 않습니다.' },
  { question: '원본 파일이나 이전 결과가 덮어써지나요?', answer: '입력한 원본을 보존하고 처리 결과를 새 버전으로 저장합니다. 프로젝트에서 버전을 비교하고 원하는 결과를 내보낼 수 있습니다. 중요한 프로젝트는 일반 파일과 마찬가지로 별도 백업을 권장합니다.' },
  { question: '어떤 3D 결과물을 받을 수 있나요?', answer: '상자·테이블·선반 템플릿에서 치수와 색을 지정할 수 있습니다. 결과는 GLB, Blender .blend, 썸네일과 턴테이블입니다. 일반적인 문장 하나로 임의의 3D 물체를 만드는 기능을 보장하지 않습니다.' },
  { question: 'Windows에서 실행 경고가 나면 어떻게 하나요?', answer: 'Windows Authenticode 코드 서명이 없는 초기 공개 빌드여서 SmartScreen 경고가 나타날 수 있습니다. 업데이트 파일의 암호학적 서명과 Windows 코드 서명은 다릅니다. GitHub 공식 릴리스와 다운로드 섹션의 SHA-256을 확인해 주세요.' },
  { question: '오류를 제보하거나 소스를 볼 수 있나요?', answer: '소스 코드와 검증 기록을 GitHub에 공개합니다. 문제가 생기면 운영체제, 앱 버전, 작업 종류와 재현 순서를 이슈에 남겨 주세요. 계정 토큰이나 개인 원본 파일은 포함하지 마세요.', link: `${sourceUrl}/issues`, label: 'GitHub 이슈 열기' },
];

export default function App() {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const screenshotDialog = useRef<HTMLDialogElement>(null);
  const screenshotTrigger = useRef<HTMLButtonElement>(null);
  const checksumElement = useRef<HTMLElement>(null);

  async function copyChecksum() {
    try {
      await navigator.clipboard.writeText(release.sha256);
      setCopyState('copied');
    } catch {
      const node = checksumElement.current;
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopyState('failed');
    }
  }

  return <>
    <a className="skip-link" href="#main">본문으로 이동</a>
    <header className="site-header">
      <div className="header-inner page-width">
        <a href="#" className="wordmark" aria-label="Asset Studio 첫 화면"><Mark /><span>Asset Studio</span></a>
        <nav aria-label="주요 메뉴">
          <a href="#workbench">작업대</a>
          <a href="#outputs">작업물</a>
          <a href="#download">다운로드</a>
        </nav>
        <a className="header-source" href={sourceUrl}><Github size={17} aria-hidden="true" /><span>소스 코드</span><ArrowUpRight size={14} aria-hidden="true" /></a>
      </div>
    </header>

    <main id="main">
      <section className="hero page-width" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="release-note"><span className="release-dot" aria-hidden="true" />Windows {release.version} 공개 배포</p>
          <h1 id="hero-title">이미지와 3D 소품을,<br />내 컴퓨터에서.</h1>
          <p className="hero-description">게임과 앱에 쓸 애셋을 만들고 다듬는 작은 작업대.<br className="desktop-break" /> 원본을 남기고, 버전을 쌓고, 필요한 파일로 꺼내세요.</p>
          <div className="hero-actions"><DownloadLink /><a className="text-link" href="#workbench">작업대 살펴보기 <ArrowDownToLine size={16} aria-hidden="true" /></a></div>
          <p className="download-hint">Windows x64 설치 파일 <span>{sizeMiB} MiB</span><br /><a href="#requirements">WebView2 필요 · 3D 제작은 Blender 별도 설치</a></p>
        </div>
        <figure className="hero-specimens">
          <div className="specimen-board">
            <div className="main-specimen"><img src="/media/crate.png" alt="Blender로 만든 옅은 청록색 나무 상자 렌더" width="512" height="512" fetchPriority="high" /><span className="specimen-caption">상자 <span>Crate</span></span></div>
            <div className="small-specimen"><img src="/media/table.png" alt="Blender로 만든 파란 상판과 밝은 다리의 테이블 렌더" width="512" height="512" /><span className="specimen-caption">테이블 <span>Table</span></span></div>
            <div className="small-specimen"><img src="/media/shelf.png" alt="Blender로 만든 파란 프레임의 3단 선반 렌더" width="512" height="512" /><span className="specimen-caption">선반 <span>Shelf</span></span></div>
          </div>
          <figcaption><span className="caption-line" aria-hidden="true" />Asset Studio의 Blender 작업자로 만든 기본 소품</figcaption>
        </figure>
      </section>

      <div className="value-strip">
        <div className="page-width"><p><span>내 파일, 내 작업 공간</span>원본 보존</p><p><span>외부 AI 없이도</span>로컬 2D·3D 제작</p><p><span>다음 작업으로 연결</span>이미지 · GLB · JSON</p></div>
      </div>

      <section id="workbench" className="workbench-section section-space" aria-labelledby="workbench-title">
        <div className="page-width">
          <div className="section-heading workbench-heading"><h2 id="workbench-title">도구와 작업물을<br />한 작업대에 펼치세요.</h2><p>라이브러리에서 고르고, 가운데에서 확인하고,<br className="desktop-break" /> 오른쪽에서 다듬으세요. 아래 작업 큐가 처리 기록을 남깁니다.</p></div>
          <figure className="workstation-figure">
            <button ref={screenshotTrigger} className="screenshot-button" aria-label="Asset Studio 브라우저 미리보기 화면 크게 보기" onClick={() => screenshotDialog.current?.showModal()}>
              <img src="/media/workstation-browser.png" alt="Asset Studio의 브라우저 미리보기. 왼쪽 프로젝트 목록, 가운데 이미지 라이브러리, 오른쪽 편집 속성, 아래 작업 큐가 보입니다." width="1500" height="960" loading="lazy" />
              <span className="expand-label"><Expand size={16} aria-hidden="true" />화면 크게 보기</span>
            </button>
            <figcaption><span>실제 앱 UI의 브라우저 미리보기 화면</span><span>이미지 편집 · 라이브러리 · 버전 · 작업 큐</span></figcaption>
          </figure>
          <div className="features-grid">{features.map(({ icon: Icon, title, text }) => <article className="feature" key={title}><Icon size={26} strokeWidth={1.5} aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}</div>
        </div>
      </section>

      <section className="workflow-section" aria-labelledby="workflow-title">
        <div className="page-width workflow-layout">
          <div><h2 id="workflow-title">입력부터 내보내기까지,<br />파일로 남는 작업.</h2><p>작업은 내 컴퓨터에서 처리합니다.<br />결과를 확인하고 다음 도구로 이어 가세요.</p></div>
          <ol className="workflow-steps">
            <li><span className="step-number" aria-hidden="true">1</span><div><h3>가져오기</h3><p>PNG·JPEG·WebP 원본과 프로젝트 규격을 준비합니다.</p></div></li>
            <li><span className="step-number" aria-hidden="true">2</span><div><h3>다듬고 확인하기</h3><p>2D를 새 버전으로 변환하거나, 치수로 3D 소품을 만듭니다.</p></div></li>
            <li><span className="step-number" aria-hidden="true">3</span><div><h3>파일로 꺼내기</h3><p>이미지, 아틀라스와 JSON, GLB와 .blend를 내보냅니다.</p></div></li>
          </ol>
        </div>
      </section>

      <section id="outputs" className="outputs-section section-space page-width" aria-labelledby="outputs-title">
        <div className="section-heading"><div><h2 id="outputs-title">이 작업대에서 만든 것들.</h2><p>아래 이미지는 실제 생성한 Blender 소품의 렌더입니다.</p></div><a className="text-link" href={`${sourceUrl}/tree/master/examples/procedural`}>예제 산출물 보기 <ArrowUpRight size={16} aria-hidden="true" /></a></div>
        <div className="model-gallery">{models.map(model => <figure className="model-specimen" key={model.type}><img src={model.src} alt={`${model.name} 템플릿으로 실제 생성한 Blender 3D 렌더`} width="512" height="512" loading="lazy" /><figcaption><div><h3>{model.name}</h3><span>{model.type}</span></div><p>{model.text}</p></figcaption></figure>)}</div>
        <div className="output-note"><Box size={23} strokeWidth={1.5} aria-hidden="true" /><p>치수와 색을 바꿔 만드는 기본 소품.<br className="mobile-break" /> GLB, .blend, 썸네일과 턴테이블을 함께 저장합니다.</p><span>Blender 5.2.1 필요</span></div>
      </section>

      <section className="status-section section-space" aria-labelledby="status-title">
        <div className="page-width status-layout">
          <div className="status-intro"><h2 id="status-title">확인한 기능을<br />분명히 적습니다.</h2><p>{release.version}은 초기 공개 버전입니다.<br />검증 범위는 현재 Windows 호스트이며,<br />미확인 기능을 완성된 기능처럼 소개하지 않습니다.</p><a className="text-link" href={`${sourceUrl}/blob/master/docs/verification.md`}>검증 기록 읽기 <ArrowUpRight size={16} aria-hidden="true" /></a></div>
          <dl className="status-list">{statuses.map(item => <div key={item.feature} className="status-item"><dt>{item.feature}<span className={`status-label ${item.tone}`}>{item.tone === 'verified' && <Check size={13} aria-hidden="true" />}{item.status}</span></dt><dd>{item.detail}</dd></div>)}</dl>
        </div>
      </section>

      <section id="download" className="download-section section-space page-width" aria-labelledby="download-title">
        <div className="download-card">
          <div className="download-main"><Mark /><h2 id="download-title">작업대를 열어 보세요.</h2><p>설치 파일을 실행하고 안내를 따르세요.<br />앱 안의 사용 가이드로 시작할 수 있습니다.</p><DownloadLink secondary /><a className="portable-link" href={portableUrl}>설치 없이 쓰는 포터블 ZIP</a><a className="release-link" href={releaseUrl}>v{release.version} 릴리스 기록 <ArrowUpRight size={14} aria-hidden="true" /></a></div>
          <div id="requirements" className="download-requirements"><h3>받기 전에 확인해 주세요</h3><dl><div><dt>운영체제</dt><dd>Windows x64</dd></div><div><dt>앱 실행</dt><dd>Microsoft WebView2 Runtime</dd></div><div><dt>3D 제작</dt><dd>Blender 5.2.1 별도 설치</dd></div><div><dt>배포 형태</dt><dd>설치형 · 앱 내부 업데이트</dd></div><div><dt>파일 크기</dt><dd>{release.bytes.toLocaleString('en-US')} bytes <span>(약 {sizeMiB} MiB)</span></dd></div></dl><p className="unsigned-note">업데이트 파일에는 암호학적 서명이 있습니다. Windows 코드 서명은 없어 실행 경고가 나타날 수 있습니다. 공식 릴리스와 파일 해시를 확인해 주세요.</p></div>
        </div>
        <div className="checksum-row"><div className="checksum-heading"><span>설치 파일 SHA-256</span><button type="button" onClick={copyChecksum}>{copyState === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{copyState === 'copied' ? '복사됨' : '해시 복사'}</button></div><code ref={checksumElement}>{release.sha256}</code><p className="copy-result" role="status" aria-live="polite">{copyState === 'copied' ? 'SHA-256 해시를 복사했습니다.' : copyState === 'failed' ? '해시를 선택했습니다. 선택한 텍스트를 직접 복사해 주세요.' : ''}</p></div>
      </section>

      <section className="faq-section section-space page-width" aria-labelledby="faq-title"><h2 id="faq-title">처음 열기 전에 궁금한 것.</h2><div className="faq-list">{faqs.map(faq => <details key={faq.question}><summary>{faq.question}<span className="faq-indicator" aria-hidden="true" /></summary><div className="faq-answer"><p>{faq.answer}</p>{faq.link && <a className="text-link" href={faq.link}>{faq.label}<ArrowUpRight size={15} aria-hidden="true" /></a>}</div></details>)}</div></section>
    </main>

    <footer className="site-footer"><div className="page-width footer-inner"><a className="wordmark" href="#" aria-label="Asset Studio 첫 화면"><Mark /><span>Asset Studio</span></a><p>파일을 남기고, 다음 작업으로.</p><div><a href={sourceUrl}>GitHub 소스</a><a href={releaseUrl}>릴리스</a><a href={`${sourceUrl}/issues`}>오류 제보</a><a href="/third-party-notices.txt">라이선스</a></div></div></footer>

    <dialog className="screenshot-dialog" ref={screenshotDialog} aria-labelledby="screenshot-dialog-title" onClose={() => screenshotTrigger.current?.focus()} onClick={event => { if (event.target === event.currentTarget) screenshotDialog.current?.close(); }}><div className="dialog-header"><h2 id="screenshot-dialog-title">Asset Studio 브라우저 미리보기</h2><button type="button" aria-label="화면 닫기" onClick={() => screenshotDialog.current?.close()}><X size={22} aria-hidden="true" /></button></div><img src="/media/workstation-browser.png" alt="확대한 Asset Studio 브라우저 미리보기 작업 화면" width="1500" height="960" /><p>브라우저 미리보기 화면입니다. Windows 네이티브 실행 검증 범위는 기능별 확인 상태와 GitHub 기록에서 볼 수 있습니다.</p></dialog>
  </>;
}
