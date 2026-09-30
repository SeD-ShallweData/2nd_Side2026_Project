import type { Metadata } from "next";

import { InspectorNav } from "@/components/inspector/InspectorNav";
import { PromptStudioPage } from "@/components/inspector/PromptStudioPage";
import { requireOperatorPage } from "@/server/auth/pageGuards";

export const metadata: Metadata = { title: "LLM 프롬프트" };

/* 프롬프트는 플랫폼 운영이다. 근로감독관에게는 열지 않는다. */
export default async function InspectorPromptsPage() {
  await requireOperatorPage();

  return (
    <div className="inspector-page">
      <InspectorNav current="prompts" />
      <PromptStudioPage />
    </div>
  );
}
