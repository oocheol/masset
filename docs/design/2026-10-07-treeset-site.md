# Treeset 소개 사이트 · 2026-10-07

공식 주소는 https://treeset.win/, 브랜드는 Treeset이며 제품명은 Asset Studio를 유지한다. 문의 주소는 oocheol@treeset.win이다. GitHub 저장소와 npm 패키지 이름, 앱·CLI 릴리스 파일은 유지한다.

## 화면과 콘텐츠

- 깊은 청색 작업 공간, 분기형 Treeset 로고, 실제 Blender 결과를 중심으로 첫 화면을 구성한다. 한글 본문은 로컬 시스템 글꼴 17px를 사용한다.
- 실제 작업 화면, 개별 산출물 갤러리, 제작 흐름, 시작 가이드, FAQ와 Treeset 프로젝트 소개를 제공한다. 작업 화면은 브라우저 미리보기라는 점을 표시한다.
- 앱 없이 Codex에서 사용하는 스킬 설치를 Windows·Apple Silicon Mac 다운로드보다 먼저 배치한다. 공개 npm latest 0.1.13과 GitHub 공용 설치 패키지 0.1.14의 차이를 설명한다.
- 플랫폼별 기능과 실제 검증 범위는 접힌 상세 안내에서 확인한다. 사업자 등록, Claude 연동, 사용 실적이나 새 네이티브 제작 결과를 주장하지 않는다.
- canonical·Open Graph·Twitter·sitemap·robots는 treeset.win으로 일치시킨다. 공유 이미지는 로컬 1200×630 PNG이다.

## 확인한 항목

- 사이트 TypeScript 검사, Vite 프로덕션 빌드와 `git diff --check` 통과.
- Chrome에서 1440px 데스크톱, 820px 태블릿, 390px·320px 모바일 화면 검사. 가로 스크롤 없이 명령과 다운로드 안내를 표시한다.
- 렌더 선택, 이미지·작업 화면 확대, Escape와 닫기 버튼, 확대 종료 후 포커스 복원, FAQ·설치 상세 펼치기 및 복사 완료 표시 확인.
- 대표 이미지의 고정 높이로 생기던 여백과 한글 제목의 단어 중간 줄바꿈을 수정한 뒤 확인.
- 실제 공개 릴리스의 다운로드 6개와 안내 링크 5개 정상 확인. 릴리스 버전·용량·SHA-256 데이터를 변경하지 않았다.
- 로컬 브라우저 검사에서 누락 이미지와 경고·오류 로그 없음. 빌드 HTML의 canonical·OG URL·OG 이미지·Twitter 이미지는 각각 하나이며 인라인 script/style 없음.

## 배포 구성

Vercel의 기존 `masset` 프로젝트를 사용한다. Cloudflare DNS에서 루트와 www는 Vercel이 이 프로젝트에 지정한 CNAME을 DNS 전용으로 연결한다. Cloudflare 네임서버를 유지해 이메일 라우팅과 함께 사용한다.

`vercel.json`은 기존 masset-nu.vercel.app과 www.treeset.win을 treeset.win으로 영구 이동시키며 경로를 유지한다. 기존 CSP와 보안 헤더, 배포 파일 허용 목록을 유지한다. 비밀값, 브라우저 인증 상태와 사용자 원본 파일을 배포하지 않는다.
