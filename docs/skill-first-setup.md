# 스킬만 설치해서 시작하기 · 0.1.12

Codex에서 Asset Studio 스킬을 사용하면 **Asset Studio 앱을 따로 설치하거나 열 필요가 없습니다.** 스킬의 첫 실행이 독립 네이티브 CLI와 작업자를 사용자 전용 폴더에 준비합니다. 이미 연결된 공식 Codex의 ChatGPT 계정은 재사용합니다.

스킬은 지침과 설치 진입점입니다. 실제 이미지 처리·파일 검증·3D 변환은 내려받은 Rust CLI와 로컬 작업자가 수행합니다. 앱 없이 작동하지만 실행 도구와 모델이 필요 없는 것은 아닙니다.

## 설치

Codex에서 작업을 열 수 있는 환경을 먼저 준비하세요. Asset Studio 앱은 설치하지 않아도 됩니다. Node.js 22.20 이상에서 아래 명령을 실행하면 Codex 스킬 설치·등록을 함께 진행합니다. Windows x64·Apple Silicon Mac 공통입니다.

```sh
npx @oocheol/asset-studio@latest install
```

설치된 스킬을 최신 npm 버전에 포함된 스킬로 업데이트하려면 다음을 실행합니다. 현재 npm 패키지는 **0.1.12**, 스킬이 준비하는 독립 CLI는 **Windows 0.1.12 · Mac 0.1.11**입니다. npm 설치 기능과 네이티브 런타임 버전은 별도로 관리하며 `status`에서 둘 다 표시합니다.

```sh
npx @oocheol/asset-studio@latest update
npx @oocheol/asset-studio@latest status
```

한 버전을 고정하려면 `npx @oocheol/asset-studio@0.1.12 install`을 사용하세요. 전역 명령을 계속 쓰려면 다음과 같이 설치할 수 있습니다.

```sh
npm install --global @oocheol/asset-studio
asset-studio-skill install
asset-studio-skill status
```

**npm 전역 설치 뒤에는 `asset-studio-skill install`도 한 번 실행해야 Codex 스킬이 등록됩니다.** 전역 npm 패키지는 `npm install --global @oocheol/asset-studio@latest`로 업데이트하고 `asset-studio-skill update`를 실행합니다. `npm install` 자체는 스킬을 바꾸거나 실행 파일·모델을 내려받지 않습니다. 설치 훅과 외부 npm 의존성은 없습니다.

사용자 기본 경로는 `~/.agents/skills/asset-studio`이며, 기존 스킬이 `~/.codex/skills/asset-studio` 한 곳에만 있으면 그 경로를 재사용합니다. 이전·수정된 스킬 전체는 `~/.agents/.asset-studio-skill/backups`에 보존한 후 새 버전으로 교체합니다. 백업은 스킬 탐색 폴더 밖에 두며 자동 삭제하지 않습니다. 두 위치에 이미 같은 스킬이 있으면 중복 경로를 표시하고 이전 사본을 임의로 지우지 않습니다. 프로젝트 하나에만 설치하려면 `--project "절대 프로젝트 경로"`를 추가하세요. 그 경우 프로젝트 `.agents/skills/asset-studio`와 `.agents/.asset-studio-skill/backups`를 사용합니다.

