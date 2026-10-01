import Image from "next/image";
import Link from "next/link";
import { withMobileBreaks } from "@/components/common/MobileBreaks";
import { format } from "@/i18n/defineMessages";
import { landingMessages, type LandingMessages } from "@/i18n/messages/landing";

/*
 * 랜딩 부품은 서버 컴포넌트다. 페이지가 현재 언어 사전을 넘기고,
 * 넘기지 않으면(테스트 등) 한국어로 그린다.
 */
type Props = { m?: LandingMessages };


const STEP_KEYS = [
  { number: "01", icon: "⌕", key: "company" },
  { number: "02", icon: "?", key: "questions" },
  { number: "03", icon: "✓", key: "contract" },
] as const;

const COMMUNITY_KEYS = ["pay", "breaks", "firstDay"] as const;

/**
 * 상담 예시 질문을 쿼리 값으로 넣는다. 쿼리 구분에 쓰이는 문자만 인코딩해
 * 기존 한국어 링크(`임금이%20밀릴...%3F`)와 같은 모양을 유지한다.
 */
function chatPromptHref(prompt: string): string {
  return `/chat?prompt=${prompt.replace(/[%&#+?= ]/g, (char) => encodeURIComponent(char))}`;
}

export function FeatureSection({ m = landingMessages.ko }: Props) {
  const f = m.flow;
  return (
    <section className="section refresh-flow" aria-labelledby="flow-title">
      <div className="shell">
        <div className="section-heading"><span className="eyebrow">{f.eyebrow}</span><h2 id="flow-title">{f.title}</h2><p>{withMobileBreaks(f.desc)}</p></div>
        <div className="refresh-step-grid">
          {STEP_KEYS.map((step) => {
            const copy = f.steps[step.key];
            return <article key={step.number}><i>{step.icon}</i><span>{format(f.stepLabel, { number: step.number })}</span><h3>{copy.title}</h3><p>{withMobileBreaks(copy.body)}</p><b>{copy.tag}</b></article>;
          })}
        </div>
      </div>
    </section>
  );
}

export function RiskPreviewSection({ m = landingMessages.ko }: Props) {
  const r = m.risk;
  const wageItems = [
    [r.wageItems.listing, r.wageItems.listingValue],
    [r.wageItems.turnover, "18%"],
    [r.wageItems.trend, r.wageItems.trendValue],
    [r.wageItems.completeness, r.wageItems.completenessValue],
  ] as const;
  return (
    <section className="section refresh-risk-showcase" aria-labelledby="risk-preview-title">
      <div className="shell">
        <div className="refresh-section-row"><div><span className="eyebrow">{r.eyebrow}</span><h2 id="risk-preview-title">{withMobileBreaks(r.title)}</h2><p>{r.desc}</p></div><Link href="/companies" className="button button-outline">{r.searchCta} →</Link></div>
        <div className="refresh-risk-preview" aria-label={r.previewAria}>
          <article className="refresh-risk-card is-watch">
            <header><div><small>{r.wage.scope}</small><h3>{r.wage.title}</h3></div><strong>{r.wage.status}</strong></header>
            <p className="refresh-status-copy"><strong>{r.wage.listedExample}</strong><span>{r.wage.extraExample}</span></p>
            <dl>{wageItems.map(([item, value]) => <div key={item}><dt>{item}</dt><dd>{value}</dd></div>)}</dl>
            <small className="refresh-preview-note">{r.wage.note}</small>
          </article>
          <article className="refresh-risk-card is-review">
            <header><div><small>{r.safety.scope}</small><h3>{r.safety.title}</h3></div><strong>{r.safety.status}</strong></header>
            <p className="refresh-status-copy">{r.safety.body}</p>
            <div className="refresh-context-box"><b>{r.safety.rangeLabel}</b><span>{r.safety.rangeValue}</span></div>
            <ul><li>{r.safety.check1}</li><li>{r.safety.check2}</li><li>{r.safety.check3}</li></ul>
            <small className="refresh-preview-note">{r.safety.note}</small>
          </article>
        </div>
      </div>
    </section>
  );
}

