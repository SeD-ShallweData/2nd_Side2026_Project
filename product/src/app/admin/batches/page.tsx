import type { Metadata } from "next";
import { AdminAccessGate } from "@/components/admin/AdminAccessGate";
import { BatchStatusPage } from "@/components/inspector/BatchStatusPage";

export const metadata: Metadata = { title: "ML 배치 현황" };

export default function AdminBatchesPage() {
  return (
    <div className="inspector-page">
      <AdminAccessGate>
        <BatchStatusPage
          endpoint="/api/admin/batches"
          eyebrow="관리자 · 읽기 전용"
          title="ML 배치 현황"
          description="실제 데이터베이스의 서비스 배치와 전체 적재 이력을 확인합니다."
        />
      </AdminAccessGate>
    </div>
  );
}
