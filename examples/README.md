# 실제 에셋 예제

로컬 SVG 경로로 만든 [아이콘 12종](../apps/desktop/public/examples/index.json)과 실제 Blender 메시 예제를 포함합니다. AI 이미지 생성의 성공 증거로 사용하지 않습니다.

최종 3D 예제는 [검증 메타데이터](procedural/run-8fa3777b7c994505ba1c5592453a8543/verification.json)에 파일 SHA-256, 매개변수, 실제 치수, 도구 버전과 재열기 결과를 기록했습니다.

| 유형 | 실제 GLB | 편집 원본 | GLB 정점 / 삼각형 | Y-up 치수(m) |
| --- | --- | --- | --- | --- |
| 상자 | [model.glb](procedural/run-8fa3777b7c994505ba1c5592453a8543/crate/model.glb) | [source.blend](procedural/run-8fa3777b7c994505ba1c5592453a8543/crate/source.blend) | 3,240 / 1,620 | 1.2 × 0.9 × 0.8 |
| 테이블 | [model.glb](procedural/run-8fa3777b7c994505ba1c5592453a8543/table/model.glb) | [source.blend](procedural/run-8fa3777b7c994505ba1c5592453a8543/table/source.blend) | 1,944 / 972 | 1.6 × 0.76 × 0.8 |
| 선반 | [model.glb](procedural/run-8fa3777b7c994505ba1c5592453a8543/shelf/model.glb) | [source.blend](procedural/run-8fa3777b7c994505ba1c5592453a8543/shelf/source.blend) | 1,512 / 756 | 1.0 × 1.8 × 0.4 |

동일 승인 스타일을 고정 작업자에 전달하고 Blender 5.2.1 LTS에서 순차 CPU 실행했습니다. 새 Blender 프로세스에서 GLB와 `.blend`를 다시 열었으며, 별도의 Three.js 로더도 UV·노멀·재질·치수·피벗과 비퇴화 삼각형을 검사했습니다. 각 모델에는 512px 썸네일과 256px 턴테이블 PNG 4장이 있습니다. `.blend` 원본은 미터·Z-up, GLB는 미터·Y-up입니다.

이 예제 파일들은 작업자를 직접 실행한 결과입니다. 포터블 Tauri 앱의 저장소·큐·내보내기 통합과 실제 3D 렌더 검증은 [별도의 검증 기록](../docs/verification.md)에 구분합니다. 시각화용 조립 메시이며 제조용 CAD 또는 공학적 검토를 통과한 설계가 아닙니다.

이 저장소에서 새로 작성한 예제 이미지 경로와 메시 데이터에는 루트 Apache-2.0 라이선스를 적용합니다. 작업자 소스의 GPL-3.0-or-later 라이선스와 별개이며, 임의의 사용자 입력·외부 서비스 생성물에 같은 권리를 보증하지 않습니다.

재생성 방법은 [작업자 문서](../docs/blender-worker.md), 전체 검증 구분은 [검증 기록](../docs/verification.md)에 있습니다.
