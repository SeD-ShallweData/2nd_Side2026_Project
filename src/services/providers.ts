import { MockChatProvider } from "@/adapters/mock/MockChatProvider";
import { MockCompanyRepository } from "@/adapters/mock/MockCompanyRepository";
import { MockContractReviewProvider } from "@/adapters/mock/MockContractReviewProvider";
import { MockRiskProvider } from "@/adapters/mock/MockRiskProvider";
import { RealChatProvider } from "@/adapters/real/RealChatProvider";
import { RealCompanyRepository } from "@/adapters/real/RealCompanyRepository";
import { RealContractReviewProvider } from "@/adapters/real/RealContractReviewProvider";
import { MlRiskProvider } from "@/adapters/real/MlRiskProvider";
import { getDataMode } from "@/config/dataMode";
import type { CompanyRepository } from "@/domain/company";
import type { ChatProvider } from "@/domain/chat";
import type { ContractReviewProvider } from "@/domain/contract";
import type { RiskProvider } from "@/domain/risk";

const mockCompanyRepository = new MockCompanyRepository();
const mockRiskProvider = new MockRiskProvider();
const realCompanyRepository = new RealCompanyRepository();
const realRiskProvider = new MlRiskProvider();

export function getCompanyRepository(): CompanyRepository {
  return getDataMode() === "real" ? realCompanyRepository : mockCompanyRepository;
}

export function getRiskProvider(): RiskProvider {
  return getDataMode() === "real" ? realRiskProvider : mockRiskProvider;
}

export function getChatProvider(): ChatProvider {
  if (getDataMode() === "real") return new RealChatProvider();
  return new MockChatProvider(mockCompanyRepository, mockRiskProvider);
}

export function getContractReviewProvider(): ContractReviewProvider {
  return getDataMode() === "real" ? new RealContractReviewProvider() : new MockContractReviewProvider();
}
