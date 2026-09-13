import type { Metadata } from "next";
import { AdminAccessGate } from "@/components/admin/AdminAccessGate";
import { ModerationReportList } from "@/components/admin/ModerationReportList";

export const metadata: Metadata = { title: "커뮤니티 신고 관리" };

export default function AdminPage() {
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
