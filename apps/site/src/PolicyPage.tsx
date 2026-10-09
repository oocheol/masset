import { ArrowUpRight, Mail } from 'lucide-react';
import { TreesetMark } from './App';
import { sourceUrl } from './content';
import SiteFooterLinks from './SiteFooterLinks';
import { policyContact, policyEffectiveDate, policyOperator, privacySections, providerPolicyLinks, termsSections, type SiteLanguage } from './policies';
import './documents.css';

export default function PolicyPage({ kind, language = 'ko' }: { kind: 'terms' | 'privacy'; language?: SiteLanguage }) {
  const isPrivacy = kind === 'privacy';
  const sections = isPrivacy ? privacySections : termsSections;
  const title = isPrivacy ? (language === 'ko' ? '개인정보처리방침' : 'Privacy notice') : (language === 'ko' ? '이용약관' : 'Terms of use');
  const alternate = language === 'ko' ? `/${kind}/en/` : `/${kind}/`;
  const lead = isPrivacy
    ? { ko: '어떤 정보가 브라우저에 남고, 무엇을 직접 보내는지 확인하세요.', en: 'See what stays in your browser and what you choose to send.' }
    : { ko: '공개 도구와 예제를 이용할 때 알아둘 조건을 설명합니다.', en: 'Conditions for using the public tools, examples and contact channel.' };
  return <div className="project-overview document-page" lang={language}>
    <a className="skip-link" href="#document-main">{language === 'ko' ? '본문으로 이동' : 'Skip to content'}</a>
    <header className="overview-header page-width"><a className="wordmark" href="/"><TreesetMark /><span>Treeset</span></a><nav aria-label={language === 'ko' ? '안내 메뉴' : 'Information navigation'}><a href={language === 'ko' ? '/' : '/about/'}>Asset Studio</a><a href={`/research/claude-scenarios/${language === 'en' ? 'en/' : ''}`}>{language === 'ko' ? '가상 테스트 예시' : 'Synthetic scenarios'}</a><a href={alternate} lang={language === 'ko' ? 'en' : 'ko'}>{language === 'ko' ? 'English' : '한국어'}</a></nav></header>
    <main id="document-main" className="page-width">
      <section className="document-hero"><h1>{title}</h1><p className="overview-lead">{lead[language]}</p><dl className="document-metadata"><div><dt>{language === 'ko' ? '적용일' : 'Effective'}</dt><dd><time dateTime={policyEffectiveDate}>{policyEffectiveDate}</time></dd></div><div><dt>{language === 'ko' ? '운영·문의' : 'Operator / contact'}</dt><dd>{policyOperator} · <a href={`mailto:${policyContact}`}>{policyContact}</a></dd></div></dl></section>
      <div className="document-layout">
        <nav className="document-toc" aria-label={language === 'ko' ? '문서 목차' : 'On this page'}>{sections.map(section => <a key={section.id} href={`#${section.id}`}>{section.title[language]}</a>)}</nav>
        <div className="document-body">
          {sections.map(section => <section id={section.id} key={section.id} aria-labelledby={`${section.id}-title`}><h2 id={`${section.id}-title`}>{section.title[language]}</h2>{section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph[language]}</p>)}{section.bullets && <ul>{section.bullets.map((item, index) => <li key={index}>{item[language]}</li>)}</ul>}</section>)}
          {isPrivacy && <section id="provider-policies"><h2>{language === 'ko' ? '제공자별 정책' : 'Provider policies'}</h2><ul className="document-link-list">{providerPolicyLinks.map(link => <li key={link.href}><a href={link.href}>{link.label}<ArrowUpRight size={17} aria-hidden="true" /></a></li>)}</ul><p className="document-scope-note">{language === 'ko' ? '제공자 링크만으로 이 사이트의 모든 처리 설정이 확인되거나 국외 이전 절차가 충족된 것으로 표시하지 않습니다. 미확인 설정은 본문의 확인 중 항목에 구분했습니다.' : 'Provider links alone do not establish every setting for this site or completion of overseas-transfer procedures. Unconfirmed settings are identified in the notice.'}</p></section>}
          <section id="contact"><h2>{language === 'ko' ? '문의하기' : 'Contact'}</h2><a className="text-link" href={`mailto:${policyContact}`}><Mail size={18} aria-hidden="true" />{policyContact}</a><p>{language === 'ko' ? '이 문서는 한국어와 영어로 제공됩니다. 내용 차이나 오류를 발견하면 알려주세요. 확인 후 수정 내용과 적용일을 공개합니다.' : 'This document is available in Korean and English. Please report differences or errors so the correction and effective date can be published.'}</p></section>
        </div>
      </div>
    </main>
    <footer className="overview-footer page-width"><a href="/">Treeset / Asset Studio</a><nav aria-label={language === 'ko' ? '관련 안내' : 'Related information'}><SiteFooterLinks language={language} /><a href={sourceUrl}>GitHub</a></nav></footer>
  </div>;
}
