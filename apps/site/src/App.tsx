import { useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Box, Check, Copy, Expand, FileImage, FolderOpen, Github, Layers, ShieldCheck, Sparkles, Terminal, X } from 'lucide-react';

import { macInstallCommand, macReleases, release } from './release';

const sourceUrl = 'https://github.com/oocheol/masset';
const releaseUrl = `${sourceUrl}/releases/tag/v${release.version}`;
const latestReleaseUrl = `${sourceUrl}/releases/latest`;
const downloadUrl = `${sourceUrl}/releases/download/v${release.version}/${release.filename}`;
const portableUrl = `${sourceUrl}/releases/download/v${release.version}/${release.portableFilename}`;
const sizeMiB = (release.bytes / 1_048_576).toFixed(2);
const hasMacRelease = macReleases.length > 0;
const skillVersion = '0.1.12';
const skillDownloadUrl = `${sourceUrl}/releases/download/v${skillVersion}/AssetStudio_${skillVersion}_codex-plugin-windows-macos.zip`;
const skillInstallCommand = 'npx @oocheol/asset-studio@latest install';

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
  { feature: 'Windows 0.1.12 · 새 디자인과 앱 없이 Codex에서 제작', status: 'Windows CLI 실제 확인', tone: 'verified', detail: '독립 스킬과 CLI가 기존 공식 Codex 로그인을 재사용합니다. 필요한 도구는 승인 후 사용자 전용 공간에 준비합니다. 0.1.12 CLI에서 실제 이미지 편집·저장·별도 프로세스 재열기·내보내기를 확인했습니다. CPU TripoSR 생성과 Blender의 GLB·.blend 재열기는 0.1.11에서 실증했습니다. 앱의 이미지·3D·혼합 제작도 유지합니다. 새로운 GPT 요청은 보내지 않았습니다.' },
  { feature: 'Mac 0.1.12 · 제작과 결과 검수 중심의 새 화면', status: 'Mac 0.1.12 제공', tone: 'experimental', detail: '제작 입력·연결 상태·개별 진행률과 검수를 중심으로 화면을 정리했습니다. 보관함과 결과 화면을 오가도 제작 입력을 보존합니다. Mac DMG와 서명된 업데이트를 제공합니다. npm 스킬은 0.1.12이며 Mac 독립 CLI는 기존 0.1.11을 유지합니다. 잠금 상태로 Mac 화면과 설치·업데이트 교체 실행 검증을 생략했습니다.' },
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
  { question: 'npm으로 설치하면 Asset Studio 앱 없이 Codex에서 쓸 수 있나요?', answer: '네. npm으로 Codex 스킬을 설치하면 Asset Studio 앱을 설치하거나 열지 않고 사용할 수 있습니다. Codex가 필요하며 npm 설치에는 Node.js 22.20 이상을 사용하세요. 설치 후 새 Codex 작업에서 $asset-studio로 요청합니다. 기존 공식 Codex 로그인을 재사용하고, 처리용 CLI는 첫 사용 시 다운로드 동의를 받아 준비합니다. 3D를 요청할 때만 Blender·Python·모델을 추가로 준비합니다. Windows x64와 Apple Silicon Mac을 지원합니다.', link: `${sourceUrl}/blob/master/docs/skill-first-setup.md`, label: '앱 없이 시작하기' },
  { question: 'npm 전역 설치 후에는 무엇을 실행하나요?', answer: 'npm install --global @oocheol/asset-studio로 설치했다면 asset-studio-skill install을 한 번 실행해 Codex 스킬을 등록하세요. 그다음 새 Codex 작업을 열면 됩니다. 상단 npx 명령은 설치와 스킬 등록을 함께 진행합니다.', link: `${sourceUrl}/blob/master/docs/skill-first-setup.md`, label: 'npm 설치·스킬 등록 안내' },
  { question: 'npm으로 설치한 스킬은 어떻게 업데이트하나요?', answer: '터미널에서 npx @oocheol/asset-studio@latest update를 실행하세요. 이전 스킬은 별도 폴더에 백업하며, 같은 버전의 파일이 온전하면 그대로 유지합니다. npm 설치 기능 버전과 Windows·Mac 실행 도구 버전은 별도로 관리합니다.', link: `${sourceUrl}/blob/master/docs/skill-first-setup.md`, label: '스킬 설치·업데이트 안내' },
  { question: 'Codex가 게임을 만들면서 에셋도 제작할 수 있나요?', answer: '스킬을 설치하고 $asset-studio 게임을 만들어줘라고 요청하세요. Codex가 필요한 개별 에셋을 제작해 게임 엔진에 반영하고 실행·검증하는 흐름입니다. 별도 MCP 서버나 유료 API 키는 필요하지 않습니다. 스킬 자체는 지침과 설치 진입점이며 실제 에셋 처리는 자동 준비한 CLI가 수행합니다. 게임 완성은 엔진에서 실행해 확인해야 합니다.', link: `${sourceUrl}/blob/master/docs/codex-integration.md`, label: 'Codex 연동 안내' },
  { question: '개발 도구를 설치해야 하나요?', answer: 'Node.js나 Rust는 앱 사용과 스킬 ZIP 설치에 필요하지 않습니다. npx로 스킬을 설치하려면 Node.js 22.20 이상이 필요합니다. Windows 앱에는 WebView2 Runtime이 필요하며 자동 다운로드하지 않습니다. 3D 소품을 만들 때는 Blender 5.2.1을 별도로 설치해 주세요.' },
  { question: '기존 버전은 어떻게 업데이트하나요?', answer: 'Windows 설치 사용자는 앱에서 0.1.12로 업데이트하세요. Mac 0.1.4 이상은 앱에서 0.1.12로 업데이트하세요. Mac 0.1.3 이하와 Windows 초기 포터블은 최신 설치본을 한 번 직접 설치하세요. 업데이트 패널에서 승인하면 서명·버전·크기·SHA-256 검사 후 설치하고 재실행합니다. 프로젝트와 원본은 보존합니다.' },
  { question: 'Codex를 설치하지 않았는데 구독 연결을 할 수 있나요?', answer: 'Windows 0.1.12과 Apple Silicon Mac 0.1.12의 구독 연결 화면에서 Codex 준비 → 공식 계정 연결 → 연결 확인 순서로 진행하세요. 플랫폼에 맞는 공식 Codex 0.160.0 배포본의 출처·용량·SHA-256·라이선스를 확인하고 동의하면 앱 전용 공간에 준비합니다. OpenAI 서명이 유효한 기존 Codex가 있으면 재사용하고, 로그인은 OpenAI 공식 페이지에서 진행합니다.' },
  { question: 'AI 계정 없이도 사용할 수 있나요?', answer: '네. 로컬 이미지 편집, 스프라이트·아틀라스 제작, Blender 기본 소품 생성에는 외부 AI 계정이 필요하지 않습니다. GPT Image2 구독 연결은 별도 기능이며 0.1.2에서 Windows 새 이미지 한 장의 수신부터 재열기까지 확인했습니다. 공식 Codex 로그인과 계정 이용 권한이 필요하며 유료 API로 자동 대체하지 않습니다.' },
  { question: '원본 파일이나 이전 결과가 덮어써지나요?', answer: '입력한 원본을 보존하고 처리 결과를 새 버전으로 저장합니다. 프로젝트에서 버전을 비교하고 원하는 결과를 내보낼 수 있습니다. 중요한 프로젝트는 일반 파일과 마찬가지로 별도 백업을 권장합니다.' },
  { question: '게임 설명과 프로젝트 폴더로 에셋을 만들 수 있나요?', answer: 'Windows 0.1.12과 Mac 0.1.12은 게임 에셋 제작 → 게임 프로젝트 루트 연결 → 게임 설명 → 필요한 에셋 분석 → 필요한 에셋 모두 제작 → 결과 검수가 기본 흐름입니다. 상대 파일 목록과 누락 참조를 참고하고 소스 코드 내용은 GPT에 전송하지 않습니다. Windows와 Apple Silicon Mac에서 개별 이미지와 이미지 기반 3D를 제작합니다. 기존 파일을 보존하고 새 결과 폴더에 저장합니다. 한 계획은 최대 120개 시각 에셋이며 생략한 요구 사항은 경고로 표시합니다.', link: `${sourceUrl}/blob/master/docs/game-production.md`, label: '프로젝트에서 제작하는 흐름' },
  { question: '구성안 모델과 이미지 제작 모델은 같은가요?', answer: 'GPT-5.5는 텍스트 제작 목록을 계획하고, GPT-6.1 Sol이 공식 구독 경로의 GPT Image 2 요청을 담당합니다. Mac 0.1.12의 3D 항목은 개별 참고 이미지 → 로컬 TripoSR → Blender 변환과 검증으로 이어집니다. 실제 메시를 직접 GPT에서 받는 기능은 아닙니다. 이전 0.1.6의 묶음 모델은 기존 Blender 고정 레시피를 사용합니다. 응답에 실제 이미지 모델 ID가 없으면 미확인으로 기록합니다.' },
  { question: '요청 이미지 수는 모델까지 합친 수인가요?', answer: '요청 이미지 수는 이미지·스프라이트·텍스처 행의 정확한 수이며, 혼합 구성의 모델 행은 별도로 셉니다. 2D 행마다 이름과 설명이 다른 오브젝트 하나를 개별 PNG로 요청합니다. 구성안에서 행을 추가·삭제하거나 제외한 뒤에는 포함한 이미지·모델 행 수가 실제 제출 수입니다.' },
  { question: '참고 이미지나 GLB는 어떻게 사용하나요?', answer: 'PNG·JPEG·WebP와 검증 가능한 GLB를 합쳐 최대 5개를 직접 선택하고, 이미지·미리보기·메타데이터의 외부 전송에 동의합니다. GLB는 측정한 메시 치수·정점 수·삼각형 수와 이미 있는 썸네일로 참고합니다. 임의 모델의 형상을 재구성·편집하거나 원본 메시를 코드로 실행하는 기능은 제공하지 않습니다.' },
  { question: '어떤 3D 결과물을 받을 수 있나요?', answer: 'Windows 0.1.12과 Mac 0.1.12은 제작 목록의 3D 항목마다 GPT 참고 이미지를 만들고 로컬 모델로 변환합니다. 게임용 GLB·LOD·텍스처는 새 프로젝트 결과 폴더에 저장하고, 고해상도 형상·편집 가능한 .blend·미리보기는 로컬 보관함에도 남깁니다. 기존 이미지·GLB를 최대 5개씩 다듬는 별도 도구도 제공합니다.', link: `${sourceUrl}/blob/master/docs/model-quality.md`, label: '이미지에서 3D·모델 다듬기 안내' },
  { question: '현재 Tripo Studio와 같은 모델인가요?', answer: '구형 오픈 모델 TripoSR을 사용합니다. 한 장에서 보이지 않는 뒷면을 추정하고 얇거나 각진 물체는 형태가 흐려질 수 있습니다. 8K·자동 리깅·쿼드 리토폴로지는 제공하지 않습니다. Windows는 최초 동의 후 Python·CPU 라이브러리·모델을 약 1.89GiB 내려받습니다. 준비 후 Windows·Mac CPU에서 로컬 실행하며 입력 이미지를 외부에 전송하거나 유료 API로 대체하지 않습니다.' },
  { question: 'Windows에서 실행 경고가 나면 어떻게 하나요?', answer: 'Windows Authenticode 코드 서명이 없는 초기 공개 빌드여서 SmartScreen 경고가 나타날 수 있습니다. 업데이트 파일의 암호학적 서명과 Windows 코드 서명은 다릅니다. GitHub 공식 릴리스와 다운로드 섹션의 SHA-256을 확인해 주세요.' },
  { question: 'Mac에는 어떻게 설치하나요?', answer: '아래 Mac 다운로드의 터미널 명령을 사용하면 스크립트와 DMG를 검증하고 사용자 Applications에 새 앱을 설치합니다. Apple 계정이나 관리자 암호는 필요하지 않습니다. 브라우저로 DMG를 받은 경우에는 앱을 복사한 뒤 시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기로 최초 실행을 허용하세요. Apple 공증은 없으며 업데이트 파일의 서명과는 별개입니다.' },
  { question: 'Mac에서도 구독 연결과 3D를 사용할 수 있나요?', answer: 'Apple Silicon Mac 0.1.12은 GPT 구독 연결과 공식 Codex 준비를 지원합니다. 앱 내부 업데이트는 0.1.4부터 지원합니다. Mac Blender 작업자는 새 게임 레시피의 실제 생성과 GLB·.blend 재열기를 검증했습니다. Mac 네이티브 백엔드에서 개별 PNG 5장·모델 2개의 제작·저장·재열기·내보내기를 확인했습니다.' },
  { question: '오류를 제보하거나 소스를 볼 수 있나요?', answer: '소스 코드와 검증 기록을 GitHub에 공개합니다. 문제가 생기면 운영체제, 앱 버전, 작업 종류와 재현 순서를 이슈에 남겨 주세요. 계정 토큰이나 개인 원본 파일은 포함하지 마세요.', link: `${sourceUrl}/issues`, label: 'GitHub 이슈 열기' },
];

