import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { forbidden } from "next/navigation";

import { getOptionalSessionUser } from "@/services/authService";
import { SESSION_COOKIE_NAME } from "@/server/auth/sessionCookie";

export default async function InspectorLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const cookieStore = await cookies();
  const user = await getOptionalSessionUser(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (user?.role !== "inspector") forbidden();

  return children;
}
