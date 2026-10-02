# Asset Studio 소개 사이트

한국어 정적 React/Vite 페이지입니다. 앱 실행과 AI 공급자 연결을 요청하는 코드는 포함하지 않습니다.

루트 워크스페이스에서 `npm run site:dev`, `npm run site:build`를 사용합니다. 이 패키지 단독 스크립트는 `npm run dev`, `npm run build`, `npm run preview`이며 개발·미리보기 포트는 4174입니다.

`VITE_SITE_URL`에 실제 공개 HTTPS 주소를 설정해 빌드하면 canonical, Open Graph 이미지·주소와 sitemap.xml을 생성합니다. Vercel에서는 `VERCEL_PROJECT_PRODUCTION_URL`을 대체 주소로 사용합니다. 공개 주소가 없으면 임의의 주소를 출력하지 않습니다.

다운로드 버전, 실행파일명, ZIP 크기와 SHA-256은 `src/App.tsx`의 `release` 객체에서 관리합니다. 최종 배포 ZIP의 값과 일치시켜야 합니다.

`public/media`의 소품 3장은 프로젝트의 실제 Blender 작업자가 생성한 렌더입니다. `workstation-browser.png`는 브라우저 미리보기 UI이며 사이트 캡션과 확대 창에도 출처를 표시합니다. 네이티브 앱 촬영으로 소개하지 않습니다.

외부 폰트·이미지·스크립트를 요청하지 않고 inline style과 inline script를 사용하지 않습니다. 화면 확대는 네이티브 dialog, FAQ는 details/summary, 해시 복사는 Clipboard API를 사용하며 복사 실패 시 해시를 선택해 직접 복사할 수 있습니다. 390px 모바일 배치와 키보드 포커스 복귀를 확인했습니다.
