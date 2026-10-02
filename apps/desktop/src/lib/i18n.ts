export type Locale = 'ko' | 'en';
export const messages = {
  ko: {library:'에셋 라이브러리', canvas:'2D 캔버스', model:'3D 뷰포트', compare:'버전 비교', import:'가져오기', export:'묶음 내보내기', projects:'프로젝트', presets:'제작 프리셋', queue:'작업 큐', search:'에셋 이름, 태그 검색', local:'로컬 작업 공간', browser:'브라우저 미리보기', native:'데스크톱', all:'전체 에셋', selected:'선택됨', specification:'제작 규격', style:'스타일 가이드', asset:'에셋 속성', apply:'적용', cancel:'취소', create:'만들기', save:'저장', noSelection:'에셋을 선택하세요', plan:'제작 계획', planning:'설명을 제작 계획으로 정리', project:'프로젝트', recent:'최근 프로젝트', settings:'환경 확인'},
  en: {library:'Asset library', canvas:'2D canvas', model:'3D viewport', compare:'Version comparison', import:'Import', export:'Export bundle', projects:'Projects', presets:'Production presets', queue:'Job queue', search:'Search assets and tags', local:'Local workspace', browser:'Browser preview', native:'Desktop', all:'All assets', selected:'selected', specification:'Asset specification', style:'Style guide', asset:'Asset properties', apply:'Apply', cancel:'Cancel', create:'Create', save:'Save', noSelection:'Select an asset', plan:'Production plan', planning:'Create a production plan', project:'Project', recent:'Recent projects', settings:'Environment'},
} as const;
export function isMac() {return /Mac|iPhone|iPad/.test(navigator.platform);}
export const shortcutModifier = () => isMac() ? '⌘' : 'Ctrl';
