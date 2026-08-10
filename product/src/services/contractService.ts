import { MockContractReviewProvider } from "@/adapters/mock/MockContractReviewProvider";
import { getDataMode, getMockDelayMs, isMockFallbackEnabled } from "@/config/dataMode";
import type { ContractReviewRequest, ContractReviewResult } from "@/domain/contract";
import { getContractReviewProvider } from "@/services/providers";
import { delay } from "@/utils/delay";
import { ServiceError } from "@/utils/errors";

export const MAX_CONTRACT_SIZE = 10 * 1024 * 1024;
export const ALLOWED_CONTRACT_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;

export function validateContractRequest(request: ContractReviewRequest): void {
  const hasText = Boolean(request.text?.trim());
  const hasFile = Boolean(request.file_metadata);
  const hasScenario = Boolean(request.scenario_id?.trim());
  if (!hasText && !hasFile && !hasScenario) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "검토할 계약서 파일 또는 테스트 텍스트를 입력해 주세요.",
      400,
      false,
    );
  }
  if (request.text && request.text.length > 20_000) {
    throw new ServiceError("VALIDATION_ERROR", "테스트 텍스트는 20,000자 이하여야 합니다.", 400, false);
  }
  if (request.file_metadata) {
    if (request.file_metadata.size_bytes > MAX_CONTRACT_SIZE) {
      throw new ServiceError("FILE_TOO_LARGE", "파일은 10MB 이하만 업로드할 수 있습니다.", 413, false);
    }
    if (!ALLOWED_CONTRACT_TYPES.includes(request.file_metadata.content_type as (typeof ALLOWED_CONTRACT_TYPES)[number])) {
      throw new ServiceError(
        "UNSUPPORTED_MEDIA_TYPE",
        "PDF, PNG, JPG 파일만 업로드할 수 있습니다.",
        415,
        false,
      );
    }
  }
}

export async function reviewContract(request: ContractReviewRequest): Promise<ContractReviewResult> {
  validateContractRequest(request);
  await delay(getMockDelayMs());
  try {
    return await getContractReviewProvider().review(request);
  } catch (error) {
    if (getDataMode() !== "real" || !isMockFallbackEnabled()) throw error;
    return new MockContractReviewProvider().review(request);
  }
}
