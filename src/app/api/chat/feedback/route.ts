import { NextResponse } from "next/server";
import { parseComparisonFeedback, saveComparisonFeedback } from "@/server/comparisonFeedbackStore";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const feedback = parseComparisonFeedback(await request.json());
    await saveComparisonFeedback(feedback);
    return NextResponse.json({ saved: true });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "INVALID_FEEDBACK", message: error instanceof Error ? error.message : "평가를 저장하지 못했습니다." } },
      { status: 400 },
    );
  }
}
