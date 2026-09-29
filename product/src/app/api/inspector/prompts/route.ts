import { NextResponse } from "next/server";

import { requireOperatorRequest } from "@/server/auth/inspectorAccess";
import { isOpsConsoleEnabled } from "@/server/ops/opsMode";
import { REQUIRED_PROMPTS, getPromptOverride, loadPromptFile, refreshPromptOverrides } from "@/server/promptLoader";
import { errorPayload } from "@/utils/errors";

export const dynamic = "force-dynamic";

/*
 * 운영 관리자에게 현재 적용 중인 시스템 프롬프트를 보여준다.
 *
 * 이름은 REQUIRED_PROMPTS 에 박힌 세 가지만 받는다. 요청에서 받은 문자열로
 * 파일을 여는 길을 열어 두면 경로 조작이 들어온다.
 *
 * 파일은 고치지 않는다. 프롬프트 파일은 자산 무결성 해시로 고정돼 있고(#81) 웹 유닛은
 * 파일을 쓸 수 없다. 편집은 운영 콘솔이 DB에 버전으로 저장·적용하며(migration 0021),
 * 적용된 DB 버전이 있으면 파일보다 우선한다. source 가 어느 쪽이 쓰이는지 알려 준다.
 */
const LABELS: Record<(typeof REQUIRED_PROMPTS)[number], { title: string; usage: string }> = {
  "chat/system": { title: "노동 상담 시스템 프롬프트", usage: "일반 사용자 AI 상담" },
  "inspector/system": { title: "점검 보조 시스템 프롬프트", usage: "근로감독관 AI 점검 보조" },
  "rewrite/system": { title: "질문 재작성 프롬프트", usage: "검색 전 질문 정규화" },
};

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireOperatorRequest(request);
    const editable = isOpsConsoleEnabled();
    // 목록을 볼 때는 다른 웹 프로세스가 방금 적용한 것도 보이도록 기다렸다가 읽는다.
    if (editable) await refreshPromptOverrides(true);
    const items = REQUIRED_PROMPTS.map((name) => {
      const fileText = loadPromptFile(name);
      const override = getPromptOverride(name);
      const text = override?.body ?? fileText;
      return {
        name,
        title: LABELS[name].title,
        usage: LABELS[name].usage,
        text,
        line_count: text.split("\n").length,
        char_count: text.length,
        source: override ? "db" : "file",
        active_version: override ? { version: override.version, sha256: override.sha256, activated_at: override.activatedAt } : null,
        file_text: fileText,
      };
    });
    return NextResponse.json({ editable, items });
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
