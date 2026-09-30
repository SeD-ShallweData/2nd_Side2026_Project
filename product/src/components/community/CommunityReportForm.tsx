"use client";

import { type FormEvent, useId, useState } from "react";
import type {
  CommunityReportReason,
  CreateCommunityReportRequest,
} from "@/app/api/community/communityApiContract";
import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { communityMessages } from "@/i18n/messages/community";
import { CommunityApiError, reportCommunityPost } from "@/services/communityClient";

// 계약 파일에는 신고 사유 라벨이 없어 값 순서만 두고, 라벨은 번역 사전(report.reasons)에서 읽는다.
const REPORT_REASONS: ReadonlyArray<CommunityReportReason> = ["spam", "abuse", "privacy", "misinformation", "other"];

const DETAIL_MAX = 500;

export function CommunityReportForm({ postId }: { postId: string }) {
  const m = useMessages(communityMessages);
  const n = (value: number) => value.toLocaleString(m.numberLocale);
  const errorMessages: Record<string, string> = m.report.errors;
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<CommunityReportReason | "">("");
  const [detail, setDetail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reportedMessage, setReportedMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || reportedMessage) return;

    const trimmedDetail = detail.trim();
    setSubmitError(null);
    if (!reason) {
      setFieldError(m.report.reasonRequired);
      return;
    }
    if (trimmedDetail.length > DETAIL_MAX) {
      setFieldError(format(m.report.detailTooLong, { max: n(DETAIL_MAX) }));
      return;
    }
    setFieldError(null);

    // 공백만 입력한 경우 detail 키 자체를 보내지 않는다.
    const input: CreateCommunityReportRequest = { reason };
    if (trimmedDetail) input.detail = trimmedDetail;

    setSubmitting(true);
    try {
      await reportCommunityPost(postId, input);
      setReportedMessage(m.report.submitted);
    } catch (caught) {
      if (caught instanceof CommunityApiError) {
        // 이미 신고한 글은 서버 판단을 최종으로 보고 이 화면에서도 완료 처리한다.
        if (caught.code === "DUPLICATE_REPORT") {
          setReportedMessage(m.report.errors.DUPLICATE_REPORT);
          return;
        }
        setSubmitError(errorMessages[caught.code] ?? caught.message);
        return;
      }
      setSubmitError(m.report.networkError);
    } finally {
      setSubmitting(false);
    }
  }

  if (reportedMessage) {
    // 부모(.community-post-actions)가 가로 flex 라 field-help 의 margin-top 8px 이
    // 이 문구만 아래로 내려앉게 만든다. 버튼들과 같은 중심선에 두려고 margin 을 0 으로 둔다.
    return <p className="field-help" role="status" style={{ margin: 0 }}>{reportedMessage}</p>;
  }

  if (!open) {
    // 문단으로 감싸면 flex 자식이 <p> 가 되어 버튼이 혼자 내려앉는다. 버튼만 내보낸다.
    return (
      <button type="button" className="button button-outline button-small" onClick={() => setOpen(true)}>
        {m.report.open}
      </button>
    );
  }

  return (
    // 신고 폼은 라디오 5개와 textarea 를 담아 버튼 한 칸에 들어가지 않는다.
    // 부모가 flex-wrap 이므로 flexBasis 100% 면 신고 버튼이 있던 자리에서 줄을 바꿔 한 줄을 통째로 쓴다.
    // order 로 밀지 않는다 — 보이는 순서와 탭 순서가 어긋나면 안 된다.
    <form className="search-form" onSubmit={handleSubmit} noValidate style={{ flexBasis: "100%" }}>
      <label id={`${fieldId}-reason-label`}>{m.report.reasonLabel}</label>
      <div role="radiogroup" aria-labelledby={`${fieldId}-reason-label`}>
        {REPORT_REASONS.map((item) => (
          <label className="field-help" key={item}>
            <input
              type="radio"
              name={`${fieldId}-reason`}
              value={item}
              checked={reason === item}
              disabled={submitting}
              onChange={() => setReason(item)}
            />
            {" "}{m.report.reasons[item]}{"　"}
          </label>
        ))}
      </div>

      <label htmlFor={`${fieldId}-detail`}>{m.report.detailLabel}</label>
      <textarea
        id={`${fieldId}-detail`}
        value={detail}
        rows={4}
        maxLength={DETAIL_MAX}
        disabled={submitting}
        placeholder={m.report.detailPlaceholder}
        aria-describedby={`${fieldId}-detail-help`}
        onChange={(event) => setDetail(event.target.value)}
      />
      <p className="field-help" id={`${fieldId}-detail-help`}>
        {format(m.report.detailHelp, { max: n(DETAIL_MAX), count: n(detail.trim().length) })}
      </p>

      <div className="contract-actions">
        <button type="submit" className="button button-dark" disabled={submitting}>
          {submitting ? m.report.submitting : m.report.submit}
        </button>
        <button type="button" className="button button-ghost" disabled={submitting} onClick={() => setOpen(false)}>
          {m.report.cancel}
        </button>
      </div>

      {fieldError ? <p className="field-error" role="alert">{fieldError}</p> : null}
      {submitError ? <p className="field-error" role="alert">{submitError}</p> : null}
    </form>
  );
}
