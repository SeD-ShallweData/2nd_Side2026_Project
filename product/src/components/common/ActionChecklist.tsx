"use client";

import { useState } from "react";

const CHECK_ITEMS = [
  ["payday", "임금", "임금 지급일이 계약서에 명시되어 있는지"],
  ["wage-parts", "임금", "기본급, 수당, 상여금이 구분되어 있는지"],
  ["hours", "근로시간", "소정근로시간과 휴게시간이 명시되어 있는지"],
  ["overtime", "근로시간", "연장·야간·휴일근로 수당 기준이 명시되어 있는지"],
  ["pay-structure", "급여", "기본급·수당 구성과 지급일을 확인했는지"],
  ["location", "근무조건", "계약서의 근무 장소와 실제 안내가 일치하는지"],
  ["report", "산업안전", "산업재해 발생 시 보고 절차를 안내받았는지"],
  ["equipment", "산업안전", "안전교육과 보호구 지급 여부를 확인했는지"],
] as const;

export function ActionChecklist() {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const count = CHECK_ITEMS.filter(([id]) => checked[id]).length;

  return (
    <section className="checklist-card" aria-labelledby="checklist-title">
      <div className="section-title-row">
        <div>
          <span className="eyebrow">직접 확인할 항목</span>
          <h2 id="checklist-title">입사 전 행동 체크리스트</h2>
          <p>모델 상태와 관계없이 실제 계약과 근무 환경을 직접 확인하세요.</p>
        </div>
        <div className="check-progress" aria-live="polite">
          <strong>{count}</strong> / {CHECK_ITEMS.length} 확인
        </div>
      </div>
      <div className="progress-track" aria-hidden="true">
        <span style={{ width: `${(count / CHECK_ITEMS.length) * 100}%` }} />
      </div>
      <div className="check-grid">
        {CHECK_ITEMS.map(([id, category, label]) => (
          <label className={`check-item ${checked[id] ? "is-checked" : ""}`} key={id}>
            <input
              type="checkbox"
              checked={Boolean(checked[id])}
              onChange={(event) => setChecked((current) => ({ ...current, [id]: event.target.checked }))}
            />
            <span className="custom-check" aria-hidden="true">
              {checked[id] ? "✓" : ""}
            </span>
            <span>
              <small>{category}</small>
              <strong>{label}</strong>
            </span>
          </label>
        ))}
      </div>
      <p className="checklist-note">체크 상태는 현재 브라우저 화면에서만 유지되며 새로고침하면 초기화됩니다.</p>
    </section>
  );
}
