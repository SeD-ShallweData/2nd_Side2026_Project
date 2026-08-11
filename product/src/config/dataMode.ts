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

export function getMockDelayMs(): number {
  const parsed = Number(process.env.MOCK_DELAY_MS ?? 250);
  if (!Number.isFinite(parsed)) return 250;
  return Math.min(Math.max(parsed, 0), 2_000);
}