Node.js를 사용하지 않으려면 [스킬 플러그인 ZIP](https://github.com/oocheol/masset/releases/download/v0.1.12/AssetStudio_0.1.12_codex-plugin-windows-macos.zip)을 받고 `skills/asset-studio` 폴더를 사용자 `~/.agents/skills/asset-studio`에 설치하세요. Windows의 `~`는 사용자 홈 폴더입니다. ZIP 수동 설치 시에는 기존 사본을 먼저 백업하세요. 어느 방법으로 설치했든 Codex의 스킬 목록을 다시 읽는 새 작업에서 시작합니다.

## Codex에서 요청하기

설치 후 **새 Codex 작업**을 열고 `$asset-studio`와 함께 필요한 에셋을 설명하세요.

> $asset-studio 게임에 사용할 캐릭터 이미지와 3D 소품을 만들어줘

기존 게임에 반영하려면 프로젝트 폴더와 필요한 이미지·정적 3D 소품을 함께 설명하고, 결과를 넣은 뒤 게임을 실행해 확인하도록 요청하세요. 기존 공식 Codex 로그인을 재사용하며 처리용 CLI는 첫 사용 시 다운로드 동의를 받아 준비합니다. 3D 작업에는 Blender·Python·모델을 추가로 준비합니다.

독립 CLI 패키지는 **Windows x64 0.1.12와 Apple Silicon Mac 0.1.11**을 제공합니다. npm 설치 명령에는 Node.js가 필요하며, ZIP 스킬 설치와 독립 CLI 준비는 운영체제 기본 도구로 진행합니다. 공통 스킬 ZIP에는 두 플랫폼의 독립 CLI 파일 크기·SHA-256·전체 파일 목록이 포함됩니다. Mac 네이티브 CLI 실행 검증은 잠금 상태로 생략했습니다. Intel Mac 패키지는 제공하지 않습니다.

## 첫 실행에서 하는 일

1. 고정 릴리스의 CLI ZIP과 모든 파일을 SHA-256·크기·목록으로 검증해 설치합니다. 이미 설치한 파일도 실행 전 확인합니다.
2. 공식 Codex 실행 환경과 기존 로그인을 확인합니다. 없으면 고정 공식 배포본을 준비합니다. 인증이 필요한 계정만 공식 브라우저 로그인으로 안내하며, 비밀번호 입력은 사용자가 완료합니다.
3. 3D 작업을 요청한 경우에만 호환 Blender·Python을 찾고 없으면 전용 폴더에 준비합니다. TripoSR와 고정 라이브러리도 로컬로 준비합니다. 2D 작업에는 이 다운로드가 필요하지 않습니다.
4. CLI 설치·로컬 모델 준비·GPT 계정 상태를 각각 보고합니다. 계정의 이미지 도구 이용 가능 여부는 실제 진단 결과를 따릅니다. 준비 과정에서는 이미지 생성 요청을 보내지 않습니다.

외부 다운로드는 출처·버전·크기·해시·라이선스를 표시하고 동의한 작업에서 진행합니다. “없으면 설치하고 준비해”라고 이미 승인한 작업에서는 같은 동의를 반복해서 묻지 않습니다. 계정 토큰은 복사·출력하지 않고 기존 `CODEX_HOME`을 유지합니다. 유료 API나 다른 모델로 자동 대체하지 않습니다.

## 수동 진입점

Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\skills\asset-studio\scripts\bootstrap.ps1" -ConsentDownloads
# 3D도 필요한 경우 마지막에 -Needs3d 추가
```

Apple Silicon Mac에서는 다음 진입점을 사용합니다. Mac 파일 목록이 포함된 공통 스킬 ZIP을 설치하세요. 이전 Windows 전용 스킬 ZIP에는 Mac 패키지가 없으므로 공통 ZIP을 사용해야 합니다.

```sh
bash "$HOME/.agents/skills/asset-studio/scripts/bootstrap.sh" --consent-downloads
# 3D도 필요한 경우 마지막에 --needs-3d 추가
```

위 PowerShell 옵션은 해당 프로세스에만 적용합니다. 시스템 실행 정책은 변경하지 않습니다. 로그인 안내가 필요하면 `-LoginIfNeeded` 또는 `--login-if-needed`를 추가합니다. 계정이 연결돼 있으면 새 로그인 절차를 시작하지 않습니다.

출력 `runtime_ready`의 `cliPath`와 `resourcePath`를 사용합니다. Windows 경로는 `%LOCALAPPDATA%/AssetStudioCLI/runtimes`, Mac은 `~/Library/Application Support/AssetStudioCLI/runtimes` 아래 버전·플랫폼·아카이브 해시로 구분합니다. 편집된 실행 도구는 자동 덮어쓰거나 실행하지 않습니다. `installation.json`의 임의 경로만 믿고 실행하지 않습니다.

직접 CLI를 사용할 때:

```sh
"/absolute/asset-cli" prepare --resources /absolute/resources --consent-downloads --needs-3d
"/absolute/asset-cli" doctor --resources /absolute/resources --check-gpt
```

`--data-dir /absolute/path`로 런타임 데이터를 분리할 수 있습니다. 로컬 편집·3D만 사용할 때는 로더에 `-LocalOnly` / `--local-only`를 추가하거나 CLI의 `prepare --local-only`를 사용하면 계정 확인·Codex 설치를 생략합니다. `doctor`는 다운로드하지 않습니다. [제작·복구 명령](../integrations/codex/skills/asset-studio/references/cli.md)을 참고하세요.

## 로컬 3D 다운로드

| 구성요소 | 고정 출처와 버전 | 용량 | 검증·라이선스 |
| --- | --- | ---: | --- |
| Blender Windows x64 | `download.blender.org`, 5.2.1 ZIP | 404,851,964 bytes | 공식 SHA-256 목록; GPL-3.0 및 배포본 포함 라이선스 |
| Blender Mac arm64 | `download.blender.org`, 5.2.1 DMG | 346,264,899 bytes | 공식 SHA-256 목록; GPL-3.0 및 배포본 포함 라이선스 |
| Mac CPython | Astral python-build-standalone, 20251014 CPython 3.9.24 | 18,209,249 bytes | 고정 GitHub asset SHA-256; MPL-2.0 빌드 소스, Python-2.0 및 포함 의존성 |
| Windows CPython·TripoSR·라이브러리 | Python.org·PyTorch·PyPI·GitHub·Hugging Face | 약 1.89 GiB | [Windows 고정 목록](../workers/image3d/runtime-lock-windows.json), 파일별 SHA-256·라이선스 |
| Mac TripoSR·라이브러리 | PyTorch·PyPI·GitHub·Hugging Face | 고정 목록 합계 | [Mac 고정 목록](../workers/image3d/runtime-lock.json), 파일별 SHA-256·라이선스 |

Blender SHA-256: Windows `0e631dad7d0cad6d5d18abdd2e2550f6c0213215334eda00ddbd3d22b96ecb2c`, Mac `6409e21de80994db5f4c4a34486b6fd43cea21085b912f7491c53e923acb65a3`. 공식 [Blender 목록](https://download.blender.org/release/Blender5.2/blender-5.2.1.sha256)과 비교합니다. Mac Python SHA-256은 `6b65213e639e91eb8072db80ed9c140d769af1d5e0386efd8f153449c3694714`입니다. CLI 자체는 [스킬의 고정 명세](../integrations/codex/skills/asset-studio/references/native-runtime.json)에서 플랫폼별 바이트와 해시를 확인합니다.

이미지→3D에는 최소 16GB RAM이 필요합니다. Windows는 Microsoft Visual C++ x64 런타임이 없으면 `needs_attention`으로 알립니다. 이 시스템 구성요소를 관리자 권한으로 몰래 설치하지 않습니다. Mac CLI에는 Apple Developer ID 공증이 없습니다. 운영체제의 신뢰 확인이 필요한 경우 해당 파일만 확인하며 시스템 전체 보안을 끄지 않습니다.

GUI 앱은 시각 편집·결과 검수·라이브러리를 직접 사용할 때 선택할 수 있습니다. Windows·Mac 앱은 0.1.12이며 독립 CLI는 Windows 0.1.12 · Mac 0.1.11입니다. Windows의 실행 검증은 [별도 기록](releases/v0.1.12-windows.md), Mac 앱의 빌드·실행 생략 범위는 [Mac 0.1.12 배포 기록](releases/v0.1.12-macos.md), 독립 Mac CLI의 실행 생략 범위는 [Mac 0.1.11 배포 기록](releases/v0.1.11-macos.md)에 구분합니다. Mac 0.1.12 앱의 설치 버튼은 앱에 포함된 0.1.11 스킬을 등록하므로 최신 공통 스킬은 npm 또는 새 ZIP으로 설치·업데이트하세요.
