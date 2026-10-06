# npm 스킬 배포

전용 패키지는 `@oocheol/asset-studio`, 명령은 `asset-studio-skill`입니다. [설치·업데이트 안내](skill-first-setup.md)와 [패키지 소스](../integrations/npm)를 참고하세요.

## 0.1.13 공개 확인 · 2026-10-06

[npm 공개 패키지](https://www.npmjs.com/package/@oocheol/asset-studio)의 `latest`는 **0.1.13**입니다. Windows·Mac 공용 패키지 하나이며 운영체제별 실행 도구를 선택합니다. 이번에는 **Windows 앱·독립 CLI 0.1.13**, **Mac 앱 0.1.12·독립 CLI 0.1.11**을 사용합니다. 새 Mac 실행 파일은 만들지 않았습니다.

공개 레지스트리에서 받은 실제 파일은 게시한 **77,296바이트**와 동일했습니다. SHA-256은 `7afaf6b28c4cc80f58ee5505c9a4e9c6b00542334bda491154a489ee51ffaa65`, 스킬 8개 파일의 목록 SHA-256은 `f9faecd287f84bbc332e752e0aec4ccf80fb52a3b92b35451dcedbc8a96c9809`입니다. SRI는 다음과 같습니다.

```text
sha512-bwle1msaUGhxTA7oaeg5qj/0cTx0BTGnjBghMOoHlDEDexyHEf2YEPrBjVpHv1dSxUbdrpAxvxsRaR0MgJBUBQ==
```

새 npm 캐시·격리 프로젝트에서 공개 0.1.13의 `install`·`update`·`status`를 실제 실행했습니다. 공개 **0.1.12 → `latest` 0.1.13** 업데이트는 이전 스킬 8개 파일·설치 기록·사용자 추가 파일을 모두 백업했습니다. 다시 업데이트하면 `unchanged`, 상태 확인은 `current`였습니다. Mac 런타임 고정 정보 전체도 기존 값과 같았습니다. 사용자 전역 스킬은 변경하지 않았습니다.

공개 npm으로 설치한 스킬의 실제 Windows PowerShell 5.1 로더는 공개 CLI ZIP을 받아 **380개 파일과 설치 영수증**을 검사하고 새 격리 폴더에 준비했습니다. 테스트용 패키지·manifest 지정 없이 기본 개인 런타임 폴더 구조를 사용했고, 마지막 준비 명령은 출력만 했습니다. 이번 공개 로더 검사는 로그인·모델 다운로드·새 이미지 생성 요청을 보내지 않았습니다. 동일한 CLI ZIP의 실제 2D·3D 저장·재열기·내보내기는 [Windows 릴리스 기록](releases/v0.1.13-windows.md)에 별도로 있습니다. 보조 검사기의 영수증 버전 필드와 파일 정렬 가정을 실제 형식에 맞춰 바로잡았으며 처음 검사와 다운로드 기록도 보존했습니다.

[Windows 빌드·브라우저·독립 내보내기 CI](https://github.com/oocheol/masset/actions/runs/37429774705)와 [Windows·Apple Silicon Mac npm 설치 CI](https://github.com/oocheol/masset/actions/runs/37429774774)가 통과했습니다. Mac의 npm 설치 검사는 새 Mac 네이티브 앱 검증과 구분합니다.

```sh
npx @oocheol/asset-studio@latest install
npx @oocheol/asset-studio@latest update
npx @oocheol/asset-studio@latest status
```

Asset Studio 앱 설치는 선택입니다. Node.js 22.20 이상으로 스킬을 등록한 뒤 새 Codex 작업에서 `$asset-studio`로 요청합니다. 기존 공식 Codex 인증을 재사용하며 필요한 실행 도구·3D 모델은 승인한 범위에서 준비합니다. [소개 사이트](https://masset-nu.vercel.app/)와 [Windows 0.1.13 다운로드](https://github.com/oocheol/masset/releases/tag/v0.1.13)에도 같은 플랫폼별 버전을 표시합니다.

## 0.1.12 공개 확인 · 2026-10-06

[npm 공개 패키지](https://www.npmjs.com/package/@oocheol/asset-studio)의 당시 `latest`는 **0.1.12**였습니다. 앱을 설치하지 않고 `npx @oocheol/asset-studio@latest install`로 Codex 스킬을 등록합니다. npm 설치에는 Node.js 22.20 이상이 필요하며, 등록한 스킬의 첫 사용 시 별도의 네이티브 CLI를 해시 검증 후 준비합니다. 기존 Codex 인증을 재사용하고, 인증이 없거나 만료된 경우에만 공식 로그인 절차를 진행합니다.

공개 레지스트리의 실제 배포 파일은 게시한 **77,089바이트**와 일치했습니다. SHA-256은 `190808356fcb52b7704debf2c3660f27504b6113f0aa6ede337a0321cd2edbaa`이며, 스킬 8개 파일의 목록 SHA-256은 `438fcbbc3c31c9ff94942d3a2b3f182a461b805031dd978c9d2aa83efd792d33`입니다. SRI는 다음과 같습니다.

```text
sha512-8eQ9NsEIOItx2DYuLbIpJJ93ZEmP+aHKTvWRUn19mQpmJvXeR7AJy5j6GhuF6/wmvAym/QfGh0C07zVqsXsppw==
```

이번 공통 스킬은 **Windows CLI 0.1.12 / Apple Silicon Mac CLI 0.1.11**을 고정합니다. 기존 Mac CLI·앱 0.1.12·업데이트 채널은 보존했으며, 이번 Windows 작업에서 Mac 실행 파일을 새로 만들지 않았습니다. Mac 앱 0.1.12에 포함된 스킬은 0.1.11이므로 최신 공통 스킬은 npm 또는 공통 ZIP으로 설치합니다.

새 npm 캐시·격리 프로젝트에서 공개 배포본의 `install`·`update`·`status`를 실제 실행해 8개 파일과 설치 기록을 확인했습니다. **0.1.11 → 공개 `latest` 0.1.12** 업데이트에서는 이전 8개 파일·설치 기록·추가한 사용자 파일을 백업으로 보존했습니다. 다시 업데이트하면 `unchanged`, 상태 확인은 `current`였으며 Mac 런타임 고정 정보는 바뀌지 않았습니다. 사용자 전역 스킬은 변경하지 않았습니다.

별도 Windows PowerShell 5.1 검증에서는 새 스킬 로더가 공개 CLI ZIP을 실제로 받아 SHA-256·파일 377개를 검사하고 사용자 전용 공간에 준비했습니다. 로더 준비만 확인했으며 새 로그인이나 이미지 생성은 요청하지 않았습니다. npm 설치 기능 검사 19개도 통과했습니다. [Windows 앱·CLI의 실제 검증과 한계](releases/v0.1.12-windows.md)를 함께 확인하세요.

```sh
npx @oocheol/asset-studio@latest install
npx @oocheol/asset-studio@latest update
npx @oocheol/asset-studio@latest status
```

## 0.1.11 당시 공개 확인 · 2026-10-06

[npm 공개 패키지](https://www.npmjs.com/package/@oocheol/asset-studio)의 당시 `latest`는 0.1.11이었습니다. 공개 레지스트리에서 받은 77,013바이트의 실제 배포 파일이 게시한 파일과 일치했습니다. SHA-256은 `3694f028ac698d379f5cfd7520fe1fc910b0b77531b3836172a9bef3972061fb`입니다.

새 npm 캐시와 격리된 프로젝트에서 `npx @oocheol/asset-studio@latest`의 `install`·`update`·`status`를 실행해 설치, 같은 버전 유지, 정상 상태를 확인했습니다. 설치된 스킬 8개 파일과 설치 기록의 무결성도 검사했습니다. 이 검증은 사용자 전역 스킬을 변경하거나 새 네이티브 도구·모델을 다운로드하지 않았습니다.

[Windows·Apple Silicon Mac CI](https://github.com/oocheol/masset/actions/runs/37402478433)에서 설치·백업·손상 거부·실패 복구 검사 19개와 실제 npm 배포 파일 설치가 각각 통과했습니다. npm 설치 기능과 스킬 배포 검사이며 네이티브 앱·이미지 제공자의 새로운 실행 실증과는 구분합니다.

## 버전과 산출물

- `integrations/npm/package.json`의 버전은 npm 설치 기능 버전입니다. 한번 게시한 버전은 다시 사용하지 않습니다.
- `integrations/codex/skills/asset-studio/references/native-runtime.json`은 별도로 출시한 Windows x64·Apple Silicon Mac CLI의 버전·파일 크기·SHA-256을 고정합니다. 설치 기능만 수정하면 앱이나 실행 도구를 다시 빌드할 필요가 없습니다.
- `npm run skill:prepare`는 공통 스킬 8개 파일을 LF로 정규화해 배포용 사본과 SHA-256 목록을 만듭니다. 설치에서는 정규화 없이 그 배포 바이트를 그대로 검사·복사합니다. 원본 스킬 소스는 바꾸지 않습니다.
- `npm run skill:test`는 격리된 임시 폴더에서 보존·버전 변경·손상 거부·잠금·실패 복구를 검사합니다. `npm run skill:pack`은 `output/npm-skill`에 실제 `.tgz`를 만듭니다. 네이티브 실행 파일과 모델은 포함하지 않습니다.

```sh
npm run skill:test
npm run skill:pack
npm run skill:verify
npm publish ./output/npm-skill/oocheol-asset-studio-0.1.13.tgz --ignore-scripts --access public
```

게시 후 `npm view @oocheol/asset-studio@버전 dist --json`으로 실제 레지스트리의 무결성을 확인하고, 새 캐시·격리 프로젝트에서 `npx @oocheol/asset-studio@버전 install --project "절대 경로" --json`으로 실제 배포본을 설치해 확인합니다. 공개 메타데이터와 실제 설치가 확인되기 전에는 사이트의 기본 설치 명령을 바꾸지 않습니다.

## GitHub 검증과 선택적 게시

`.github/workflows/npm-skill.yml`은 패키지 관련 변경에서 Windows·Apple Silicon Mac의 npm 설치 검사를 실행하고 `.tgz`를 저장합니다. 앱·네이티브 바이너리·3D 모델을 빌드하거나 다운로드하지 않습니다. Mac에서 이 검사가 통과해도 네이티브 앱 실행을 검증했다는 뜻은 아닙니다.

게시 작업은 master에서 `workflow_dispatch`의 `publish`를 선택할 때만 실행합니다. 먼저 npm 패키지 Settings에서 GitHub Actions trusted publisher를 직접 구성해야 합니다.

| 설정 | 값 |
| --- | --- |
| Organization or user | `oocheol` |
| Repository | `masset` |
| Workflow filename | `npm-skill.yml` |
| Environment | 지정하지 않음 |

OIDC 게시 권한은 해당 게시 job의 `id-token: write`에만 있습니다. 저장소에 장기 npm 토큰을 넣지 않습니다. 현재 PC의 직접 게시 로그인과 GitHub trusted publisher 설정은 별개의 상태입니다. 설정을 실제로 완료하기 전에는 자동 게시가 준비됐다고 표시하지 않습니다.

공식 문서: [공개 scoped 패키지](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), [trusted publishers](https://docs.npmjs.com/trusted-publishers/). Trusted publishing은 npm 11.5.1 이상·Node.js 22.14 이상과 GitHub-hosted runner가 필요합니다. 이 workflow는 Node.js 24.15.0을 사용합니다.
