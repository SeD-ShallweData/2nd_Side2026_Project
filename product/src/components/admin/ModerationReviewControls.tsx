"use client";

import { useId, useState } from "react";
import { ModerationApiError, reviewModerationReport } from "@/services/communityModerationClient";

const RESOLUTION_NOTE_MAX = 500;

interface ModerationReviewControlsProps {
  reportId: string;
  onReviewed: () => void;
}

type PendingDecision = "accept" | "dismiss" | null;

// 서버(communityService.ts parseReviewRequest)의 규칙을 그대로 따른다 — 그보다 강하게 만들지 않는다.
function reviewErrorMessage(error: ModerationApiError): string {
  switch (error.code) {
    case "VALIDATION_ERROR":
    case "AUTHENTICATION_REQUIRED":
    case "FORBIDDEN":
      return error.message;
    case "COMMUNITY_REPORT_NOT_FOUND":
      return "신고 내역을 찾을 수 없습니다. 목록을 새로고침해 주세요.";
    case "COMMUNITY_REPORT_ALREADY_REVIEWED":
      return "이미 처리된 신고입니다. 목록을 새로고침합니다.";
    default:
      return error.retryable
        ? "처리 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요."
        : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

export function ModerationReviewControls({ reportId, onReviewed }: ModerationReviewControlsProps) {
  const fieldId = useId();
  const [pendingDecision, setPendingDecision] = useState<PendingDecision>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function startDecision(decision: "accept" | "dismiss") {
    setPendingDecision(decision);
    setResolutionNote("");
    setNoteError(null);
    setSubmitError(null);
  }

  function cancel() {
    if (submitting) return;
    setPendingDecision(null);
    setNoteError(null);
    setSubmitError(null);
  }

  async function confirm() {
    if (submitting || !pendingDecision) return;

    const trimmedNote = resolutionNote.trim();
    if (trimmedNote.length > RESOLUTION_NOTE_MAX) {
      setNoteError(`메모는 ${RESOLUTION_NOTE_MAX.toLocaleString("ko-KR")}자 이하여야 합니다.`);
      return;
    }
    setNoteError(null);
    setSubmitError(null);

    setSubmitting(true);
    try {
      // 빈 메모는 키 자체를 보내지 않는다 — 서버는 값이 있으면 최소 1자를 요구한다.
      await reviewModerationReport(reportId, {
        decision: pendingDecision,
        ...(trimmedNote ? { resolution_note: trimmedNote } : {}),
      });
      setPendingDecision(null);
      onReviewed();
    } catch (caught) {
      setSubmitting(false);
      if (caught instanceof ModerationApiError) {
        setSubmitError(reviewErrorMessage(caught));
        if (caught.code === "COMMUNITY_REPORT_ALREADY_REVIEWED") onReviewed();
        return;
      }
      setSubmitError("네트워크 문제로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
  }

  if (!pendingDecision) {
    return (
      <div className="contract-actions" role="group" aria-label="신고 처리">
        <button type="button" className="button button-dark" onClick={() => startDecision("accept")}>
          승인
        </button>
        <button type="button" className="button button-outline" onClick={() => startDecision("dismiss")}>
          기각
        </button>
        {submitError ? <p className="field-error" role="alert">{submitError}</p> : null}
      </div>
    );
  }

  return (
    <div role="group" aria-label="신고 처리 확인">
      <p className="field-help">
        {pendingDecision === "accept"
          ? "승인하면 신고된 게시글이 공개 목록에서 즉시 숨김 처리됩니다. 계속할까요?"
          : "기각하면 이 신고는 조치 없이 종료됩니다. 계속할까요?"}
      </p>

      <div className="search-form">
        <label htmlFor={`${fieldId}-resolution-note`}>처리 메모 (선택)</label>
        <textarea
          id={`${fieldId}-resolution-note`}
          value={resolutionNote}
          rows={3}
          maxLength={RESOLUTION_NOTE_MAX}
          disabled={submitting}
          placeholder="필요하면 처리 사유를 남겨주세요."
          aria-invalid={Boolean(noteError)}
          aria-describedby={noteError ? `${fieldId}-note-error` : `${fieldId}-note-help`}
          onChange={(event) => setResolutionNote(event.target.value)}
        />
        {noteError
          ? <p className="field-error" id={`${fieldId}-note-error`} role="alert">{noteError}</p>
          : <p className="field-help" id={`${fieldId}-note-help`}>최대 {RESOLUTION_NOTE_MAX.toLocaleString("ko-KR")}자</p>}
      </div>

      <div className="contract-actions">
        <button
          type="button"
          className="button button-dark"
          disabled={submitting}
          onClick={() => void confirm()}
        >
          {submitting ? "처리 중" : pendingDecision === "accept" ? "승인 확정" : "기각 확정"}
        </button>
        <button type="button" className="button button-ghost" disabled={submitting} onClick={cancel}>
          취소
        </button>
      </div>

      {submitError ? <p className="field-error" role="alert">{submitError}</p> : null}
    </div>
  );
}
