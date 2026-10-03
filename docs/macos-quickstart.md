# Mac 시험 배포 사용 안내

현재 Mac 공개 배포는 Apple Silicon(M 시리즈)용이며, 로컬 이미지 편집·스프라이트·아틀라스 기능 중심의 시험 배포입니다. Intel 빌드와 다운로드 선택지는 제외했습니다. macOS 12.0은 설정상 최소 버전이며, 패키지의 실제 검증 OS·아키텍처·SHA-256은 릴리스 기록을 확인하세요.

## Apple 계정 없이 터미널로 설치

Apple 개발자 등록 없이 GitHub에서 배포하는 앱은 터미널 설치 스크립트를 제공할 수 있습니다. GitHub에 올리는 것 자체가 Apple 공증을 부여하지는 않습니다. 이 방식은 브라우저로 다운로드할 때 붙는 quarantine 정보를 새 설치 사본에 전달하지 않습니다.

터미널에서 다음 명령을 실행합니다. 설치 대상과 공증이 없는 시험 빌드라는 안내를 확인하고 `y`를 입력합니다.

```sh
curl -fsSL https://github.com/oocheol/masset/releases/download/v0.1.3/install-macos.sh | bash
```

스크립트는 공식 0.1.3 DMG를 내려받아 **용량·SHA-256 → 앱 버전·식별자·Apple Silicon 아키텍처 → ad-hoc 서명 무결성**을 확인합니다. 새 사본을 `~/Applications/Asset Studio.app`에 설치하고 실행합니다. 관리자 암호나 Apple 계정은 필요하지 않습니다. 해당 경로에 앱이 있으면 덮어쓰지 않고 중단합니다.

이미 같은 경로에 설치했다면 별도 위치를 지정할 수 있습니다.

```sh
curl -fsSL https://github.com/oocheol/masset/releases/download/v0.1.3/install-macos.sh | bash -s -- --destination "$HOME/Applications/Asset Studio 0.1.3"
```

소스를 먼저 읽으려면 [릴리스 설치 스크립트](https://github.com/oocheol/masset/releases/download/v0.1.3/install-macos.sh)를 확인하세요. 이 설치는 Apple 공증을 대신하지 않으며 시스템 전체 Gatekeeper나 기존 앱·다운로드 파일·프로젝트를 변경하지 않습니다.

## 브라우저로 DMG 설치

1. `.dmg`를 열고 **Asset Studio.app**을 **Applications** 폴더로 복사합니다.
2. Applications에서 앱을 실행합니다. 기존 프로젝트나 원본 파일은 지우지 마세요.
3. 현재 공개된 0.1.3은 Apple Developer ID 서명·공증이 없는 시험 빌드입니다. 실행 경고가 나타나면 아래 절차를 따르세요.

## 기존 시험 빌드의 실행 경고

“Apple은 ‘Asset Studio’에 … 악성 코드가 없음을 확인할 수 없습니다”는 현재 배포본에 Apple 공증이 없어서 나타나는 경고입니다.

1. 공식 GitHub 릴리스의 DMG인지 확인하고 릴리스 기록의 SHA-256과 비교합니다.
2. 앱을 Applications로 복사한 뒤 한 번 실행하고 경고 창을 닫습니다.
3. **시스템 설정 → 개인정보 보호 및 보안**을 열고 아래쪽 **보안** 영역으로 이동합니다.
4. Asset Studio 차단 안내 옆의 **확인 없이 열기**를 누릅니다. Mac 암호나 Touch ID 인증 후 표시되는 창에서 **열기**를 선택합니다.

이 선택은 해당 앱에 대한 예외입니다. 시스템 전체 Gatekeeper를 끄거나 파일의 quarantine 속성을 제거할 필요가 없습니다. 앱이 파일을 손상시킨다는 별도의 경고가 나타나거나 다운로드의 해시가 다르면 이 절차로 허용하지 마세요.

경고 없이 설치할 새 배포본에는 개발자 인증서와 Apple 공증이 필요합니다. [서명·공증 설정 안내](macos-signing.md)를 참고하세요. 아래 사용 범위는 현재 공개 시험 빌드 기준입니다.

Node.js·Rust 개발 도구와 Windows WebView2는 Mac 앱 사용에 필요하지 않습니다. 로컬 기능은 외부 AI 계정 없이 사용할 수 있습니다.

이 Mac 시험 배포는 공식 Codex 실행 파일·이미지 호스트의 서명과 설치 레이아웃을 아직 검증하지 않았으므로 **구독 연결과 Codex 자동 준비를 지원하지 않습니다**. Mac 앱 내부 업데이트도 제공하지 않습니다. 새 버전은 소개 사이트 또는 GitHub 릴리스에서 받아 앱을 교체하세요. 교체 전에 앱을 닫고 프로젝트를 별도로 백업하세요.

Blender 기반 3D 기능은 Mac 실행 검증 전입니다. Windows의 Blender·구독 이미지 실증을 Mac의 지원 결과로 적용하지 않습니다. Gatekeeper 최초 실행, 다른 실제 Mac 하드웨어, 이전 버전 교체·제거도 별도 검증 항목입니다.

개발자가 Mac 서버에서 직접 빌드할 때는 Xcode Command Line Tools와 잠금 파일의 Node/Rust 버전을 사용합니다.

```sh
npm ci
cargo test --workspace --target aarch64-apple-darwin
node scripts/collect-third-party-notices.mjs --target aarch64-apple-darwin --out docs/licenses --strict
npm run desktop:build -- --target aarch64-apple-darwin --config "$PWD/apps/desktop/src-tauri/tauri.macos.trial.conf.json" --bundles app,dmg
```

마지막 명령은 인증서 없는 개발용 시험 빌드입니다. `--config`는 실제 CLI 작업 디렉터리에 맞는 절대 경로를 사용합니다. GitHub의 **Verified macOS packages** 수동 workflow도 기본값 **trial**로 Apple 계정 없이 빌드합니다. 공증된 배포는 **notarized**를 선택하고 [인증 정보를 등록](macos-signing.md)합니다. 이 workflow는 실제 DMG를 마운트해 복사한 앱의 WebView/IPC와 별도 네이티브 Backend 산출물을 확인하며, 공증 배포에서는 서명·공증·Gatekeeper도 필수로 검사합니다.

Mac 패키지에 들어가는 라이선스 원문은 해당 아키텍처의 Cargo 의존성을 기준으로 빌드 서버에서 수집합니다. Windows 라이선스 인벤토리로 대체하지 않습니다.

현재 공개된 시험 빌드는 로컬 ad-hoc 서명으로 앱 번들의 파일을 봉인했습니다. 해당 릴리스의 `codesign --verify --deep --strict` 통과는 Apple Developer ID 신원 서명이나 공증을 뜻하지 않습니다. 새 공증 workflow의 성공과 새 배포본의 검증 기록이 준비되기 전까지 현재 DMG의 서명·공증 상태는 그대로입니다.
