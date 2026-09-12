import type { CommunityModerationReportDto } from "@/app/api/community/communityApiContract";
import { relativeTimeLabel } from "@/components/community/communityFormat";
import { ModerationReviewControls } from "@/components/admin/ModerationReviewControls";
import { POST_STATUS_LABELS, REPORT_REASON_LABELS, REPORT_STATUS_LABELS } from "@/components/admin/moderationLabels";

export function ModerationReportCard({
  report,
  onReviewed,
}: {
  report: CommunityModerationReportDto;
  onReviewed: () => void;
}) {
  return (
    <article className="community-post-card">
      <div>
        <span>{REPORT_REASON_LABELS[report.reason]}</span>
        <small>
          {REPORT_STATUS_LABELS[report.status]} · 신고 {relativeTimeLabel(report.created_at)}
          {report.reviewed_at ? ` · 처리 ${relativeTimeLabel(report.reviewed_at)}` : ""}
        </small>
      </div>

      <h2>{report.post.title}</h2>
      <p>대상 게시글 현재 상태: {POST_STATUS_LABELS[report.post.status]}</p>
      {report.detail ? <p>신고 상세: {report.detail}</p> : null}

      <div>
        <strong>신고 당시 게시글 스냅샷</strong>
        <p>{report.post_snapshot.title}</p>
        <p className="community-post-body">{report.post_snapshot.body}</p>
        <small>스냅샷 기준 시각: {relativeTimeLabel(report.post_snapshot.updated_at)}</small>
      </div>

      {report.resolution_note ? <p className="field-help">처리 메모: {report.resolution_note}</p> : null}

      {report.status === "pending" ? (
        <ModerationReviewControls reportId={report.report_id} onReviewed={onReviewed} />
      ) : null}
    </article>
  );
}
