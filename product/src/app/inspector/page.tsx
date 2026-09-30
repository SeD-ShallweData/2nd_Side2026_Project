import type { Metadata } from "next";

import { InspectorDashboard } from "@/components/inspector/InspectorDashboard";
import { InspectorNav } from "@/components/inspector/InspectorNav";
import { canOperatePlatform } from "@/server/auth/inspectorAccess";
import { requireInspectorPage } from "@/server/auth/pageGuards";

export const metadata: Metadata = { title: "근로감독관 대시보드" };

export default async function InspectorPage() {
  // 레이아웃 검사와 별개로 페이지에서도 권한을 다시 확인한다(server/auth/pageGuards.ts).
  const user = await requireInspectorPage();

  return (
    <div className="inspector-page">
      <InspectorNav current="dashboard" />
      <InspectorDashboard isOperator={canOperatePlatform(user.role)} />
    </div>
  );
}
