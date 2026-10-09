import type { SiteLanguage } from './policies';

export default function SiteFooterLinks({ language = 'ko' }: { language?: SiteLanguage }) {
  const suffix = language === 'en' ? 'en/' : '';
  return <>
    <a href={`/terms/${suffix}`}>{language === 'ko' ? '이용약관' : 'Terms of use'}</a>
    <a href={`/privacy/${suffix}`}>{language === 'ko' ? '개인정보처리방침' : 'Privacy notice'}</a>
    <a href={`/research/claude-scenarios/${suffix}`}>{language === 'ko' ? '가상 테스트 예시' : 'Synthetic scenarios'}</a>
  </>;
}
