# npm 스킬 배포

전용 패키지는 `@oocheol/asset-studio`, 명령은 `asset-studio-skill`입니다. [설치·업데이트 안내](skill-first-setup.md)와 [패키지 소스](../integrations/npm)를 참고하세요.

## 버전과 산출물

- `integrations/npm/package.json`의 버전은 npm 설치 기능 버전입니다. 한번 게시한 버전은 다시 사용하지 않습니다.
- `integrations/codex/skills/asset-studio/references/native-runtime.json`은 별도로 출시한 Windows x64·Apple Silicon Mac CLI의 버전·파일 크기·SHA-256을 고정합니다. 설치 기능만 수정하면 앱이나 실행 도구를 다시 빌드할 필요가 없습니다.
- `npm run skill:prepare`는 공통 스킬 8개 파일을 LF로 정규화해 배포용 사본과 SHA-256 목록을 만듭니다. 설치에서는 정규화 없이 그 배포 바이트를 그대로 검사·복사합니다. 원본 스킬 소스는 바꾸지 않습니다.
- `npm run skill:test`는 격리된 임시 폴더에서 보존·버전 변경·손상 거부·잠금·실패 복구를 검사합니다. `npm run skill:pack`은 `output/npm-skill`에 실제 `.tgz`를 만듭니다. 네이티브 실행 파일과 모델은 포함하지 않습니다.

```sh
npm run skill:test
npm run skill:pack
npm run skill:verify
npm publish ./output/npm-skill/oocheol-asset-studio-0.1.11.tgz --ignore-scripts --access public
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
