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
      <div className="shell chat-page-shell">
        <div className="page-heading page-heading-left">
          <span className="eyebrow">공식 정보 기반 행동 안내</span>
          <h1>노동 관련 상황을 물어보세요</h1>
          <p>공식 노동법 검색 결과를 두 모델에 동일하게 전달하며, 법률 판단이나 전문가 상담을 대신하지 않습니다.</p>
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
