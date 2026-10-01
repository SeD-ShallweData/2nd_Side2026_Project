import type { Metadata } from "next";
import { ChatPanel } from "@/components/chat/ChatPanel";
import type { ChatMode } from "@/domain/chat";
import { getCompanyById } from "@/services/companyService";
import { getChatExecutionMode } from "@/server/responses/responsesConfig";
import { chatMessages } from "@/i18n/messages/chat";
import { getMessages } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = await getMessages(chatMessages);
  return { title: m.metaTitle };
}

interface ChatPageProps {
  searchParams: Promise<{ company_id?: string; prompt?: string; mode?: string; contract_review?: string }>;
}

const CHAT_MODES: ChatMode[] = ["general", "wage", "safety", "contract"];

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const params = await searchParams;
  const mode = CHAT_MODES.includes(params.mode as ChatMode) ? (params.mode as ChatMode) : "general";
  const company = params.company_id
    ? await getCompanyById(params.company_id).catch(() => null)
    : null;
  const prompt = params.prompt?.slice(0, 2_000);
  const executionMode = getChatExecutionMode();
  const m = (await getMessages(chatMessages)).page;
  return (
    <div className="page-section conversation-page">
      <div className="shell chat-page-shell refresh-chat-shell">
        <div className="page-heading page-heading-left">
          <span className="eyebrow">{m.eyebrow}</span>
          <h1>{executionMode === "dual_api" ? m.titleDual : m.titleTools}</h1>
          <p>
            {m.intro}
            <br />
            {executionMode === "dual_api" ? null : <>{m.introTools}{" "}</>}
            {m.finalJudgment}
          </p>
        </div>
        <ChatPanel
          companyId={company?.company_id}
          companyName={company?.company_name}
          suggestedPrompt={prompt}
          chatMode={mode}
          executionMode={executionMode}
          contractReviewRequested={mode === "contract" && params.contract_review === "1"}
        />
      </div>
    </div>
  );
}
