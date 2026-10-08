# Treeset / Asset Studio 소개 사이트

공식 주소는 https://treeset.win/ 입니다. Treeset을 독립 제작 도구 프로젝트로 소개하고, 제품 이름 Asset Studio는 유지합니다. 한국어 중심의 정적 React/Vite 페이지이며 짧은 영문 프로젝트 소개도 제공합니다. 외부 계정 연결이나 에셋 생성은 사이트에서 실행하지 않습니다.

설치 없는 실제 웹 예제는 [/play/workshop/](https://treeset.win/play/workshop/)와 [영문 예제](https://treeset.win/play/workshop/en/)입니다. 실제 로컬 Blender 소품 3개를 불러와 로봇을 움직이고 셀을 전달합니다. 소품 배치·90도 회전·목표 경로 이동, 새 JSON 저장·다시 열기, PNG 저장을 제공합니다. [영문 제작 기록](https://treeset.win/devlog/workshop/)과 [편집 가능한 ZIP](https://treeset.win/examples/workshop-starter.zip)을 함께 공개합니다. 개발자 예시이며 고객 사례나 Claude 생성 결과로 표시하지 않습니다.

예제 코드는 src/workshop에 있습니다. Three.js는 체험 시작 때만 로드하고, GLB를 같은 사이트에서 순서대로 받아 원본 용량·SHA-256을 확인합니다. 장면 JSON은 고정된 3개 에셋과 유효한 위치만 허용하며 외부 URL이나 코드를 실행하지 않습니다. 배치는 별도 localStorage 키에 저장하고 원본 파일을 수정하지 않습니다. 예제 자체는 계정·서버 저장·제공자 요청을 사용하지 않습니다.

루트 워크스페이스에서 npm run site:dev, npm run site:build를 사용합니다. 패키지 단독 개발·빌드·미리보기 명령은 npm run dev, npm run build, npm run preview이며 개발·미리보기 포트는 4174입니다. TypeScript는 루트의 node_modules/typescript/bin/tsc -p apps/site/tsconfig.json으로 확인할 수 있습니다.

공식 canonical, Open Graph, Twitter 메타데이터의 기본값은 index.html에 두고 scripts/build.mjs가 경로별 값과 초기 HTML을 생성합니다. 한국어·영문 예제, 제작 기록, 프로젝트 소개, Claude 기획 상태를 포함한 6개 페이지는 JavaScript 실행 전에도 본문과 링크를 읽을 수 있습니다. 미리보기와 별도 Vercel 주소에서도 canonical은 https://treeset.win의 해당 경로입니다. public/robots.txt와 public/sitemap.xml도 같은 주소를 사용합니다. VITE_SITE_URL이나 VERCEL_PROJECT_PRODUCTION_URL로 메타데이터를 중복 주입하지 않습니다.

다운로드 버전·실행 파일명·파일 크기·SHA-256은 src/release.ts에서 관리합니다. Windows 설치본·포터블 ZIP, Apple Silicon Mac DMG·검증된 터미널 설치 명령을 보존합니다. 공개 파일의 값과 반드시 일치시켜야 하며 Intel Mac 패키지는 제공하지 않습니다.

src/content.ts에 현재 스킬 명령, 갤러리 설명, FAQ와 검증 범위를 둡니다. GitHub 공용 installer 0.1.14는 Windows·Mac CLI 0.1.13을 준비합니다. npm 레지스트리 latest는 아직 0.1.13이므로 두 최신 CLI용 기본 명령은 검증된 GitHub 패키지를 사용합니다. 짧은 npm 설치 명령은 별도 펼침에 제공하며 레지스트리 게시 상태가 달라지면 문구와 명령을 함께 갱신합니다.

public/media의 crate·table·shelf는 실제 절차형 Blender 작업자가 만든 소품 렌더입니다. GPT 생성이나 이미지→3D의 성공 예시로 소개하지 않습니다. workstation-browser-013.png는 1500×960 브라우저 UI 미리보기이며 사이트 캡션과 확대 창에 구분합니다. 브라우저 검사가 네이티브 앱 지원을 증명하지 않습니다.

Treeset 색·로고와 제작 흐름 공유 그래픽은 로컬 SVG로 만들었습니다. treeset-share.svg가 편집 가능한 원본이며, treeset-share.png는 기존 @resvg/resvg-js로 렌더한 1200×630 이미지입니다. 외부 폰트·이미지·스크립트 요청, inline style·inline script, 분석 SDK, 새 백엔드·연락 폼은 없습니다. 연락처는 mailto:oocheol@treeset.win 입니다.

네이티브 dialog는 확대 이미지와 키보드 포커스 복귀를, details/summary는 FAQ·설치 조건·검증 기록을 제공합니다. 모든 명령·해시 복사 버튼은 Clipboard API 실패 시 원문을 선택해 직접 복사하게 합니다. CSS는 320px부터 반응형 배치, 가시적 포커스와 reduced-motion을 지원합니다. 실제 브라우저와 배포 상태 검사는 별도 확인해야 합니다.

검증 명령은 `npx vitest run apps/site/src/workshop/state.test.ts`, `npx tsc --noEmit -p apps/site/tsconfig.json`, `npm run site:build`입니다. 운영 HTML·CSP·파일 바이트·ZIP 목록 검사는 `node apps/site/scripts/verify-public.mjs https://treeset.win <새 기록 파일 경로>`로 수행합니다. 브라우저 플레이·저장·복원은 이 검사와 별도로 확인합니다. 자세한 범위는 [web-workshop-example.md](../../docs/web-workshop-example.md)에 있습니다.
