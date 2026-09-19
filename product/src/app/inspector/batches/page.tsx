import type { Metadata } from "next";
import { cookies } from "next/headers";
import { forbidden } from "next/navigation";
import { InspectorNav } from "@/components/inspector/InspectorNav";
import { BatchStatusPage } from "@/components/inspector/BatchStatusPage";
import { canOperatePlatform } from "@/server/auth/inspectorAccess";
import { SESSION_COOKIE_NAME } from "@/server/auth/sessionCookie";
import { getOptionalSessionUser } from "@/services/authService";

export const metadata: Metadata = { title: "배치 현황" };

/*
 * 레이아웃은 근로감독관도 통과시킨다. 배치는 플랫폼 운영이라 여기서 다시
 * 좁힌다. 메뉴에서 감추는 것만으로는 주소를 직접 쳐서 들어올 수 있다.
 */
export default async function InspectorBatchesPage() {
  const cookieStore = await cookies();
  const user = await getOptionalSessionUser(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!canOperatePlatform(user?.role)) forbidden();

  return (
    <div className="inspector-page">
      <InspectorNav current="batches" />
      <BatchStatusPage />
    </div>
  );
}
