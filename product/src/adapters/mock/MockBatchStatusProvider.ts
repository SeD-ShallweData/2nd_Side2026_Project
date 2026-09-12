export const MockBatchStatusProvider = {
  getWageBatch: async () => ({
    asOf: "2026-06-01",
    targetPeriod: "2026-12",
    isTargetStale: false,
    rowCount: 553598,
    validUntil: "2026-07-01",
    drift: { status: "정상", errorCount: 0, warningCount: 1, notCheckableCount: 3 },
    distribution: { normal: 32613, watch: 431646, review: 22098, unknown: 67241 },
  }),
  getSafetyBatch: async () => ({
    asOf: "2026-04-19",
    targetPeriod: "2026-04-20~26",
    isTargetStale: true,
    rowCount: 515608,
    validUntil: null,
    drift: { status: "불일치", errorCount: 1, warningCount: 0, notCheckableCount: 2 },
    distribution: { top1: 5161, top5: 20739, top10: 25690, general: 464018 },
  })
};