import type { BatchDomainStatus, DriftCheckRecord } from "@/domain/batch";

/*
 * 배치 현황 정의서(docs/mlops/MLOps_배치현황정의서.md) 항목을 그리는 표시 전용 컴포넌트.
 * - 임금체불·산업재해는 분모·시간 단위·등급 체계가 달라 항상 따로 그리고 합산하지 않는다.
 * - 읽지 못한 값은 "⚪ 검사 불가"로 쓰고, ⚪를 ✅로 세지 않는다.
 * - 드리프트 결과는 결정 41번(옵션 C)에 따라 사람이 기입한 기록이며 화면에 그 사실을 적는다.
 */

const UNVERIFIABLE = "⚪ 검사 불가";

function count(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString("ko-KR") : "미기록";
}

function cases(value: number | null): string {
  return typeof value === "number" ? `${value.toLocaleString("ko-KR")}건` : "미기록";
}

function percent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

export function driftResultLabel(record: DriftCheckRecord): "정상" | "불일치" {
  return record.result === "aligned" ? "정상" : "불일치";
}

export function DriftCheckCard({ record }: { record: DriftCheckRecord }) {
  const ok = record.result === "aligned";
  return (
    <section className="batch-drift-card" aria-label="스키마 드리프트 검사">
      <header>
        <div>
          <span className="eyebrow">4. 스키마 드리프트 검사 (migration 정합성)</span>
          <h2>최근 검사 {record.checked_at} · {record.target}</h2>
        </div>
        <span className="batch-manual-badge">수동 기입</span>
      </header>
      <p className="batch-drift-result">
        <span className={`batch-drift-badge ${ok ? "is-ok" : "is-mismatch"}`}>{driftResultLabel(record)}</span>
        <strong>경고 {cases(record.warning_count)} · 검사 불가 {cases(record.unverifiable_count)}</strong>
        <code>{record.result}</code>
      </p>
      <dl className="batch-drift-facts">
        <div><dt>적용 migration</dt><dd>{count(record.migrations_applied)} / {count(record.migrations_expected)}{record.last_migration ? ` (마지막 ${record.last_migration})` : ""}</dd></div>
        <div><dt>후조건</dt><dd>{count(record.postconditions_passed)} / {count(record.postconditions_total)} 충족</dd></div>
        <div><dt>검사 명령</dt><dd><code>{record.command}</code></dd></div>
        <div><dt>기입</dt><dd>{record.recorded_by}</dd></div>
      </dl>
      {record.unrecorded_migrations.length > 0 ? (
        <p className="batch-warning-line" role="note">
          이 기록 이후 병합된 migration {record.unrecorded_migrations.join(", ")} 의 운영 적용 여부는 기록되지 않았습니다.
          재검사 전까지 현재 정합성은 미확인입니다.
        </p>
      ) : null}
      {record.notes.length > 0 ? <ul className="batch-note-list">{record.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
      <p className="batch-unverifiable-line">
        <strong>{UNVERIFIABLE}</strong> ML 산출물 자체 검사(self_check.py 25개 항목 — 🟡 경고·⚪ 검사 불가 포함) 결과는 아직 이 화면에 연결되지 않았습니다.
      </p>
      <p className="batch-muted-line">
        화면이 검사를 직접 실행하지 않습니다. 배포 때 실행한 결과를 운영자가 옮겨 적은 값이며, 데이터 분포 변화(데이터 드리프트)와는 다른 검사입니다.
      </p>
    </section>
  );
}

function staleBadge(domain: BatchDomainStatus) {
  if (domain.stale === null) return <span className="batch-check-badge is-unverifiable">{UNVERIFIABLE}</span>;
  if (domain.stale) return <span className="batch-check-badge is-stale">대상 기간 지남 (stale)</span>;
  return <span className="batch-check-badge is-current">대상 기간 전</span>;
}

export function BatchDomainCard({ domain }: { domain: BatchDomainStatus }) {
  return (
    <article className={`batch-domain-card is-${domain.domain}`} aria-label={`${domain.title} 배치 현황`}>
      <header>
        <h3>{domain.title}</h3>
        {staleBadge(domain)}
      </header>

      <section aria-label="기준일과 예측 대상">
        <h4>1. 기준일과 예측 대상</h4>
        <dl className="batch-domain-facts">
          <div><dt>{domain.as_of_label}</dt><dd>{domain.as_of ?? UNVERIFIABLE}</dd></div>
          <div><dt>{domain.target_label}</dt><dd>{domain.target ?? UNVERIFIABLE}</dd></div>
          <div><dt>관측창 종료월 일치(M2)</dt><dd>{UNVERIFIABLE} <small>형식만 확인 가능, 실제 관측창과의 일치는 파일·DB만으로 확인할 수 없습니다.</small></dd></div>
        </dl>
        {domain.stale_detail ? <p className={domain.stale ? "batch-warning-line" : "batch-muted-line"}>{domain.stale_detail}</p> : null}
      </section>

      <section aria-label="적재 행수">
        <h4>2. 적재 행수</h4>
        <p className="batch-domain-count">
          <strong>{domain.row_count === null ? UNVERIFIABLE : `${domain.row_count.toLocaleString("ko-KR")}곳`}</strong>
          <small>{domain.row_count_source} · 정의서 기준 {domain.reference_row_count.toLocaleString("ko-KR")}곳</small>
        </p>
      </section>

      <section aria-label="등급 분포">
        <h4>3. 등급 분포 (4종)</h4>
        {domain.grades.status === "ok" ? (
          <ul className="batch-grade-list">
            {domain.grades.items.map((item) => (
              <li key={item.key} className={`tone-${item.tone}`}>
                <span>{item.label}</span>
                <strong>{percent(item.ratio)}</strong>
                <small>{item.count.toLocaleString("ko-KR")}곳</small>
                <i aria-hidden="true"><em style={{ width: `${item.ratio ?? 0}%` }} /></i>
              </li>
            ))}
          </ul>
        ) : (
          <p className="batch-unverifiable-line"><strong>{UNVERIFIABLE}</strong> {domain.grades.reason}</p>
        )}
        <p className="batch-muted-line">{domain.grade_basis}</p>
      </section>

      <section aria-label="유효기간">
        <h4>5. 유효기간</h4>
        <p className="batch-domain-count">
          <strong>{domain.valid_until ?? "갱신 확인 필요"}</strong>
          <small>{domain.valid_until_note}</small>
        </p>
      </section>
    </article>
  );
}

export function BatchDomainPanels({ domains }: { domains: BatchDomainStatus[] }) {
  return (
    <section className="batch-domain-panel" aria-label="임금체불·산업재해 배치 현황">
      <p className="batch-no-sum-notice" role="note">
        <strong>합산 금지</strong> 임금체불과 산업재해는 분모·시간 단위(월/주)·등급 체계가 달라 따로 봅니다. 두 숫자를 더하거나 비교하지 마세요.
      </p>
      <div className="batch-domain-grid">
        {domains.map((domain) => <BatchDomainCard key={domain.domain} domain={domain} />)}
      </div>
    </section>
  );
}
