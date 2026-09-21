import { parseComparisonFeedback, saveComparisonFeedback } from "@/server/comparisonFeedbackStore";
import { assertSameOriginRequest, noStoreError, noStoreJson, readJsonBody } from "@/server/auth/http";
import { ServiceError } from "@/utils/errors";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    let feedback;
    try {
      feedback = parseComparisonFeedback(await readJsonBody(request));
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        "INVALID_FEEDBACK",
        error instanceof Error ? error.message : "평가를 저장하지 못했습니다.",
        400,
        false,
      );
    }
    const persisted = await saveComparisonFeedback(feedback);
    return noStoreJson({ accepted: true, persisted });
  } catch (error) {
    return noStoreError(error);
  }
}
