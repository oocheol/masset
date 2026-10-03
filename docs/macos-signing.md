# macOS Developer ID 서명·공증

현재 공개된 0.1.3 Mac DMG는 ad-hoc 시험 빌드입니다. 이 서명은 파일 변조 확인용이며 Apple의 개발자 신원 확인이나 공증을 대신하지 않습니다. 따라서 “Apple은 ‘Asset Studio’에 … 악성 코드가 없음을 확인할 수 없습니다” 경고가 나타납니다. 소스 설정을 수정해도 이미 다운로드한 파일은 바뀌지 않습니다. 기존 앱의 실행 방법은 [Mac 안내](macos-quickstart.md#기존-시험-빌드의-실행-경고)를 참고하세요.

이 경고를 해결하는 배포본은 **Developer ID Application 서명 → Apple 공증 → 공증 티켓 첨부 → Gatekeeper 검증**을 모두 통과해야 합니다. Apple Developer Program 계정과 인증서의 개인 키가 필요합니다. 인증서가 없는 빌드는 정식 배포 대상으로 취급하지 않습니다.

## GitHub Actions 인증 정보 준비

1. Apple Developer 계정에서 **Developer ID Application** 인증서를 만듭니다. App Store용 Apple Distribution이나 개발용 Apple Development 인증서를 사용하지 않습니다.
2. Mac의 키체인 접근에서 해당 인증서와 **개인 키를 함께** 암호로 보호한 `.p12`로 내보냅니다. `.cer` 파일만으로는 서명할 수 없습니다.
3. 인증서 이름은 `security find-identity -v -p codesigning`에서 확인합니다. 예: `Developer ID Application: Publisher Name (ABCDE12345)`.
4. [Apple 계정](https://account.apple.com/)에서 공증용 앱 암호를 만듭니다. 일반 로그인 비밀번호를 사용하지 않습니다.
5. [저장소 Actions Secrets](https://github.com/oocheol/masset/settings/secrets/actions)에 아래 여섯 항목을 등록합니다. 비밀번호·인증서·개인 키는 채팅이나 저장소 파일에 넣지 않습니다.

| Secret | 내용 |
| --- | --- |
| `APPLE_CERTIFICATE` | 개인 키를 포함한 `.p12` 파일의 base64 문자열 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12`를 내보낼 때 지정한 암호 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)` 전체 이름 |
| `APPLE_ID` | 공증 권한이 있는 Apple 계정 이메일 |
| `APPLE_PASSWORD` | Apple 계정에서 생성한 앱 암호 |
| `APPLE_TEAM_ID` | 인증서와 같은 Apple 팀의 10자리 ID |

인증서 변환·등록은 저장소 밖의 비공개 경로에서 합니다. 나머지 Secret은 `gh secret set`의 입력 프롬프트 또는 GitHub 설정 화면에서 등록할 수 있습니다.

```sh
openssl base64 -A -in /private/path/developer-id.p12 -out /private/path/certificate-base64.txt
gh secret set APPLE_CERTIFICATE --repo oocheol/masset < /private/path/certificate-base64.txt
gh secret set APPLE_CERTIFICATE_PASSWORD --repo oocheol/masset
gh secret set APPLE_SIGNING_IDENTITY --repo oocheol/masset
gh secret set APPLE_ID --repo oocheol/masset
gh secret set APPLE_PASSWORD --repo oocheol/masset
gh secret set APPLE_TEAM_ID --repo oocheol/masset
```

## 서명된 배포 후보 만들기

**Verified macOS packages** workflow의 `distribution`을 **notarized**로 선택해 실행합니다. 기본값 **trial**은 Apple 계정 없이 사용할 수 있는 시험 배포입니다. Apple Silicon용만 생성합니다.

```sh
gh workflow run macos-release.yml --repo oocheol/masset -f distribution=notarized
```

인증 정보가 누락되면 빌드 전에 실패합니다. Tauri는 hardened runtime과 타임스탬프를 사용해 앱과 DMG를 서명하고, 앱을 공증하여 티켓을 첨부합니다. `scripts/macos-signing.mjs notarize`는 최종 DMG도 Apple에 제출하고 **Accepted** 결과를 확인한 뒤 DMG에 티켓을 첨부합니다. 공증·티켓 첨부가 실패하면 패키지를 업로드하지 않습니다. 암호가 포함된 공증 명령 인수는 로그에 기록하지 않습니다.

이어 실제 DMG를 마운트·복사하고, `--require-notarization --expected-team-id`로 다음 조건을 검사합니다.

- 앱과 DMG의 서명 무결성, 예상 Developer ID 팀, 보안 타임스탬프, 앱 hardened runtime
- 앱과 DMG 각각의 `xcrun stapler validate`
- 복사한 앱의 `spctl --assess --type execute`, DMG의 `spctl --assess --type open --context context:primary-signature`; 모두 `Notarized Developer ID`여야 함
- `syspolicy_check distribution`과 기존 실제 WebView/IPC·별도 네이티브 2D Backend 검사

모든 검사를 통과한 경우에만 `macos-arm64-notarized-package`를 업로드합니다. 실패한 실행은 진단 자료만 남깁니다. Gatekeeper 검사는 macOS 15 runner의 실제 정책 평가이며, 다른 Mac에서 브라우저로 다운로드한 뒤 Finder에서 처음 실행하는 검증은 별도로 수행해야 합니다. 시스템 전체 보안 설정이나 사용자 설치본의 quarantine 속성을 바꾸지 않습니다.

이 workflow는 릴리스를 자동 게시하지 않습니다. 공증 티켓을 첨부하면 DMG 바이트가 바뀌므로 **최종** 파일로 용량·SHA-256과 릴리스·사이트 메타데이터를 다시 생성하고, 새 배포본의 공개 다운로드를 확인한 뒤 게시합니다. 기존 0.1.3 파일이나 과거 검증 기록을 서명된 것으로 바꾸지 않습니다.

## 로컬 빌드와 명시적 시험 빌드

로컬에서는 키체인의 Developer ID 인증서와 위의 신원·공증 환경 변수를 사용합니다. `.p12`를 키체인에 설치했다면 `APPLE_CERTIFICATE`와 `APPLE_CERTIFICATE_PASSWORD`는 생략할 수 있습니다. 공증은 Apple ID 세 항목 대신 `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`로도 가능합니다. 마지막 항목은 App Store Connect 팀 API 키의 `.p8` 파일 경로입니다.

기본 Mac 설정 `tauri.macos.conf.json`은 Apple 계정 없이 ad-hoc 서명합니다. 공증된 배포는 `--config "$PWD/apps/desktop/src-tauri/tauri.macos.notarized.conf.json"`을 명시하며 해당 profile의 hook에서 신원·공증 정보를 요구합니다. workflow의 **trial**도 ad-hoc 서명이며 브라우저 다운로드의 경고가 계속 나타납니다. 결과물은 `macos-arm64-trial-package`로 구분하고 [GitHub 터미널 설치](macos-quickstart.md#apple-계정-없이-터미널로-설치)를 제공할 수 있습니다. 공증 배포가 실패했을 때 trial로 자동 전환하지 않습니다.

[Tauri macOS 서명 문서](https://v2.tauri.app/distribute/sign/macos/) · [Apple 공증 안내](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
