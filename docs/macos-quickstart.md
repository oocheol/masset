# Mac 설치와 앱 내부 업데이트

Apple Silicon(M 시리즈)용 **0.1.6은 게임 에셋 묶음과 개별 이미지·모델 제작을 추가합니다. GPT 구독 연결과 공식 Codex 준비를 지원합니다.** 앱 내부 업데이트는 0.1.4부터 제공합니다. Apple 개발자 계정 없이 설치할 수 있으며, 로컬 이미지 편집·스프라이트·아틀라스를 사용할 수 있습니다. Intel 빌드는 제공하지 않습니다.

## Apple 계정 없이 터미널로 설치

[공식 README의 Mac 설치 명령](https://github.com/oocheol/masset#mac-설치)을 터미널에 붙여 넣으세요. 명령은 설치 스크립트의 SHA-256을 먼저 확인한 뒤 실행합니다. 안내를 읽고 `y`를 입력하면 공식 0.1.6 DMG의 크기·SHA-256, 앱 버전·식별자·Apple Silicon 아키텍처와 ad-hoc 서명 무결성을 확인해 설치합니다.

기본 설치 위치는 **`~/Applications/Asset Studio 0.1.6/Asset Studio.app`**입니다. 관리자 암호와 Apple 계정은 필요하지 않습니다. 같은 위치에 앱이 있으면 덮어쓰지 않고 중단합니다. 기존 0.1.3 앱과 프로젝트는 그대로 두고 새 앱을 설치하므로, 이전 앱을 종료한 뒤 새 앱을 사용하세요. 새 앱도 기존의 로컬 프로젝트 저장 위치를 사용합니다.

소스를 먼저 읽으려면 [설치 스크립트](https://github.com/oocheol/masset/releases/download/v0.1.6/install-macos.sh)를 확인하세요. 설치 스크립트는 GitHub에서 내려받은 검증된 DMG를 새 앱으로 복사하며, 브라우저의 quarantine 정보를 새 사본에 전달하지 않습니다. GitHub 배포나 이 설치 방법이 Apple 공증을 부여하지는 않습니다.

## 브라우저로 DMG 설치

1. [공식 0.1.6 DMG](https://github.com/oocheol/masset/releases/download/v0.1.6/AssetStudio_0.1.6_macos-arm64.dmg)를 받습니다. 릴리스의 SHA-256과 비교하세요.
2. Finder에서 홈 폴더의 `Applications` 안에 `Asset Studio 0.1.6` 폴더를 만듭니다. DMG의 **Asset Studio.app**을 그 폴더로 복사합니다. DMG 안에서 직접 실행하면 업데이트할 수 없습니다.
3. 복사한 앱을 실행합니다. 기존 앱과 프로젝트·원본 파일은 삭제할 필요가 없습니다.

## 기존 시험 빌드의 실행 경고

브라우저로 받은 앱에는 Apple Developer ID 서명·공증이 없어 “Apple은 ‘Asset Studio’에 … 악성 코드가 없음을 확인할 수 없습니다”라는 경고가 나타날 수 있습니다.

1. 공식 GitHub 릴리스의 파일과 SHA-256이 맞는지 확인합니다.
2. 복사한 앱을 한 번 실행하고 경고 창을 닫습니다.
3. **시스템 설정 → 개인정보 보호 및 보안 → 보안**에서 Asset Studio 옆의 **확인 없이 열기**를 선택합니다.
4. Mac 암호 또는 Touch ID로 인증한 뒤 **열기**를 선택합니다.

이 선택은 해당 앱에 대한 예외입니다. 시스템 전체 Gatekeeper를 끌 필요는 없습니다. 파일 손상 경고가 나타나거나 해시가 다르면 허용하지 마세요. Apple 공증된 배포를 만들려면 [Developer ID 서명·공증 설정](macos-signing.md)이 필요합니다.

## 앱에서 다음 버전으로 업데이트

1. **0.1.3 이하를 사용 중이면 0.1.6를 한 번 직접 설치**합니다. 이전 공개 앱에는 Mac 업데이트 기능이 없습니다.
2. 앱은 시작할 때와 사용 중 주기적으로 GitHub의 Mac 전용 채널에서 새 버전을 확인합니다. 상단 **앱 업데이트** 버튼으로 직접 확인할 수도 있습니다.
3. 새 버전의 출처·버전·크기·SHA-256을 확인하고 승인 체크 후 **지금 업데이트**를 누릅니다. 제작 작업이 진행 중이면 완료 후 설치합니다.
4. 앱은 파일의 암호학적 서명·서명된 버전·크기·SHA-256과 앱 번들을 검증합니다. 이전 앱을 백업한 뒤 설치 위치의 앱을 교체하고 재실행합니다. 프로젝트·원본·에셋 버전은 유지합니다.

앱은 쓰기 가능한 사용자 `~/Applications`에 설치하세요. 관리자 권한으로 앱을 덮어쓰는 업데이트는 사용하지 않습니다. 앱 백업은 `~/Library/Caches/org.localassets.workbench/updates/` 아래에 남습니다. 검증 실패 시 기존 앱을 유지하고, 교체 실패 시 이전 앱 복원을 시도합니다. 네트워크 오류는 업데이트 패널에서 다시 확인할 수 있습니다.

**업데이트 서명과 Apple 코드 서명·공증은 별개입니다.** Mac 업데이트 파일은 프로젝트의 별도 키로 서명하며, 이 키에는 Apple 개발자 등록이 필요하지 않습니다. Windows 업데이트 채널과 키도 별도로 유지합니다.

## 사용 범위와 개발 빌드

Node.js·Rust 개발 도구와 Windows WebView2는 앱 사용에 필요하지 않습니다. macOS 12.0은 설정상 최소값이며, 모든 Mac·최소 OS의 실행을 보장하지 않습니다. 실제 검증 환경과 파일은 [0.1.6 기록](releases/v0.1.6-macos.md)을 확인하세요.

### GPT 구독 연결

1. 상단 **구독 연결**을 엽니다. OpenAI Developer ID 서명이 유효한 공식 ChatGPT/Codex Mac 앱의 Codex 런타임과 이미지 실행 호스트를 발견하면 재사용합니다.
2. Codex가 없으면 **Codex 준비**에서 Apple Silicon용 공식 0.160.0 배포본의 출처·용량·SHA-256·라이선스를 확인하고 동의한 뒤 **다운로드 준비**를 누릅니다. 앱 전용 공간에 준비하며 Node.js·Rust와 PATH 설정이 필요하지 않습니다.
3. **공식 계정 연결**에서 ChatGPT 구독 계정으로 로그인하고 앱으로 돌아와 **연결 확인**을 누릅니다. 이미 공식 Codex에 로그인돼 있으면 인증을 재사용합니다. 앱은 인증 파일을 읽거나 토큰을 복사하지 않으며 유료 API로 대체하지 않습니다.
4. 연결이 준비되면 **이미지 제작**에서 설명을 입력하고 직접 요청합니다. 실제 이미지 수신·파일 검증·프로젝트 저장 여부와 확인된 응답 모델은 별도로 표시합니다.

Mac 네이티브 백엔드에서 새 요청 한 번으로 PNG 수신·디코딩·저장·재열기·독립 내보내기를 확인했습니다. 추론 모델은 `gpt-6.1-sol`, 요청 이미지 모델은 `gpt-image-2`입니다. 응답은 실제 이미지 모델 ID를 제공하지 않아 확인 값은 null이며, 다른 계정의 모델 권한과 한도를 보장하지 않습니다. 이 단일 이미지 연결 기록과 게임 묶음의 구성안 작성 단계는 구분합니다.

### 게임 에셋 묶음 · Mac 0.1.6

**게임 에셋 만들기 → 게임 에셋 묶음 구성안**에서 게임 설명과 **2D 이미지 / 3D 모델 / 이미지 + 3D 모델**을 선택합니다. **요청 이미지 수 (선택)**는 이미지·스프라이트·텍스처 행의 정확한 수이며, 혼합 구성의 모델 행은 별도로 셉니다. PNG·JPEG·WebP와 검증 가능한 GLB를 합쳐 최대 5개의 참고 자료를 고르고, 공식 Codex로 전달할 이미지·미리보기·메타데이터에 명시적으로 동의하세요. GLB는 측정한 메시 정보와 이미 있는 썸네일로 참고합니다.

**구성안 만들기**는 GPT 구독 연결에서 **GPT-5.5 (`gpt-5.5`)의 텍스트 응답만 요청**합니다. 공식 카탈로그의 모델을 도구 실행 없이 사용하는 구성안 단계이며, **GPT-6.1 Sol (`gpt-6.1-sol`) 이미지 에이전트**는 승인 후 별도의 이미지 제작 요청을 담당합니다. 개별 이름·설명·용도와 포함 여부를 수정하고, 모델 행에서는 레시피·너비·깊이·높이·베벨·색상을 편집합니다. 공통 규격·스타일과 항목을 승인한 뒤 **검토한 에셋 묶음 제작**으로 포함한 행 전체를 한 번에 큐에 등록합니다. 2D 행마다 오브젝트 하나를 개별 이미지로 요청하며, 기존 2D 개선은 원본을 유지한 새 버전으로 저장합니다.

3D는 별도 설치한 Blender의 고정 레시피 **상자·테이블·선반·검·소총·우주선·배럴·바위·나무**로 새 독립 에셋을 만듭니다. 참고 GLB를 임의로 재구성·편집하거나 원본 메시를 코드로 실행하지 않습니다. 스크립트 자동 실행을 끈 Mac Blender 5.2.1 LTS 작업자에서 새 여섯 레시피의 실제 생성과 GLB·`.blend` 재열기를 검증했습니다. **Mac 네이티브 백엔드에서 실제 구성안 수신과 개별 PNG 5장·모델 2개의 제작·저장·재열기·독립 내보내기를 확인**했습니다.

[게임 에셋 묶음의 개별 행·전송 동의·레시피 안내](game-asset-bundles.md)

### 소스에서 개발 빌드

```sh
npm ci
cargo test --workspace --target aarch64-apple-darwin
node scripts/collect-third-party-notices.mjs --target aarch64-apple-darwin --out docs/licenses --strict
# 배포용: 저장소 밖의 Mac updater 키와 암호를 환경 변수로 설정한 뒤 실행
npm run desktop:build -- --target aarch64-apple-darwin --config "$PWD/apps/desktop/src-tauri/tauri.macos.trial.conf.json" --bundles app,dmg
# 서명 키가 없는 개발용 패키지: updater 배포 파일을 생성하지 않음
# npm run desktop:build -- --target aarch64-apple-darwin --config "$PWD/apps/desktop/src-tauri/tauri.macos.ci.conf.json" --bundles app,dmg
```

배포 빌드는 `TAURI_SIGNING_PRIVATE_KEY`·`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`가 필요합니다. GitHub **Verified macOS packages** workflow는 `MACOS_UPDATER_PRIVATE_KEY`·`MACOS_UPDATER_KEY_PASSWORD` secrets를 사용합니다. 기본 **trial**은 Apple 계정 없이 빌드하고, **notarized**는 별도의 Apple 인증 정보가 필요합니다. 실제 DMG의 복사 앱 WebView/IPC, Backend 2D 출력, 업데이트 파일의 서명·버전·변조 거부를 확인한 뒤 패키지를 업로드합니다. 릴리스 공개는 별도 단계입니다.
