import { NextResponse } from "next/server";

import { requireOperatorRequest } from "@/server/auth/inspectorAccess";
import { REQUIRED_PROMPTS, loadPrompt } from "@/server/promptLoader";
import { errorPayload } from "@/utils/errors";

export const dynamic = "force-dynamic";

/*
 * 운영 관리자에게 현재 적용 중인 시스템 프롬프트를 보여준다.
 *
 * 이름은 REQUIRED_PROMPTS 에 박힌 세 가지만 받는다. 요청에서 받은 문자열로
 * 파일을 여는 길을 열어 두면 경로 조작이 들어온다.
 *
 * 쓰기는 없다. 프롬프트 파일은 자산 무결성 해시로 고정돼 있어, 파일을 고치면
 * contractHealth.ts 의 상수와 어긋나 배포가 멈춘다(#81). 편집 경로를 붙이려면
 * 그 구조를 먼저 정해야 한다.
 */
const LABELS: Record<(typeof REQUIRED_PROMPTS)[number], { title: string; usage: string }> = {
  "chat/system": { title: "노동 상담 시스템 프롬프트", usage: "일반 사용자 AI 상담" },
  "inspector/system": { title: "점검 보조 시스템 프롬프트", usage: "근로감독관 AI 점검 보조" },
  "rewrite/system": { title: "질문 재작성 프롬프트", usage: "검색 전 질문 정규화" },
};

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireOperatorRequest(request);
    const items = REQUIRED_PROMPTS.map((name) => {
      const text = loadPrompt(name);
      return {
        name,
        title: LABELS[name].title,
        usage: LABELS[name].usage,
        text,
        line_count: text.split("\n").length,
        char_count: text.length,
      };
    });
    return NextResponse.json({ editable: false, items });
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