export default function App() {
  const [inspectedModel, setInspectedModel] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [installCopyState, setInstallCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [skillCopyState, setSkillCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const installCommandElement = useRef<HTMLElement>(null);
  const skillCommandElement = useRef<HTMLElement>(null);
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

  async function copySkillInstall() {
    try {
      await navigator.clipboard.writeText(skillInstallCommand);
      setSkillCopyState('copied');
    } catch {
      if (skillCommandElement.current) {
        const range = document.createRange();
        range.selectNodeContents(skillCommandElement.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setSkillCopyState('failed');
    }
  }

  return <>
    <a className="skip-link" href="#main">본문으로 이동</a>
    <header className="site-header">
      <div className="header-inner page-width">
        <a href="#" className="wordmark" aria-label="Asset Studio 첫 화면"><Mark /><span>Asset Studio</span></a>
        <nav aria-label="주요 메뉴"><a href="#workbench">사용 흐름</a><a href="#outputs">결과 예시</a><a href="#download" className="header-start">시작하기 <ArrowRight size={15} aria-hidden="true"/></a></nav>
        <a className="header-source" href={sourceUrl} aria-label="GitHub 소스 코드"><Github size={19} aria-hidden="true"/></a>
      </div>
    </header>
    <main id="main">
      <section className="hero page-width" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-dot"/> 게임 개발자를 위한 에셋 제작</p>
          <h1 id="hero-title">게임의 아이디어를,<br/><span>쓸 수 있는 에셋으로.</span></h1>
          <p className="hero-description">어떤 게임을 만들고 있나요?<br/>게임 설명과 참고 자료에서 필요한 2D 이미지와 3D 모델을<br className="desktop-break"/> 개별 파일로 제작하고, 결과를 확인하세요.</p>
          <div className="hero-actions"><a className="button button-primary" href="#download-skill"><Sparkles size={19} aria-hidden="true"/>Codex에서 시작하기 <ArrowRight size={18} aria-hidden="true"/></a><a className="button button-light" href="#download">앱 다운로드 <ArrowDownToLine size={18} aria-hidden="true"/></a></div>
          <p className="hero-platforms">Codex 스킬 · Windows · Apple Silicon Mac</p>
          <div className="hero-promise"><ShieldCheck size={18} aria-hidden="true"/><span>원본은 보존하고, 제작 결과는 새 파일로.</span></div>
        </div>
        <figure className="hero-specimens">
          <div className="inspection-header"><span><Box size={16} aria-hidden="true"/> 소품 라이브러리</span><span className="sample-label">실제 Blender 렌더</span></div>
          <div className="inspection-stage"><img src={specimen.src} alt={`${specimen.name} 템플릿으로 실제 생성한 Blender 3D 렌더`} width="512" height="512"/><div className="specimen-label"><strong>{specimen.name}</strong><span>{specimen.filename} · 512 × 512</span></div></div>
          <div className="specimen-picker" role="group" aria-label="3D 렌더 선택">{models.map((model,index)=><button key={model.type} type="button" aria-pressed={inspectedModel===index} aria-label={`${model.name} 렌더 보기`} onClick={()=>setInspectedModel(index)}><img src={model.src} alt="" width="40" height="40"/><span>{model.name}</span>{inspectedModel===index&&<Check size={15} aria-hidden="true"/>}</button>)}</div>
          <figcaption>Asset Studio의 로컬 Blender 작업자로 만든 기본 소품 예시</figcaption>
        </figure>
      </section>
      <div className="value-strip"><div className="page-width"><p><FileImage size={19} aria-hidden="true"/> 에셋마다 독립 파일</p><p><Layers size={19} aria-hidden="true"/> 2D 이미지 + 3D 모델</p><p><FolderOpen size={19} aria-hidden="true"/> 게임 프로젝트와 연결</p><p><ShieldCheck size={19} aria-hidden="true"/> 로컬 저장 · 원본 보존</p></div></div>

      <section id="workbench" className="workbench-section section-space page-width" aria-labelledby="workbench-title">
        <div className="section-heading"><div><p className="eyebrow">설명 → 제작 → 검수</p><h2 id="workbench-title">직접 그리는 시간은 줄이고,<br/>게임을 만드는 데 집중하세요.</h2></div><p>Codex에 에셋 제작을 연결하거나,<br/>앱에서 제작 목록과 결과를 한눈에 확인하세요.</p></div>
        <ol className="workflow-steps">
          <li><span className="step-number">01</span><FolderOpen size={22} aria-hidden="true"/><h3>게임과 프로젝트를 연결</h3><p>장르, 배경, 스타일을 설명하세요. 프로젝트의 에셋 목록과 누락 참조를 함께 살펴봅니다.</p></li>
          <li><span className="step-number">02</span><Sparkles size={22} aria-hidden="true"/><h3>필요한 에셋을 개별 제작</h3><p>제작 목록을 확인한 뒤 한 번에 요청하세요. 각 이미지와 3D 모델은 독립 결과로 저장합니다.</p></li>
          <li><span className="step-number">03</span><Check size={22} aria-hidden="true"/><h3>결과를 확인하고 개선</h3><p>완료한 에셋을 검수하고, 필요한 결과만 다시 제작하세요. 기존 파일과 이전 버전은 보존합니다.</p></li>
        </ol>
        <figure className="workstation-figure">
          <div className="workstation-title"><span><Sparkles size={17} aria-hidden="true"/> 제작부터 결과 확인까지</span><span className="preview-label">개선된 제작 홈 · 브라우저 미리보기</span></div>
          <button ref={screenshotTrigger} className="screenshot-button" aria-label="Asset Studio 브라우저 미리보기 화면 크게 보기" onClick={()=>screenshotDialog.current?.showModal()}><img src="/media/production-home-browser-011.jpg" alt="개선된 제작 홈의 브라우저 미리보기. 프로젝트 연결, 게임 설명, 제작할 에셋을 단계별로 확인하는 화면." width="1500" height="960" loading="lazy"/><span className="expand-label"><Expand size={16} aria-hidden="true"/>크게 보기</span></button>
          <figcaption><span>최신 디자인의 브라우저 화면입니다. 분석·생성은 데스크톱 앱에서 사용합니다.</span><a href="#verification">플랫폼별 검증 범위 <ArrowUpRight size={14} aria-hidden="true"/></a></figcaption>
        </figure>
      </section>

      <section id="outputs" className="outputs-section section-space" aria-labelledby="outputs-title"><div className="page-width">
        <div className="section-heading"><div><p className="eyebrow">내 게임에 남는 결과물</p><h2 id="outputs-title">미리보기 다음에는,<br/>실제로 쓸 파일.</h2></div><a className="text-link" href={`${sourceUrl}/tree/master/examples/procedural`}>예제 산출물 보기 <ArrowUpRight size={16} aria-hidden="true"/></a></div>
        <div className="model-gallery">{models.map(model=><figure className="model-specimen" key={model.type}><div className="model-file"><Box size={15} aria-hidden="true"/><span>{model.filename}</span><span>로컬 생성 예시</span></div><img src={model.src} alt={`${model.name} 템플릿으로 실제 생성한 Blender 3D 렌더`} width="512" height="512" loading="lazy"/><figcaption><h3>{model.name}<span>{model.type}</span></h3><p>{model.text}</p></figcaption></figure>)}</div>
        <div className="output-note"><Layers size={22} aria-hidden="true"/><div><strong>개별 이미지 · GLB 모델 · Blender 원본</strong><p>3D 제작에는 Blender와 로컬 모델 준비가 필요합니다. 이미지 한 장에서 추정한 형상과 텍스처는 결과를 검수해 주세요.</p></div><a className="text-link" href={`${sourceUrl}/blob/master/docs/image-to-3d-research.md`}>3D 제작 안내 <ArrowUpRight size={16} aria-hidden="true"/></a></div>
      </div></section>

      <section id="download" className="download-section section-space page-width" aria-labelledby="download-title">
        <div className="section-heading"><div><p className="eyebrow">나에게 맞는 방식으로 시작</p><h2 id="download-title">Codex와 함께, 또는 앱에서.</h2></div><p>기존 공식 Codex 로그인을 사용합니다.<br/>유료 API로 자동 대체하지 않습니다.</p></div>
        <nav className="platform-picker" aria-label="사용 방법별 다운로드"><a href="#download-skill">Codex 스킬</a><a href="#download-windows">Windows 앱</a><a href="#download-mac">Mac 앱</a></nav>
        <section id="download-skill" className="skill-download" aria-labelledby="skill-download-title">
          <div className="skill-download-copy"><span className="download-kicker"><Terminal size={17} aria-hidden="true"/> CODEX SKILL</span><h3 id="skill-download-title">게임을 만드는 흐름에,<br/>에셋 제작을 더하세요.</h3><p>Asset Studio 앱 없이 Codex에서 사용할 수 있습니다.<br/>스킬을 설치하고 새 Codex 작업에서 <code>$asset-studio</code>로 요청하세요.</p><p className="skill-requirements">Codex · Node.js 22.20 이상<br/>Windows x64 · Apple Silicon Mac</p></div>
          <div className="skill-download-command"><div className="command-heading"><span>터미널에서 설치</span><button type="button" aria-label="Codex 스킬 설치 명령 복사" onClick={copySkillInstall}>{skillCopyState==='copied'?<Check size={16} aria-hidden="true"/>:<Copy size={16} aria-hidden="true"/>}{skillCopyState==='copied'?'복사됨':'명령 복사'}</button></div><pre><code ref={skillCommandElement}>{skillInstallCommand}</code></pre><p className="copy-result" role="status" aria-live="polite">{skillCopyState==='copied'?'설치 명령을 복사했습니다. 터미널에 붙여 넣으세요.':skillCopyState==='failed'?'명령을 선택했습니다. 직접 복사해 주세요.':'필요한 처리 도구는 첫 사용 시 다운로드 동의를 받아 준비합니다.'}</p><div className="skill-links"><a href={`${sourceUrl}/blob/master/docs/skill-first-setup.md`}>설치·요청 안내 <ArrowUpRight size={14} aria-hidden="true"/></a><a href="https://www.npmjs.com/package/@oocheol/asset-studio">npm 패키지 <ArrowUpRight size={14} aria-hidden="true"/></a><a href={skillDownloadUrl}><ArrowDownToLine size={15} aria-hidden="true"/> 스킬 ZIP · v{skillVersion}</a></div><p className="skill-zip-note">Node.js 없이 설치하려면 ZIP의 skills/asset-studio를 ~/.agents/skills에 넣으세요. 3D를 요청할 때만 Blender·Python·모델을 추가로 준비합니다.</p></div>
        </section>
        <div className="desktop-downloads">
          <section id="download-windows" className="desktop-download-card" aria-labelledby="windows-download-title"><div className="download-card-header"><Box size={22} aria-hidden="true"/><span>Windows x64 · v{release.version}</span></div><h3 id="windows-download-title">Windows에서 제작</h3><p>Microsoft WebView2 Runtime이 필요합니다.<br/>3D 제작은 메모리 16 GB 이상과 Blender를 준비하세요.</p><DownloadLink/><a className="portable-link" href={portableUrl}>설치 없이 쓰는 포터블 ZIP <ArrowUpRight size={14} aria-hidden="true"/></a><p className="download-warning">Windows 코드 서명이 없어 실행 경고가 나타날 수 있습니다. 공식 릴리스와 파일 해시를 확인하세요.</p>
            <details className="installation-details"><summary>설치 조건과 파일 검증</summary><div id="requirements"><dl className="download-properties"><div><dt>앱 실행</dt><dd>Microsoft WebView2 Runtime</dd></div><div><dt>이미지 → 3D</dt><dd>16GB RAM · Blender 5.2.1 · Visual C++ x64 런타임</dd></div><div><dt>첫 3D 준비</dt><dd>동의 후 약 1.89GiB 다운로드 · Python 자동 준비</dd></div><div><dt>업데이트</dt><dd>앱 내부 서명 검증 · 설치 · 재실행</dd></div><div><dt>파일 크기</dt><dd>{release.bytes.toLocaleString('en-US')} bytes · {sizeMiB} MiB</dd></div></dl><div className="checksum-row"><div className="command-heading"><span>설치 파일 SHA-256</span><button type="button" onClick={copyChecksum}>{copyState==='copied'?<Check size={15} aria-hidden="true"/>:<Copy size={15} aria-hidden="true"/>}{copyState==='copied'?'복사됨':'해시 복사'}</button></div><code ref={checksumElement}>{release.sha256}</code><p role="status" aria-live="polite">{copyState==='copied'?'해시를 복사했습니다.':copyState==='failed'?'해시를 선택했습니다. 직접 복사해 주세요.':''}</p></div><a className="text-link" href={releaseUrl}>릴리스 기록 <ArrowUpRight size={14} aria-hidden="true"/></a></div></details>
          </section>
          <section id="download-mac" className="desktop-download-card" aria-labelledby="mac-download-title"><div className="download-card-header"><Box size={22} aria-hidden="true"/><span>Apple Silicon · v{macReleases[0]?.version}</span></div><h3 id="mac-download-title">Mac에서 제작</h3><p>M 시리즈 Mac용 정식 배포입니다.<br/>GPT 구독 연결 · 개별 2D·3D 제작 · 앱 내부 업데이트</p><MacDownloadLink/><a className="portable-link" href={`${sourceUrl}/blob/master/docs/macos-quickstart.md`}>Mac 설치·업데이트 안내 <ArrowUpRight size={14} aria-hidden="true"/></a><p className="download-warning">Apple 공증이 없어 첫 실행 경고가 나타날 수 있습니다. 아래 설치 안내를 확인해 주세요.</p>
            <details className="installation-details"><summary>Mac 설치 방법과 파일 검증</summary><div className="mac-install-guide"><h4>DMG로 설치</h4><ol><li>홈 폴더의 Applications 안에 Asset Studio {macReleases[0]?.version} 폴더를 만듭니다.</li><li>DMG를 열고 앱을 해당 폴더에 복사합니다. DMG 안에서 직접 실행하지 마세요.</li><li>확인 경고를 닫은 뒤 시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기 → 열기를 선택합니다.</li></ol><p>macOS 12는 설정상 최소값입니다. GPT 연결은 공식 Codex의 운영체제 요구 사항도 따릅니다. 3D 제작은 메모리 16 GB 이상과 Blender가 필요합니다.</p><h4>터미널로 설치</h4><p>기존 앱을 닫고 아래 명령을 실행하세요. 파일 검증과 설치 위치를 확인하고 y를 입력하면 새 사본을 설치합니다. 기존 앱·프로젝트를 보존하며 관리자 암호가 필요하지 않습니다.</p><div className="mac-terminal-install"><div className="command-heading"><span>Mac 설치 명령</span><button type="button" onClick={copyMacInstall}><Copy size={15} aria-hidden="true"/>{installCopyState==='copied'?'복사됨':'설치 명령 복사'}</button></div><pre><code ref={installCommandElement}>{macInstallCommand}</code></pre><p role="status" aria-live="polite">{installCopyState==='copied'?'설치 명령을 복사했습니다. 터미널에 붙여 넣으세요.':installCopyState==='failed'?'명령을 선택했습니다. 직접 복사해 주세요.':'설치 안내를 읽고 y를 입력하면 진행합니다.'}</p></div><h4>다음 버전부터는 앱에서 업데이트</h4><p>Mac 0.1.4 이상은 앱에서 출처·버전·크기·해시를 확인하고 업데이트하세요. 다운로드·검증·설치 후 재실행하며 이전 앱을 백업합니다. 0.1.3 이하는 최신 설치본을 한 번 설치하세요. 업데이트 서명은 Apple 공증과 별개이며, 시스템 전체 Gatekeeper를 끌 필요는 없습니다.</p>{hasMacRelease&&macReleases.map(item=><dl className="download-properties" key={item.architecture}><div><dt>파일</dt><dd>{item.filename}</dd></div><div><dt>용량</dt><dd>{item.bytes.toLocaleString('en-US')} bytes · {(item.bytes/1_048_576).toFixed(2)} MiB</dd></div><div><dt>SHA-256</dt><dd><code>{item.sha256}</code></dd></div></dl>)}</div></details>
          </section>
        </div>
      </section>

      <section id="verification" className="verification-section page-width" aria-labelledby="verification-title"><div><ShieldCheck size={24} aria-hidden="true"/><h2 id="verification-title">확인한 범위를 투명하게.</h2><p>기능별 산출물 검사와 네이티브 실행 검증을 구분해 기록합니다.</p></div><details className="verification-details"><summary>플랫폼별 기능·검증 기록 보기</summary><dl className="status-list">{statuses.map(item=><div key={item.feature} className="status-item"><dt>{item.feature}<span className={`status-label ${item.tone}`}>{item.tone==='verified'&&<Check size={13} aria-hidden="true"/>}{item.status}</span></dt><dd>{item.detail}</dd></div>)}</dl><a className="text-link" href={`${sourceUrl}/blob/master/docs/verification.md`}>전체 검증 기록 <ArrowUpRight size={16} aria-hidden="true"/></a></details></section>
      <section className="faq-section section-space page-width" aria-labelledby="faq-title"><div><p className="eyebrow">자주 묻는 질문</p><h2 id="faq-title">시작하기 전에.</h2><p className="faq-intro">설치와 연결, 원본 보존까지.</p></div><div className="faq-list">{faqs.map(faq=><details key={faq.question}><summary>{faq.question}<span className="faq-indicator" aria-hidden="true"/></summary><div className="faq-answer"><p>{faq.answer}</p>{faq.link&&<a className="text-link" href={faq.link}>{faq.label}<ArrowUpRight size={15} aria-hidden="true"/></a>}</div></details>)}</div></section>
    </main>
    <footer className="site-footer"><div className="page-width footer-inner"><div><a className="wordmark" href="#" aria-label="Asset Studio 첫 화면"><Mark/><span>Asset Studio</span></a><p>아이디어는 게임으로. 결과는 내 프로젝트에.</p></div><div className="footer-links"><a href={sourceUrl}>GitHub 소스</a><a href={latestReleaseUrl}>릴리스</a><a href={`${sourceUrl}/issues`}>오류 제보</a><a href="/third-party-notices.txt">라이선스</a></div></div></footer>
    <dialog className="screenshot-dialog" ref={screenshotDialog} aria-labelledby="screenshot-dialog-title" onClose={()=>screenshotTrigger.current?.focus()} onClick={event=>{if(event.target===event.currentTarget)screenshotDialog.current?.close();}}><div className="dialog-header"><h2 id="screenshot-dialog-title">Asset Studio 제작 홈 · 브라우저 미리보기</h2><button type="button" aria-label="화면 닫기" onClick={()=>screenshotDialog.current?.close()}><X size={22} aria-hidden="true"/></button></div><img src="/media/production-home-browser-011.jpg" alt="확대한 제작 홈의 브라우저 미리보기" width="1500" height="960"/><p>브라우저 미리보기 화면입니다. Windows·Mac 네이티브 검증 범위는 플랫폼별 기록을 확인해 주세요.</p></dialog>
  </>;
}
