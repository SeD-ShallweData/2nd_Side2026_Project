import type { Metadata } from "next";
import { ChatPanel } from "@/components/chat/ChatPanel";
import type { ChatMode } from "@/domain/chat";
import { getCompanyById } from "@/services/companyService";

export const metadata: Metadata = { title: "노동 상담" };

interface ChatPageProps {
  searchParams: Promise<{ company_id?: string; prompt?: string; mode?: string }>;
}

const CHAT_MODES: ChatMode[] = ["general", "wage", "safety", "contract"];

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const params = await searchParams;
  const mode = CHAT_MODES.includes(params.mode as ChatMode) ? (params.mode as ChatMode) : "general";
  const company = params.company_id
    ? await getCompanyById(params.company_id).catch(() => null)
    : null;
  const prompt = params.prompt?.slice(0, 2_000);
  return (
    <div className="page-section conversation-page">
      <div className="shell chat-page-shell refresh-chat-shell">
        <div className="page-heading page-heading-left">
          <span className="eyebrow">AI 노동 상담</span>
          <h1>같은 질문, 두 관점으로 확인하세요</h1>
          <p>답변보다 공식 근거와 다음 행동을 먼저 볼 수 있게 구성했습니다.</p>
        </div>
        <ChatPanel
          companyId={company?.company_id}
          companyName={company?.company_name}
          suggestedPrompt={prompt}
          chatMode={mode}
        />
      </div>
    </div>
  );
}
