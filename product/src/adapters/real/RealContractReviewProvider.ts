import type {
  ContractReviewProvider,
  ContractReviewResult,
} from "@/domain/contract";
import { ServiceError } from "@/utils/errors";

export class RealContractReviewProvider implements ContractReviewProvider {
  async review(): Promise<ContractReviewResult> {
    throw new ServiceError(
      "CONTRACT_PROVIDER_UNAVAILABLE",
      "실제 계약서 분석 공급자가 아직 연결되지 않았습니다.",
      503,
      true,
    );
  }
}
