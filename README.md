<p align="center">
  <img src="docs/media/readme/asset-studio-banner.svg" alt="Asset Studio — 로컬 에셋 제작 작업대" width="100%">
</p>

<h1 align="center">Asset Studio</h1>

<p align="center">
  <strong>게임을 설명하고, 필요한 이미지와 3D 에셋을 한 번에.</strong><br>
  프로젝트를 연결해 제작 목록을 만들고, 개별 결과를 확인하세요.
</p>

<p align="center">
  <a href="https://github.com/oocheol/masset/releases/tag/v0.1.8"><img src="https://img.shields.io/badge/release-0.1.8-334c60?style=flat-square&amp;labelColor=101d29" alt="Release 0.1.8"></a>
  <a href="https://github.com/oocheol/masset/releases/download/v0.1.8/AssetStudio_0.1.8_x64-setup.exe"><img src="https://img.shields.io/badge/Windows-x64-334c60?style=flat-square&amp;labelColor=101d29" alt="Windows x64"></a>
  <a href="https://github.com/oocheol/masset/releases/download/v0.1.8/AssetStudio_0.1.8_macos-arm64.dmg"><img src="https://img.shields.io/badge/macOS-Apple_Silicon-334c60?style=flat-square&amp;labelColor=101d29" alt="macOS Apple Silicon"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-334c60?style=flat-square&amp;labelColor=101d29" alt="Core license Apache-2.0"></a>
</p>

<p align="center">
  <a href="https://masset-nu.vercel.app/"><strong>기능 소개 사이트</strong></a> ·
  <a href="https://github.com/oocheol/masset/releases/tag/v0.1.8"><strong>다운로드</strong></a> ·
  <a href="#project-structure">프로젝트 구조</a> ·
  <a href="docs/windows-quickstart.md">사용 가이드</a>
</p>

Tauri 2 + Rust + React/TypeScript로 만든 오픈소스 게임 에셋 제작 도구입니다. **Windows·Mac 0.1.8은 게임 설명 + 프로젝트 루트 연결 → 필요한 에셋 분석 → 개별 제작 → 결과 검수**를 기본 화면으로 제공합니다. Windows는 이미지 제작을 기본으로 하고, Apple Silicon Mac은 GPT 참고 이미지에서 로컬 TripoSR와 Blender로 3D도 제작합니다. 두 플랫폼에서 기존 GLB 다듬기와 기본 소품 제작은 **편집 도구**로 이용할 수 있습니다.

**Windows와 Mac 모두 0.1.8을 배포합니다.** Windows 설치형·포터블의 네이티브 실행, 프로젝트 폴더 읽기, Blender GLB 생성·다듬기·재열기와 공개 업데이트 다운로드 검증을 통과했습니다. Mac은 DMG 설치·실행, GPT 구성안·개별 PNG 수신, 로컬 GLB 제작을 확인한 기존 배포본을 유지합니다. [게임 제작 흐름](docs/game-production.md) · [Windows 검증](docs/releases/v0.1.8-windows.md) · [Mac 검증](docs/releases/v0.1.8-macos.md)

**3D 만들기**에서 투명 배경의 단일 물체 이미지 또는 GLB를 최대 5개 선택하세요. 이미지마다 모델 하나를 만들고, 기존 GLB는 원본을 남긴 새 버전으로 저장합니다. 게임용·고해상도 형상·LOD, UV 색상 텍스처, 지원되는 경우 메시에서 베이크한 노멀맵, 편집 가능한 `.blend`, 썸네일·턴테이블을 함께 내보냅니다. 이미지 복원은 Apple Silicon·CPython 3.9·최소 16GB 메모리와 Blender가 필요하며, 최초 동의 후 약 1.68GB의 모델 가중치와 의존성을 준비합니다. 이후 CPU에서 로컬로 실행하고 유료 API로 대체하지 않습니다. 구형 오픈 모델 TripoSR을 사용하므로 현재 Tripo Studio H3.1과 같은 품질이나 8K·리깅·쿼드 리토폴로지는 제공하지 않습니다. [사용 방법과 결과 범위](docs/model-quality.md)를 확인하세요.

