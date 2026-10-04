import { useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Box, Check, Copy, Expand, Github, Image, Layers, PackageOpen, X } from 'lucide-react';

import { macInstallCommand, macReleases, release } from './release';

const sourceUrl = 'https://github.com/oocheol/masset';
const releaseUrl = `${sourceUrl}/releases/tag/v${release.version}`;
const downloadUrl = `${sourceUrl}/releases/download/v${release.version}/${release.filename}`;
const portableUrl = `${sourceUrl}/releases/download/v${release.version}/${release.portableFilename}`;
const sizeMiB = (release.bytes / 1_048_576).toFixed(2);
const hasMacRelease = macReleases.length > 0;

function Mark() {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="m7 13 13-7 13 7v15l-13 7-13-7V13Z M7 13l13 7 13-7 M20 20v15 M13.5 9.5l13 7" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
}

function DownloadLink({ secondary = false }: { secondary?: boolean }) {
  return <a className={`button ${secondary ? 'button-light' : 'button-primary'}`} href={downloadUrl}>
    <ArrowDownToLine size={19} aria-hidden="true" /> Windows 다운로드
  </a>;
}

const models = [
  { name: '상자', type: 'Crate', filename: 'crate.png', src: '/media/crate.png', text: '판재와 테두리의 형태를 갖춘 기본 상자.' },
  { name: '테이블', type: 'Table', filename: 'table.png', src: '/media/table.png', text: '상판과 네 다리를 갖춘 기본 테이블.' },
  { name: '선반', type: 'Shelf', filename: 'shelf.png', src: '/media/shelf.png', text: '여러 층으로 구성한 기본 수납 선반.' },
];

const statuses = [
  { feature: '로컬 이미지 편집·스프라이트·아틀라스', status: 'Windows 실제 확인', tone: 'verified', detail: '원본 보존과 새 버전 저장, 출력 이미지와 JSON을 확인했습니다.' },
  { feature: 'Blender 기본 소품 생성·3D 미리보기', status: 'Windows 실제 확인', tone: 'verified', detail: '네이티브 앱에서 생성과 렌더를 확인하고, 새 Blender 프로세스에서 산출물을 4회 다시 열어 검사했습니다.' },
  { feature: '밝기 기반 노멀맵', status: '실험 기능', tone: 'experimental', detail: '이미지 밝기에서 표면 방향을 근사합니다. 실제 표면 구조를 복원하는 기능은 아닙니다.' },
  { feature: 'GPT-6.1 Sol 추론·GPT Image2 구독 요청', status: 'Windows 새 요청 1회 확인', tone: 'verified', detail: '0.1.2에서 도구 설정 충돌을 수정했습니다. 새 PNG 수신·저장·재열기·독립 내보내기를 확인했습니다. 실제 이미지 모델 ID와 모든 계정의 권한은 미확인입니다.' },
  { feature: 'Codex가 없는 PC의 관리형 준비', status: '구현·오프라인 검사', tone: 'pending', detail: '다운로드 동의·해시·압축 경로·등록·취소 검사를 통과했습니다. 새 공식 패키지의 실제 다운로드·준비는 별도 미검증 항목입니다.' },
  { feature: 'macOS 로컬 2D·앱 내부 업데이트', status: 'Apple Silicon 실제 확인', tone: 'verified', detail: '0.1.4부터 업데이트 파일 서명·버전을 검증해 앱을 교체하고 재실행합니다. 실제 Mac에서 프로젝트·원본 보존을 확인했습니다. 구독 연결은 미지원이며, 3D는 Mac 검증 전입니다.' },
];

