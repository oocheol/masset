# Asset Studio

[기능 소개 사이트](https://masset-nu.vercel.app/) · [Windows 설치 파일](https://github.com/oocheol/masset/releases/download/v0.1.3/AssetStudio_0.1.3_x64-setup.exe) · [공개 릴리스](https://github.com/oocheol/masset/releases/tag/v0.1.3)

로컬에서 이미지와 절차적 3D 에셋 묶음을 제작·검사·버전 관리·내보내는 Windows/macOS용 오픈소스 데스크톱 도구입니다. Tauri 2, Rust, React/TypeScript, SQLite, Three.js를 사용합니다. 프로젝트 이름은 가칭이며 파일 계약은 브랜드와 분리되어 있습니다.

**0.1.3은 소개 사이트와 앱의 미래적인 작업대 디자인을 적용했습니다.** [디자인과 새 배포 기록](docs/releases/v0.1.3.md)을 참고하세요. Mac은 Apple Silicon용만 배포합니다.

**0.1.2는 GPT-6.1 Sol (`gpt-6.1-sol`)의 이미지 도구 설정 충돌을 수정했습니다.** 이미지 목표는 GPT Image 2입니다. 수정된 Windows Backend에서 새 요청 한 번으로 PNG 수신·디코딩·저장·재열기·독립 내보내기 검사를 통과했습니다. 공개 이벤트에 실제 이미지 모델 ID가 없어 `confirmedModel=null`은 유지합니다. 계정 인증·로컬 준비 상태와 계정별 모델 권한을 구분하며 기존 실패 작업을 자동 재전송하지 않습니다. 다른 모델이나 유료 API로 조용히 전환하지 않습니다. [공급자 실증 기록](docs/provider-feasibility.md)과 [ima2-gen 구조 비교](docs/ima2-gen-comparison.md)를 참고하세요.

앱 소스가 오픈소스인 것과 외부 AI 모델·서비스가 무료 또는 오픈소스인 것은 다릅니다. 입력·출력 에셋의 권리는 소스코드 라이선스와 별도로 확인해야 합니다.

구현·검증·실험·차단·계획 항목은 [현재 완료 범위](docs/completion-status.md)에 정리했습니다.

## Windows 다운로드

[Asset Studio 0.1.3 설치 파일](https://github.com/oocheol/masset/releases/download/v0.1.3/AssetStudio_0.1.3_x64-setup.exe)을 실행하세요. 기존 0.1.1/0.1.2 설치 사용자는 앱 내부 업데이트를 이용하고, 0.1.0 포터블 사용자는 한 번 직접 설치하면 이후부터 앱 안에서 업데이트할 수 있습니다. 시작 시와 10분마다 새 버전을 확인하고, 승인한 파일의 서명·버전·크기·SHA-256을 검사한 뒤 제작 작업이 끝났을 때 설치·재시작합니다.

주요 버튼·입력 글씨는 14px 이상, 가이드는 16px로 키웠고 긴 설명은 접었습니다. 상단 **사용 가이드**에서 단계별 이용 방법을 확인하세요. [포터블 ZIP](https://github.com/oocheol/masset/releases/download/v0.1.3/AssetStudio-windows-x64-portable.zip)도 제공하며 전체를 새 폴더에 풀어 실행합니다. WebView2와 3D용 Blender는 별도 필요합니다. Node.js·Rust 개발 도구는 이용자에게 필요하지 않습니다. 업데이트 파일 서명과 별개로 Windows Authenticode 코드 서명은 없습니다.

Codex가 없는 사용자도 상단 **구독 연결**에서 **Codex 준비 → 공식 계정 연결 → 연결 확인** 순서로 시작할 수 있습니다. 공식 Windows x64 패키지의 출처·버전·용량·SHA-256·라이선스를 확인하고 동의하면 앱 전용 공간에 준비합니다. 파일 해시와 OpenAI 실행 파일 서명을 검사하며 진행 확인·취소를 지원합니다. 기존의 검증 가능한 Codex는 재사용하고 로그인은 공식 페이지에서 진행합니다. [다운로드 정보와 안내](docs/windows-quickstart.md#chatgpt-구독-이미지)를 확인하세요.

[처음 사용하기](docs/windows-quickstart.md) · [릴리스 안내와 SHA-256](docs/releases/v0.1.3.md) · [공개 배포 메타데이터](docs/releases/v0.1.3.json)

## Mac 다운로드

0.1.3 Mac은 Apple Silicon(M 시리즈)용 로컬 2D 시험 배포입니다. [Apple Silicon DMG](https://github.com/oocheol/masset/releases/download/v0.1.3/AssetStudio_0.1.3_macos-arm64.dmg)를 받으세요. Intel 빌드와 다운로드 선택지는 제외했습니다. DMG를 열고 **Asset Studio.app**을 **Applications**로 복사합니다. [Mac 설치 안내](docs/macos-quickstart.md)와 [용량·SHA-256·실제 검증 기록](docs/releases/v0.1.3-macos.json)을 확인하세요.

Apple Silicon의 실제 macOS 15.7.9에서 Rust 138개, DMG 마운트·복사, 앱 번들 봉인, 실제 WebView·12개 이미지·가이드·IPC, 별도 네이티브 Backend의 2D 작업 6개와 PNG 16개 독립 검사를 통과했습니다. 공개 다운로드의 용량·해시도 일치했습니다. macOS 12.0은 설정상 최소값입니다. 로컬 ad-hoc 서명만 적용하며 Apple Developer ID 서명·공증과 Gatekeeper 최초 다운로드는 미검증입니다. Mac 구독 연결·Codex 자동 준비·앱 내부 업데이트는 지원하지 않으며 Blender 3D는 Mac 실행 검증 전입니다.

| 영역 | 현재 범위 | 검증 상태 |
| --- | --- | --- |
| 로컬 프로젝트 | SQLite, 원본 보존, 버전, 독립 manifest 내보내기 | 네이티브 통합 결과는 [검증 기록](docs/verification.md) 참조 |
| 2D | 가져오기, 결정론적 변환, 마스크, 스프라이트·아틀라스, PNG/WebP/JPEG | Rust 이미지 검사 15개·독립 검사 9개 통과; 실제 네이티브 가져오기·변환·아틀라스·내보내기·재열기 검증 |
| 절차적 3D | 상자·테이블·선반, GLB, 편집 가능한 `.blend`, 썸네일·턴테이블 | Windows 워커 3종 검증; release 백엔드 상자·테이블 재열기와 포터블 앱의 실제 상자 GLB 로딩·WebGL 픽셀 검증 통과; 선반 앱 흐름은 별도 |
| 기본 재질 처리 | Base Color·PBR 상수, 밝기 기반 노멀맵 계산 | 실험적 노멀맵의 Rust 검사·네이티브 파일 출력 통과; 물성 측정 또는 AO/고급 재질 복원 지원을 주장하지 않음 |
| 작업 큐 | 자원 한도, 의존 관계, 취소·복구·부분 재실행 | 스케줄러 33개·프로세스 충돌 검사 2개 통과; 로컬 해시 6개 작업의 1회 실측은 761→448ms(1.70배), AI/Blender 성능으로 일반화하지 않음 |
| 결과 캐시 | 입력 SHA·도구 버전 키, 저장 결과 복사본 검사·명시적 재사용 | 네이티브 백엔드의 선택 결과 재사용·버전 보존·재열기 확인 |
| 구독 이미지 생성 | GPT-6.1 Sol 추론·GPT Image 2 목표·공식 Codex 연결·명시 요청 | 수정된 Windows Backend의 새 요청 1회 수신·저장·재열기 검증. 실제 이미지 모델 ID와 모든 계정 권한은 미확인 |
| macOS 패키지 | Apple Silicon DMG, 로컬 2D 시험 배포 | macOS 15.7.9 실제 창·IPC·번들 봉인·별도 Backend 출력·공개 다운로드 검증; 구독/앱 업데이트 미지원, 공증/설치 수명주기/3D 별도 |
| 이미지 기반 3D·CAD | 추후 독립 어댑터 | 계획됨, 지원하지 않음 |

## 실행 및 빌드

개발 시 Node.js 24와 Rust 1.99.0 stable을 사용합니다. Windows에서는 Visual Studio C++ 도구와 Windows SDK, WebView2가 필요합니다. macOS에서는 Xcode Command Line Tools가 필요합니다. 설치 패키지 이용자는 Node/Rust 개발 도구가 필요하지 않습니다. 3D 작업에는 별도로 동의하여 설치한 Blender가 필요하며 앱은 이를 자동 다운로드하지 않습니다.

```powershell
npm ci
# Rust 설치 위치가 PATH에 없다면 이 PowerShell 프로세스에만 추가합니다.
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
. .\scripts\with-native-env.ps1
cargo test --workspace
npm run typecheck
npm test
npm run desktop
```

Windows 포터블 빌드가 기본 경로입니다. EXE와 `examples`, `workers/blender`, 라이선스를 새 폴더와 ZIP으로 묶고 파일별 SHA-256을 기록합니다. NSIS 도구 다운로드는 이 경로에 포함되지 않습니다.

```powershell
.\scripts\build-windows.ps1
# 개발 도구/의존성이 준비되어 있다면 -SkipInstall을 사용할 수 있습니다.
# 승인·해시 검증한 NSIS 캐시와 저장소 밖의 비공개 서명 키가 준비된 경우:
# .\scripts\build-windows.ps1 -Distribution Nsis -SigningKeyPath 'C:\private\updater.key'
# .\scripts\package-windows-release.ps1 -BuildReportPath output/release/windows-x64-build.json
```

Windows를 먼저 검증하며 macOS CI는 명시적인 수동 선택으로만 실행합니다. 포터블 폴더도 다른 PC의 런타임·DLL 확인이 필요합니다. 네이티브 빌드 명령과 아키텍처별 상태, NSIS 추가 도구의 출처·크기·해시는 [플랫폼 표](docs/platform-support.md)에 있습니다. 서명·공증·설치/업그레이드/제거 검증은 별도 항목입니다.

0.1.0의 Windows 개발 호스트 검사에서는 Rust 110개 통과·4개 fixture 제외, release 백엔드 8개 작업과 출력 33개, 포터블 앱의 화면·12개 이미지·네이티브 IPC·실제 Blender 3D 렌더를 확인했습니다. 0.1.1과 0.1.2의 별도 검사 범위는 [검증 기록](docs/verification.md)에 표시하며 이전 기록은 보존합니다. 현재 공개 배포 파일의 해시는 [0.1.3 릴리스 메타데이터](docs/releases/v0.1.3.json)에서 확인합니다. 다른 PC·설치 수명주기는 별도 검증 상태입니다.

## 에셋 제작 흐름

1. 새 프로젝트를 만들고 규격·스타일 프리셋을 선택합니다.
2. 기존 PNG/WebP/JPEG를 가져옵니다. 예제 아이콘은 로컬에서 만든 fixture이며 AI 생성의 증거가 아닙니다.
3. 크기·색상·배경·마스크 등을 변환하여 새 버전을 저장합니다. 선택한 이미지 묶음을 아틀라스로 패킹할 수 있습니다.
4. Blender가 감지되면 치수와 색상을 지정해 절차적 상자·테이블·선반을 만듭니다. GLB와 `.blend`를 저장합니다.
5. 실제 파일과 `manifest.json`이 포함된 새 폴더로 내보냅니다. 원본 프로젝트 파일을 덮어쓰지 않습니다.

```powershell
# 앱 DB 없이 실제 내보내기 파일을 검사합니다.
npm run verify:artifacts -- 'C:\exports\내보낸 에셋'
# 네이티브 백엔드 + 파일 검사. WebView/설치 검증과 별개입니다.
cargo build -p asset-desktop --bin asset-cli
.\scripts\native-smoke.ps1
# 실제 Blender 모델도 포함하려면 -WithBlender를 추가합니다.
# 포터블 앱의 실제 GLB 로딩·WebGL 픽셀까지 검사하려면:
.\scripts\native-smoke.ps1 -Native3D -Executable 'C:\배포폴더\asset-desktop.exe'
```

PNG는 실제 디코딩·CRC·알파·픽셀·해상도, GLB는 별도 Three.js 로더의 기하·인덱스·노멀·UV·재질·치수를 검사합니다. `.blend`는 별도의 새 Blender 프로세스에서 열어 확인합니다. [재현 절차와 결과](docs/verification.md)를 보세요.

실제 절차적 [상자·테이블·선반 예제](examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/verification.json)에는 GLB, 편집 가능한 `.blend`, 썸네일과 턴테이블 PNG가 있습니다. Blender 작업자를 직접 실행해 만든 결과이며 Tauri 앱 통합 결과로 표시하지 않습니다.

아이콘과 모델의 파일별 링크·치수·재생성 안내는 [실제 에셋 예제](examples/README.md)에 있습니다.

브라우저 미리보기(`npm run dev`)는 개발용 UI 검사입니다. IndexedDB 저장과 ZIP 다운로드를 검증하지만, Rust 저장소·Tauri 네이티브 명령 실행의 증거가 아닙니다. 외부 생성 테스트는 일반 fixture 테스트와 분리되어 있으며 명시적으로 실행해야 합니다. 브라우저 검사는 기존 Google Chrome을 사용하고 실행 파일을 자동 다운로드하지 않습니다.

## 구조 및 기여

기능 소개 사이트의 소스는 `apps/site`에 있습니다. `npm run site:dev`로 로컬에서 열고, `npm run site:build`로 정적 사이트를 만듭니다. 루트 `vercel.json`은 사이트만 빌드·배포합니다. Windows 설치 파일·ZIP과 Mac DMG는 GitHub Release에서 제공합니다.

모듈 경계는 [아키텍처](docs/architecture.md), 신뢰 경계는 [보안 설계](docs/security-design.md)에 있습니다. [CONTRIBUTING](CONTRIBUTING.md)과 [SECURITY](SECURITY.md)를 먼저 읽어 주세요.

코어 소스는 [Apache-2.0](LICENSE), Blender 작업자 코드는 별도 GPL-3.0-or-later 라이선스입니다. Blender 실행 파일은 앱에 포함되지 않습니다. [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)에 의존성과 재배포 경계를 기록합니다. 에셋이 제조용 CAD나 공학적 안전 검토를 통과했다는 의미는 없습니다.
