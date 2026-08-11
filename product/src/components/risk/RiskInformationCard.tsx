import { DataSourceList } from "@/components/common/DataSourceList";
import { StatusBadge } from "@/components/common/StatusBadge";
import type { SafetyContextPublic, SourceReference, WageRiskPublic } from "@/domain/risk";

const CONFIDENCE_LABEL = {
  sufficient: "자료 충분",
  limited: "제한적 자료",
  unavailable: "확인 불가",
} as const;

const LISTING_LABEL = {
  listed: "공개 명단 일치 결과 있음",
  not_listed: "공개 명단 일치 결과 없음",
  unavailable: "공개 명단 확인 불가",
} as const;

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
  const isWage = props.kind === "wage";
  const title = isWage ? "임금 지급 관련 정보" : "지역·업종 산업재해 신호";
  const kicker = isWage ? "사업장 단위 확인 정보" : "개별 사업장 판정 아님";
  const question = isWage ? "왜 임금 관련 추가 확인이 필요한가요?" : "산업재해 정보는 무엇을 확인해야 하나요?";
  const unknown = props.data.level === "unknown";

  return (
    <article className={`risk-card risk-card-${props.kind}`}>
      <div className="risk-card-head">
        <div>
          <span className="card-kicker">{kicker}</span>
          <h2>{title}</h2>
        </div>
        <StatusBadge level={props.data.level} />
      </div>

      <p className={`risk-summary ${unknown ? "risk-summary-unknown" : ""}`}>{props.data.summary}</p>

      {!isWage ? (
        <div className="scope-strip">
          <strong>분석 범위</strong>
          <span>
            {props.data.region ?? "지역 정보 없음"} · {props.data.industry ?? "업종 정보 없음"}
          </span>
        </div>
      ) : null}

      {!unknown ? (
        <div className="risk-section">
          <h3>주요 확인 신호</h3>
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
            <p className="muted-text">추가로 표시할 세부 확인 신호는 없습니다. 아래 체크리스트는 직접 확인해 주세요.</p>
          )}
        </div>
      ) : (
        <div className="unknown-panel">
          <strong>결과를 추정하지 않습니다.</strong>
          <p>자료가 부족하다는 사실만 표시하며, 이를 정상이나 안전으로 바꾸지 않습니다.</p>
        </div>
      )}

      {isWage ? (
        <div className="listing-panel">
          <div>
            <span>공식 명단 확인</span>
            <strong>{LISTING_LABEL[props.data.official_listing.status]}</strong>
          </div>
          <small>
            {props.data.official_listing.as_of
              ? `기준 ${props.data.official_listing.as_of}`
              : "확인 가능한 기준일 없음"}
          </small>
          <p>명단에 없다는 사실은 체불 이력이 전혀 없거나 미래 체불이 없다는 뜻이 아닙니다.</p>
        </div>
      ) : (
        <p className="scope-disclaimer">{props.data.disclaimer}</p>
      )}

      <dl className="risk-meta">
        <div>
          <dt>데이터 신뢰도</dt>
          <dd>{CONFIDENCE_LABEL[props.data.confidence]}</dd>
        </div>
        <div>
          <dt>데이터 기준일</dt>
          <dd>{props.dataAsOf ?? "미확정"}</dd>
        </div>
      </dl>

      <details className="source-details">
        <summary>데이터 출처 보기</summary>
        <DataSourceList sources={props.sources} />
      </details>

      <button type="button" className="button button-outline card-action" onClick={() => props.onAsk(question)}>
        자세히 물어보기 <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}
