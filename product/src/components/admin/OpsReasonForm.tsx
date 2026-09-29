"use client";

import { FormEvent, useId, useState } from "react";

/*
 * 운영 콘솔의 모든 변경은 사유를 남긴다(감사 로그). 확인 버튼을 누르기 전에
 * 무엇이 바뀌는지와 사유 입력을 한자리에서 보여 준다.
 */
export function OpsReasonForm({
  summary,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  summary: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  const valid = trimmed.length >= 2 && trimmed.length <= 300;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid && !busy) onConfirm(trimmed);
  }

  return (
    <form className="ops-reason-form" onSubmit={submit}>
      <p className="ops-reason-summary">{summary}</p>
      <label htmlFor={id}>변경 사유 (감사 기록에 남습니다)</label>
      <input
        id={id}
        value={reason}
        maxLength={300}
        placeholder="예: 시연을 위해 5월 배치로 고정"
        onChange={(event) => setReason(event.target.value)}
        autoFocus
      />
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="ops-reason-actions">
        <button type="submit" className="button button-dark" disabled={!valid || busy}>
          {busy ? "처리 중" : confirmLabel}
        </button>
        <button type="button" className="button button-outline" onClick={onCancel} disabled={busy}>
          취소
        </button>
      </div>
    </form>
  );
}
