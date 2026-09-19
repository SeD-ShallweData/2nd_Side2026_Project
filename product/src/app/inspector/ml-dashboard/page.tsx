import type { Metadata } from "next";
import { cookies } from "next/headers";

import { InspectorNav } from "@/components/inspector/InspectorNav";
import { MlDashboardPage } from "@/components/inspector/MlDashboardPage";
import { canOperatePlatform } from "@/server/auth/inspectorAccess";
import { SESSION_COOKIE_NAME } from "@/server/auth/sessionCookie";
import { getOptionalSessionUser } from "@/services/authService";

export const metadata: Metadata = { title: "ML 대시보드" };

/*
 * 집계는 근로감독관도 본다. 모델 운영 패널은 운영 관리자에게만 보인다.
 * 보이는 것을 막는 것만으로는 부족하므로, 패널이 실제로 서버를 부를 때가
 * 오면 그 경로도 admin 으로 좁혀야 한다.
 */
export default async function MlDashboardRoute() {
  const cookieStore = await cookies();
  const user = await getOptionalSessionUser(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null);

  return (
    <div className="inspector-page">
      <InspectorNav current="ml-dashboard" />
      <MlDashboardPage canOperate={canOperatePlatform(user?.role)} />
    </div>
  );
}
