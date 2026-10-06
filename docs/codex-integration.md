# Codex에서 게임을 만들며 에셋 제작하기

**0.1.11 공통 스킬은 Windows x64와 Apple Silicon Mac에서 앱 없이 시작할 수 있습니다.** 필요한 독립 CLI·작업자·3D 런타임을 동의 후 사용자 전용 폴더에 준비하고, 기존 공식 Codex 로그인을 재사용합니다. [스킬 플러그인 ZIP](https://github.com/oocheol/masset/releases/download/v0.1.11/AssetStudio_0.1.11_codex-plugin-windows-macos.zip) · [앱 없이 시작하는 설치 안내](skill-first-setup.md). Codex가 게임을 구현하며 개별 에셋 제작·엔진 반영·실행 검증을 이어가는 구성입니다. 별도 MCP 서버·포트·API 키는 필요하지 않습니다. Windows와 Mac 앱도 0.1.11로 제공합니다. 공통 스킬 ZIP에는 Mac 독립 CLI의 고정 파일 목록도 포함됩니다. Mac 실행 검증은 잠금 상태로 생략했으며 [배포 기록](releases/v0.1.11-macos.md)에 명시합니다.

| 방법 | 설치와 사용 | 선택 |
| --- | --- | --- |
| 독립 CLI + 로컬 스킬 | 스킬 설치 후 누락 도구 자동 준비, Codex가 JSON 목록과 CLI 호출 | 앱 없이 사용. 기존 Rust 제작·검증 경로를 재사용 |
| 스킬 플러그인 패키지 | `integrations/codex/plugin.json`과 `skills/` 배포 | 로컬·팀 배포용 패키지 포함. 공개 디렉터리 등록은 별도 |
| MCP 서버 | 지속 실행, 명령/상태 도구, 연결 설정 필요 | 현재 구현하지 않음. CLI에 없는 제작 기능을 추가하지도 않으므로 초기 설치에는 불필요 |
| 별도 유료 API | API 키·비용·새 공급자 검증 필요 | 제공하지 않음 |

스킬 탐색·암묵 호출은 [공식 Codex 스킬 안내](https://learn.chatgpt.com/docs/build-skills), 플러그인 형식은 [공식 플러그인 패키징 안내](https://developers.openai.com/plugins/build/plugins)를 기준으로 합니다. 암묵 호출은 설명이 작업과 맞을 때 Codex가 선택하는 방식이며, 모든 요청에서 자동 호출된다고 보장하지 않습니다.

## 설치와 시작

새 사용자는 [스킬 설치 안내](skill-first-setup.md)에 따라 `skills/asset-studio`를 `~/.agents/skills/asset-studio`에 설치하고 새 Codex 작업에서 호출합니다. 앱·Python·Node·Rust가 없어도 운영체제 기본 도구로 준비합니다.

Mac 0.1.11 앱 사용자는 제작 홈의 **Codex 스킬 설치** 버튼이나 다음 CLI 명령으로 공통 스킬을 설치할 수도 있습니다. 앱에 포함된 CLI 경로를 함께 등록합니다.

```sh
"$HOME/Applications/Asset Studio 0.1.11/Asset Studio.app/Contents/MacOS/asset-cli" install-codex
```

위 명령은 터미널 설치의 기본 앱 위치입니다. 다른 폴더에 설치했다면 해당 앱의 `Contents/MacOS/asset-cli` 경로를 사용하세요.

사용자 `~/.agents/skills/asset-studio`에 스킬과 실제 CLI 경로를 저장합니다. 앱 위치에 맞는 CLI가 설치되며, 기존 관리형 스킬은 해시 확인 후 백업하고 갱신합니다. 사용자가 수정한 스킬은 덮어쓰지 않습니다. Codex의 스킬 목록을 새로 읽는 새 작업에서 사용하세요.

Codex에 다음처럼 요청합니다.

> $asset-studio 폐광 기지에 잠입해 포로를 구출하는 게임을 만들어줘. 기존 프로젝트를 활용하고, 부족한 이미지와 정적 3D 소품도 만들어 게임에 넣은 뒤 직접 실행해서 확인해줘.

스킬을 직접 지정하지 않아도 게임 제작·에셋 작업과 맞을 때 선택될 수 있습니다. 0.1.11 스킬 진입점은 설치·계정·3D 상태를 확인하고 필요한 준비를 진행합니다. 이미 공식 Codex에 로그인한 환경은 별도 연결 없이 재사용하며 토큰을 복사하거나 유료 API로 대체하지 않습니다.

## CLI 사용

0.1.11 독립 CLI는 스킬이 검증·설치한 경로와 `--resources /absolute/runtime/resources`로 호출합니다. 아래는 Mac 0.1.11 앱에 포함된 CLI의 호출 예입니다. 독립 개발 빌드에는 `--resources /absolute/masset`를 전달합니다.

```sh
"$HOME/Applications/Asset Studio 0.1.11/Asset Studio.app/Contents/MacOS/asset-cli" doctor --check-gpt
"$HOME/Applications/Asset Studio 0.1.11/Asset Studio.app/Contents/MacOS/asset-cli" produce \
  --game-root /absolute/MyGame \
  --manifest /absolute/assets.json \
  --request-id 5130c051-cd41-4eaa-9f91-caa1e9808131 --allow-gpt
```

Codex는 [JSON 예시](../integrations/codex/skills/asset-studio/references/manifest.json)에 따라 이미 알고 있는 게임의 제작 목록을 작성합니다. `referencePaths`에 선택한 PNG·JPEG·WebP·GLB의 절대 경로를 최대 5개 추가할 수 있습니다. 한 항목은 이름·종류·설명·용도를 가진 개별 에셋입니다. 무기 5개는 서로 다른 항목 5개이며, 한 이미지에 무기 5개를 모아 요청하지 않습니다. `plannerModel=codex-manifest`는 별도 GPT 분석 호출 없이 Codex 목록을 사용했음을 기록합니다.

JSON Lines 출력의 `plan`, `progress`, `result`로 실제 제작을 추적합니다. Codex는 작업 프로세스를 유지하면서 게임 코드를 구현하고, `status --workspace /absolute/workspace`로 마지막 저장 상태를 읽을 수 있습니다. 앱이 열어 둔 작업 공간과 별도 CLI 작업 공간을 사용하며, 검증된 로컬 모델은 공유합니다. 결과는 엔진별 새 폴더와 해시 명세에 저장합니다.

같은 게임·목록·요청 UUID로 다시 호출하면 기존 작업을 이어갑니다. UUID를 바꾸면 새로운 제작 요청입니다. 제출 결과가 불명확한 GPT 작업은 자동 재요청하지 않습니다. `external_unknown`은 먼저 확인하고, 의도한 새 제출만 승인합니다. 로컬 변환 실패는 이미 받은 이미지를 보존해 해당 단계만 다시 처리할 수 있습니다. 명령 실패·시간 초과는 0이 아닌 종료 코드와 JSON 오류를 반환합니다.

기존 이미지/GLB의 가져오기·3D 변환·로컬 후처리·내보내기는 `init`과 `command --json`을 사용합니다. 자세한 요청 형식과 복구는 [CLI 참조](../integrations/codex/skills/asset-studio/references/cli.md)를 참고하세요. `--allow-gpt`는 승인된 게임 설명과 참고 자료의 공식 구독 전송을 허용하는 명시적 CLI 옵션입니다.

## 역할과 검증 범위

Asset Studio는 개별 시각 에셋과 검증 가능한 파일을 만듭니다. Codex는 플레이어 조작·AI·미션·카메라·음향·애니메이션을 구현하고, 실제 엔진 가져오기·재질·충돌·씬 연결·빌드·플레이 테스트를 담당합니다. Unity의 GLB 가져오기 지원 여부도 실제 프로젝트에서 확인해야 합니다. 에셋 폴더 생성으로 게임 완성을 선언하지 않습니다.

이미지에서 3D는 Windows x64·Apple Silicon Mac의 TripoSR·Blender 경로이며 숨은 면·얇은 물체의 형상은 확인이 필요합니다. 새로운 모델 품질이나 리깅·애니메이션을 보장하지 않습니다. Windows 0.1.9 앱에는 새 CLI가 포함되지 않으므로 0.1.11 독립 스킬을 사용합니다. 이전 Mac 0.1.10 최종 앱 패키지의 추가 설치·화면 테스트는 당시 요청에 따라 생략했으며, [이전 개발 검증](codex-integration-validation.md)에 기록했습니다. 독립 CLI 검증은 0.1.11 릴리스 기록에서 별도로 확인합니다. 모바일 성능과 게임 전체 완성 검증은 포함하지 않습니다.
