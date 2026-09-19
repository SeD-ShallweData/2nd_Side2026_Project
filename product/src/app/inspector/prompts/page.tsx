import type { Metadata } from "next";
import { cookies } from "next/headers";
import { forbidden } from "next/navigation";

import { InspectorNav } from "@/components/inspector/InspectorNav";
import { PromptStudioPage } from "@/components/inspector/PromptStudioPage";
import { canOperatePlatform } from "@/server/auth/inspectorAccess";
import { SESSION_COOKIE_NAME } from "@/server/auth/sessionCookie";
import { getOptionalSessionUser } from "@/services/authService";

export const metadata: Metadata = { title: "LLM 프롬프트" };

/* 프롬프트는 플랫폼 운영이다. 근로감독관에게는 열지 않는다. */
export default async function InspectorPromptsPage() {
  const cookieStore = await cookies();
  const user = await getOptionalSessionUser(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!canOperatePlatform(user?.role)) forbidden();

  return (
    <div className="inspector-page">
      <InspectorNav current="prompts" />
      <PromptStudioPage />
    </div>
  );
}
