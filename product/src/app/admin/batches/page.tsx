import type { Metadata } from "next";
import { AdminAccessGate } from "@/components/admin/AdminAccessGate";
import { BatchStatusPage } from "@/components/inspector/BatchStatusPage";
import { requireOperatorPage } from "@/server/auth/pageGuards";

export const metadata: Metadata = { title: "Machine Learning 배치 현황" };

/* 배치 운영은 운영 관리자만 연다. 서버에서 먼저 확인하고, 아니면 403 화면을 낸다. */
export default async function AdminBatchesPage() {
  await requireOperatorPage();

  return (
    <div className="inspector-page">
      <AdminAccessGate>
        <BatchStatusPage
          endpoint="/api/admin/batches"
          eyebrow="관리자 · 배치 운영"
          title="Machine Learning 배치 현황"
          description="서비스 배치와 전체 적재 이력을 확인하고, 필요하면 서비스할 배치를 고정하거나 자동 선택으로 되돌립니다."
        />
      </AdminAccessGate>
    </div>
  );
}
