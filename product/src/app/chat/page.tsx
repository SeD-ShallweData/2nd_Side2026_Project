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
              ? "공식 근거로 먼저 확인하세요"
              : "필요한 근거를 도구로 확인하세요"}
          </h1>
          <p>
            근로기준법 조문과 공식 자료를 먼저 찾아본 뒤에 답합니다. 지어낸 말이 섞이지 않도록
            RAG 구조로 설계해, 근거를 찾지 못하면 찾지 못했다고 말합니다.
            <br />
            {executionMode === "dual_api"
              ? "두 모델의 답을 나란히 비교해 볼 수도 있습니다."
              : "필요한 공식 정보 도구만 골라 연결해 한 답변으로 정리합니다."}{" "}
            최종 판단은 전문가와 함께 하세요.
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
