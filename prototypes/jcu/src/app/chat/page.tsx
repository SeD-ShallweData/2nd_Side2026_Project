import type { Metadata } from "next";
import { ChatPanel } from "@/components/chat/ChatPanel";

export const metadata: Metadata = { title: "노동 상담" };

export default function ChatPage() {
  return (
    <div className="page-section conversation-page">
      <div className="shell chat-page-shell">
        <div className="page-heading page-heading-left">
          <span className="eyebrow">공식 정보 기반 행동 안내</span>
          <h1>노동 관련 상황을 물어보세요</h1>
          <p>현재는 규칙 기반 Mock 상담이며, 법률 판단이나 전문가 상담을 대신하지 않습니다.</p>
        </div>
        <ChatPanel />
      </div>
    </div>
  );
}
