import Image from "next/image";
import { DataSourceList } from "@/components/common/DataSourceList";
import { StatusBadge } from "@/components/common/StatusBadge";
import type { SafetyContextPublic, SourceReference, WageRiskPublic } from "@/domain/risk";
import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { companyMessages } from "@/i18n/messages/company";

// domain/riskPresentation 의 UNCONNECTED_WAGE_OBSERVATION_LABELS 와 같은 순서다.
// 한국어 문구는 사전(risk.observationLabels, risk.listingLabel)에 같은 값으로 들어 있다.
const OBSERVATION_KEYS = ["turnover", "employmentTrend", "dataCompleteness"] as const;

type CardProps =
  | {
      kind: "wage";
      data: WageRiskPublic;
      dataAsOf: string | null;
      sources: SourceReference[];
      onAsk: (question: string) => void;
    }
  | {
      kind: "safety";
      data: SafetyContextPublic;
      dataAsOf: string | null;
      sources: SourceReference[];
      onAsk: (question: string) => void;
    };

export function RiskInformationCard(props: CardProps) {
  const m = useMessages(companyMessages).risk;
  const isWage = props.kind === "wage";
  const validatedFirmSafety = !isWage && props.data.scope === "validated_firm_context";
  const title = isWage
    ? m.titleWage
    : validatedFirmSafety
      ? m.titleSafetyValidated
      : m.titleSafetyContext;
  const kicker = isWage
    ? m.kickerWage
    : validatedFirmSafety
      ? m.kickerSafetyValidated
      : m.kickerSafetyContext;
  const question = isWage
    ? props.data.level === "normal"
      ? m.questionWageNormal
      : m.questionWageReview
    : m.questionSafety;
  const unknown = props.data.level === "unknown";
  const unavailable = props.data.availability === "unavailable";

  return (
    <article className={`risk-card risk-card-${props.kind} risk-level-${props.data.level}`}>
      <div className="risk-card-head">
        <div>
          <span className="card-kicker">{kicker}</span>
          <h2>{title}</h2>
        </div>
        <StatusBadge level={props.data.level} verdict={isWage ? props.data.verdict : undefined} kind={props.kind} />
      </div>

      <p className={`risk-summary ${unknown ? "risk-summary-unknown" : ""}`}>{props.data.summary}</p>

      {!isWage ? (
        <div className="scope-strip">
          <strong>{m.scopeTitle}</strong>
          <span>
            {validatedFirmSafety ? m.scopeValidated : m.scopeContext} · {props.data.region ?? m.noRegion} · {props.data.industry ?? m.noIndustry}
          </span>
        </div>
      ) : null}

      {unavailable ? (
        <div className="unknown-panel unavailable-panel" role="status">
          <strong>{m.unavailableTitle}</strong>
          <p>{m.unavailableBody}</p>
        </div>
      ) : !unknown ? (
        <div className="risk-section">
          <h3>{m.evidenceTitle}</h3>
          {props.data.evidence_items.length > 0 ? (
            <ul className="evidence-list">
              {props.data.evidence_items.map((item) => (
                <li key={item.code}>
                  <span aria-hidden="true">•</span>
                  <div>
                    <strong>{item.label}</strong>
                    <p>{item.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted-text">{m.evidenceEmpty}</p>
          )}
        </div>
      ) : (
        <div className="unknown-panel">
          <strong>{m.unknownTitle}</strong>
          <p>{m.unknownBody}</p>
        </div>
      )}

      {isWage ? (
        props.data.positive_signals ? (
          <section className="risk-section" aria-label={m.positiveTitle}>
            <h3>{m.positiveTitle}</h3>
            {props.data.positive_signals.availability === "ready" && !unknown && !unavailable ? (
              <>
                <p>{format(m.positiveCount, { count: props.data.positive_signals.confirmed_count ?? "" })}</p>
                <ul className="evidence-list">
                  {props.data.positive_signals.items.map((item) => (
                    <li key={item.label}>
                      <span aria-hidden="true">{item.status === "confirmed" ? "✓" : "—"}</span>
                      <div><strong>{item.label}</strong><p>{item.status === "confirmed" ? m.statusConfirmed : m.statusUnconfirmed}</p></div>
                    </li>
                  ))}
                </ul>
              </>
            ) : <p>{m.positiveUnavailable}</p>}
            <p className="observation-note">{m.positiveNote}</p>
          </section>
        ) : null
      ) : null}

      {isWage ? (
        <div className="wage-indicator-coverage" role="status">
          <strong>{m.coverageOfficial}</strong>
          <span>{m.coveragePending}</span>
        </div>
      ) : null}

      {isWage ? (
        <div className="listing-panel">
          <div>
            <span>{m.listingLabel}</span>
            <strong>{m.listing[props.data.official_listing.status]}</strong>
          </div>
          <small>
            {props.data.official_listing.as_of
              ? format(m.listingAsOf, { date: props.data.official_listing.as_of })
              : m.listingAsOfMissing}
          </small>
          <p>{m.listingNote}</p>
        </div>
      ) : null}

      {isWage ? (
        <section className="risk-section wage-observation-section" aria-labelledby="wage-observation-title">
          <div className="observation-title-row">
            <h3 id="wage-observation-title">{m.observationTitle}</h3>
            <span>{m.observationPending}</span>
          </div>
          <dl className="wage-observation-list">
            {OBSERVATION_KEYS.map((key) => (
              <div key={key}>
                <dt>{m.observationLabels[key]}</dt>
                <dd>{m.observationUnavailable}</dd>
              </div>
            ))}
          </dl>
          <p className="observation-note">{m.observationNote}</p>
        </section>
      ) : null}

      {!isWage ? (
        <p className="scope-disclaimer">{props.data.disclaimer}</p>
      ) : null}

      <dl className="risk-meta">
        <div>
          <dt>{m.metaConfidence}</dt>
          <dd>{m.confidence[props.data.confidence]}</dd>
        </div>
        <div>
          <dt>{m.metaAsOf}</dt>
          <dd>{props.dataAsOf ?? m.metaAsOfMissing}</dd>
        </div>
      </dl>

      <details className="source-details">
        <summary>{m.sourcesToggle}</summary>
        <DataSourceList sources={props.sources} />
      </details>

      <button type="button" className="button button-outline card-action" aria-label={format(m.askAria, { question })} onClick={() => props.onAsk(question)}>
        <Image src="/brand/donworry-avatar.png" alt="" width={192} height={192} />
        {m.askButton} <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}
