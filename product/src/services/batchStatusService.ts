import { MockBatchStatusProvider } from "../adapters/mock/MockBatchStatusProvider";

export const batchStatusService = {
  getBatches: async () => {
    // TODO: 관리자 권한 검사(민규)
    const wage = await MockBatchStatusProvider.getWageBatch();
    const safety = await MockBatchStatusProvider.getSafetyBatch();
    
    return { wage, safety };
  }
};