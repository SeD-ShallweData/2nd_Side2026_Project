import type { Metadata } from "next";
import { cookies } from "next/headers";

import { InspectorDashboard } from "@/components/inspector/InspectorDashboard";
import { InspectorNav } from "@/components/inspector/InspectorNav";
import { canOperatePlatform } from "@/server/auth/inspectorAccess";
import { SESSION_COOKIE_NAME } from "@/server/auth/sessionCookie";
import { getOptionalSessionUser } from "@/services/authService";

export const metadata: Metadata = { title: "근로감독관 대시보드" };

export default async function InspectorPage() {
  const cookieStore = await cookies();
  const user = await getOptionalSessionUser(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null);

  return (
    <div className="inspector-page">
      <InspectorNav current="dashboard" />
      <InspectorDashboard isOperator={canOperatePlatform(user?.role)} />
    </div>
  );
}
