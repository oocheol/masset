# 구독 이미지 생성 실증 — 2026-10-03

사용자가 이미지 목표를 **GPT Image 2**로 변경했다. 종전 2.5 선택 검증은 현재 출시 조건이 아니다. Windows를 먼저 검증하며 macOS 실행은 이후 별도로 검증한다.

## 0.1.1 추론 모델 변경

최종 사용자 지시로 추론 모델을 **GPT-6.1 Sol (`gpt-6.1-sol`)**로 변경했다. 이미지 목표는 `gpt-image-2`다. 새 요청에는 추론 모델도 저장하며, 기존 요청의 모델이나 런타임 버전이 달라졌으면 자동으로 실행하지 않는다.

Windows에서는 명시적으로 지정된 실행 파일을 우선하며 검증 실패 시 다른 실행 파일로 넘어가지 않는다. 자동 탐색은 기존 Programs 설치와 Local/OpenAI의 버전별 설치 최대 32개를 확인하고, 유효한 OpenAI 서명과 안전한 버전 문자열을 확인한 후보 중 SemVer 우선순위가 가장 높은 것을 선택한다. 범위 밖에 있는 설치본은 `CODEX_EXECUTABLE`로 명시할 수 있다. alpha 버전 문자열은 보존하지만 그 버전의 실제 이미지 생성 성공을 보장하지 않는다. macOS 실행 검증은 아직 없다.

앱 화면과 읽기 전용 진단에는 `reasoningModel`, `catalogSource=application_pinned_catalog`, `inferenceAccess=unknown`을 구분해 표시한다. 정적 모델 목록의 일치 검사는 계정 이용 권한 증거가 아니다. 사용자 설정과 인증 파일을 바꾸지 않았으며 이 수정에서 외부 생성 요청은 제출하지 않았다. 계정 모델 권한과 실제 이미지 수신은 계속 미검증이다.

현재 ima2-gen은 자체 OAuth transport로 GPT-6 계획과 GPT Image 2 렌더를 분리한다. 그 방식과 공식 Codex RPC 방식의 차이는 [소스 비교](ima2-gen-comparison.md)에 기록했다. 사용자 요구사항의 비공개 엔드포인트 금지 경계를 유지한다.

최종 빌드의 읽기 전용 검사에서는 유효한 OpenAI 서명의 `codex-cli 0.159.0-alpha.12.1`을 선택했고 `authenticated=true`, `ready=true`, `reasoningModel=gpt-6.1-sol`을 확인했다. `inferenceAccess=unknown`, `catalogSource=application_pinned_catalog`이며 `probe_only`, `generationRequested=false`다. 새 요청·수신 이미지 없이 진단을 마쳤으므로 모델 이용 권한과 실제 생성은 여전히 확인되지 않았다.

## 0.1.0 당시 실제 확인한 범위

계정 상태를 담은 `tests/provider/codex-probe.json`, `tests/provider/runtime-*.json`과 `output/**`의 실행 기록은 로컬에서 보존하며 공개 저장소에는 포함하지 않습니다. 이 문서는 그 기록의 결과를 요약합니다. 공개 소스에는 재현용 진단 코드, 공식 문서 근거와 스키마 요약을 제공합니다.

공식 Codex 0.147.0의 `app-server --listen stdio://`와 공개 `account/read`에서 ChatGPT 구독 인증, 공개 capability에서 이미지 도구를 확인했다. 요청·이벤트·파일 저장 경로는 구현했다. **실제 생성 파일 수신 → 디코딩 → 저장 → 재열기 실증은 미완료다.** 로그인이나 fixture 성공을 이미지 생성 성공으로 집계하지 않는다.

