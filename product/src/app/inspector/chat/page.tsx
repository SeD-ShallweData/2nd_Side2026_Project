import type { Metadata } from "next";
import { InspectorChatPanel } from "@/components/inspector/InspectorChatPanel";
import { InspectorNav } from "@/components/inspector/InspectorNav";

export const metadata: Metadata = { title: "근로감독관 AI 점검 보조" };

interface InspectorChatPageProps {
  searchParams: Promise<{ company_id?: string }>;
}

export default async function InspectorChatPage({ searchParams }: InspectorChatPageProps) {
  const params = await searchParams;
  return (
    <div className="inspector-page inspector-chat-page">
      <InspectorNav current="chat" />
      <div className="shell inspector-chat-shell">
        <div className="inspector-chat-heading">
          <span className="eyebrow">AI-assisted inspection</span>
          <h1>사업장 데이터와 공식 근거를<br />함께 검토하세요.</h1>
          <p>동일한 내부 DB 컨텍스트와 노동법 RAG 검색 결과를 두 모델에 병렬 전달합니다.</p>
        </div>
        <InspectorChatPanel companyId={params.company_id?.slice(0, 64)} />
      </div>
    </div>
  );
}
