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

function MacDownloadLink() {
  const mac = macReleases[0];
  return mac ? <a className="button button-primary" href={mac.downloadUrl} aria-label={`Mac 다운로드 · Apple Silicon v${mac.version}`}>
    <ArrowDownToLine size={19} aria-hidden="true" /> Mac 다운로드
  </a> : null;
}

const models = [
  { name: '상자', type: 'Crate', filename: 'crate.png', src: '/media/crate.png', text: '판재와 테두리의 형태를 갖춘 기본 상자.' },
  { name: '테이블', type: 'Table', filename: 'table.png', src: '/media/table.png', text: '상판과 네 다리를 갖춘 기본 테이블.' },
  { name: '선반', type: 'Shelf', filename: 'shelf.png', src: '/media/shelf.png', text: '여러 층으로 구성한 기본 수납 선반.' },
];

const statuses = [
  { feature: 'Windows 0.1.9 · 이미지와 3D 제작', status: 'Windows CPU 생성 확인', tone: 'verified', detail: '게임 프로젝트에서 이미지·3D·혼합을 선택합니다. Windows CPU에서 실제 TripoSR 메시 생성, Blender 처리, 저장·프로젝트 재열기·독립 내보내기를 확인했습니다. Python은 앱 전용 공간에 준비하며 첫 다운로드에 동의가 필요합니다. 이번 검증은 로컬 이미지 입력이며 새로운 GPT 요청은 보내지 않았습니다.' },
  { feature: 'Mac 0.1.8 · 게임 프로젝트에서 제작과 검수', status: 'Mac 실제 제작 확인', tone: 'experimental', detail: '게임 설명과 프로젝트 루트로 필요한 시각 에셋을 분석하고, 최대 120개를 개별 작업으로 제작합니다. GPT 참고 이미지에서 로컬 TripoSR 모델을 만들고 새 프로젝트 폴더에 저장합니다. 실제 PNG·GLB 제작·해시 검증·별도 Blender 재열기를 확인했습니다. 검증한 Apple Silicon DMG를 제공합니다.' },
  { feature: '로컬 이미지 편집·스프라이트·아틀라스', status: 'Windows 실제 확인', tone: 'verified', detail: '원본 보존과 새 버전 저장, 출력 이미지와 JSON을 확인했습니다.' },
  { feature: 'Blender 기본 소품 생성·3D 미리보기', status: 'Windows 실제 확인', tone: 'verified', detail: '네이티브 앱에서 생성과 렌더를 확인하고, 새 Blender 프로세스에서 산출물을 4회 다시 열어 검사했습니다.' },
  { feature: 'Mac 0.1.6 게임 에셋 묶음', status: 'Mac 백엔드 제작 확인', tone: 'experimental', detail: 'GPT-5.5에 텍스트 구성안을 요청하고, 개별 이름·설명·참고 자료와 포함 여부를 수정해 한 번에 큐에 제출하는 흐름입니다. Mac 네이티브 백엔드에서 개별 PNG 5장과 모델 2개의 제작·저장·재열기·독립 내보내기를 확인했습니다.' },
  { feature: 'Mac Blender 게임 소품 작업자', status: '작업자·산출물 확인', tone: 'verified', detail: '검·소총·우주선·배럴·바위·나무를 실제 생성하고 GLB·.blend를 별도 Blender 프로세스에서 다시 열었습니다. Mac 작업자 검사이며, 게임 묶음의 데스크톱 전체 흐름과 구분합니다.' },
  { feature: 'Windows·Mac · 로컬 이미지 → 3D', status: 'CPU 산출물 확인', tone: 'experimental', detail: '이미지마다 독립 메시를 만들고 기존 GLB는 원본을 보존해 다듬습니다. 게임용·고해상도·LOD, UV 텍스처·Blender 원본·턴테이블을 저장합니다. 최소 16GB RAM과 Blender가 필요합니다. Windows CPython 3.12.10은 앱이 준비하며 Mac은 CPython 3.9를 사용합니다. 한 장으로 추정한 형상의 정확도는 입력에 따라 달라집니다.' },
  { feature: '밝기 기반 노멀맵', status: '실험 기능', tone: 'experimental', detail: '이미지 밝기에서 표면 방향을 근사합니다. 실제 표면 구조를 복원하는 기능은 아닙니다.' },
  { feature: 'GPT-6.1 Sol 추론·GPT Image2 구독 요청', status: 'Windows·Mac 실제 수신 확인', tone: 'verified', detail: 'Windows 0.1.2와 Mac 0.1.5 구현에서 각각 새 PNG 한 장의 수신·저장·재열기·독립 내보내기를 확인했습니다. 실제 이미지 모델 ID와 다른 계정의 권한은 미확인입니다.' },
  { feature: 'Codex가 없는 기기의 관리형 준비', status: 'Mac 공식 패키지 준비 확인', tone: 'verified', detail: 'Apple Silicon 공식 패키지의 크기·해시·OpenAI 서명·실행 권한·등록을 실제 확인했습니다. 다운로드 동의·취소·압축 경로 검사도 통과했습니다. Windows의 신규 다운로드 실증은 별도 기록합니다.' },
  { feature: 'macOS 로컬 2D·구독 연결·앱 내부 업데이트', status: 'Apple Silicon 실제 확인', tone: 'verified', detail: '0.1.6은 게임 에셋 묶음과 개별 이미지·모델 제작을 추가합니다. GPT 구독 연결과 공식 Codex 준비를 지원합니다. 0.1.4부터 서명·버전을 검증해 앱을 교체하고 재실행합니다. 프로젝트·원본을 보존합니다. Mac 3D 작업자와 네이티브 백엔드의 게임 묶음 제작을 확인했습니다.' },
];