Mac 0.1.6의 **게임 에셋 묶음**은 게임 설명으로 GPT-5.5 (`gpt-5.5`)의 텍스트 구성안을 요청합니다. 2D 이미지·3D 모델·혼합 구성을 고르고, 이름과 설명이 있는 행을 수정·승인해 포함한 항목을 한 번에 큐에 제출하세요. [게임 에셋 묶음 사용 흐름](docs/game-asset-bundles.md)에서 참고 자료 전송 동의, 개별 이미지 수와 고정 3D 레시피를 안내합니다. Mac 네이티브 백엔드에서 실제 구성안을 받아 무기 이미지 5장과 모델 2개를 개별 에셋으로 제작·저장·재열기·내보내기했습니다.

## 작업대 미리보기

[![Asset Studio 0.1.3 에셋 라이브러리 — 실제 브라우저 미리보기](apps/site/public/media/workstation-browser-013.png)](apps/site/public/media/workstation-browser-013.png)

라이브러리 → 2D 캔버스 → 3D 뷰포트 → 버전 비교를 오가며, 오른쪽 검사 패널에서 에셋을 다듬고 아래 작업 큐에서 진행 상태를 확인합니다. 위 이미지는 **실제 0.1.3 브라우저 미리보기**이며 네이티브 실행 증거와 구분합니다. 이미지를 누르면 원본 크기로 볼 수 있습니다.

<details>
<summary><strong>앱 안의 사용 가이드 보기</strong></summary>

[![원본 가져오기부터 내보내기와 구독 연결까지 안내하는 실제 사용 가이드](docs/media/readme/workbench-guide-013.png)](docs/media/readme/workbench-guide-013.png)

주요 버튼·입력 글씨는 14px 이상, 가이드는 16px입니다. 단계별 안내, 접을 수 있는 설명, Esc 닫기와 키보드 포커스를 지원합니다. 이 화면도 브라우저 UI 검사에서 캡처했습니다.

</details>

## 실제 제작 결과

| 상자 · Crate | 테이블 · Table | 선반 · Shelf |
| :---: | :---: | :---: |
| [<img src="apps/site/public/media/crate.png" alt="실제 Blender 상자 렌더" width="280">](examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/crate/model.glb) | [<img src="apps/site/public/media/table.png" alt="실제 Blender 테이블 렌더" width="280">](examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/table/model.glb) | [<img src="apps/site/public/media/shelf.png" alt="실제 Blender 선반 렌더" width="280">](examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/shelf/model.glb) |
| 1.2 × 0.9 × 0.8 m | 1.6 × 0.76 × 0.8 m | 1.0 × 1.8 × 0.4 m |
| [GLB](examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/crate/model.glb) · [Blender 원본](examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/crate/source.blend) | [GLB](examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/table/model.glb) · [Blender 원본](examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/table/source.blend) | [GLB](examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/shelf/model.glb) · [Blender 원본](examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/shelf/source.blend) |

세 이미지는 저장소의 **고정 Blender 작업자가 실제 메시에서 렌더한 512px 썸네일**입니다. GLB, 편집 가능한 `.blend`, 턴테이블 PNG와 [파일별 검증 기록](examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/verification.json)이 함께 있습니다. 치수는 GLB의 X × Y × Z이며 미터/Y-up 기준입니다. 작업자 직접 실행 결과로, AI 이미지 생성이나 앱 전체 흐름의 성공 증거로 표시하지 않습니다.

[로컬 아이콘 12종과 모델 예제 더 보기 →](examples/README.md)

## 무엇을 할 수 있나요?