const faqs = [
  { question: '개발 도구를 설치해야 하나요?', answer: '아니요. 설치 파일을 실행하고 안내를 따르면 됩니다. Node.js나 Rust는 앱 사용에 필요하지 않습니다. Windows WebView2 Runtime은 필요하며 자동 다운로드하지 않습니다. 3D 소품을 만들 때는 Blender 5.2.1을 별도로 설치해 주세요.' },
  { question: '기존 버전은 어떻게 업데이트하나요?', answer: 'Mac 0.1.3 이하는 0.1.4를 한 번 직접 설치하세요. 이후부터 앱이 새 버전을 확인하고, 업데이트 패널에서 승인하면 서명·버전·크기·SHA-256 검사 후 설치하고 재실행합니다. 프로젝트와 원본은 보존합니다. Windows 0.1.0 포터블도 업데이트가 가능한 설치형을 한 번 설치해야 합니다.' },
  { question: 'Codex를 설치하지 않았는데 구독 연결을 할 수 있나요?', answer: 'Windows x64 앱의 구독 연결 화면에서 Codex 준비 → 공식 계정 연결 → 연결 확인 순서로 진행하세요. 공식 Codex 0.160.0 배포본의 출처·150.15 MiB 용량·SHA-256·라이선스를 확인하고 동의하면 앱 전용 공간에 준비합니다. 기존 Codex가 있으면 재사용하고, 로그인은 OpenAI 공식 페이지에서 진행합니다.' },
  { question: 'AI 계정 없이도 사용할 수 있나요?', answer: '네. 로컬 이미지 편집, 스프라이트·아틀라스 제작, Blender 기본 소품 생성에는 외부 AI 계정이 필요하지 않습니다. GPT Image2 구독 연결은 별도 기능이며 0.1.2에서 Windows 새 이미지 한 장의 수신부터 재열기까지 확인했습니다. 공식 Codex 로그인과 계정 이용 권한이 필요하며 유료 API로 자동 대체하지 않습니다.' },
  { question: '원본 파일이나 이전 결과가 덮어써지나요?', answer: '입력한 원본을 보존하고 처리 결과를 새 버전으로 저장합니다. 프로젝트에서 버전을 비교하고 원하는 결과를 내보낼 수 있습니다. 중요한 프로젝트는 일반 파일과 마찬가지로 별도 백업을 권장합니다.' },
  { question: '어떤 3D 결과물을 받을 수 있나요?', answer: '상자·테이블·선반 템플릿에서 치수와 색을 지정할 수 있습니다. 결과는 GLB, Blender .blend, 썸네일과 턴테이블입니다. 일반적인 문장 하나로 임의의 3D 물체를 만드는 기능을 보장하지 않습니다.' },
  { question: 'Windows에서 실행 경고가 나면 어떻게 하나요?', answer: 'Windows Authenticode 코드 서명이 없는 초기 공개 빌드여서 SmartScreen 경고가 나타날 수 있습니다. 업데이트 파일의 암호학적 서명과 Windows 코드 서명은 다릅니다. GitHub 공식 릴리스와 다운로드 섹션의 SHA-256을 확인해 주세요.' },
  { question: 'Mac에는 어떻게 설치하나요?', answer: '아래 Mac 다운로드의 터미널 명령을 사용하면 스크립트와 DMG를 검증하고 사용자 Applications에 새 앱을 설치합니다. Apple 계정이나 관리자 암호는 필요하지 않습니다. 브라우저로 DMG를 받은 경우에는 앱을 복사한 뒤 시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기로 최초 실행을 허용하세요. Apple 공증은 없으며 업데이트 파일의 서명과는 별개입니다.' },
  { question: 'Mac에서도 구독 연결과 3D를 사용할 수 있나요?', answer: 'Mac에서는 로컬 2D 기능과 0.1.4부터 앱 내부 업데이트를 지원합니다. Codex 구독 연결·관리형 준비는 지원하지 않습니다. Blender 3D는 아직 Mac에서 검증하지 않았습니다.' },
  { question: '오류를 제보하거나 소스를 볼 수 있나요?', answer: '소스 코드와 검증 기록을 GitHub에 공개합니다. 문제가 생기면 운영체제, 앱 버전, 작업 종류와 재현 순서를 이슈에 남겨 주세요. 계정 토큰이나 개인 원본 파일은 포함하지 마세요.', link: `${sourceUrl}/issues`, label: 'GitHub 이슈 열기' },
];

