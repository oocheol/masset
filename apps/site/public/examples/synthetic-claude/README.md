# Synthetic Claude planning examples / 가상 Claude 기획 예시

> **Authored illustrations — not executed. No real participants or Claude calls.**
>
> **작성된 가상 예시 — 미실행. 실제 참여자와 Claude 호출이 없습니다.**

## 한국어

### 출처와 목적

이 폴더는 Treeset이 2026년 10월 9일 AI의 도움으로 작성한 **가상 설계·평가 자료**입니다. Asset Studio의 Claude 기획 기능을 앞으로 어떻게 검토할지 설명하기 위해 여섯 제작 역할을 설정했습니다. 참여자는 모집하지 않았으며, 실제 사용자나 고객의 발언을 인용하지 않았습니다. 대화와 예상 제작 계획은 모두 작성된 예시입니다.

- 실제 사용자 테스트·인터뷰·고객 후기·추천사·제품 사용 기록이 아닙니다.
- Claude 또는 다른 제공자 API를 호출하지 않았으며, Claude가 생성한 결과물이 아닙니다.
- 이미지·모델을 생성하거나 파일·게임 엔진·장치를 검증한 기록이 아닙니다.
- 사용자 수, 평가 점수, 처리 시간, 비용, 품질 개선률을 측정하지 않았습니다.
- 실제 사용자·Claude 사용·프로그램 신청 자격을 증명하는 자료로 사용하지 않습니다.

`scenarios.json`은 `type: "synthetic-design-evaluation"`, `synthetic: true`, `providerExecuted: false`를 명시합니다. 각 사례는 `status: "illustrative-not-executed"`, `observedResults: null`, `metrics: null`입니다. 픽셀 치수, 삼각형 상한, 재질 수, 에셋 수와 검수 항목은 **향후 확인할 목표 조건**이며 달성한 결과가 아닙니다.

### 여섯 시나리오

| ID | 가상 역할 | 검토하려는 설계 문제 |
| --- | --- | --- |
| SIM-01 | 1인 픽셀 게임 개발자 | 이미지 크기·팔레트·알파·타일 경계의 일관성 |
| SIM-02 | 모바일 로우폴리 개발자 | 폴리곤·재질 예산과 작은 화면의 실루엣 |
| SIM-03 | 테크니컬 아티스트 | GLB 구조 검수, 엔진 검수 분리, 원본 보존 |
| SIM-04 | 다국어 콘텐츠 디자이너 | 한국어·영어 의미 보존과 이미지·UI 문구 분리 |
| SIM-05 | 소규모 게임잼 팀 | 최소 범위, 독립 작업 지시, 공통 스타일과 전달 |
| SIM-06 | 개인정보 보호를 중시하는 교육자 | 외부 전송 제한, 로컬 제작, 공유 전 메타데이터 확인 |

각 사례의 세 대화 턴은 `simulated-user`, `illustrative-plan`, `simulated-follow-up`입니다. 이 역할명은 허구의 요청·작성된 계획·허구의 후속 요청을 구분합니다. 예상 계획의 에셋 파일명은 나중에 만들 수 있는 출력 이름이며, 이 폴더에 해당 이미지·모델이 존재한다는 뜻이 아닙니다.

SIM-06의 외부 전송 없는 조건에서는 원격 Claude 호출이 요구와 맞지 않습니다. 이를 기능 제약을 확인하는 예시로 남겼으며 로컬 Claude 실행·오프라인 검증 성공을 주장하지 않습니다.

### 실제 검증으로 이어가는 방법

1. **목적과 동의부터 확인합니다.** 실제 참여자에게 테스트 목적, 수집·보관·공개 항목, 외부 제공자에게 전송할 내용, 참여 중단 방법을 설명하고 동의 범위를 기록합니다. 개인정보·비공개 작품이 없는 별도 브리프를 준비합니다.
2. **환경과 제공자 상태를 기록합니다.** 실제 앱 버전·커밋, 운영체제, 실행 경로, 제공자·모델 식별자, 클라이언트 버전, 테스트 일시와 관련 설정을 확인합니다. 유료 호출이나 모델 변경은 별도 승인을 받은 범위에서만 진행합니다. 인증정보는 기록하거나 공개하지 않습니다.
3. **동일 브리프를 실제로 실행합니다.** 정확한 입력·출력과 수정 요청을 보관하고, 지원되지 않는 작업·오류·중단을 구분해 기록합니다. 원본을 보존하고 별도 출력 경로를 사용합니다.
4. **결과물을 확인합니다.** 실제 파일의 치수·알파·삼각형 수·재질·메타데이터 등을 확인합니다. 자동 구조 검수와 사람이 수행한 시각·게임 엔진 검수를 구분합니다. 확인하지 않은 항목은 미확인으로 남깁니다.
5. **측정값을 출처와 함께 기록합니다.** 처리 시간·비용·성공 여부는 실제 로그 또는 제공자 응답에서 확인된 값만 적습니다. 참여자 피드백을 수집했다면 가상 대화와 분리하고 공개 동의 범위를 따릅니다.
6. **새 기록으로 공개합니다.** 이 가상 파일의 미실행 상태를 실제 결과로 바꾸지 않습니다. 실제 검증 자료는 별도 위치와 형식으로 보관하며 입력·출력·제공자 버전·방법·한계를 함께 공개합니다. 실행 여부와 사용자 참여 여부를 각각 명시합니다.

