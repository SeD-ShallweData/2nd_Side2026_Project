import type { Metadata } from "next";
import { InspectorChatPanel } from "@/components/inspector/InspectorChatPanel";
import { InspectorNav } from "@/components/inspector/InspectorNav";
import { requireInspectorPage } from "@/server/auth/pageGuards";

export const metadata: Metadata = { title: "근로감독관 AI 점검 보조" };

interface InspectorChatPageProps {
  searchParams: Promise<{ company_id?: string }>;
}

export default async function InspectorChatPage({ searchParams }: InspectorChatPageProps) {
  // 레이아웃 검사와 별개로 페이지에서도 권한을 다시 확인한다(server/auth/pageGuards.ts).
  await requireInspectorPage();
  const params = await searchParams;
  return (
    <div className="inspector-page inspector-chat-page">
      <InspectorNav current="chat" />
      <div className="shell inspector-chat-shell">
        <div className="inspector-chat-heading">
          <span className="eyebrow">AI-assisted inspection</span>
          <h1>사업장 데이터와 공식 근거를<br />함께 검토하세요.</h1>
          <p>사업장 내부 자료와 노동법 검색 근거를 Upstage에 전달해 한 개의 점검 보조 답변을 받습니다.</p>
        </div>
        <InspectorChatPanel companyId={params.company_id?.slice(0, 64)} />
      </div>
    </div>
  );
}