| 기능 | 작업대에서 하는 일 | 남는 결과 |
| --- | --- | --- |
| 이미지 편집 | PNG/WebP/JPEG 가져오기, 크기·색상·배경·마스크 처리 | 원본과 구분된 새 이미지 버전 |
| 스프라이트·아틀라스 | 프레임을 나누고 여러 이미지를 묶어 패킹 | 실제 이미지와 프레임 메타데이터 |
| 게임 에셋 묶음 · Mac 0.1.6 | 게임 설명 → 텍스트 구성안 → 개별 행 편집·승인 → 포함한 행을 한 번에 큐 등록 | 개별 이미지·새 독립 모델 또는 기존 2D의 새 버전 |
| 게임 프로젝트 제작 · Windows·Mac 0.1.8 | 게임 설명·루트 폴더 분석 → 개별 제작 → 결과 확인·검수 | 새 게임 결과 폴더, 개별 PNG·해시 명세, 최대 120개. 이미지→3D는 Apple Silicon Mac |
| 절차적 3D · Mac 0.1.6 | 상자·테이블·선반·검·소총·우주선·배럴·바위·나무의 치수·베벨·색상 지정 | 개별 GLB, 편집 가능한 `.blend`, 렌더 |
| 이미지→3D · 모델 다듬기 · Mac 0.1.7 | 투명 이미지의 개별 메시 복원 또는 기존 GLB의 예산·UV·재질 정리 | 원본 보존, 게임용·고해상도·LOD GLB, 텍스처·`.blend`·턴테이블 |
| 버전·캐시 | 이전 결과 비교, 검증된 결과의 명시적 재사용 | 해시와 제작 이력이 있는 에셋 |
| 작업 큐 | 의존 관계, 자원 한도, 취소·복구·부분 재실행 | SQLite에 저장되는 작업 상태 |
| 독립 내보내기 | 선택한 에셋과 버전을 새 묶음으로 저장 | 실제 파일 + 상대 경로·SHA-256이 있는 `manifest.json` |
| 구독 이미지 연결 | Windows·Apple Silicon Mac에서 공식 Codex 준비·로그인·명시적 생성 요청 | 검증 후 저장한 파일과 요청·확인 모델 정보 |

기본 아이콘은 로컬 SVG/PNG 예제입니다. GPT-6.1 Sol(`gpt-6.1-sol`) 추론과 GPT Image 2(`gpt-image-2`) 목표의 구독 경로는 **Windows 0.1.2와 Mac 0.1.5 구현에서 각각 새 이미지 한 장의 수신·저장·재열기·독립 내보내기를 실증**했습니다. 실제 이미지 모델 ID는 응답에서 제공되지 않아 `confirmedModel=null`이며, 모든 계정의 모델 권한을 보장하지 않습니다.

[공급자 실증](docs/provider-feasibility.md) · [ima2-gen 구조 비교](docs/ima2-gen-comparison.md) · [현재 구현 범위](docs/completion-status.md)

Mac 0.1.6 묶음의 **요청 이미지 수**는 이미지·스프라이트·텍스처 행을 합친 정확한 수입니다. 혼합 구성의 모델 행은 별도로 셉니다. 2D 행마다 오브젝트 하나를 개별 PNG로 요청하며, 구성안을 수정한 뒤에는 포함한 행의 현재 수가 제출 수입니다. 참고 자료는 PNG·JPEG·WebP와 검증 가능한 GLB를 합쳐 최대 5개까지 선택하고 외부 전송에 명시적으로 동의합니다. GLB는 측정한 메시 메타데이터와 이미 있는 썸네일로 참고합니다. Mac 0.1.8의 모델 개선 도구도 원본을 보존한 새 버전으로 저장합니다.

**GPT-5.5는 도구 실행 없이 텍스트 구성안을 제안하는 플래너**, **GPT-6.1 Sol은 항목 승인 후 별도로 이미지 제작을 요청하는 이미지 에이전트**입니다. Mac 0.1.8의 기본 제작은 GPT 참고 이미지에서 로컬 TripoSR와 Blender로 3D를 만듭니다. 공개 0.1.6 묶음의 모델은 Blender 고정 레시피를 사용합니다. 모델 설정이나 카탈로그 등록을 실제 플래너 응답의 성공으로 표시하지 않습니다.

## 다운로드와 시작하기

