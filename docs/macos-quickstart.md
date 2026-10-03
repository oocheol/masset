# Mac 시험 배포 사용 안내

현재 Mac 공개 배포는 Apple Silicon(M 시리즈)용이며, 로컬 이미지 편집·스프라이트·아틀라스 기능 중심의 시험 배포입니다. Intel 빌드와 다운로드 선택지는 제외했습니다. macOS 12.0은 설정상 최소 버전이며, 패키지의 실제 검증 OS·아키텍처·SHA-256은 릴리스 기록을 확인하세요.

1. `.dmg`를 열고 **Asset Studio.app**을 **Applications** 폴더로 복사합니다.
2. Applications에서 앱을 실행합니다. 기존 프로젝트나 원본 파일은 지우지 마세요.
3. Apple Developer ID 서명·공증은 적용하지 않았습니다. macOS가 해당 앱의 실행을 차단하면 출처와 파일 해시를 확인한 뒤 시스템 설정의 **개인정보 보호 및 보안**에서 해당 앱에 대한 **확인 없이 열기**를 선택할 수 있습니다. 시스템 전체 보안 설정을 끄는 명령은 사용하지 않습니다.

Node.js·Rust 개발 도구와 Windows WebView2는 Mac 앱 사용에 필요하지 않습니다. 로컬 기능은 외부 AI 계정 없이 사용할 수 있습니다.

이 Mac 시험 배포는 공식 Codex 실행 파일·이미지 호스트의 서명과 설치 레이아웃을 아직 검증하지 않았으므로 **구독 연결과 Codex 자동 준비를 지원하지 않습니다**. Mac 앱 내부 업데이트도 제공하지 않습니다. 새 버전은 소개 사이트 또는 GitHub 릴리스에서 받아 앱을 교체하세요. 교체 전에 앱을 닫고 프로젝트를 별도로 백업하세요.

Blender 기반 3D 기능은 Mac 실행 검증 전입니다. Windows의 Blender·구독 이미지 실증을 Mac의 지원 결과로 적용하지 않습니다. Gatekeeper 최초 실행, 다른 실제 Mac 하드웨어, 이전 버전 교체·제거도 별도 검증 항목입니다.

개발자가 Mac 서버에서 직접 빌드할 때는 Xcode Command Line Tools와 잠금 파일의 Node/Rust 버전을 사용합니다.

```sh
npm ci
cargo test --workspace --target aarch64-apple-darwin
node scripts/collect-third-party-notices.mjs --target aarch64-apple-darwin --out docs/licenses --strict
npm run desktop:build -- --target aarch64-apple-darwin --config "$PWD/apps/desktop/src-tauri/tauri.macos.conf.json" --bundles app,dmg
```

마지막 명령의 `--config`는 실제 CLI 작업 디렉터리에 맞는 절대 경로를 사용하는 편이 안전합니다. GitHub의 **Verified macOS packages** 수동 workflow는 Apple Silicon 패키지만 만들고 실제 DMG를 마운트해 복사한 앱의 WebView/IPC와 별도 네이티브 Backend 산출물을 확인합니다. 통과한 패키지만 별도 단계에서 공개합니다.

Mac 패키지에 들어가는 라이선스 원문은 해당 아키텍처의 Cargo 의존성을 기준으로 빌드 서버에서 수집합니다. Windows 라이선스 인벤토리로 대체하지 않습니다.

Mac 설정은 로컬 ad-hoc 서명으로 앱 번들의 파일을 봉인합니다. 검증 workflow는 복사한 앱에 `codesign --verify --deep --strict`를 실행해 파일 봉인을 확인합니다. Apple Developer ID 신원 서명과 공증, Gatekeeper 최초 다운로드 허용 여부는 별도 미검증 항목입니다.
