import type {
  CommunityPostStatus,
  CommunityReportReason,
  CommunityReportStatus,
} from "@/app/api/community/communityApiContract";

// 계약 파일에는 한국어 라벨이 없어 화면용으로만 정의한다. CommunityReportForm.tsx의 사유 라벨과 맞춘다.
export const REPORT_REASON_LABELS: Record<CommunityReportReason, string> = {
  spam: "스팸/광고",
  abuse: "욕설/괴롭힘",
  privacy: "개인정보 노출",
  misinformation: "잘못된 정보",
  other: "기타",
};

export const REPORT_STATUS_LABELS: Record<CommunityReportStatus, string> = {
  pending: "대기중",
  accepted: "승인됨",
  dismissed: "기각됨",
};

export const POST_STATUS_LABELS: Record<CommunityPostStatus, string> = {
  published: "공개",
  hidden: "숨김",
  deleted: "삭제됨",
};