| 검사 | 실제 결과 | 증거 |
| --- | --- | --- |
| 공식 런타임·구독 인증·도구 제한 | 통과 | `tests/provider/runtime-readonly-proof.json` |
| 첫 생성 시도 | terminal failed, 원인 진단 미보존, 자동 재요청 없음 | `output/native/provider-live-20261002-080847/provider-proof.json` |
| 진단 보강 후 생성 시도 | terminal failed; other, 모델 불가·잘못된 요청 단서, 이미지 도구 미관찰 | `output/native/provider-diagnostic-20261002-171618/provider-proof.json` 및 작업 폴더의 `provider-failed-*.json` |
| 고정 gpt-6-luna 호환성 시도 | 이미지 도구 시작 전 terminal failed, 같은 진단 단서 | `output/native/provider-luna-20261002-172543/provider-proof.json` |
| 고정 gpt-5.5 호환성 시도 (최종) | `invalid_request_error`, 이미지 도구 시작 전 실패; 추가 시도 중단 | `output/native/provider-compat-20261002-173201/provider-proof.json` |
| 실제 사용 이미지 모델 | null | 공개 이미지 이벤트에 실제 모델 필드 없음 |
| 실제 수신 파일 | 0 | 수신·재열기 성공으로 표시하지 않음 |
| 별도 유료 API / 직접 비공개 HTTP | 사용하지 않음 | 공식 프로세스의 공개 RPC만 사용 |

실패의 불리언 단서는 원문에서 추출한 진단이며 계정 권한 부족을 확정하지 않는다. HTTP 상태는 반환되지 않았다. 원문 메시지·토큰·헤더·인증 URL은 저장하지 않는다. 이전 ephemeral thread의 공개 thread/read도 -32600으로 거절되어 첫 실패 원인은 unknown이다 (`tests/provider/runtime-prior-failure-read.json`).

0.1.0 빌드의 추론 모델은 공개 목록에 있는 `gpt-5.5`로 고정했으며 이미지 목표는 계속 GPT Image 2다. 런타임의 자동 모델 대체가 아니라 각 소스 변경 후 명시적으로 새 검증 요청을 실행했다. 최종 오류의 코드·HTTP 상태는 null, 오류 유형은 `invalid_request_error`, 모델 불가 단서는 true, 계정별 미지원의 정확한 문구는 false다. 따라서 현재 공식 런타임/계정 조합의 요청 거절을 확인했지만 서버의 세부 원인까지 확정하지 못했다. 4개 실행 요청은 각각 1회 제출 후 종료됐고 받은 이미지는 0개다. 더 많은 모델을 추측해 호출하지 않는다.

최종 Rust 전체 검사는 110개 통과·4개 subprocess fixture 제외이며 이 중 공급자 검사는 24개다 (`output/native/workspace-tests-final.log`). 이것은 실제 외부 생성 실패를 성공으로 바꾸지 않는다.

## 연결·모델·인증 구조

앱은 인증 파일을 읽거나 복사하지 않는다. 공식 런타임이 로그인·갱신을 관리한다. 공개 로그인 URL은 호스트를 검증해 OS 브라우저로만 열며 UI/프로젝트/로그에 전달하지 않는다. API-key 인증을 구독으로 취급하지 않는다.

자식 프로세스에서 API 키·base URL 환경변수를 제거하고 ChatGPT 인증을 강제한다. 사용자 커스텀 설정의 영향을 피하도록 공개 CLI 설정으로 공식 provider, ChatGPT URL, Codex 기본 URL을 고정한다. 앱 자체는 그 HTTP 주소를 호출하지 않는다. 동일 이름의 사용자 정의 openai provider는 거부한다.