export function ContractPreviewSection({ m = landingMessages.ko }: Props) {
  const c = m.contract;
  return (
    <section className="section refresh-contract-preview" aria-labelledby="contract-preview-title"><div className="shell refresh-split-section">
      <div><span className="eyebrow">{c.eyebrow}</span><h2 id="contract-preview-title">{c.title}</h2><p>{c.desc}</p><Link href="/contracts" className="button button-dark">{c.cta} →</Link></div>
      <div className="refresh-contract-card"><span>▤</span><div><small>{c.cardSmall}</small><h3>{c.cardTitle}</h3><ul><li><b>✓</b><span>{c.found}</span><strong>{format(c.count, { count: 3 })}</strong></li><li><b>!</b><span>{c.missing}</span><strong>{format(c.count, { count: 1 })}</strong></li><li><b>?</b><span>{c.extra}</span><strong>{format(c.count, { count: 2 })}</strong></li></ul></div></div>
    </div></section>
  );
}

export function CommunityPreview({ m = landingMessages.ko }: Props) {
  const c = m.community;
  return (
    <section className="section refresh-community-preview" aria-labelledby="community-preview-title"><div className="shell">
      <div className="refresh-section-row"><div><span className="eyebrow">{c.eyebrow}</span><h2 id="community-preview-title">{c.title}</h2><p>{c.desc}</p></div><Link href="/community" className="button button-outline">{c.cta} →</Link></div>
      <div className="refresh-post-grid">{COMMUNITY_KEYS.map((key) => {
        const post = c.posts[key];
        return <article key={key}><div><b>{post.place}</b><em>{post.tag}</em></div><h3>{post.title}</h3><p>{post.body}</p></article>;
      })}</div>
    </div></section>
  );
}

export function ConsultPreviewSection({ m = landingMessages.ko }: Props) {
  const c = m.consult;
  return (
    <section className="section refresh-consult-preview" aria-labelledby="consult-preview-title"><div className="shell refresh-split-section">
      <div><span className="eyebrow">{c.eyebrow}</span><h2 id="consult-preview-title">{c.titleLine1}<br />{c.titleLine2}</h2><p>{withMobileBreaks(c.desc)}</p><div className="refresh-prompt-list"><Link href={chatPromptHref(c.prompt1)}>{c.prompt1Label} <span>→</span></Link><Link href={chatPromptHref(c.prompt2)}>{c.prompt2Label} <span>→</span></Link></div></div>
      <div className="refresh-answer-preview"><header><span>{c.compareTitle}</span><small>{c.compareNote}</small></header><div><article><b>Upstage Solar</b><h3>{c.solar.title}</h3><ol><li>{c.solar.step1}</li><li>{c.solar.step2}</li><li>{c.solar.step3}</li></ol><small>{c.solar.foot}</small></article><article><b>SKT A.X</b><h3>{c.ax.title}</h3><p>{c.ax.body}</p><small>{c.ax.foot}</small></article></div></div>
    </div></section>
  );
}

export function FinalCta({ m = landingMessages.ko }: Props) {
  return (
    <section className="refresh-final-cta"><div className="shell"><span className="eyebrow">{m.final.eyebrow}</span><h2>{m.hero.titleLine1}<br />{format(m.final.titleLine2, { brand: m.brand })}</h2><div className="refresh-button-row"><Link href="/chat" className="button button-outline button-large consult-cta"><Image src="/brand/donworry-mascot.png" alt="" width={192} height={192} />{m.hero.ctaChat} <span aria-hidden="true">→</span></Link><Link href="/companies" className="button button-dark button-large">{m.hero.ctaCompanies} →</Link></div></div></section>
  );
}
