import type { Metadata } from "next";
import { AdminAccessGate } from "@/components/admin/AdminAccessGate";
import { ModerationReportList } from "@/components/admin/ModerationReportList";
import { requireOperatorPage } from "@/server/auth/pageGuards";

export const metadata: Metadata = { title: "커뮤니티 신고 관리" };

/*
 * 서버에서 먼저 운영 관리자 세션을 확인하고, 아니면 403 화면을 낸다(/inspector 와 같은 방식).
 * AdminAccessGate 는 화면을 연 뒤 세션이 끝난 경우를 안내하는 용도로 남겨 둔다.
 * 신고 데이터와 처리는 moderation API 가 따로 401/403 으로 막는다.
 */
export default async function AdminPage() {
  await requireOperatorPage();

  return (
    <div className="page-section community-page">
      <div className="shell community-shell">
        <div className="page-heading page-heading-left community-heading">
          <span className="eyebrow">관리자</span>
          <h1>커뮤니티 신고 관리</h1>
          <p>접수된 신고를 확인하고 승인 또는 기각을 결정합니다. 승인하면 대상 게시글이 공개 목록에서 숨김 처리됩니다.</p>
        </div>
        <AdminAccessGate>
          <ModerationReportList />
        </AdminAccessGate>
      </div>
    </div>
  );
}