추론 카탈로그는 공식 [openai/codex 커밋 b1e72963](https://github.com/openai/codex/tree/b1e72963c3b71a9265a551e54beff078384efed9)의 `codex-rs/models-manager/models.json` 복사본이다. SHA-256: `fd219bd9f061278275f528939f82f54d2eb97df4b25c23b022adbe48813d920b`. Apache-2.0 원문·upstream NOTICE를 동봉한다. 목록은 계정의 실제 실행 권한 증거가 아니다. 추론 모델과 이미지 모델은 서로 다른 값이다.

셸·코드 실행·패치·브라우저·앱·플러그인·MCP·하위 에이전트 도구를 제한하고 서버발 도구/승인 요청을 거부한다. 연결 시 적용된 제한을 다시 확인한다. analytics/feedback/OTel은 끈다. 생성 요청에는 사용자가 제출한 설명과 승인한 스타일/규격이 들어간다.

## 영속 작업과 수신

- 명시적 생성 요청에 UUID를 부여해 1~20개 작업을 만든다. 같은 ID·내용의 중복 제출은 기존 작업을 반환하고, 같은 ID의 다른 내용은 거부한다.
- 외부 작업은 로컬 정책상 동시 1개다. CPU 이미지·Blender 자원 풀과 분리하며 이 값이 공급자의 실제 한도라는 주장은 하지 않는다.
- 제출 전에 의도를 저장하고 Started의 thread/turn ID를 SQLite에 기록한다. 실행마다 별도의 UUID를 부여한다.
- 제출 후 연결 끊김·프로토콜 오류·결과 불명은 external_unknown으로 보존한다. 자동 재전송하지 않는다.
- 파일 경로·크기·형식·SHA-256과 receipt를 확인한 뒤 프로젝트에 새 버전으로 복사한다. 실제 치수가 규격과 다르면 경고한다.
- requestedModel=gpt-image-2와 confirmedModel=null을 구분한다. 이미지 모델을 추론 모델 이름으로 채우지 않는다.
- Codex turn의 interrupted는 원격 이미지 작업 중단을 증명하지 않는다. 원격 결과가 불명확하면 unknown을 유지한다.

크기·투명 배경·편집·마스크·참조 입력의 생성 제어는 이 앱에서 검증되지 않아 제공하지 않는다. 로컬 투명화·크기 조정은 별도 후처리 버전이다.

## ima2-gen 참고와 독자 구현

[ima2-gen](https://github.com/lidge-ai/ima2-gen)의 MIT 소스를 `8c27479c140b1a8db59b866cf41df099e287dd9e`로 고정해 읽었다. 실행·설치하지 않았다. 모델/결제 경로 명시, 제한된 worker join, 결과별 프롬프트·시간·설정 보존, 작은 진행 이벤트를 참고했다.

이 앱은 Tauri/Rust/SQLite DAG로 독립 구현했다. 요청 ID 중복 방지, WAL 복구, 메모리·CPU·디스크 예약, 실행 UUID, 파일 해시를 검증하는 완료 journal을 추가했다. 참고 소스의 인증 파일 파싱이나 비공개 HTTP 직접 호출은 도입하지 않았다. 참고 구현을 무제한 Promise.all이라고 묘사하지 않는다.

완료 journal은 결과 저장 후 journal 작성 → 큐 완료 경계의 복구를 지원한다. 결과 DB 저장과 journal 게시 사이 크래시까지 단일 트랜잭션으로 만들지는 못했다. `crates/scheduler/artifacts/benchmark-results.json`은 해시 fixture 실측이며 전체 이미지/Blender/공급자 성능 배수로 일반화하지 않는다.

## 공식 문서와 재현

원문 URL·해시·핵심 문장은 `tests/provider/official-doc-evidence.json`, 버전별 스키마는 `tests/provider/codex-schema-summary.json`에 기록했다.

- [Codex 이미지 생성](https://learn.chatgpt.com/docs/image-generation): 기본 GPT Image 2 및 일반 Codex 한도.
- [Codex 인증](https://developers.openai.com/codex/auth), [app-server](https://developers.openai.com/codex/app-server): 공식 관리형 인증과 공개 통합.
- [외부 Sign in with ChatGPT 제한](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): 외부 token-sharing 경로와 Codex 자체 관리형 런타임을 구분한다.
- [이미지 API](https://developers.openai.com/api/docs/guides/image-generation): 별도 결제 경로이며 본 앱의 대체 수단으로 호출하지 않는다.

```powershell
. .\scripts\with-native-env.ps1
cargo test -p asset-providers
cargo build -p asset-desktop --bin provider-proof
# 기본은 연결 진단만 수행. 반드시 새 폴더 지정.
.\target\debug\provider-proof.exe --output C:\masset\output\provider-probe-new
# 외부 생성은 명시적 실행이며 구독 한도를 소비할 수 있음.
.\target\debug\provider-proof.exe --output C:\masset\output\provider-live-new --generate
```

현재 설치 버전에 대한 결과다. macOS 공급자 실행과 실제 원격 취소는 미검증이다. 후속 실제 생성 결과는 이 문서와 증거 경로를 함께 갱신한다.

