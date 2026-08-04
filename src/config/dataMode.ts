export type DataMode = "mock" | "real";

export function getDataMode(): DataMode {
  return process.env.APP_DATA_MODE === "real" ? "real" : "mock";
}

export function getMockDelayMs(): number {
  const parsed = Number(process.env.MOCK_DELAY_MS ?? 250);
  if (!Number.isFinite(parsed)) return 250;
  return Math.min(Math.max(parsed, 0), 2_000);
}

export function isMockFallbackEnabled(): boolean {
  return process.env.ENABLE_MOCK_FALLBACK !== "false";
}
