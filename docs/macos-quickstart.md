# Mac 설치와 앱 내부 업데이트

Apple Silicon(M 시리즈)용 **0.1.4부터 앱 내부 업데이트를 제공합니다.** Apple 개발자 계정 없이 설치할 수 있으며, 로컬 이미지 편집·스프라이트·아틀라스를 사용할 수 있습니다. Intel 빌드는 제공하지 않습니다.

## Apple 계정 없이 터미널로 설치

[공식 README의 Mac 설치 명령](https://github.com/oocheol/masset#mac-설치)을 터미널에 붙여 넣으세요. 명령은 설치 스크립트의 SHA-256을 먼저 확인한 뒤 실행합니다. 안내를 읽고 `y`를 입력하면 공식 0.1.4 DMG의 크기·SHA-256, 앱 버전·식별자·Apple Silicon 아키텍처와 ad-hoc 서명 무결성을 확인해 설치합니다.

기본 설치 위치는 **`~/Applications/Asset Studio 0.1.4/Asset Studio.app`**입니다. 관리자 암호와 Apple 계정은 필요하지 않습니다. 같은 위치에 앱이 있으면 덮어쓰지 않고 중단합니다. 기존 0.1.3 앱과 프로젝트는 그대로 두고 새 앱을 설치하므로, 이전 앱을 종료한 뒤 새 앱을 사용하세요. 새 앱도 기존의 로컬 프로젝트 저장 위치를 사용합니다.

소스를 먼저 읽으려면 [설치 스크립트](https://github.com/oocheol/masset/releases/download/v0.1.4/install-macos.sh)를 확인하세요. 설치 스크립트는 GitHub에서 내려받은 검증된 DMG를 새 앱으로 복사하며, 브라우저의 quarantine 정보를 새 사본에 전달하지 않습니다. GitHub 배포나 이 설치 방법이 Apple 공증을 부여하지는 않습니다.

## 브라우저로 DMG 설치

1. [공식 0.1.4 DMG](https://github.com/oocheol/masset/releases/download/v0.1.4/AssetStudio_0.1.4_macos-arm64.dmg)를 받습니다. 릴리스의 SHA-256과 비교하세요.
2. Finder에서 홈 폴더의 `Applications` 안에 `Asset Studio 0.1.4` 폴더를 만듭니다. DMG의 **Asset Studio.app**을 그 폴더로 복사합니다. DMG 안에서 직접 실행하면 업데이트할 수 없습니다.
3. 복사한 앱을 실행합니다. 기존 앱과 프로젝트·원본 파일은 삭제할 필요가 없습니다.

## 기존 시험 빌드의 실행 경고

브라우저로 받은 앱에는 Apple Developer ID 서명·공증이 없어 “Apple은 ‘Asset Studio’에 … 악성 코드가 없음을 확인할 수 없습니다”라는 경고가 나타날 수 있습니다.

1. 공식 GitHub 릴리스의 파일과 SHA-256이 맞는지 확인합니다.
2. 복사한 앱을 한 번 실행하고 경고 창을 닫습니다.
3. **시스템 설정 → 개인정보 보호 및 보안 → 보안**에서 Asset Studio 옆의 **확인 없이 열기**를 선택합니다.
4. Mac 암호 또는 Touch ID로 인증한 뒤 **열기**를 선택합니다.

이 선택은 해당 앱에 대한 예외입니다. 시스템 전체 Gatekeeper를 끌 필요는 없습니다. 파일 손상 경고가 나타나거나 해시가 다르면 허용하지 마세요. Apple 공증된 배포를 만들려면 [Developer ID 서명·공증 설정](macos-signing.md)이 필요합니다.

## 앱에서 다음 버전으로 업데이트

1. **0.1.3 이하를 사용 중이면 0.1.4를 한 번 직접 설치**합니다. 이전 공개 앱에는 Mac 업데이트 기능이 없습니다.
2. 앱은 시작할 때와 사용 중 주기적으로 GitHub의 Mac 전용 채널에서 새 버전을 확인합니다. 상단 **앱 업데이트** 버튼으로 직접 확인할 수도 있습니다.
3. 새 버전의 출처·버전·크기·SHA-256을 확인하고 승인 체크 후 **지금 업데이트**를 누릅니다. 제작 작업이 진행 중이면 완료 후 설치합니다.
4. 앱은 파일의 암호학적 서명·서명된 버전·크기·SHA-256과 앱 번들을 검증합니다. 이전 앱을 백업한 뒤 설치 위치의 앱을 교체하고 재실행합니다. 프로젝트·원본·에셋 버전은 유지합니다.

앱은 쓰기 가능한 사용자 `~/Applications`에 설치하세요. 관리자 권한으로 앱을 덮어쓰는 업데이트는 사용하지 않습니다. 앱 백업은 `~/Library/Caches/org.localassets.workbench/updates/` 아래에 남습니다. 검증 실패 시 기존 앱을 유지하고, 교체 실패 시 이전 앱 복원을 시도합니다. 네트워크 오류는 업데이트 패널에서 다시 확인할 수 있습니다.

**업데이트 서명과 Apple 코드 서명·공증은 별개입니다.** Mac 업데이트 파일은 프로젝트의 별도 키로 서명하며, 이 키에는 Apple 개발자 등록이 필요하지 않습니다. Windows 업데이트 채널과 키도 별도로 유지합니다.

## 사용 범위와 개발 빌드

Node.js·Rust 개발 도구와 Windows WebView2는 앱 사용에 필요하지 않습니다. macOS 12.0은 설정상 최소값이며, 모든 Mac·최소 OS의 실행을 보장하지 않습니다. 실제 검증 환경과 파일은 [0.1.4 기록](releases/v0.1.4-macos.md)을 확인하세요.

Mac의 구독 연결·Codex 자동 준비는 지원하지 않습니다. Blender 3D는 Mac 실행 검증 전입니다. Windows의 실증을 Mac의 지원 결과로 적용하지 않습니다.

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