가상 예시는 평가 설계의 출발점입니다. 실제 실행·파일 검증·참여자 관찰이 없는 상태에서 수락 조건을 통과로 표시하지 않습니다.

## English

### Provenance and purpose

Treeset authored this **fictional design and evaluation material** with AI assistance on October 9, 2026. The six production roles illustrate how the proposed Claude planning workflow in Asset Studio could be reviewed later. No participants were recruited, and no statements from actual users or customers are quoted. All dialogue and expected production plans are authored examples.

- These are not actual user tests, interviews, reviews, testimonials, or product-use records.
- No Claude or other provider API was called. This is not Claude-generated output.
- No images or models were generated, and no files, game engines, or devices were validated.
- No user counts, ratings, processing times, costs, or quality improvements were measured.
- Do not use these examples as evidence of real users, Claude usage, or program eligibility.

The JSON declares `type: "synthetic-design-evaluation"`, `synthetic: true`, and `providerExecuted: false`. Every case has `status: "illustrative-not-executed"`, `observedResults: null`, and `metrics: null`. Pixel dimensions, triangle caps, material counts, asset limits, and review checks are **future target constraints**, not achieved results.

### Six scenarios

| ID | Fictional role | Design issue to review |
| --- | --- | --- |
| SIM-01 | Solo pixel-game developer | Consistent dimensions, palettes, alpha, and tile seams |
| SIM-02 | Mobile low-poly developer | Triangle/material budgets and small-screen silhouettes |
| SIM-03 | Technical artist | GLB structural checks, separate engine review, source preservation |
| SIM-04 | Multilingual content designer | Korean/English intent and separation of images from UI copy |
| SIM-05 | Small game-jam team | Minimal scope, independent instructions, shared style and handoff |
| SIM-06 | Privacy-conscious educator | No external transfer, local production, metadata review before sharing |

Each case contains three dialogue turns: `simulated-user`, `illustrative-plan`, and `simulated-follow-up`. These distinguish fictional requests, authored plans, and fictional follow-ups. Asset filenames in the expected plans are proposed output names; they do not mean corresponding images or models exist in this folder.

SIM-06's no-external-transfer requirement is incompatible with remote Claude calls. It remains a constraint-checking example, not a claim of local Claude execution or validated offline behavior.

### How to repeat with real evidence

1. **Confirm purpose and consent.** Explain the test purpose, collected/retained/published data, information sent to external providers, and how to stop participating. Record the scope of consent. Prepare a separate brief without personal data or private artwork.
2. **Record the environment and provider.** Verify the actual app version and commit, operating system, execution path, provider/model identifiers, client version, timestamp, and relevant settings. Run paid calls or model changes only within separately approved scope. Do not record or publish credentials.
3. **Execute the same brief.** Preserve exact inputs, outputs, and revision requests. Distinguish unsupported operations, failures, and interruptions. Preserve sources and use separate output paths.
4. **Inspect actual artifacts.** Check dimensions, alpha, triangles, materials, metadata, and other relevant properties on real files. Separate automated structural checks from human visual and game-engine checks. Leave unverified checks unverified.
5. **Record only observed measurements.** Use real logs or provider responses for processing time, cost, and success status. Keep actual participant feedback separate from fictional dialogue and honor the agreed publication scope.
6. **Publish a new record.** Do not relabel these unexecuted examples as real results. Store real validation in a separate location and format, documenting inputs, outputs, provider version, method, and limitations. State provider execution and user participation separately.

These illustrations are a starting point for evaluation design. Do not mark acceptance criteria as passed without actual execution, artifact checks, and participant observations where applicable.
