import type { Metadata } from "next";
import { InspectorNav } from "@/components/inspector/InspectorNav";
import { BatchStatusPage } from "@/components/inspector/BatchStatusPage";
import { requireOperatorPage } from "@/server/auth/pageGuards";

export const metadata: Metadata = { title: "배치 현황" };

/*
 * 레이아웃은 근로감독관도 통과시킨다. 배치는 플랫폼 운영이라 여기서 다시
 * 좁힌다. 메뉴에서 감추는 것만으로는 주소를 직접 쳐서 들어올 수 있다.
 */
export default async function InspectorBatchesPage() {
  await requireOperatorPage();

  return (
    <div className="inspector-page">
      <InspectorNav current="batches" />
      <BatchStatusPage />
    </div>
  );
}
