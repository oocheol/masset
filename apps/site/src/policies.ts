export type SiteLanguage = 'ko' | 'en';
export type Localized = { ko: string; en: string };
export type PolicySection = { id: string; title: Localized; paragraphs: Localized[]; bullets?: Localized[] };
export const policyEffectiveDate = '2026-10-09';
export const policyContact = 'oocheol@treeset.win';
export const policyOperator = 'JEONG WOOCHEOL';

export const termsSections: PolicySection[] = [
  {
    id: 'operator', title: { ko: '운영자와 적용 범위', en: 'Operator and scope' },
    paragraphs: [
      { ko: 'Treeset은 JEONG WOOCHEOL이 개발·운영하는 독립 프로젝트이며, 현재 사업자등록 전입니다. Asset Studio는 게임 에셋의 제작·정리·검수·내보내기를 돕는 공개 소스 도구입니다.', en: 'Treeset is an independent project developed and operated by JEONG WOOCHEOL. It is currently pre-incorporation and has not registered a business. Asset Studio is an open-source tool for creating, organizing, reviewing and exporting game assets.' },
      { ko: '이 안내는 treeset.win의 소개 페이지, 웹 예제, 공개 자료와 문의 창구에 적용됩니다. 소프트웨어와 예제 파일의 이용·수정·배포 권리는 해당 파일에 포함된 라이선스가 정합니다.', en: 'These terms cover the information pages, browser examples, public materials and contact channel at treeset.win. Rights to use, modify and redistribute software or example files are governed by the licenses supplied with those files.' },
    ],
  },
  {
    id: 'access', title: { ko: '이용과 비용', en: 'Access and costs' },
    paragraphs: [
      { ko: '현재 소개 사이트, 웹 예제와 공개 다운로드는 Treeset 회원가입이나 Treeset 이용료 없이 이용할 수 있습니다. 이 사이트에는 결제 기능이 없습니다.', en: 'The current information site, browser examples and public downloads do not require a Treeset account or a Treeset access fee. This site has no checkout or payment feature.' },
      { ko: '선택한 외부 AI 서비스의 계정·구독·사용 한도·요금은 해당 제공자의 조건에 따릅니다. 공개 다운로드가 외부 AI 이용 권한을 제공하는 것은 아닙니다. 유료 제공자로 자동 전환하지 않습니다.', en: 'Accounts, subscriptions, quotas and charges for an external AI service are subject to that provider’s terms. A public download does not grant access to external AI services. The tool does not automatically switch to a paid provider.' },
    ],
  },
  {
    id: 'licenses', title: { ko: '파일과 라이선스', en: 'Files and licenses' },
    paragraphs: [
      { ko: 'Asset Studio의 공개 소스는 저장소의 Apache-2.0 라이선스를 확인하세요. 라이브러리·모델·예제에 별도 조건이 있으면 해당 라이선스와 third-party notices도 함께 적용됩니다. 이 안내는 공개 소스 라이선스가 허용한 권리를 축소하지 않습니다.', en: 'Consult the repository’s Apache-2.0 license for the Asset Studio source. Libraries, models and examples may carry separate licenses and third-party notices. These terms do not reduce rights granted by an applicable open-source license.' },
      { ko: '직접 가져온 이미지·모델·기획서의 권한과 선택한 생성 제공자의 이용 조건을 확인하세요. 출력물이 제3자의 권리를 침해하지 않는다고 일괄 보장할 수 없으므로 공개·상업 이용 전에 결과와 출처를 검토하세요.', en: 'Check your rights to imported images, models and briefs, together with the terms of the selected generation provider. Outputs cannot be universally guaranteed free of third-party rights; review the result and its provenance before publication or commercial use.' },
    ],
  },
  {
    id: 'local-work', title: { ko: '로컬 작업과 결과 검수', en: 'Local work and review' },
    paragraphs: [
      { ko: '로컬 프로젝트와 에셋은 사용자가 선택한 기기에 보관됩니다. 웹 작업장 예제의 배치는 해당 브라우저에 저장되며 JSON·PNG를 새 파일로 내려받을 수 있습니다. 중요한 원본은 별도로 백업하세요.', en: 'Local projects and assets remain on the device selected by the user. The browser workshop keeps its layout in that browser and offers JSON and PNG downloads as new files. Keep a separate backup of important originals.' },
      { ko: '미리보기나 예제의 성공이 모든 게임 엔진·기기·모델에서의 작동을 보장하지는 않습니다. 실제 제작에 사용하기 전에 형식·치수·축·피벗·재질·라이선스를 확인하세요. 플랫폼별 검증 범위는 각 배포 기록에 표시합니다.', en: 'A successful preview or example does not establish compatibility with every engine, device or model. Check file format, dimensions, axes, pivots, materials and licenses before production use. Release records describe the scope of platform verification.' },
    ],
  },
  {
    id: 'external-services', title: { ko: '외부 서비스 연결', en: 'External services' },
    paragraphs: [
      { ko: '공식 Codex·Claude 연결은 사용자가 해당 제공자에서 인증하고 전송을 승인하는 선택 기능입니다. 업데이트와 다운로드는 GitHub·npm 등 외부 서비스에 접속할 수 있습니다. 외부 링크를 이용하면 해당 서비스의 조건과 개인정보 안내가 적용됩니다.', en: 'Official Codex and Claude connections are optional features that require authentication with the relevant provider and approval of transmission. Updates and downloads can contact services such as GitHub and npm. Following an external link brings that service’s terms and privacy information into scope.' },
      { ko: 'Claude 기획 기능은 현재 소스 프로토타입이며 공개 0.1.13 설치 파일에 포함되지 않았습니다. 실제 Claude 실행 검증도 보류 중입니다. 제공자의 모델·계정 권한·대기열·장애는 Treeset이 제어하지 않습니다.', en: 'Claude planning is currently a source prototype and is not included in the public 0.1.13 installers. Live Claude execution verification remains pending. Treeset does not control a provider’s models, account access, queues or outages.' },
    ],
  },
  {
    id: 'examples', title: { ko: '예시와 가상 테스트 기록', en: 'Examples and synthetic records' },
    paragraphs: [
      { ko: '실제 로컬 제작 파일, 개발자가 만든 웹 예제, 가상 사용자 시나리오는 각각의 페이지에 구분해 표시합니다. 가상 기록은 실제 고객·인터뷰·사용 후기·Claude 출력·성능 측정 결과를 의미하지 않습니다.', en: 'Actual local production files, developer-made browser examples and synthetic user scenarios are identified separately on their pages. Synthetic records do not represent real customers, interviews, testimonials, Claude outputs or measured performance.' },
      { ko: '가상 역할과 예시 계획은 기획·검수 방법을 설명하기 위해 작성한 자료입니다. 실제 테스트로 확인하지 않은 만족도·시간 절감·사용자 수는 표시하지 않습니다.', en: 'Fictional roles and illustrative plans are authored materials for explaining planning and review methods. They do not claim satisfaction, time savings or user counts that have not been measured in a real test.' },
    ],
  },
  {
    id: 'changes-and-rights', title: { ko: '변경·오류·법정 권리', en: 'Changes, problems and legal rights' },
    paragraphs: [
      { ko: '초기 제품의 기능과 제공 범위는 개발 과정에서 바뀔 수 있습니다. 중요한 변경은 배포 기록과 안내 페이지에 공개하고 이 문서의 적용일을 갱신합니다. 변경된 안내를 이미 발생한 이용 관계에 소급해 불리하게 적용하지 않습니다.', en: 'Features and availability of an early product may change during development. Important changes are published in release records and information pages, and this document’s effective date is updated. Changes will not be applied retroactively to disadvantage an existing use relationship.' },
      { ko: '관련 법령이 보장하는 이용자의 권리는 유지됩니다. 이 안내는 운영자의 고의·중대한 과실에 대한 책임을 면제하거나 법률상 책임을 일괄 배제하는 조항으로 해석하지 않습니다. 오류나 권리 관련 문의는 아래 연락처로 보내주세요.', en: 'User rights provided by applicable law are preserved. These terms do not exempt the operator from liability for intentional misconduct or gross negligence, or exclude legal responsibility across the board. Use the contact below for problems or questions about your rights.' },
    ],
  },
];

