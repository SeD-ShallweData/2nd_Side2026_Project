import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { forbidden } from "next/navigation";

import { getOptionalSessionUser } from "@/services/authService";
import { canInspect } from "@/server/auth/inspectorAccess";
import { SESSION_COOKIE_NAME } from "@/server/auth/sessionCookie";

export default async function InspectorLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const cookieStore = await cookies();
  const user = await getOptionalSessionUser(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null);
  // 배치 현황처럼 운영에 속한 화면은 각 페이지에서 다시 admin 으로 좁힌다.
  if (!canInspect(user?.role)) forbidden();

  return children;
}
