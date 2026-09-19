export type DataMode = "mock" | "real";

function parseDataMode(value: string | undefined): DataMode | undefined {
  if (value === "real" || value === "mock") return value;
  return undefined;
}

export function getDataMode(): DataMode {
  return parseDataMode(process.env.APP_DATA_MODE) ?? "real";
}

export function getCompanyDataMode(): DataMode {
  return parseDataMode(process.env.COMPANY_DATA_MODE) ?? getDataMode();
}

export function getContractDataMode(): DataMode {
  return parseDataMode(process.env.CONTRACT_DATA_MODE) ?? getDataMode();
}

export function getAuthDataMode(): DataMode {
  return parseDataMode(process.env.AUTH_DATA_MODE) ?? getDataMode();
}

export function getCommunityDataMode(): DataMode {
  return parseDataMode(process.env.COMMUNITY_DATA_MODE) ?? getDataMode();
}

export function getWorksiteTipDataMode(): DataMode {
  return parseDataMode(process.env.WORKSITE_TIP_DATA_MODE) ?? getDataMode();
}

/* 대화 원문은 인증·커뮤니티와 보존 기간, 삭제권, 접근 대상이 달라 독립 전환한다. */
export function getConversationDataMode(): DataMode {
  return parseDataMode(process.env.CONVERSATION_DATA_MODE) ?? getDataMode();
}

export function getFavoriteDataMode(): DataMode {
  return parseDataMode(process.env.FAVORITE_DATA_MODE) ?? getDataMode();
}

export function getMockDelayMs(): number {
  const parsed = Number(process.env.MOCK_DELAY_MS ?? 250);
  if (!Number.isFinite(parsed)) return 250;
  return Math.min(Math.max(parsed, 0), 2_000);
}