export const privacySections: PolicySection[] = [
  {
    id: 'controller', title: { ko: '담당자와 범위', en: 'Contact and scope' },
    paragraphs: [
      { ko: 'Treeset의 운영자와 개인정보 문의 담당자는 JEONG WOOCHEOL이며 연락처는 oocheol@treeset.win입니다. 현재 사업자등록 전 독립 개발 프로젝트입니다.', en: 'The Treeset operator and privacy contact is JEONG WOOCHEOL, reachable at oocheol@treeset.win. Treeset is currently an independent, pre-incorporation project.' },
      { ko: '이 안내는 소개 사이트·웹 예제·개발자 문의에 관한 것입니다. 로컬 앱·CLI의 저장과 사용자가 선택하는 외부 연결도 별도로 설명합니다. 사이트 열람을 모든 외부 전송에 대한 동의로 간주하지 않습니다.', en: 'This notice covers the information site, browser examples and developer contact. Local app and CLI storage and user-selected external connections are explained separately. Visiting the site is not treated as consent to every possible external transmission.' },
    ],
  },
  {
    id: 'site-data', title: { ko: '사이트에서 처리하는 정보', en: 'Information on the site' },
    paragraphs: [
      { ko: '현재 사이트에는 회원가입·로그인·결제·문의 제출 폼이 없습니다. 개발자가 추가한 광고 추적기·방문자 분석 스크립트·프로필 쿠키도 없습니다. 사이트 코드가 이름·이메일·결제정보·플레이 시간을 수집하는 기능은 없습니다.', en: 'The current site has no account signup, login, checkout or contact-submission form. The developer has not added advertising trackers, visitor analytics scripts or profile cookies. The site code has no feature that collects names, email addresses, payment details or play time.' },
      { ko: '페이지와 파일 전달·접속 보안 과정에서는 호스팅·네트워크 제공자가 IP 주소, 요청 URL, 접속 시각과 브라우저 요청 정보 같은 기술 정보를 처리할 수 있습니다. 개발자가 방문자 로그를 별도 데이터베이스로 모으는 기능은 없습니다.', en: 'Hosting and network providers may process technical information such as IP addresses, requested URLs, access times and browser request information to deliver pages and files and protect access. The developer has not implemented a separate database collecting visitor logs.' },
    ],
  },
  {
    id: 'browser-storage', title: { ko: '웹 예제와 브라우저 저장', en: 'Browser examples and storage' },
    paragraphs: [
      { ko: '웹 작업장 예제는 소품 ID·위치·회전으로 구성된 배치 JSON을 이 브라우저의 localStorage에 저장합니다. 저장 키는 treeset.workshop.layout.v1입니다. 브라우저가 해당 사이트 데이터를 지울 때까지 남으며 자체 만료 시간은 없습니다.', en: 'The browser workshop stores layout JSON containing prop IDs, positions and rotations in this browser’s localStorage, under treeset.workshop.layout.v1. It remains until the browser removes that site data; the example does not implement its own expiry time.' },
      { ko: '가져오기로 선택한 장면 JSON은 브라우저 안에서 읽고 검증하며 서버에 업로드하지 않습니다. JSON·PNG 내보내기는 사용자의 기기에 새 파일을 준비합니다. 이 웹 예제에는 임의 이미지 업로드 기능이 없습니다.', en: 'A scene JSON selected for import is read and validated inside the browser and is not uploaded to a server. JSON and PNG export prepares new files on your device. This browser example has no arbitrary image-upload feature.' },
      { ko: '배치 보관을 원하지 않으면 브라우저 설정에서 treeset.win의 사이트 데이터를 삭제하거나 저장을 차단할 수 있습니다. 저장을 차단해도 웹 예제를 열 수 있지만 다음 방문에 배치가 복원되지 않을 수 있습니다.', en: 'To prevent layout persistence, remove site data for treeset.win or block storage in your browser settings. Blocking storage does not prevent opening the example, but the layout may not be restored on your next visit.' },
    ],
  },
  {
    id: 'contact-information', title: { ko: '문의 정보와 보관', en: 'Contact information and retention' },
    paragraphs: [
      { ko: '이메일로 문의하면 직접 보낸 발신 주소·이름(포함한 경우)·문의 내용·첨부파일·수신 시각을 답변과 문제 해결에 사용합니다. 서비스 이용에 관한 요청에 답하기 위해 필요한 정보만 처리하며, 별도 동의 없이 홍보 메일 발송이나 사용자 후기 공개에 사용하지 않습니다.', en: 'If you contact us by email, the sender address, name if supplied, message, attachments and receipt time are used to reply and investigate the issue. Only information needed to respond to a service-related request is processed. It is not used for marketing emails or public testimonials without separate permission.' },
      { ko: '문의 처리와 필요한 후속 확인이 끝나 정보가 불필요하게 되면 지체 없이 삭제합니다. 법령에 따라 보존해야 하는 정보는 해당 근거와 기간을 확인해 별도로 관리합니다. 자동으로 일정 일수 뒤 삭제되는 메일 보관 기능을 주장하지 않습니다.', en: 'Contact information is deleted without delay when the issue and necessary follow-up are complete and the information is no longer needed. Information that must be kept by law is managed separately after confirming its legal basis and period. This notice does not claim an automated mailbox deletion schedule.' },
      { ko: '전자 문서와 첨부파일은 운영자가 관리하는 저장소·메일함에서 삭제하며, 공개 문서에는 개인정보가 포함되지 않도록 필요한 부분만 남깁니다. 비밀번호·API 키·주민등록번호 같은 정보는 문의에 넣지 마세요.', en: 'Electronic messages and attachments are deleted from operator-managed storage and mailboxes. Public documentation keeps only the necessary parts without personal information. Do not include passwords, API keys or government identification numbers in a message.' },
    ],
  },
  {
    id: 'service-providers', title: { ko: '서비스 제공자와 국외 처리', en: 'Service providers and overseas processing' },
    paragraphs: [
      { ko: '사이트는 Vercel 호스팅을 사용하며, 도메인 DNS·메일 전달에는 Cloudflare, 문의 수신에는 Google Gmail을 사용합니다. 각 서비스가 맡는 목적은 페이지·파일 전달, 접속 보안, 도메인 운영과 메일 전달·수신입니다.', en: 'The site uses Vercel hosting. Cloudflare is used for domain DNS and email routing, and Google Gmail for receiving contact email. Their purposes include page and file delivery, access protection, domain operation, email routing and receipt.' },
      { ko: '이 제공자들은 대한민국 밖에서도 정보를 처리할 수 있습니다. 이 사이트의 실제 접속 로그 보관기간·처리 국가·하위 처리자와 메일 보관 설정의 세부 내용은 현재 확인 중입니다. 국내에서만 보관한다거나 국외 이전이 없다고 보장하지 않습니다. 제공자 정책과 확인된 내용은 아래 링크 및 이 문서의 변경 기록에 공개합니다.', en: 'These providers can process information outside South Korea. The exact retention of access logs, processing countries, subprocessors and mailbox retention settings for this site are still being checked. Storage exclusively in South Korea or the absence of overseas transfers is not guaranteed. Provider policies and confirmed details are published through the links below and updates to this notice.' },
      { ko: '새로운 개인정보 수집이나 별도 동의가 필요한 국외 이전을 도입할 경우 처리 항목·목적·수신자·국가·보관기간·거부 방법을 먼저 안내하고 필요한 절차를 진행합니다. 현재 소개 사이트에는 개인정보를 입력·제출하는 폼을 추가하지 않았습니다.', en: 'Before introducing new personal-information collection or an overseas transfer requiring separate consent, the information, purpose, recipient, country, retention and refusal method will be explained and required steps completed. The current information site has no form for entering and submitting personal information.' },
    ],
  },
  {
    id: 'local-app', title: { ko: '로컬 앱·CLI와 선택한 AI 연결', en: 'Local app, CLI and selected AI connections' },
    paragraphs: [
      { ko: '로컬 프로젝트의 입력·복사본·결과와 작업 기록은 사용자의 프로젝트 폴더와 앱 데이터 폴더에 저장됩니다. Treeset 사이트에 프로젝트를 자동 업로드하는 기능은 없습니다. 업데이트 확인과 외부 AI 요청 때문에 앱 전체가 항상 오프라인인 것은 아닙니다.', en: 'Local project inputs, copies, outputs and work records are stored in the user’s project and app-data folders. There is no feature automatically uploading projects to the Treeset site. The entire app is not always offline because update checks and external AI requests can use the network.' },
      { ko: '사용자가 승인한 GPT 이미지 요청은 입력한 프롬프트·스타일·규격과 선택한 참조 이미지를 공식 제공자에 보낼 수 있습니다. Claude 기획 소스 프로토타입은 승인된 게임 설명·아트 방향·에셋 개수만 전달하는 구조입니다. 실제 Claude 검증은 보류 중이고 0.1.13 공개 설치 파일에는 포함되지 않았습니다.', en: 'An approved GPT image request can send the entered prompt, style, dimensions and selected reference images to the official provider. The Claude planning source prototype is designed to send only an approved game description, art direction and asset count. Live Claude verification remains pending and the prototype is not included in the public 0.1.13 installers.' },
      { ko: '선택한 제공자의 처리·보관 조건은 해당 서비스의 최신 정책을 확인하세요. 사이트를 열거나 npm 스킬을 설치하는 것만으로 외부 AI 전송을 승인한 것으로 처리하지 않습니다.', en: 'Consult the selected provider’s current policy for its processing and retention practices. Merely visiting the site or installing the npm skill is not treated as approval of an external AI transmission.' },
    ],
  },
  {
    id: 'public-records', title: { ko: '공개 피드백과 가상 기록', en: 'Public feedback and synthetic records' },
    paragraphs: [
      { ko: 'GitHub 이슈는 외부 서비스에 공개될 수 있으므로 민감한 자료는 올리지 마세요. 실제 사용자의 발언이나 자료를 사례로 공개할 때에는 공개 범위에 대한 별도 허락을 받습니다.', en: 'GitHub issues can become public on an external service, so avoid posting sensitive materials. Publishing a real user’s words or materials as a case study requires separate permission covering the scope of publication.' },
      { ko: '가상 사용자 시나리오의 역할·대화·예시 계획은 개발 설명을 위해 작성한 합성 자료입니다. 실제 참여자의 이름·연락처·행동 기록을 수집해 만든 자료가 아니며 실제 고객 후기나 Claude 사용 기록으로 표시하지 않습니다.', en: 'Roles, dialogue and illustrative plans in the synthetic user scenarios are authored materials for explaining development. They were not made by collecting the names, contacts or activity records of actual participants, and are not labeled as customer testimonials or Claude usage records.' },
    ],
  },
  {
    id: 'rights-and-security', title: { ko: '권리 행사와 보호', en: 'Your rights and protection' },
    paragraphs: [
      { ko: '운영자가 처리하는 본인 정보의 열람·정정·삭제·처리정지·동의 철회를 oocheol@treeset.win으로 요청할 수 있습니다. 확인과 답변에 필요한 최소한의 정보만 요청하며 법령상 제한이 있으면 사유를 안내합니다. 보호자·법정대리인도 관련 권리를 행사할 수 있습니다.', en: 'You can request access, correction, deletion, restriction of processing or withdrawal of consent for your information handled by the operator at oocheol@treeset.win. Only the minimum information needed to verify and answer the request will be sought. Any legal restriction will be explained. Guardians and legal representatives can exercise relevant rights.' },
      { ko: '문의 자료 접근을 운영자로 제한하고 HTTPS, 사이트의 콘텐츠 보안 정책, 외부 인증 제공자의 로그인 흐름을 사용합니다. 개인정보를 판매하거나 광고 목적으로 제공하는 기능은 없습니다. 제공자별 독립적 처리에 관한 요청은 해당 제공자의 창구도 이용할 수 있습니다.', en: 'Access to contact materials is restricted to the operator. The site uses HTTPS and a content security policy, and external authentication uses the provider’s official sign-in flow. No feature sells personal information or supplies it for advertising. Requests relating to a provider’s independent processing can also be directed to that provider.' },
    ],
  },
  {
    id: 'updates', title: { ko: '변경 기록', en: 'Updates' },
    paragraphs: [
      { ko: '2026년 10월 9일: 최초 공개. 사이트·브라우저 저장·문의·로컬 앱·외부 제공자·가상 기록을 구분해 안내했습니다. 처리 범위가 바뀌면 변경 내용과 적용일을 공개하고 필요한 경우 별도 안내·동의 절차를 진행합니다.', en: 'October 9, 2026: first publication. Site handling, browser storage, contact, local apps, external providers and synthetic records are described separately. Changes to processing scope will be published with their effective date, with separate notice or consent steps where required.' },
    ],
  },
];

export const providerPolicyLinks = [
  { label: 'Vercel privacy notice', href: 'https://vercel.com/legal/privacy-notice' },
  { label: 'Cloudflare privacy policy', href: 'https://www.cloudflare.com/privacypolicy/' },
  { label: 'Google privacy policy', href: 'https://policies.google.com/privacy' },
  { label: 'OpenAI privacy policy', href: 'https://openai.com/policies/privacy-policy/' },
  { label: 'Anthropic privacy policy', href: 'https://www.anthropic.com/legal/privacy' },
];
