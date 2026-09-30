"use client";

import { useState } from "react";
import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { commonMessages } from "@/i18n/messages/common";

// [체크 상태 id, 분류 사전 키, 항목 사전 키]
const CHECK_ITEMS = [
  ["payday", "wage", "payday"],
  ["wage-parts", "wage", "wageParts"],
  ["hours", "hours", "hours"],
  ["overtime", "hours", "overtime"],
  ["contract-copy", "contract", "contractCopy"],
  ["location", "conditions", "location"],
  ["report", "safety", "report"],
  ["equipment", "safety", "equipment"],
] as const;

export function ActionChecklist() {
  const m = useMessages(commonMessages).checklist;
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const count = CHECK_ITEMS.filter(([id]) => checked[id]).length;

  return (
    <section className="checklist-card" aria-labelledby="checklist-title">
      <div className="section-title-row">
        <div>
          <span className="eyebrow">{m.eyebrow}</span>
          <h2 id="checklist-title">{m.title}</h2>
          <p>{m.desc}</p>
        </div>
        <div className="check-progress" aria-live="polite">
          <strong>{count}</strong>{format(m.progress, { total: CHECK_ITEMS.length })}
        </div>
      </div>
      <div className="progress-track" aria-hidden="true">
        <span style={{ width: `${(count / CHECK_ITEMS.length) * 100}%` }} />
      </div>
      <div className="check-grid">
        {CHECK_ITEMS.map(([id, categoryKey, itemKey]) => (
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
              <small>{m.categories[categoryKey]}</small>
              <strong>{m.items[itemKey]}</strong>
            </span>
          </label>
        ))}
      </div>
      <p className="checklist-note">{m.note}</p>
    </section>
  );
}
