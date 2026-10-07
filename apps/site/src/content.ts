export const sourceUrl = 'https://github.com/oocheol/masset';
export const skillVersion = '0.1.13';
export const skillPackageVersion = '0.1.14';
export const skillInstallCommand = 'npx --yes https://github.com/oocheol/masset/releases/download/v0.1.13/oocheol-asset-studio-0.1.14.tgz install';
export const npmInstallCommand = 'npx @oocheol/asset-studio@latest install';
export const skillUpdateCommand = 'npx --yes https://github.com/oocheol/masset/releases/download/v0.1.13/oocheol-asset-studio-0.1.14.tgz update';
export const skillDownloadUrl = `${sourceUrl}/releases/download/v${skillVersion}/AssetStudio_${skillVersion}_codex-plugin-windows-macos-cli13.zip`;

export const models = [
  { name: '상자', type: 'Crate', src: '/media/crate.png', description: '판재와 프레임으로 만든 기본 수납 상자.', file: 'crate', material: '패널 + 프레임' },
  { name: '테이블', type: 'Table', src: '/media/table.png', description: '상판과 네 다리로 구성한 기본 테이블.', file: 'table', material: '상판 + 다리' },
  { name: '선반', type: 'Shelf', src: '/media/shelf.png', description: '여러 층의 수납 공간을 갖춘 기본 선반.', file: 'shelf', material: '선반 + 지지대' },
];

export const statuses = [
  {
    feature: 'Windows 0.1.13', status: '네이티브·CLI 산출물 확인', tone: 'verified',
    detail: '실제 CPU 예제에서 첫 이미지→3D 제작 80.9초, 같은 원시 모델을 재사용한 제작 31.2초를 확인했습니다. UV 공간 활용과 형태를 보존하는 LOD를 개선하고, 완성된 모델 다음에 별도 미리보기를 만듭니다. GLB·.blend를 별도 프로세스에서 다시 열고 내보내기를 확인했습니다. 단일 예제의 관측값이며 새 GPT 요청은 보내지 않았습니다.',
    link: `${sourceUrl}/blob/master/docs/releases/v0.1.13-windows.md`,
  },
  {
    feature: 'Apple Silicon Mac 0.1.13', status: '빌드·CLI 검사 / GUI 검사 생략', tone: 'limited',
    detail: 'Windows 0.1.13의 원시 3D 캐시·UV·LOD 개선을 반영한 앱·DMG·독립 CLI와 서명된 업데이트를 제공합니다. CLI의 실제 PNG 처리·재열기·내보내기 및 패키지 무결성을 확인했습니다. 잠금 상태로 앱 화면·설치·업데이트 교체와 새 GPT·3D 제작은 검사하지 않았습니다. Windows 측정값은 Mac 성능 수치가 아닙니다.',
    link: `${sourceUrl}/blob/master/docs/releases/v0.1.13-macos.md`,
  },
  {
    feature: '로컬 2D 편집·기본 Blender 소품', status: 'Windows 산출물 확인', tone: 'verified',
    detail: '원본 보존, 새 버전 저장, 스프라이트·아틀라스의 출력 이미지와 JSON을 확인했습니다. 기본 Blender 소품은 네이티브 앱에서 생성·렌더하고 새 Blender 프로세스에서 다시 열었습니다. 이 페이지의 상자·테이블·선반은 고정 레시피로 생성한 실제 렌더이며 GPT 생성이나 이미지→3D 예시가 아닙니다.',
    link: `${sourceUrl}/tree/master/examples/procedural`,
  },
  {
    feature: '로컬 이미지 → 3D', status: 'Windows·Mac CPU 산출물 확인', tone: 'limited',
    detail: '한 장의 이미지에서 독립 메시를 만들고, 게임용 GLB·고해상도 형상·LOD·UV 텍스처·.blend·미리보기를 새 버전으로 저장합니다. 오픈 모델 TripoSR을 사용하며 보이지 않는 뒷면과 얇은 형상의 정확도는 입력에 따라 달라집니다. 최소 16GB RAM과 Blender가 필요합니다. 8K·자동 리깅·쿼드 리토폴로지는 제공하지 않습니다.',
    link: `${sourceUrl}/blob/master/docs/model-quality.md`,
  },
  {
    feature: 'GPT 구독 연결', status: '과거 Windows·Mac 이미지 수신 확인', tone: 'verified',
    detail: 'GPT-6.1 Sol을 통해 공식 Codex의 GPT Image 2 구독 경로로 요청합니다. Windows 0.1.2와 Mac 0.1.5에서 새 PNG의 수신·저장·재열기·독립 내보내기를 확인했습니다. 응답에 실제 이미지 모델 ID가 없으면 미확인으로 기록합니다. 계정별 사용 권한과 한도는 다르며 유료 API로 자동 대체하지 않습니다.',
    link: `${sourceUrl}/blob/master/docs/verification.md`,
  },
  {
    feature: 'Codex 준비·앱 내부 업데이트', status: '플랫폼·버전별 기록', tone: 'limited',
    detail: '공식 Codex가 없는 기기에서는 출처·크기·SHA-256·라이선스를 표시한 뒤 다운로드 동의를 받아 준비합니다. Mac 공식 패키지의 OpenAI 서명·실행·등록을 확인했으며 Windows의 신규 다운로드 실증은 별도 기록입니다. 앱 업데이트는 배포 서명·버전·크기·해시를 검사합니다. 이 서명은 Windows 코드 서명이나 Apple 공증과 별개입니다.',
    link: `${sourceUrl}/blob/master/docs/platform-support.md`,
  },
];