| 플랫폼 | 현재 다운로드 | 현재 범위 |
| --- | --- | --- |
| Windows x64 · 0.1.8 | [설치 파일](https://github.com/oocheol/masset/releases/download/v0.1.8/AssetStudio_0.1.8_x64-setup.exe) · [포터블 ZIP](https://github.com/oocheol/masset/releases/download/v0.1.8/AssetStudio-windows-x64-portable.zip) | 프로젝트 기반 2D 제작 · GLB 다듬기 · 기본 소품 · 구독 연결 · 앱 내부 업데이트 |
| Mac Apple Silicon · 0.1.8 | [DMG](https://github.com/oocheol/masset/releases/download/v0.1.8/AssetStudio_0.1.8_macos-arm64.dmg) | 프로젝트 기반 개별 2D·3D 제작 · GPT 구독 연결 · 결과 검수 · 앱 내부 업데이트 |

**Windows:** 설치 파일을 실행하거나 포터블 ZIP 전체를 새 폴더에 풀어 사용합니다. 기존 0.1.1~0.1.3 설치 사용자는 앱의 업데이트 패널에서 0.1.8을 확인할 수 있습니다. WebView2와 3D용 Blender는 별도 필요하며, 이용자에게 Node.js·Rust 개발 도구는 필요하지 않습니다. Codex가 없으면 **구독 연결 → Codex 준비 → 공식 계정 연결 → 연결 확인** 순서로 시작합니다. 앱 전용 Codex 다운로드는 출처·라이선스·해시를 안내하고 동의 후 진행합니다. 이미지에서 TripoSR로 3D를 추정하는 경로는 현재 Mac 전용이며 Windows 제작 화면은 지원되는 이미지 모드로 시작합니다.

### Mac 설치

Apple 개발자 계정 없이 설치하려면 다음 명령을 **터미널에 붙여 넣고 안내를 확인한 뒤 `y`**를 입력합니다. 설치 스크립트 자체의 SHA-256을 먼저 확인하며, 스크립트는 공식 DMG의 크기·SHA-256과 앱 번들까지 검증합니다.

```sh
(
  set -eu
  install_tmp="$(mktemp -d)"
  trap 'rm -rf "$install_tmp"' EXIT
  curl -fsSL https://github.com/oocheol/masset/releases/download/v0.1.8/install-macos.sh -o "$install_tmp/install-macos.sh"
  printf '%s  %s\n' 'd4c56620274ce0a6238027883e42a46f6f3192d6e452958707f2936c886f4696' "$install_tmp/install-macos.sh" | shasum -a 256 -c -
  bash "$install_tmp/install-macos.sh"
)
```

새 앱은 `~/Applications/Asset Studio 0.1.8/Asset Studio.app`에 설치합니다. 기존 앱을 닫고 새 앱을 사용하세요. 기존 앱·프로젝트·원본은 보존합니다. **Mac 0.1.3 이하는 업데이트 기능이 없으므로 공개 최신 앱을 한 번 직접 설치해야 합니다.** 이후에는 앱이 새 버전을 확인하고, 업데이트 패널에서 승인하면 서명·버전·크기·해시 검사 → 이전 앱 백업 → 교체 → 재실행 순서로 진행합니다. 제작 작업이 끝난 뒤 설치하며 프로젝트와 에셋 버전은 유지합니다.

브라우저로 DMG를 받았다면 앱을 홈 폴더의 Applications 안에 새 폴더를 만들어 복사하세요. 최초 실행 경고는 **시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기 → 열기**로 허용할 수 있습니다. DMG 안에서 직접 실행하지 마세요. 업데이트가 설치 폴더에 쓰기 권한을 필요로 합니다.

**Mac 구독 연결:** 0.1.8에서 **구독 연결 → Codex 준비 → 공식 계정 연결 → 연결 확인** 순서로 진행합니다. OpenAI 서명이 유효한 공식 ChatGPT/Codex Mac 앱의 런타임을 재사용하고, 없으면 동의 후 검증된 Apple Silicon용 Codex 0.160.0을 앱 전용 공간에 준비합니다. 인증 정보는 공식 Codex가 관리하며 유료 API로 대체하지 않습니다. 0.1.4 이상은 앱 내부 업데이트로 0.1.8을 받을 수 있습니다.

Asset Studio의 Apple Developer ID 서명·공증은 없습니다. 앱 업데이트 파일은 프로젝트의 별도 키로 서명하며 Apple 공증과 구분합니다. 구독 연결에 쓰는 Codex 실행 파일·이미지 호스트의 OpenAI Developer ID 서명은 별도로 확인합니다. Mac Blender 작업자는 실제 생성·GLB·`.blend` 재열기를 검증했습니다. 새 Mac 네이티브 백엔드에서 개별 PNG 5장·모델 2개의 제작·저장·재열기·내보내기를 확인했습니다.

[Windows 사용 가이드](docs/windows-quickstart.md) · [Mac 설치·업데이트 안내](docs/macos-quickstart.md) · [Mac 0.1.8 검증 기록](docs/releases/v0.1.8-macos.md) · [Windows 0.1.8 검증 기록](docs/releases/v0.1.8-windows.md)

## Codex로 게임을 만들며 에셋 제작하기 · 0.1.10 소스

**CLI + Codex 스킬**을 추가했습니다. 앱의 **Codex 스킬 설치**를 한 번 실행한 뒤 Codex에 `$asset-studio 게임을 만들어줘`라고 요청하면, 기존 프로젝트와 필요한 개별 에셋 목록을 바탕으로 제작·엔진 반영·실행 검증을 이어가도록 안내합니다. 무기 5개는 독립 항목 5개로 제작합니다. 별도 MCP 서버나 유료 API 키가 필요하지 않습니다. 공개 다운로드 0.1.8에는 아직 이 기능이 없습니다.

[설치·CLI·방식 비교](docs/codex-integration.md) · [Mac 검증 결과와 미검증 범위](docs/codex-integration-validation.md) · [배포용 스킬 플러그인](integrations/codex/plugin.json)

## 게임 설명에서 제작과 검수까지 · Windows·Mac 0.1.8

1. **GPT 구독 연결** — 공식 계정과 연결 상태를 확인합니다.
2. **게임 프로젝트 루트 연결** — 기존 게임 폴더를 선택하고 장르·시점·세계관·스타일을 설명합니다. 참고 이미지·모델도 선택할 수 있습니다.
3. **필요한 에셋 분석** — 파일 목록과 누락 참조를 바탕으로 필요한 개별 에셋 계획을 확인합니다.
4. **필요한 에셋 모두 제작** — 각 2D 이미지를 독립 요청합니다. Apple Silicon Mac의 3D 항목은 참고 이미지를 로컬 모델로 변환합니다. 새 게임 결과 폴더에 자동으로 저장합니다.
5. **결과 검수** — 카드에서 결과를 살펴보고 승인하거나 **이 에셋 개선하기**로 선택한 결과만 다시 제작합니다. 직접 편집은 별도 **편집 도구**에서 엽니다.

### 편집 도구와 내보내기

1. **가져오기** — 새 프로젝트에 원본 이미지를 넣고 규격·스타일을 정합니다.
2. **다듬기** — 이미지를 변환하거나 Blender 소품을 만들고 새 버전으로 저장합니다.
3. **확인하기** — 버전 비교·2D/3D 미리보기·작업 큐로 결과와 상태를 확인합니다.
4. **내보내기** — 실제 파일과 `manifest.json`이 담긴 새 폴더를 꺼냅니다. 내보낸 결과는 앱 DB 없이도 검사할 수 있습니다.

### 게임 설명에서 개별 에셋까지 · Mac 0.1.6

1. **게임 에셋 만들기** — **게임 에셋 묶음 구성안**에서 게임 설명과 **2D 이미지 / 3D 모델 / 이미지 + 3D 모델**을 선택합니다. 필요한 이미지 수를 입력하고 참고 이미지·GLB를 최대 5개 선택합니다.
2. **구성안 만들기** — 참고 자료 전송에 동의한 뒤 GPT 구독 연결에서 GPT-5.5의 텍스트 구성안을 요청합니다. 이 단계에서는 이미지·모델 파일을 제작하지 않습니다.
3. **개별 항목 검토** — 이름·설명·용도·참고 자료와 포함 여부를 수정합니다. 모델 행의 레시피·미터 치수·베벨·색상도 편집합니다. 기존 2D 개선은 지정한 원본 에셋의 새 버전으로 저장하며, 3D는 새 독립 모델로 제작합니다.
4. **검토한 에셋 묶음 제작** — 공통 규격·스타일과 항목을 승인해 포함한 행 전체를 한 번에 큐에 등록합니다. 각 작업의 실제 결과를 확인한 뒤 새 묶음으로 내보냅니다.

[게임 에셋 묶음의 수량·참고 자료·레시피 안내 →](docs/game-asset-bundles.md)

<a id="project-structure"></a>

## 프로젝트 구조

UI, 제작 도구, 저장소와 검증을 모듈로 나눴습니다. 네이티브 앱에서는 **Rust Backend가 작업자를 실행**하고, Scheduler가 영속 작업 상태·의존 관계·자원 예약을 관리합니다.

```mermaid
flowchart TD
  UI["React 제작 홈<br/>게임 설명 · 폴더 연결 · 검수"] -->|"Tauri IPC"| B["Rust Backend<br/>프로젝트 분석 · 제작 · 검증"]
  C["TypeScript contracts"] -. "UI 타입 계약" .-> UI
  CLI["asset-cli"] -. "동일 Backend" .-> B
  B <--> Q["scheduler<br/>작업 상태 · 의존성<br/>자원 예약"]
  B <--> P["core<br/>프로젝트 · 버전<br/>SQLite + 원본 파일"]
  B --> I["image-pipeline<br/>로컬 2D 처리"]
  B --> R["providers<br/>GPT 계획 · 개별 이미지"]
  B --> T["로컬 TripoSR<br/>개념 이미지 → 메시"]
  T --> W["Blender 작업자<br/>게임용 · LOD · 텍스처"]
  I --> F["실제 출력 파일<br/>SHA-256 · 검증 결과"]
  R --> F
  W --> F
  F --> P
  P --> E["독립 내보내기 폴더<br/>파일 + manifest.json"]
  classDef accent fill:#101d29,stroke:#68e0e2,color:#e5edf4,stroke-width:2px;
  classDef module fill:#172a38,stroke:#334c60,color:#e5edf4;
  classDef optional fill:#19252c,stroke:#d8af64,color:#e5edf4,stroke-dasharray:5 3;
  class UI,B,F,E accent;
  class C,CLI,Q,P,I module;
  class R,T,W optional;
```

### 저장소 지도

```text
masset/
├─ apps/
│  ├─ desktop/
│  │  ├─ src/                 React 작업대·편집 UI·Three.js
│  │  ├─ public/examples/     로컬 SVG/PNG 아이콘 12종
│  │  └─ src-tauri/           Tauri 명령·Rust Backend·네이티브 CLI
│  └─ site/                   Vercel 소개·다운로드 사이트
├─ crates/
│  ├─ core/                   SQLite 프로젝트·버전·해시·내보내기
│  ├─ scheduler/              영속 큐·의존성·자원 예약·복구
│  ├─ image-pipeline/         이미지 변환·분할·아틀라스·검사
│  └─ providers/              공식 Codex RPC·Windows/Mac 런타임 준비
├─ packages/
│  ├─ contracts/              TypeScript 데이터·명령 계약
│  └─ ui/                     공용 색상 토큰
├─ workers/blender/           고정 Python 절차형 모델 작업자
├─ examples/procedural/       실제 GLB·blend·렌더·검증 기록
├─ scripts/                   빌드·패키징·라이선스·독립 파일 검사
├─ tests/                     저장소·이미지·공급자·Blender·E2E
├─ docs/                      설계·검증·플랫폼·릴리스 기록
├─ .github/workflows/         Windows CI·수동 ARM64 Mac 검증
├─ Cargo.toml / Cargo.lock    Rust workspace·의존성 잠금
└─ package.json / package-lock.json
                             npm workspace·의존성 잠금
```

CPU 이미지 처리, Blender와 외부 공급자는 별도의 자원 한도를 사용합니다. 입력 해시·도구 버전을 캐시 키에 넣고 저장 결과를 확인한 뒤 명시적으로 재사용합니다. 결과가 불명확한 외부 요청은 자동 재전송하지 않으며 유료 API로 조용히 전환하지 않습니다.

원본과 새 버전을 구분해 저장하고, 내보내기에는 상대 경로와 파일별 SHA-256을 기록합니다. Blender는 선택적 로컬 의존성으로 `--factory-startup --disable-autoexec`를 적용하며 에셋 입력을 코드로 실행하지 않습니다.

[아키텍처](docs/architecture.md) · [모듈 계약](docs/module-contract.md) · [보안 설계](docs/security-design.md) · [디자인 규칙](docs/design-system.md)

## 개발과 검증

개발 환경은 Node.js 24, Rust 1.99.0 stable입니다. Windows는 Visual Studio C++ 도구·Windows SDK·WebView2, Mac은 Xcode Command Line Tools가 필요합니다.

```powershell
npm ci
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
. .\scripts\with-native-env.ps1
cargo test --workspace --locked
npm run typecheck
npm test
npm run desktop
```

<details>
<summary><strong>사이트·배포·독립 파일 검사 명령</strong></summary>

```powershell
# 소개 사이트
npm run site:dev
npm run site:build

# 새 폴더·ZIP으로 Windows 포터블 빌드
.\scripts\build-windows.ps1

# 앱 DB 없이 실제 내보낸 파일을 검사
npm run verify:artifacts -- 'C:\exports\내보낸 에셋'

# 네이티브 Backend 검사. 창·설치 검증과 구분
cargo build -p asset-desktop --bin asset-cli
.\scripts\native-smoke.ps1

# 실제 배포 EXE의 Blender GLB 로딩·WebGL 픽셀 검사
.\scripts\native-smoke.ps1 -Native3D -Executable 'C:\배포폴더\asset-desktop.exe'
```

NSIS 설치 파일은 승인·해시 검증한 캐시 도구와 저장소 밖의 서명 키를 사용합니다. Mac 패키지 검증은 수동 선택한 Apple Silicon CI에서 수행합니다. [플랫폼별 빌드 안내](docs/platform-support.md)를 참고하세요.

</details>

**Windows 0.1.8 검증:** 포터블 ZIP의 375개 파일과 설치 패키지 리소스 368개를 대조했습니다. 실제 WebView·이미지 12개·IPC·프로젝트 폴더 읽기·Blender GLB/WebGL, 네이티브 출력 33개 파일의 독립 검사, GLB 다듬기 후 980→1,620개 삼각형 복원과 이전 버전 보존을 확인했습니다. 별도 Blender 프로세스의 재열기 57개·53개 검사와 내보내기 26개 파일 검사, 공개 다운로드·공식 Tauri 업데이트 서명 검증을 통과했습니다. 이번 Windows 검사에서 새 GPT 요청, 기존 설치본 교체·재시작, 깨끗한 PC 실행은 수행하지 않았습니다. [이전 0.1.3 기록](docs/releases/v0.1.3.md)과 Mac의 별도 네이티브 기록을 함께 보존합니다.

[전체 검증 기록](docs/verification.md) · [Windows 배포 메타데이터](docs/releases/v0.1.8-windows.json) · [Mac 0.1.8 생성 검증](docs/releases/v0.1.8-macos.json) · [Mac 배포 상태](docs/releases/v0.1.8-distribution.json)

## 기여와 라이선스

[CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) · [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)

코어 소스는 [Apache-2.0](LICENSE), Blender 작업자 코드는 별도 [GPL-3.0-or-later](workers/blender/LICENSE)입니다. Blender 실행 파일은 앱에 포함되지 않습니다. 예제 에셋의 권리와 외부 서비스 생성물·사용자 입력의 권리는 별도로 다룹니다. 외부 AI 서비스가 무료 또는 오픈소스라는 의미는 아닙니다.

이미지 기반 3D·제조용 CAD·임의 코드 플러그인 실행은 현재 지원 범위에 포함되지 않습니다.
