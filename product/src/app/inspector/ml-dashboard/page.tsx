import type { Metadata } from "next";

import { InspectorNav } from "@/components/inspector/InspectorNav";
import { MlDashboardPage } from "@/components/inspector/MlDashboardPage";
import { canOperatePlatform } from "@/server/auth/inspectorAccess";
import { requireInspectorPage } from "@/server/auth/pageGuards";

export const metadata: Metadata = { title: "Machine Learning 대시보드" };

/*
 * 집계는 근로감독관도 본다. 모델 운영 패널은 운영 관리자에게만 보인다.
 * 보이는 것을 막는 것만으로는 부족하므로, 패널이 실제로 서버를 부를 때가
 * 오면 그 경로도 admin 으로 좁혀야 한다.
 */
export default async function MlDashboardRoute() {
  // 레이아웃 검사와 별개로 페이지에서도 권한을 다시 확인한다(server/auth/pageGuards.ts).
  const user = await requireInspectorPage();

  return (
    <div className="inspector-page">
      <InspectorNav current="ml-dashboard" />
      <MlDashboardPage canOperate={canOperatePlatform(user.role)} />
    </div>
  );
}