const faqs = [
  { question: '개발 도구를 설치해야 하나요?', answer: '아니요. 설치 파일을 실행하고 안내를 따르면 됩니다. Node.js나 Rust는 앱 사용에 필요하지 않습니다. Windows WebView2 Runtime은 필요하며 자동 다운로드하지 않습니다. 3D 소품을 만들 때는 Blender 5.2.1을 별도로 설치해 주세요.' },
  { question: '기존 버전은 어떻게 업데이트하나요?', answer: 'Windows 설치 사용자는 앱에서 0.1.9로 업데이트하세요. Mac 0.1.4 이상은 기존 0.1.8 업데이트를 사용합니다. Mac 0.1.3 이하와 Windows 초기 포터블은 최신 설치본을 한 번 직접 설치하세요. 업데이트 패널에서 승인하면 서명·버전·크기·SHA-256 검사 후 설치하고 재실행합니다. 프로젝트와 원본은 보존합니다.' },
  { question: 'Codex를 설치하지 않았는데 구독 연결을 할 수 있나요?', answer: 'Windows 0.1.9와 Apple Silicon Mac 0.1.8의 구독 연결 화면에서 Codex 준비 → 공식 계정 연결 → 연결 확인 순서로 진행하세요. 플랫폼에 맞는 공식 Codex 0.160.0 배포본의 출처·용량·SHA-256·라이선스를 확인하고 동의하면 앱 전용 공간에 준비합니다. OpenAI 서명이 유효한 기존 Codex가 있으면 재사용하고, 로그인은 OpenAI 공식 페이지에서 진행합니다.' },
  { question: 'AI 계정 없이도 사용할 수 있나요?', answer: '네. 로컬 이미지 편집, 스프라이트·아틀라스 제작, Blender 기본 소품 생성에는 외부 AI 계정이 필요하지 않습니다. GPT Image2 구독 연결은 별도 기능이며 0.1.2에서 Windows 새 이미지 한 장의 수신부터 재열기까지 확인했습니다. 공식 Codex 로그인과 계정 이용 권한이 필요하며 유료 API로 자동 대체하지 않습니다.' },
  { question: '원본 파일이나 이전 결과가 덮어써지나요?', answer: '입력한 원본을 보존하고 처리 결과를 새 버전으로 저장합니다. 프로젝트에서 버전을 비교하고 원하는 결과를 내보낼 수 있습니다. 중요한 프로젝트는 일반 파일과 마찬가지로 별도 백업을 권장합니다.' },
  { question: '게임 설명과 프로젝트 폴더로 에셋을 만들 수 있나요?', answer: 'Windows·Mac 0.1.8은 게임 에셋 제작 → 게임 프로젝트 루트 연결 → 게임 설명 → 필요한 에셋 분석 → 필요한 에셋 모두 제작 → 결과 검수가 기본 흐름입니다. 상대 파일 목록과 누락 참조를 참고하고 소스 코드 내용은 GPT에 전송하지 않습니다. Windows는 개별 이미지를 제작하며, Apple Silicon Mac은 이미지에서 3D도 제작합니다. 기존 파일을 보존하고 새 결과 폴더에 저장합니다. 한 계획은 최대 120개 시각 에셋이며 생략한 요구 사항은 경고로 표시합니다.', link: `${sourceUrl}/blob/master/docs/game-production.md`, label: '프로젝트에서 제작하는 흐름' },
  { question: '구성안 모델과 이미지 제작 모델은 같은가요?', answer: 'GPT-5.5는 텍스트 제작 목록을 계획하고, GPT-6.1 Sol이 공식 구독 경로의 GPT Image 2 요청을 담당합니다. Mac 0.1.8의 3D 항목은 개별 참고 이미지 → 로컬 TripoSR → Blender 변환과 검증으로 이어집니다. 실제 메시를 직접 GPT에서 받는 기능은 아닙니다. 이전 0.1.6의 묶음 모델은 기존 Blender 고정 레시피를 사용합니다. 응답에 실제 이미지 모델 ID가 없으면 미확인으로 기록합니다.' },
  { question: '요청 이미지 수는 모델까지 합친 수인가요?', answer: '요청 이미지 수는 이미지·스프라이트·텍스처 행의 정확한 수이며, 혼합 구성의 모델 행은 별도로 셉니다. 2D 행마다 이름과 설명이 다른 오브젝트 하나를 개별 PNG로 요청합니다. 구성안에서 행을 추가·삭제하거나 제외한 뒤에는 포함한 이미지·모델 행 수가 실제 제출 수입니다.' },
  { question: '참고 이미지나 GLB는 어떻게 사용하나요?', answer: 'PNG·JPEG·WebP와 검증 가능한 GLB를 합쳐 최대 5개를 직접 선택하고, 이미지·미리보기·메타데이터의 외부 전송에 동의합니다. GLB는 측정한 메시 치수·정점 수·삼각형 수와 이미 있는 썸네일로 참고합니다. 임의 모델의 형상을 재구성·편집하거나 원본 메시를 코드로 실행하는 기능은 제공하지 않습니다.' },
  { question: '어떤 3D 결과물을 받을 수 있나요?', answer: 'Windows 0.1.9와 Mac 0.1.8은 제작 목록의 3D 항목마다 GPT 참고 이미지를 만들고 로컬 모델로 변환합니다. 게임용 GLB·LOD·텍스처는 새 프로젝트 결과 폴더에 저장하고, 고해상도 형상·편집 가능한 .blend·미리보기는 로컬 보관함에도 남깁니다. 기존 이미지·GLB를 최대 5개씩 다듬는 별도 도구도 제공합니다.', link: `${sourceUrl}/blob/master/docs/model-quality.md`, label: '이미지에서 3D·모델 다듬기 안내' },
  { question: '현재 Tripo Studio와 같은 모델인가요?', answer: '구형 오픈 모델 TripoSR을 사용합니다. 한 장에서 보이지 않는 뒷면을 추정하고 얇거나 각진 물체는 형태가 흐려질 수 있습니다. 8K·자동 리깅·쿼드 리토폴로지는 제공하지 않습니다. Windows는 최초 동의 후 Python·CPU 라이브러리·모델을 약 1.89GiB 내려받습니다. 준비 후 Windows·Mac CPU에서 로컬 실행하며 입력 이미지를 외부에 전송하거나 유료 API로 대체하지 않습니다.' },
  { question: 'Windows에서 실행 경고가 나면 어떻게 하나요?', answer: 'Windows Authenticode 코드 서명이 없는 초기 공개 빌드여서 SmartScreen 경고가 나타날 수 있습니다. 업데이트 파일의 암호학적 서명과 Windows 코드 서명은 다릅니다. GitHub 공식 릴리스와 다운로드 섹션의 SHA-256을 확인해 주세요.' },
  { question: 'Mac에는 어떻게 설치하나요?', answer: '아래 Mac 다운로드의 터미널 명령을 사용하면 스크립트와 DMG를 검증하고 사용자 Applications에 새 앱을 설치합니다. Apple 계정이나 관리자 암호는 필요하지 않습니다. 브라우저로 DMG를 받은 경우에는 앱을 복사한 뒤 시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기로 최초 실행을 허용하세요. Apple 공증은 없으며 업데이트 파일의 서명과는 별개입니다.' },
  { question: 'Mac에서도 구독 연결과 3D를 사용할 수 있나요?', answer: 'Apple Silicon Mac 0.1.8은 GPT 구독 연결과 공식 Codex 준비를 지원합니다. 앱 내부 업데이트는 0.1.4부터 지원합니다. Mac Blender 작업자는 새 게임 레시피의 실제 생성과 GLB·.blend 재열기를 검증했습니다. Mac 네이티브 백엔드에서 개별 PNG 5장·모델 2개의 제작·저장·재열기·내보내기를 확인했습니다.' },
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
          <p className="hero-purpose">게임을 설명하고,<br />필요한 에셋을 한 번에.</p>
          <p className="hero-description">프로젝트 연결 → GPT 제작 목록 → 개별 이미지·3D 생성 → 결과 검수. Windows에서도 로컬 이미지→3D를 사용할 수 있습니다. Windows {release.version} · Mac {macReleases[0]?.version}을 내려받으세요.</p>
          <div className="hero-actions"><DownloadLink /><MacDownloadLink /></div>
          <p className="download-hint">Windows x64 · Mac Apple Silicon<br /><a href="#requirements">Windows는 WebView2 필요 · 3D는 Blender 별도 설치</a></p>
          <a className="text-link mac-hero-link" href="#download-mac">Mac 설치·업데이트 안내 <ArrowDownToLine size={16} aria-hidden="true" /></a>
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
          <div className="section-heading workbench-heading"><h2 id="workbench-title">설명하고 제작하고,<br />결과를 확인하세요.</h2><p>게임 설명과 폴더 연결로 시작합니다. GPT로 제작 목록을 만들고 개별 결과를 검수하세요. Windows와 Mac에서 이미지·3D·혼합을 선택할 수 있습니다.</p></div>
          <figure className="workstation-figure">
            <div className="workstation-title"><span><Image size={17} aria-hidden="true" />기존 편집 도구</span><span className="preview-label">0.1.3 브라우저 미리보기</span></div>
            <button ref={screenshotTrigger} className="screenshot-button" aria-label="Asset Studio 브라우저 미리보기 화면 크게 보기" onClick={() => screenshotDialog.current?.showModal()}>
              <img src="/media/workstation-browser-013.png" alt="Asset Studio의 브라우저 미리보기. 왼쪽 프로젝트 목록, 가운데 이미지 라이브러리, 오른쪽 편집 속성, 아래 작업 큐가 보입니다." width="1500" height="960" loading="lazy" />
              <span className="expand-label"><Expand size={16} aria-hidden="true" />화면 크게 보기</span>
            </button>
            <figcaption><span>공개 0.1.3의 편집 화면 · 최신 제작 홈과 구분</span><span>이미지 편집 · 라이브러리 · 버전 · 작업 큐</span></figcaption>
          </figure>
          <div className="workbench-details">
            <dl className="editing-list"><div><dt><Image size={22} aria-hidden="true" />GPT와 제작 목록 준비</dt><dd>공식 구독을 연결하고 게임의 장르·시점·스타일을 설명하세요. 기존 프로젝트의 에셋 목록과 누락 참조를 참고해 제작 범위를 제안합니다.</dd></div><div><dt><Layers size={22} aria-hidden="true" />필요한 에셋을 개별 파일로</dt><dd>각 이미지와 3D 참고 이미지를 독립 요청합니다. 3D는 로컬 TripoSR와 Blender로 변환하고 게임용 GLB·LOD·텍스처를 새 폴더에 저장합니다.</dd></div><div><dt><Box size={22} aria-hidden="true" />결과 확인과 선택한 에셋 개선</dt><dd>완료된 카드에서 결과를 살펴보고 검수 승인하세요. 개선할 결과만 참고 자료로 선택해 새로 제작할 수 있습니다. 기존 게임 파일과 이전 결과는 유지합니다.</dd></div></dl>
            <aside className="workspace-note"><PackageOpen size={26} aria-hidden="true" /><h3>다음 작업도 이어서.</h3><p>프로젝트와 작업 큐를 로컬에 저장합니다. 자원별 처리, 취소·복구·캐시로 반복 제작을 관리하세요.</p><p>큰 글씨와 앱 안의 사용 가이드로 시작할 수 있습니다. Node.js·Rust 설치는 필요 없습니다.</p><a className="text-link" href="#download">내 컴퓨터에 작업대 준비 <ArrowDownToLine size={17} aria-hidden="true" /></a></aside>
          </div>
        </div>
      </section>

      <section className="workflow-section" aria-labelledby="workflow-title">
        <div className="page-width workflow-layout">
          <div><h2 id="workflow-title">게임 설명에서<br />개별 에셋까지.</h2><p>Mac 0.1.6 게임 에셋 묶음입니다. Mac 네이티브 백엔드에서 GPT-5.5 구성안과 개별 PNG 5장·GLB 모델 2개의 제작·저장·재열기·내보내기를 확인했습니다.</p><a className="text-link" href={`${sourceUrl}/blob/master/docs/game-asset-bundles.md`}>묶음 제작 안내 <ArrowUpRight size={16} aria-hidden="true" /></a></div>
          <ol className="workflow-steps">
            <li><span className="step-number" aria-hidden="true">1</span><div><h3>게임 설명 · 참고 자료</h3><p>출력 구성을 고르고 필요한 이미지 수를 입력하세요. PNG·JPEG·WebP와 GLB를 합쳐 최대 5개를 선택하고 외부 전송에 동의합니다.</p></div></li>
            <li><span className="step-number" aria-hidden="true">2</span><div><h3>개별 항목 검토</h3><p>GPT-5.5의 텍스트 구성안에서 이름·설명·용도와 포함 여부를 수정합니다. 이미지 수와 모델 수를 따로 확인하고, 모델의 레시피·치수·베벨·색상을 정하세요.</p></div></li>
            <li><span className="step-number" aria-hidden="true">3</span><div><h3>승인 후 큐 제출</h3><p>검토한 에셋 묶음 제작으로 포함한 행 전체를 한 번에 등록합니다. 각 2D 행은 오브젝트 하나의 개별 PNG를 요청하며, 실제 결과를 확인한 뒤 내보냅니다.</p></div></li>
          </ol>
        </div>
      </section>

      <section id="outputs" className="outputs-section section-space page-width" aria-labelledby="outputs-title">
        <div className="section-heading"><div><h2 id="outputs-title">치수로 만들고,<br />파일로 확인하세요.</h2><p>상자·테이블·선반. 실제 생성한 Blender 소품의 렌더입니다.</p></div><a className="text-link" href={`${sourceUrl}/tree/master/examples/procedural`}>예제 산출물 보기 <ArrowUpRight size={16} aria-hidden="true" /></a></div>
        <div className="model-gallery">{models.map(model => <figure className="model-specimen" key={model.type}><div className="model-file"><Box size={15} aria-hidden="true" /><span>{model.filename}</span></div><img src={model.src} alt={`${model.name} 템플릿으로 실제 생성한 Blender 3D 렌더`} width="512" height="512" loading="lazy" /><figcaption><div><h3>{model.name}</h3><span>{model.type}</span></div><p>{model.text}</p></figcaption></figure>)}</div>
        <div className="output-note"><Box size={23} strokeWidth={1.5} aria-hidden="true" /><p>Mac 0.1.6의 고정 레시피: 상자·테이블·선반·검·소총·우주선·배럴·바위·나무.<br />너비·깊이·높이·베벨·색상을 바꿔 새 독립 모델을 만들고 GLB, .blend, 썸네일과 턴테이블을 저장합니다.</p><span>Blender 5.2.1 필요</span></div>
      </section>

      <section className="status-section section-space" aria-labelledby="status-title">
        <div className="page-width status-layout">
          <div className="status-intro"><h2 id="status-title">확인한 만큼,<br />정확하게.</h2><p>공개 Windows v{release.version} · Mac v{macReleases[0]?.version}의 기능별 확인 범위입니다. 작업자 산출물 검사와 네이티브 데스크톱 전체 흐름을 구분해 적었습니다.</p><a className="text-link" href={`${sourceUrl}/blob/master/docs/verification.md`}>검증 기록 읽기 <ArrowUpRight size={16} aria-hidden="true" /></a></div>
          <dl className="status-list">{statuses.map(item => <div key={item.feature} className="status-item"><dt>{item.feature}<span className={`status-label ${item.tone}`}>{item.tone === 'verified' && <Check size={13} aria-hidden="true" />}{item.status}</span></dt><dd>{item.detail}</dd></div>)}</dl>
        </div>
      </section>

      <section id="download" className="download-section section-space page-width" aria-labelledby="download-title">
        <nav className="platform-picker" aria-label="운영체제별 다운로드"><a href="#download-windows">Windows x64</a><a href="#download-mac">Mac Apple Silicon</a></nav>
        <div id="download-windows" className="download-card">
          <div className="download-main"><div className="download-heading-mark"><Mark /><span>Windows x64 · v{release.version}</span></div><h2 id="download-title">당신의 작업실을<br />준비하세요.</h2><p>설치 파일을 실행하고 안내를 따르세요.<br />앱 안의 사용 가이드로 시작할 수 있습니다.</p><DownloadLink secondary /><a className="portable-link" href={portableUrl}>설치 없이 쓰는 포터블 ZIP</a><a className="release-link" href={releaseUrl}>v{release.version} 릴리스 기록 <ArrowUpRight size={14} aria-hidden="true" /></a></div>
          <div id="requirements" className="download-requirements"><h3>받기 전에 확인해 주세요</h3><dl><div><dt>운영체제</dt><dd>Windows x64</dd></div><div><dt>앱 실행</dt><dd>Microsoft WebView2 Runtime</dd></div><div><dt>이미지→3D</dt><dd>16GB RAM · Blender 5.2.1 · Visual C++ x64 런타임</dd></div><div><dt>첫 3D 준비</dt><dd>앱에서 동의 후 약 1.89GiB 다운로드 · Python 자동 준비</dd></div><div><dt>배포 형태</dt><dd>설치형 · 앱 내부 업데이트</dd></div><div><dt>파일 크기</dt><dd>{release.bytes.toLocaleString('en-US')} bytes <span>(약 {sizeMiB} MiB)</span></dd></div></dl><p className="unsigned-note">업데이트 파일에는 암호학적 서명이 있습니다. Windows 코드 서명은 없어 실행 경고가 나타날 수 있습니다. 공식 릴리스와 파일 해시를 확인해 주세요.</p></div>
        </div>
        <div className="checksum-row"><div className="checksum-heading"><span>설치 파일 SHA-256</span><button type="button" onClick={copyChecksum}>{copyState === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{copyState === 'copied' ? '복사됨' : '해시 복사'}</button></div><code ref={checksumElement}>{release.sha256}</code><p className="copy-result" role="status" aria-live="polite">{copyState === 'copied' ? 'SHA-256 해시를 복사했습니다.' : copyState === 'failed' ? '해시를 선택했습니다. 선택한 텍스트를 직접 복사해 주세요.' : ''}</p></div>
        <section id="download-mac" className="mac-download" aria-labelledby="mac-download-title">
          <div className="mac-download-heading"><h3 id="mac-download-title">Mac 다운로드</h3><span className="mac-trial-label">정식 배포 · v{macReleases[0]?.version}</span></div>
          <p className="mac-download-intro">Apple Silicon용 v{macReleases[0]?.version}. 프로젝트 기반 2D·3D 제작·GPT 구독 연결·결과 검수·앱 내부 업데이트를 지원합니다. 0.1.4 이상 사용자는 앱에서 업데이트하고, 0.1.3 이하는 아래 방법으로 새 버전을 한 번 설치하세요.</p>
          {hasMacRelease ? <div className="mac-release-grid">{macReleases.map(item => <article className="mac-release" key={item.architecture} aria-label={`${item.label} 다운로드`}>
            <h4>{item.label} · v{item.version}</h4><p>M 시리즈 Mac용 · GPT 구독 연결 · 앱 내부 업데이트</p>
            <a className="button button-primary" href={item.downloadUrl} aria-label={`${item.label} DMG 다운로드`}><ArrowDownToLine size={18} aria-hidden="true" />DMG 다운로드</a>
            <dl><div><dt>파일</dt><dd>{item.filename}</dd></div><div><dt>용량</dt><dd>{item.bytes.toLocaleString('en-US')} bytes · {(item.bytes / 1_048_576).toFixed(2)} MiB</dd></div><div><dt>SHA-256</dt><dd><code>{item.sha256}</code></dd></div></dl>
          </article>)}</div> : <p className="mac-release-pending">다운로드 파일을 확인 중입니다. 실행 검증을 마치면 Apple Silicon용 DMG를 이곳에 공개합니다.</p>}
          <div className="mac-install-guide">
            <div><h4>Apple 계정 없이 터미널로 설치</h4><ol><li>기존 앱을 닫고 아래 명령을 터미널에 붙여 넣습니다.</li><li>파일 검증과 설치 위치 안내를 확인하고 y를 입력합니다.</li><li>~/Applications/Asset Studio 0.1.8의 새 앱을 사용합니다.</li></ol><p>스크립트와 DMG의 SHA-256을 확인한 뒤 새 사본을 설치합니다. 기존 앱·프로젝트는 보존하며 관리자 암호는 필요하지 않습니다.</p></div>
            <div className="mac-install-notes"><h4>브라우저로 DMG를 받은 경우</h4><p>홈 폴더의 Applications 안에 Asset Studio 0.1.8 폴더를 만들고 앱을 복사하세요. DMG 안에서 직접 실행하지 마세요.</p><p>Apple 공증이 없어 확인 경고가 나타날 수 있습니다. 경고를 닫은 뒤 <strong>시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기 → 열기</strong>를 선택하세요. <a href={`${sourceUrl}/blob/master/docs/macos-quickstart.md`}>자세한 설치 안내</a></p><p>업데이트 파일은 별도의 키로 서명합니다. Apple 공증과는 별개이며, 시스템 전체 Gatekeeper를 끌 필요는 없습니다.</p><p>macOS 12는 설정상 최소값입니다. GPT 연결은 공식 Codex의 운영체제 요구 사항도 따릅니다. Mac Blender 작업자는 검증했으며, Mac 네이티브 백엔드의 게임 묶음 제작을 확인했습니다.</p></div>
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