export default function App() {
  const [inspectedModel, setInspectedModel] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [installCopyState, setInstallCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const installCommandElement = useRef<HTMLElement>(null);
  const screenshotDialog = useRef<HTMLDialogElement>(null);
  const screenshotTrigger = useRef<HTMLButtonElement>(null);
  const checksumElement = useRef<HTMLElement>(null);
  const specimen = models[inspectedModel];

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

  async function copyMacInstall() {
    try { await navigator.clipboard.writeText(macInstallCommand); setInstallCopyState('copied'); }
    catch {
      if (installCommandElement.current) {
        const range = document.createRange(); range.selectNodeContents(installCommandElement.current);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      }
      setInstallCopyState('failed');
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
        <a className="header-source" href={sourceUrl} aria-label="GitHub 소스 코드"><Github size={17} aria-hidden="true" /><span>소스 코드</span><ArrowUpRight size={14} aria-hidden="true" /></a>
      </div>
    </header>

    <main id="main">
      <section className="hero page-width" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="release-note">로컬 에셋 제작 작업실 <span>Windows {release.version} · Mac {macReleases[0]?.version}</span></p>
          <h1 id="hero-title">Asset Studio</h1>
          <p className="hero-purpose">이미지와 3D 소품을<br />만들고 다듬는 작업실.</p>
          <p className="hero-description">원본을 남기고, 버전을 쌓고,<br />게임과 앱에 쓸 파일로 꺼내세요.</p>
          <div className="hero-actions"><DownloadLink /><a className="text-link" href="#workbench">작업대 살펴보기 <ArrowDownToLine size={16} aria-hidden="true" /></a></div>
          <p className="download-hint">Windows x64 설치 파일 <span>{sizeMiB} MiB</span><br /><a href="#requirements">WebView2 필요 · 3D는 Blender 별도 설치</a></p>
          <a className="text-link mac-hero-link" href="#download-mac">Mac 시험 배포 안내 <ArrowDownToLine size={16} aria-hidden="true" /></a>
        </div>
        <figure className="hero-specimens">
          <div className="inspection-frame">
            <div className="inspection-header"><span><Box size={17} aria-hidden="true" />{specimen.filename}</span><span>Blender 실제 렌더</span></div>
            <div className="inspection-stage">
              <span className="inspection-corner top-left" aria-hidden="true" /><span className="inspection-corner bottom-right" aria-hidden="true" />
              <img src={specimen.src} alt={`${specimen.name} 템플릿으로 실제 생성한 Blender 3D 렌더`} width="512" height="512" fetchPriority="high" />
              <div className="inspection-readout"><span>{specimen.name} 템플릿</span><span>512 × 512 PNG</span></div>
            </div>
            <div className="specimen-picker" role="group" aria-label="3D 렌더 선택">{models.map((model, index) => <button type="button" key={model.type} aria-label={`${model.name} 렌더 보기`} aria-pressed={inspectedModel === index} onClick={() => setInspectedModel(index)}><img src={model.src} alt="" width="52" height="52" /><span>{model.name}<small>{model.type}</small></span></button>)}</div>
          </div>
          <figcaption>Asset Studio의 Blender 작업자로 만든 기본 소품</figcaption>
        </figure>
      </section>

      <div className="value-strip">
        <div className="page-width"><p><PackageOpen size={21} aria-hidden="true" /><span>원본 보존 · 새 버전 저장</span></p><p><Layers size={21} aria-hidden="true" /><span>로컬 2D · Blender 기본 소품</span></p><p><ArrowUpRight size={21} aria-hidden="true" /><span>이미지 · GLB · JSON 내보내기</span></p></div>
      </div>

      <section id="workbench" className="workbench-section section-space" aria-labelledby="workbench-title">
        <div className="page-width">
          <div className="section-heading workbench-heading"><h2 id="workbench-title">원본은 남기고,<br />결과를 다듬으세요.</h2><p>왼쪽에서 고르고, 가운데에서 확인하고,<br className="desktop-break" /> 오른쪽에서 수정하세요. 작업 큐에 처리 기록이 남습니다.</p></div>
          <figure className="workstation-figure">
            <div className="workstation-title"><span><Image size={17} aria-hidden="true" />Asset Studio 작업대</span><span className="preview-label">브라우저 미리보기</span></div>
            <button ref={screenshotTrigger} className="screenshot-button" aria-label="Asset Studio 브라우저 미리보기 화면 크게 보기" onClick={() => screenshotDialog.current?.showModal()}>
              <img src="/media/workstation-browser-013.png" alt="Asset Studio의 브라우저 미리보기. 왼쪽 프로젝트 목록, 가운데 이미지 라이브러리, 오른쪽 편집 속성, 아래 작업 큐가 보입니다." width="1500" height="960" loading="lazy" />
              <span className="expand-label"><Expand size={16} aria-hidden="true" />화면 크게 보기</span>
            </button>
            <figcaption><span>실제 앱 UI의 브라우저 미리보기 화면</span><span>이미지 편집 · 라이브러리 · 버전 · 작업 큐</span></figcaption>
          </figure>
          <div className="workbench-details">
            <dl className="editing-list"><div><dt><Image size={22} aria-hidden="true" />이미지를 새 버전으로</dt><dd>PNG·JPEG·WebP의 크기, 자르기, 색상과 배경 마스크를 조정합니다. 이전 버전과 비교하고 원하는 결과를 고르세요.</dd></div><div><dt><Layers size={22} aria-hidden="true" />프레임에서 아틀라스까지</dt><dd>이미지를 프레임으로 분할하고 한 장에 묶습니다. 좌표·피벗·재생 속도가 담긴 JSON도 함께 남습니다.</dd></div></dl>
            <aside className="workspace-note"><PackageOpen size={26} aria-hidden="true" /><h3>다음 작업도 이어서.</h3><p>프로젝트와 작업 큐를 로컬에 저장합니다. 자원별 처리, 취소·복구·캐시로 반복 제작을 관리하세요.</p><p>큰 글씨와 앱 안의 사용 가이드로 시작할 수 있습니다. Node.js·Rust 설치는 필요 없습니다.</p><a className="text-link" href="#download">내 컴퓨터에 작업대 준비 <ArrowDownToLine size={17} aria-hidden="true" /></a></aside>
          </div>
        </div>
      </section>

      <section className="workflow-section" aria-labelledby="workflow-title">
        <div className="page-width workflow-layout">
          <div><h2 id="workflow-title">만든 결과는<br />파일로 남습니다.</h2><p>외부 AI 계정 없이 로컬 편집부터 시작하세요.</p></div>
          <ol className="workflow-steps">
            <li><span className="step-number" aria-hidden="true">1</span><div><h3>가져오기</h3><p>PNG·JPEG·WebP 원본과 프로젝트 규격을 준비합니다.</p></div></li>
            <li><span className="step-number" aria-hidden="true">2</span><div><h3>다듬고 확인하기</h3><p>2D를 새 버전으로 변환하거나, 치수로 3D 소품을 만듭니다.</p></div></li>
            <li><span className="step-number" aria-hidden="true">3</span><div><h3>파일로 꺼내기</h3><p>이미지, 아틀라스와 JSON, GLB와 .blend를 내보냅니다.</p></div></li>
          </ol>
        </div>
      </section>

      <section id="outputs" className="outputs-section section-space page-width" aria-labelledby="outputs-title">
        <div className="section-heading"><div><h2 id="outputs-title">치수로 만들고,<br />파일로 확인하세요.</h2><p>상자·테이블·선반. 실제 생성한 Blender 소품의 렌더입니다.</p></div><a className="text-link" href={`${sourceUrl}/tree/master/examples/procedural`}>예제 산출물 보기 <ArrowUpRight size={16} aria-hidden="true" /></a></div>
        <div className="model-gallery">{models.map(model => <figure className="model-specimen" key={model.type}><div className="model-file"><Box size={15} aria-hidden="true" /><span>{model.filename}</span></div><img src={model.src} alt={`${model.name} 템플릿으로 실제 생성한 Blender 3D 렌더`} width="512" height="512" loading="lazy" /><figcaption><div><h3>{model.name}</h3><span>{model.type}</span></div><p>{model.text}</p></figcaption></figure>)}</div>
        <div className="output-note"><Box size={23} strokeWidth={1.5} aria-hidden="true" /><p>치수와 색을 바꿔 만드는 기본 소품.<br className="mobile-break" /> GLB, .blend, 썸네일과 턴테이블을 함께 저장합니다.</p><span>Blender 5.2.1 필요</span></div>
      </section>

      <section className="status-section section-space" aria-labelledby="status-title">
        <div className="page-width status-layout">
          <div className="status-intro"><h2 id="status-title">확인한 만큼,<br />정확하게.</h2><p>Windows v{release.version} · Mac v{macReleases[0]?.version}의 기능별 확인 범위입니다. Windows와 Mac의 지원 상태를 구분해 적었습니다.</p><a className="text-link" href={`${sourceUrl}/blob/master/docs/verification.md`}>검증 기록 읽기 <ArrowUpRight size={16} aria-hidden="true" /></a></div>
          <dl className="status-list">{statuses.map(item => <div key={item.feature} className="status-item"><dt>{item.feature}<span className={`status-label ${item.tone}`}>{item.tone === 'verified' && <Check size={13} aria-hidden="true" />}{item.status}</span></dt><dd>{item.detail}</dd></div>)}</dl>
        </div>
      </section>

      <section id="download" className="download-section section-space page-width" aria-labelledby="download-title">
        <nav className="platform-picker" aria-label="운영체제별 다운로드"><a href="#download-windows">Windows x64</a><a href="#download-mac">Mac 시험 배포</a></nav>
        <div id="download-windows" className="download-card">
          <div className="download-main"><div className="download-heading-mark"><Mark /><span>Windows x64 · v{release.version}</span></div><h2 id="download-title">당신의 작업실을<br />준비하세요.</h2><p>설치 파일을 실행하고 안내를 따르세요.<br />앱 안의 사용 가이드로 시작할 수 있습니다.</p><DownloadLink secondary /><a className="portable-link" href={portableUrl}>설치 없이 쓰는 포터블 ZIP</a><a className="release-link" href={releaseUrl}>v{release.version} 릴리스 기록 <ArrowUpRight size={14} aria-hidden="true" /></a></div>
          <div id="requirements" className="download-requirements"><h3>받기 전에 확인해 주세요</h3><dl><div><dt>운영체제</dt><dd>Windows x64</dd></div><div><dt>앱 실행</dt><dd>Microsoft WebView2 Runtime</dd></div><div><dt>3D 제작</dt><dd>Blender 5.2.1 별도 설치</dd></div><div><dt>배포 형태</dt><dd>설치형 · 앱 내부 업데이트</dd></div><div><dt>파일 크기</dt><dd>{release.bytes.toLocaleString('en-US')} bytes <span>(약 {sizeMiB} MiB)</span></dd></div></dl><p className="unsigned-note">업데이트 파일에는 암호학적 서명이 있습니다. Windows 코드 서명은 없어 실행 경고가 나타날 수 있습니다. 공식 릴리스와 파일 해시를 확인해 주세요.</p></div>
        </div>
        <div className="checksum-row"><div className="checksum-heading"><span>설치 파일 SHA-256</span><button type="button" onClick={copyChecksum}>{copyState === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{copyState === 'copied' ? '복사됨' : '해시 복사'}</button></div><code ref={checksumElement}>{release.sha256}</code><p className="copy-result" role="status" aria-live="polite">{copyState === 'copied' ? 'SHA-256 해시를 복사했습니다.' : copyState === 'failed' ? '해시를 선택했습니다. 선택한 텍스트를 직접 복사해 주세요.' : ''}</p></div>
        <section id="download-mac" className="mac-download" aria-labelledby="mac-download-title">
          <div className="mac-download-heading"><h3 id="mac-download-title">Mac 시험 배포</h3><span className="mac-trial-label">로컬 2D부터</span></div>
          <p className="mac-download-intro">Apple Silicon용 v{macReleases[0]?.version}. 로컬 2D와 앱 내부 업데이트를 지원합니다. 0.1.3 이하는 아래 방법으로 새 버전을 한 번 설치하세요.</p>
          {hasMacRelease ? <div className="mac-release-grid">{macReleases.map(item => <article className="mac-release" key={item.architecture} aria-label={`${item.label} 다운로드`}>
            <h4>{item.label} · v{item.version}</h4><p>M 시리즈 Mac용 · 앱 내부 업데이트</p>
            <a className="button button-primary" href={item.downloadUrl} aria-label={`${item.label} DMG 다운로드`}><ArrowDownToLine size={18} aria-hidden="true" />DMG 다운로드</a>
            <dl><div><dt>파일</dt><dd>{item.filename}</dd></div><div><dt>용량</dt><dd>{item.bytes.toLocaleString('en-US')} bytes · {(item.bytes / 1_048_576).toFixed(2)} MiB</dd></div><div><dt>SHA-256</dt><dd><code>{item.sha256}</code></dd></div></dl>
          </article>)}</div> : <p className="mac-release-pending">다운로드 파일을 확인 중입니다. 실행 검증을 마치면 Apple Silicon용 DMG를 이곳에 공개합니다.</p>}
          <div className="mac-install-guide">
            <div><h4>Apple 계정 없이 터미널로 설치</h4><ol><li>기존 앱을 닫고 아래 명령을 터미널에 붙여 넣습니다.</li><li>파일 검증과 설치 위치 안내를 확인하고 y를 입력합니다.</li><li>~/Applications/Asset Studio 0.1.4의 새 앱을 사용합니다.</li></ol><p>스크립트와 DMG의 SHA-256을 확인한 뒤 새 사본을 설치합니다. 기존 앱·프로젝트는 보존하며 관리자 암호는 필요하지 않습니다.</p></div>
            <div className="mac-install-notes"><h4>브라우저로 DMG를 받은 경우</h4><p>홈 폴더의 Applications 안에 Asset Studio 0.1.4 폴더를 만들고 앱을 복사하세요. DMG 안에서 직접 실행하지 마세요.</p><p>Apple 공증이 없어 확인 경고가 나타날 수 있습니다. 경고를 닫은 뒤 <strong>시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기 → 열기</strong>를 선택하세요. <a href={`${sourceUrl}/blob/master/docs/macos-quickstart.md`}>자세한 설치 안내</a></p><p>업데이트 파일은 별도의 키로 서명합니다. Apple 공증과는 별개이며, 시스템 전체 Gatekeeper를 끌 필요는 없습니다.</p><p>macOS 12는 설정상 최소값입니다. 구독 연결·Codex 자동 준비는 미지원이며, 3D는 Mac 검증 전입니다.</p></div>
          </div>
          <div className="mac-terminal-install"><div className="checksum-heading"><span>Mac 설치 명령</span><button type="button" onClick={copyMacInstall}><Copy size={15} aria-hidden="true" />{installCopyState === 'copied' ? '복사됨' : '설치 명령 복사'}</button></div><pre><code ref={installCommandElement}>{macInstallCommand}</code></pre><p role="status" aria-live="polite">{installCopyState === 'copied' ? '설치 명령을 복사했습니다. 터미널에 붙여 넣으세요.' : installCopyState === 'failed' ? '명령을 선택했습니다. 직접 복사해 주세요.' : '설치 안내를 읽고 y를 입력하면 진행합니다.'}</p></div>
          <div className="mac-update-guide"><h4>다음 버전부터는 앱에서 업데이트</h4><p>앱이 새 버전을 자동 확인합니다. 상단 앱 업데이트에서 출처·버전·크기·해시를 확인하고 승인하면 다운로드·검증·설치·재실행합니다. 제작 작업이 끝난 뒤 진행하며, 이전 앱을 백업하고 프로젝트·원본·버전을 보존합니다.</p></div>
        </section>
      </section>

      <section className="faq-section section-space page-width" aria-labelledby="faq-title"><div><h2 id="faq-title">시작하기 전에.</h2><p className="faq-intro">설치, 구독 연결,<br />원본 보존에 관한 안내.</p></div><div className="faq-list">{faqs.map(faq => <details key={faq.question}><summary>{faq.question}<span className="faq-indicator" aria-hidden="true" /></summary><div className="faq-answer"><p>{faq.answer}</p>{faq.link && <a className="text-link" href={faq.link}>{faq.label}<ArrowUpRight size={15} aria-hidden="true" /></a>}</div></details>)}</div></section>
    </main>

    <footer className="site-footer"><div className="page-width footer-inner"><a className="wordmark" href="#" aria-label="Asset Studio 첫 화면"><Mark /><span>Asset Studio</span></a><p>파일을 남기고, 다음 작업으로.</p><div><a href={sourceUrl}>GitHub 소스</a><a href={releaseUrl}>릴리스</a><a href={`${sourceUrl}/issues`}>오류 제보</a><a href="/third-party-notices.txt">라이선스</a></div></div></footer>

    <dialog className="screenshot-dialog" ref={screenshotDialog} aria-labelledby="screenshot-dialog-title" onClose={() => screenshotTrigger.current?.focus()} onClick={event => { if (event.target === event.currentTarget) screenshotDialog.current?.close(); }}><div className="dialog-header"><h2 id="screenshot-dialog-title">Asset Studio 브라우저 미리보기</h2><button type="button" aria-label="화면 닫기" onClick={() => screenshotDialog.current?.close()}><X size={22} aria-hidden="true" /></button></div><img src="/media/workstation-browser-013.png" alt="확대한 Asset Studio 브라우저 미리보기 작업 화면" width="1500" height="960" /><p>브라우저 미리보기 화면입니다. Windows 네이티브 실행 검증 범위는 기능별 확인 상태와 GitHub 기록에서 볼 수 있습니다.</p></dialog>
  </>;
}