export const faqs = [
  {
    question: '스킬만 설치하면 Asset Studio 앱 없이 사용할 수 있나요?',
    answer: '네. 새 Codex 작업에서 $asset-studio로 요청하면 처리용 CLI가 에셋을 만듭니다. 데스크톱 앱을 설치하거나 열 필요가 없습니다. 공식 Codex 로그인은 재사용하고, 필요한 CLI는 첫 사용 시 다운로드 동의를 받아 준비합니다. 3D를 요청할 때만 Blender·Python·로컬 모델을 추가로 준비합니다.',
    link: `${sourceUrl}/blob/master/docs/skill-first-setup.md`, label: '스킬로 시작하는 방법',
  },
  {
    question: 'Windows와 Mac의 npm 패키지는 따로인가요?',
    answer: '@oocheol/asset-studio 공용 패키지 하나가 Windows x64 또는 Apple Silicon Mac에 맞는 도구를 선택합니다. 플랫폼별 CLI 버전은 독립적으로 관리합니다. 현재 GitHub 설치 패키지 0.1.14는 양쪽 CLI 0.1.13을 준비하며, npm 레지스트리의 latest는 아직 0.1.13입니다. 이 페이지의 기본 명령은 최신 양쪽 CLI를 위한 검증된 GitHub 패키지를 사용합니다.',
    link: 'https://www.npmjs.com/package/@oocheol/asset-studio', label: '공개 npm 패키지',
  },
  {
    question: 'AI 계정이나 유료 API 키가 꼭 필요한가요?',
    answer: '로컬 이미지 편집, 스프라이트·아틀라스, Blender 기본 소품에는 외부 AI 계정이 필요하지 않습니다. GPT 이미지 제작에는 공식 Codex 로그인과 계정의 모델 이용 권한이 필요합니다. 구독 사용량 제한이 적용될 수 있으며 유료 API로 자동 대체하지 않습니다. Codex가 없으면 앱의 구독 연결에서 공식 배포본 준비부터 진행할 수 있습니다.',
  },
  {
    question: '이미지→3D 결과를 바로 게임에 넣어도 되나요?',
    answer: 'GLB·LOD·UV 텍스처를 내보낸 뒤 게임 엔진에서 형태, 재질, 크기와 성능을 검수하세요. 한 장의 이미지로 보이지 않는 면을 추정하는 TripoSR의 한계가 있습니다. 얇거나 각진 물체는 형태가 흐려질 수 있으며 자동 리깅·8K·쿼드 리토폴로지는 제공하지 않습니다. .blend 원본을 함께 보존하므로 Blender에서 추가로 다듬을 수 있습니다.',
    link: `${sourceUrl}/blob/master/docs/model-quality.md`, label: '3D 결과와 검수 안내',
  },
  {
    question: '제작 속도는 어떻게 개선됐나요?',
    answer: '동일 입력의 검증된 원시 3D 모델을 재사용하고, 원격 이미지 응답을 기다리는 동안 자원을 다른 제작에 돌려줍니다. 모델·텍스처는 미리보기보다 먼저 저장합니다. Windows CPU 예제 한 건에서 첫 제작 80.9초, 캐시 재사용 31.2초를 관측했습니다. 입력과 기기에 따라 속도가 달라지며 Mac에서 같은 성능 수치를 측정한 것은 아닙니다.',
    link: `${sourceUrl}/blob/master/docs/releases/v0.1.13-windows.md`, label: '측정 조건과 배포 기록',
  },
  {
    question: '게임 프로젝트와 참고 파일은 어떻게 사용하나요?',
    answer: '게임 프로젝트 루트를 연결하고 장르·배경·스타일을 설명한 뒤 개별 제작 목록을 검수합니다. 상대 파일 목록과 누락 참조를 참고하며 소스 코드 내용은 GPT에 전송하지 않습니다. PNG·JPEG·WebP와 GLB를 합쳐 최대 5개를 직접 선택할 수 있고, 외부에 보내는 참고 정보는 동의를 받습니다. 원본과 기존 결과는 보존하고 새 결과 폴더에 저장합니다.',
    link: `${sourceUrl}/blob/master/docs/game-production.md`, label: '프로젝트 제작 흐름',
  },
  {
    question: 'Windows나 Mac에서 첫 실행 경고가 나타나면요?',
    answer: 'Windows 배포본은 Authenticode 코드 서명이 없어 SmartScreen 경고가 나타날 수 있습니다. Mac 배포본은 Apple 공증이 없어 최초 실행 허용이 필요합니다. 공식 GitHub 릴리스와 파일 해시를 확인하고 아래 플랫폼별 설치 안내를 따르세요. 앱 업데이트의 암호학적 서명과 운영체제 코드 서명은 서로 다릅니다.',
    link: `${sourceUrl}/blob/master/docs/platform-support.md`, label: '플랫폼별 설치 조건',
  },
  {
    question: '앱과 스킬은 어떻게 업데이트하나요?',
    answer: 'Windows 설치 사용자는 앱의 업데이트 패널을 이용하세요. Mac은 0.1.4 이상부터 앱 내부 업데이트를 지원합니다. 이전 Mac과 초기 Windows 포터블 사용자는 최신 설치본을 한 번 설치하세요. 스킬은 설치 명령의 install을 update로 바꿔 실행합니다. 새 스킬을 넣기 전에 기존 사본을 백업하며 앱 업데이트도 프로젝트·원본을 보존합니다.',
    link: `${sourceUrl}/blob/master/docs/skill-first-setup.md`, label: '스킬 설치·업데이트 안내',
  },
  {
    question: '오류를 제보하거나 제작 구조를 살펴볼 수 있나요?',
    answer: '소스, 예제 산출물과 플랫폼별 검증 기록을 GitHub에 공개합니다. 운영체제, 앱·CLI 버전, 작업 종류와 재현 순서를 이슈에 남겨 주세요. 계정 토큰·비밀번호·개인 원본 파일은 포함하지 마세요.',
    link: `${sourceUrl}/issues`, label: 'GitHub 이슈',
  },
];
