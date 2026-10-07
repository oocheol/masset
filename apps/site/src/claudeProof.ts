export const claudeWorkflowPath = '/workflows/claude-asset-brief/';

export interface ClaudeAssetInstruction {
  name: string;
  kind: 'sprite' | 'texture' | 'model' | 'image';
  purpose: string;
  prompt: string;
  acceptanceChecks: string[];
}

export interface ClaudeProof {
  schemaVersion: 1;
  title: string;
  scenario: string;
  verifiedAt: string;
  platform: string;
  cliVersion: string;
  model: string | null;
  input: { brief: string; artDirection: string };
  plan: { assets: ClaudeAssetInstruction[]; reviewChecklist: string[]; warnings: string[] };
  checks: { label: string; result: 'passed' | 'limited'; detail: string }[];
  limitations: string[];
  artifacts: { label: string; href: string; sha256: string }[];
}

export interface ClaudeDevelopmentEvidence {
  schemaVersion: 1;
  checkedAt: string;
  platform: string;
  cliVersion: string;
  authStatus: 'subscription-unavailable';
  input: { brief: string; artDirection: string };
  checks: { label: string; result: 'passed' | 'limited'; detail: string }[];
  artifacts: { label: string; href: string; sha256: string }[];
}

// This flag describes source development, independently of published installers.
// The coordinator updates it only after checking the native implementation.
export const claudePrototypeImplemented: boolean = true;

// Populate only from an actual, sanitized provider run and inspected output.
// Keeping this null shows a pending-verification page, never a fabricated demo.
export const claudeProof: ClaudeProof | null = null;

// A local probe can establish why a request was blocked without producing a
// Claude response. This record is intentionally independent of live proof.
export const claudeDevelopmentEvidence: ClaudeDevelopmentEvidence | null = {
  "schemaVersion": 1,
  "checkedAt": "2026-10-07T15:04:25.079Z",
  "platform": "Windows x64",
  "cliVersion": "2.1.217",
  "authStatus": "subscription-unavailable",
  "input": {
    "brief": "An isometric woodland crafting game needs a storage crate, workbench and display shelf as separate props. Keep metre scale, a bottom-centre pivot and editable sources.",
    "artDirection": "Muted teal wood and sand trim. Orthographic three-quarter soft studio lighting, readable silhouettes, and fewer than 10,000 triangles per prop."
  },
  "checks": [
    {
      "label": "Official CLI observed",
      "result": "passed",
      "detail": "The native Windows CLI observed Claude Code 2.1.217. It ran version/help/auth-status probes only."
    },
    {
      "label": "Explicit transmission gate",
      "result": "passed",
      "detail": "Missing --allow-claude and transmissionApproved:false were independently rejected before a provider request."
    },
    {
      "label": "Live Claude execution",
      "result": "limited",
      "detail": "The account has no Pro or Max subscription. The user deferred execution; no planning request, generated plan or paid API fallback was used."
    }
  ],
  "artifacts": [
    {
      "label": "Developer-written request (not sent)",
      "href": "/examples/claude-brief/input.json",
      "sha256": "8cbbd3bf6c4cc7aaf9f24185a255f6f1811c2ce9b1ab7febffec747e6496bed1"
    },
    {
      "label": "Native authentication and transmission-gate record",
      "href": "/examples/claude-brief/verification.json",
      "sha256": "b8310864131cb777422a6a5b369a6cacdac0554e4ed29d1801d27dcadee96b0c"
    }
  ]
};

export function claudePublicationStatus() {
  if (claudeProof) return {
    titleEn: 'A Claude planning example you can inspect.',
    statusEn: 'Source prototype — one live run verified',
    detailEn: 'An explicit game brief and art direction become separate asset instructions, with prompts and review checks. Inspect the maintainer-run example, downloaded JSON and verification scope.',
    titleKo: 'Claude 에셋 기획 예제',
    statusKo: '소스 프로토타입 · 실제 응답 확인',
    detailKo: '게임 설명과 아트 방향을 Claude에 전달하고, 개별 에셋의 작업 지시·프롬프트·검수 기준을 받는 예제를 확인했습니다. 개발자가 직접 실행한 데모이며, 입력·출력 JSON과 검증 범위를 공개합니다.',
  };
  if (claudePrototypeImplemented) return {
    titleEn: 'From a brief to reviewable asset instructions.',
    statusEn: 'Source prototype — live verification pending',
    detailEn: 'The source prototype connects Claude Code to asset planning. A live Claude response has not been verified, so no Claude output is presented as a working example.',
    titleKo: 'Claude 에셋 기획 프로토타입',
    statusKo: '소스 구현 · 실제 응답 검증 대기',
    detailKo: 'Claude Code로 게임 설명과 아트 방향을 개별 에셋 작업 지시로 정리하는 소스 프로토타입을 구현했습니다. 실제 Claude 응답은 아직 검증하지 않아 성공한 제작 예제로 소개하지 않습니다.',
  };
  return {
    titleEn: 'From a brief to reviewable asset instructions.',
    statusEn: 'In development — live verification pending',
    detailEn: 'We are developing a Claude Code workflow for asset briefs and review checks. A live Claude response has not been verified, so no Claude output is presented as a working example.',
    titleKo: 'Claude 에셋 기획 기능',
    statusKo: '개발 중 · 실제 응답 검증 대기',
    detailKo: 'Claude Code로 게임 설명과 아트 방향을 개별 에셋 작업 지시와 검수 기준으로 정리하는 기능을 개발하고 있습니다. 실제 응답 검증을 마친 뒤 입력·출력과 검증 기록을 공개합니다.',
  };
}
