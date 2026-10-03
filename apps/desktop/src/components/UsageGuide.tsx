import {isNative} from '../lib/bridge';
import {shortcutModifier} from '../lib/i18n';

export default function UsageGuide() {
  return <div className="usage-guide">
    <p className="guide-intro">원본을 가져와 다듬고, 필요한 파일로 내보내세요. 변경한 결과는 새 버전으로 남습니다.</p>
    <ol>
      <li><h3>원본 가져오기</h3><p>라이브러리의 <strong>가져오기</strong>를 누르거나 파일을 끌어 놓으세요. PNG·JPEG·WebP 원본을 보존합니다. 단축키는 {shortcutModifier()} I입니다.</p></li>
      <li><h3>2D 이미지 다듬기</h3><p>에셋을 선택하고 오른쪽에서 <strong>크기 조정</strong>, 자르기, 색상, 배경을 바꾸세요. 새 버전을 만든 뒤 <strong>버전 비교</strong>에서 확인할 수 있습니다. 여러 이미지를 선택하면 아틀라스로 묶을 수 있습니다.</p></li>
      <li><h3>기본 3D 소품 만들기</h3><p><strong>3D 만들기</strong>에서 상자·테이블·선반을 골라 치수와 색을 정하세요. {isNative?'Blender가 필요합니다. GLB, .blend, 썸네일과 턴테이블을 만듭니다.':'브라우저에서는 Three.js로 GLB 미리보기를 만듭니다. Blender 원본 제작은 데스크톱 앱에서 확인하세요.'} 완성한 모델을 두 번 클릭하면 3D로 볼 수 있습니다.</p></li>
      <li><h3>결과 파일 내보내기</h3><p><strong>내보내기</strong>에서 대상 프로그램과 이미지 형식을 고르세요. 선택한 에셋 또는 전체 에셋을 결과 파일과 JSON 명세로 저장합니다. 단축키는 {shortcutModifier()} E입니다.</p></li>
      <li><h3>구독 이미지 생성의 확인 범위</h3><p>추론 모델은 GPT-6.1 Sol(<code>gpt-6.1-sol</code>), 요청 이미지 모델은 GPT Image2(<code>gpt-image-2</code>)입니다. 모델 목록과 연결 준비는 계정 이용 권한이나 생성 성공의 증거가 아닙니다. 이미지 생성 실증은 미완료이며, 실제 수신 파일·검증·응답 모델은 연결 패널에서 확인합니다.</p></li>
      <li><h3>새 버전으로 업데이트</h3><p><strong>앱 업데이트</strong>에서 GitHub 출처, 버전, 파일 크기, SHA-256과 소스 라이선스를 확인한 뒤 <strong>지금 업데이트</strong>를 누르세요. 작업이 실행 중이면 완료를 기다려야 합니다. 기존 0.1.0 portable 사용자는 새 NSIS 설치형을 한 번 직접 설치해야 합니다.</p></li>
    </ol>
    <p className="guide-shortcuts">{shortcutModifier()} F 검색 · {shortcutModifier()} A 표시된 에셋 전체 선택 · Esc 창 닫기</p>
  </div>;
}
