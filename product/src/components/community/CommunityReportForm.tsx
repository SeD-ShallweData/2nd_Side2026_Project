"use client";

import { type FormEvent, useId, useState } from "react";
import type {
  CommunityReportReason,
  CreateCommunityReportRequest,
} from "@/app/api/community/communityApiContract";
import { CommunityApiError, reportCommunityPost } from "@/services/communityClient";

// 계약 파일에는 신고 사유의 한국어 라벨이 없어 화면용으로만 정의한다.
const REPORT_REASONS: ReadonlyArray<{ value: CommunityReportReason; label: string }> = [
  { value: "spam", label: "스팸/광고" },
  { value: "abuse", label: "욕설/괴롭힘" },
  { value: "privacy", label: "개인정보 노출" },
  { value: "misinformation", label: "잘못된 정보" },
  { value: "other", label: "기타" },
];

const DETAIL_MAX = 500;

const ERROR_MESSAGES: Record<string, string> = {
  SELF_REPORT_NOT_ALLOWED: "본인이 작성한 게시글은 신고할 수 없습니다.",
  DUPLICATE_REPORT: "이미 신고한 게시글입니다.",
  COMMUNITY_POST_NOT_REPORTABLE: "현재 신고할 수 없는 게시글입니다.",
  AUTHENTICATION_REQUIRED: "로그인이 필요합니다. 로그인한 뒤 다시 시도해 주세요.",
  COMMUNITY_POST_NOT_FOUND: "게시글을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.",
};

export function CommunityReportForm({ postId }: { postId: string }) {
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
      setFieldError("신고 사유를 선택해 주세요.");
      return;
    }
    if (trimmedDetail.length > DETAIL_MAX) {
      setFieldError(`상세 설명은 ${DETAIL_MAX.toLocaleString("ko-KR")}자 이하여야 합니다.`);
      return;
    }
    setFieldError(null);

    // 공백만 입력한 경우 detail 키 자체를 보내지 않는다.
    const input: CreateCommunityReportRequest = { reason };
    if (trimmedDetail) input.detail = trimmedDetail;

    setSubmitting(true);
    try {
      await reportCommunityPost(postId, input);
      setReportedMessage("신고가 접수되었습니다. 관리자 검토 후 처리됩니다.");
    } catch (caught) {
      if (caught instanceof CommunityApiError) {
        // 이미 신고한 글은 서버 판단을 최종으로 보고 이 화면에서도 완료 처리한다.
        if (caught.code === "DUPLICATE_REPORT") {
          setReportedMessage(ERROR_MESSAGES.DUPLICATE_REPORT);
          return;
        }
        setSubmitError(ERROR_MESSAGES[caught.code] ?? caught.message);
        return;
      }
      setSubmitError("네트워크 문제로 신고를 접수하지 못했습니다. 잠시 후 다시 시도해 주세요.");
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
        이 게시글 신고
      </button>
    );
  }

  return (
    // 신고 폼은 라디오 5개와 textarea 를 담아 버튼 한 칸에 들어가지 않는다.
    // 부모가 flex-wrap 이므로 flexBasis 100% 면 신고 버튼이 있던 자리에서 줄을 바꿔 한 줄을 통째로 쓴다.
    // order 로 밀지 않는다 — 보이는 순서와 탭 순서가 어긋나면 안 된다.
    <form className="search-form" onSubmit={handleSubmit} noValidate style={{ flexBasis: "100%" }}>
      <label id={`${fieldId}-reason-label`}>신고 사유</label>
      <div role="radiogroup" aria-labelledby={`${fieldId}-reason-label`}>
        {REPORT_REASONS.map((item) => (
          <label className="field-help" key={item.value}>
            <input
              type="radio"
              name={`${fieldId}-reason`}
              value={item.value}
              checked={reason === item.value}
              disabled={submitting}
              onChange={() => setReason(item.value)}
            />
            {" "}{item.label}{"　"}
          </label>
        ))}
      </div>

      <label htmlFor={`${fieldId}-detail`}>상세 설명 (선택)</label>
      <textarea
        id={`${fieldId}-detail`}
        value={detail}
        rows={4}
        maxLength={DETAIL_MAX}
        disabled={submitting}
        placeholder="신고 사유를 구체적으로 적어주시면 검토에 도움이 됩니다."
        aria-describedby={`${fieldId}-detail-help`}
        onChange={(event) => setDetail(event.target.value)}
      />
      <p className="field-help" id={`${fieldId}-detail-help`}>
        최대 {DETAIL_MAX.toLocaleString("ko-KR")}자 · 현재 {detail.trim().length.toLocaleString("ko-KR")}자
      </p>

      <div className="contract-actions">
        <button type="submit" className="button button-dark" disabled={submitting}>
          {submitting ? "접수 중" : "신고 접수"}
        </button>
        <button type="button" className="button button-ghost" disabled={submitting} onClick={() => setOpen(false)}>
          취소
        </button>
      </div>

      {fieldError ? <p className="field-error" role="alert">{fieldError}</p> : null}
      {submitError ? <p className="field-error" role="alert">{submitError}</p> : null}
    </form>
  );
}
