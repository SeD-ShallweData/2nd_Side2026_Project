import type { Metadata } from "next";
import { ChatPanel } from "@/components/chat/ChatPanel";
import type { ChatMode } from "@/domain/chat";
import { getCompanyById } from "@/services/companyService";
import { getChatExecutionMode } from "@/server/responses/responsesConfig";

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
  const executionMode = getChatExecutionMode();
  return (
    <div className="page-section conversation-page">
      <div className="shell chat-page-shell refresh-chat-shell">
        <div className="page-heading page-heading-left">
          <span className="eyebrow">AI 노동 상담</span>
          <h1>
            {executionMode === "dual_api"
              ? "같은 질문, 두 관점으로 확인하세요"
              : "필요한 근거를 도구로 확인하세요"}
          </h1>
          <p>
            {executionMode === "dual_api"
              ? "답변보다 공식 근거와 다음 행동을 먼저 볼 수 있게 구성했습니다."
              : "질문에 필요한 공식 정보 도구를 선택적으로 연결해 한 답변을 만듭니다."}{" "}
            법률 판단이나 전문가 상담을 대신하지 않습니다.
          </p>
        </div>
        <ChatPanel
          companyId={company?.company_id}
          companyName={company?.company_name}
          suggestedPrompt={prompt}
          chatMode={mode}
          executionMode={executionMode}
        />
      </div>
    </div>
  );
}
