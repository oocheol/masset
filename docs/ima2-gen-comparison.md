# ima2-gen 구독 이미지 생성 구조 비교

2026-10-03에 GitHub의 현재 `main`이 `8c27479c140b1a8db59b866cf41df099e287dd9e`인 것을 확인했다. 아래는 그 커밋의 소스를 읽어 확인한 구조다. ima2-gen을 설치하거나 사용자 계정으로 실행한 결과는 아니다.

Asset Studio 0.1.1의 추론 모델은 사용자가 최종 선택한 **GPT-6.1 Sol (`gpt-6.1-sol`)**이다. 이미지 목표는 계속 **GPT Image 2 (`gpt-image-2`)**다.

| 항목 | ima2-gen 현재 소스 | Asset Studio 0.1.1 |
| --- | --- | --- |
| 기본 추론 모델 | `gpt-6-luna` | 사용자 지정 `gpt-6.1-sol` |
| OAuth 선택 목록 | `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`; 6.1 Sol은 해당 목록에 없음 | 지정 모델을 고정하고 자동 대체 없음 |
| 이전 모델 설정 | `gpt-5.5` 등을 `gpt-6-luna`로 변환 | 새 요청에 추론 모델 저장; 기존 요청의 모델을 바꾸지 않음 |
| 인증 | 자체 OAuth 로그인·세션 저장소·갱신 구현 | 공식 Codex가 인증·갱신 관리; 앱이 토큰 파일을 읽거나 복사하지 않음 |
| 모델 목록 | 계정별 원격 목록 조회·캐시 | 앱 고정 카탈로그의 일치 검사; 계정 권한 미확인 |
| 프롬프트 계획 | GPT-6가 클라이언트 함수 `image_gen`의 인자에 최종 프롬프트 반환 | 공식 app-server RPC로 지정 추론 모델에 이미지 요청 |
| 이미지 렌더 | 별도 OAuth 렌더러가 GPT Image 2 생성·편집 엔드포인트 직접 호출 | 공식 Codex의 이미지 이벤트·파일 수신을 기다림 |
| 병렬 실행 | 렌더러 최대 3개, 결과는 계획 순서로 전달 | 영속 DAG·자원별 큐; 외부 생성은 로컬 정책상 동시 1개 |
| 재요청 | 함수 호출 미발생 시 계획 단계 한 번 더 호출; 단기 429는 공유 예산으로 최대 5회 재시도 | 실패·결과 불명 뒤 자동 재전송 없음 |

ima2-gen의 `oauthImages.ts`는 GPT-6가 hosted `image_generation` 도구를 호출하지 못하는 경우를 전제로 계획과 렌더를 나눈다. 계획 모델은 함수 인자에 프롬프트를 작성한다. 렌더러는 `gpt-image-2`를 명시해 `/images/generations` 또는 `/images/edits`를 별도로 호출한다. 단일 Direct 모드에서는 계획 모델을 생략한다.

이것은 API 키 공급자와 구분된 OAuth 경로다. 이름에 Images API가 들어간다는 이유로 별도 유료 API 키 호출이라고 설명하면 안 된다. 소스에 구현되어 있다는 사실만으로 외부 앱에 공식적으로 지원되는 계약이라고 판단할 수도 없다.

`codexBackend/client.ts`는 GPT-6 목록을 조회하기 위해 측정한 클라이언트 버전 하한을 `0.157.0`으로 두고 버전과 계정별 목록을 캐시한다. 이 하한은 해당 프로젝트의 소스에 기록된 측정값이며 OpenAI의 공식 지원 최소 버전이라는 뜻이 아니다.

사용자의 원래 제품 요구사항 D는 “공식적으로 지원되고 해당 앱에 적용 가능한 연동 경로만 채택한다”와 “비공개 엔드포인트 직접 호출 … 등을 기본 아키텍처에 포함하지 않는다”라고 명시한다. Asset Studio는 계획·렌더 분리 개념과 제한된 병렬 처리 구조를 참고하되 해당 직접 HTTP·토큰 처리 구현을 도입하지 않는다. 0.1.1의 6.1 Sol 변경은 요청 설정이며 그 버전의 실제 구독 이미지 수신은 미검증으로 기록했다.

## 0.1.2 공식 도구 중개 수정

0.1.1의 Sol 카탈로그는 코드 모드만 지원했지만 앱이 해당 공식 호스트를 꺼 두어 이미지 도구를 호출하지 못하는 설정 충돌이 있었다. 0.1.2는 서명을 확인한 공식 호스트의 격리된 V8 중개를 허용하고 셸·네트워크·파일 조회·MCP·스킬·하위 에이전트 도구를 차단한다. 이미지 도구의 사용 한도 실패도 빈 결과와 구분해 보존한다. ima2-gen의 토큰 추출이나 직접 OAuth 이미지 HTTP 호출을 도입하지 않았다. 버전별 실제 수신·저장·재열기 결과는 [공급자 실증](provider-feasibility.md)에서 별도로 기록한다.

Codex가 없는 Windows 사용자를 위해 공식 GitHub 배포본을 앱 전용 공간에 준비하는 안내를 추가했다. 표시된 버전·용량·SHA-256·라이선스를 확인하고 동의해야 다운로드하며 해시·안전한 압축 해제·OpenAI 서명·버전 확인이 모두 끝난 배포본만 등록한다. 공식 로그인을 이용하므로 앱이 OAuth 토큰을 읽거나 복사하지 않는다. 기존 사용자 PATH·Codex 설치·계정 설정은 바꾸지 않는다.

## 확인한 소스

- [기본값](https://github.com/lidge-ai/ima2-gen/blob/8c27479c140b1a8db59b866cf41df099e287dd9e/config.ts#L382), [OAuth 선택 목록](https://github.com/lidge-ai/ima2-gen/blob/8c27479c140b1a8db59b866cf41df099e287dd9e/lib/providers/registry.ts#L32), [이전 모델 변환](https://github.com/lidge-ai/ima2-gen/blob/8c27479c140b1a8db59b866cf41df099e287dd9e/lib/oauthLegacyModels.ts).
- [계획·렌더·worker join](https://github.com/lidge-ai/ima2-gen/blob/8c27479c140b1a8db59b866cf41df099e287dd9e/lib/oauthImages.ts), [직접 요청 라우팅](https://github.com/lidge-ai/ima2-gen/blob/8c27479c140b1a8db59b866cf41df099e287dd9e/lib/codexBackend/index.ts), [원격 목록과 버전 처리](https://github.com/lidge-ai/ima2-gen/blob/8c27479c140b1a8db59b866cf41df099e287dd9e/lib/codexBackend/client.ts).
- [자체 인증 저장소](https://github.com/lidge-ai/ima2-gen/blob/8c27479c140b1a8db59b866cf41df099e287dd9e/lib/chatgptAuth.ts), [한도 재시도 예산](https://github.com/lidge-ai/ima2-gen/blob/8c27479c140b1a8db59b866cf41df099e287dd9e/lib/oauthRateLimit.ts).

참고 저장소의 MIT 소스를 읽었으며 실행·벤더링하지 않았다. 이 비교는 사용자 계정의 ima2-gen 실행 성공이나 서비스 이용 조건을 검증한 결과가 아니다.
