import Image from "next/image";
import Link from "next/link";
import { landingMessages, type LandingMessages } from "@/i18n/messages/landing";

/** 사전을 넘기지 않으면(테스트 등) 한국어로 그린다. */
export function LandingHero({ m = landingMessages.ko }: { m?: LandingMessages }) {
  const h = m.hero;
  return (
    <section className="refresh-hero" aria-labelledby="home-title">
      <div className="shell refresh-hero-grid">
        <div className="refresh-hero-copy">
          <span className="eyebrow">{h.eyebrow}</span>
          <h1 id="home-title">
            <span>{h.titleLine1}</span>
            <mark>{h.titleMarkBefore}<span className="refresh-brand-word">{m.brand}</span>{h.titleMarkAfter || null}</mark>
          </h1>
          <p>{h.leadLine1}<br />{h.leadLine2}</p>
          <div className="refresh-button-row">
            <Link href="/chat" className="button button-ai button-large consult-cta">
              <Image src="/brand/donworry-mascot.png" alt="" width={192} height={192} />
              {h.ctaChat} <span aria-hidden="true">→</span>
            </Link>
            <Link href="/companies" className="button button-dark button-large">{h.ctaCompanies} <span aria-hidden="true">→</span></Link>
          </div>
          <dl className="refresh-hero-facts">
            <div><dt>{h.facts.riskTerm}</dt><dd>{h.facts.riskDesc}</dd></div>
            <div><dt>{h.facts.sourceTerm}</dt><dd>{h.facts.sourceDesc}</dd></div>
            <div><dt>{h.facts.actionTerm}</dt><dd>{h.facts.actionDesc}</dd></div>
          </dl>
        </div>

        <div className="refresh-hero-visual" aria-label={h.visualAria}>
          <div className="refresh-demo-window">
            <div className="refresh-demo-bar"><i /><i /><i /><span>{h.demoBar}</span></div>
            <div className="refresh-demo-company">
              <b>OO</b><div><strong>{h.demoCompany}</strong><span>{h.demoRegion}</span></div>
            </div>
            <div className="refresh-demo-cards">
              <article className="is-watch"><small>{h.wageCard.scope}</small><strong>{h.wageCard.title}</strong><em>{h.wageCard.status}</em><p>{h.wageCard.body}</p></article>
              <article className="is-review"><small>{h.safetyCard.scope}</small><strong>{h.safetyCard.title}</strong><em>{h.safetyCard.status}</em><p>{h.safetyCard.body}</p></article>
            </div>
          </div>
          <span className="refresh-float-chip refresh-chip-top">{h.chipTop}</span>
          <span className="refresh-float-chip refresh-chip-bottom">{h.chipBottom}</span>
        </div>
      </div>
    </section>
  );
}
