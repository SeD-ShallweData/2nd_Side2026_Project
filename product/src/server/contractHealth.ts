export const CONTRACT_ASSET_CONTRACT = "donworry.contract.assets.v1";
export const CONTRACT_ASSET_MANIFEST_SHA256 = "1df5825a76b24c961f8a8f49f72c07d0e1f70a06c6f3e0912c265f91e7af4a1a";
export const CONTRACT_ASSET_FILE_COUNT = 26;
export const CONTRACT_PERSONA_COUNT = 4;
export const CONTRACT_SYSTEM_BLOCK_COUNT = 7;
export const CONTRACT_FEW_SHOT_EXAMPLE_COUNT = 9;
export const CONTRACT_KNOWLEDGE_FILE_COUNT = 13;

export function isContractHealthReady(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const health = payload as Record<string, unknown>;
  const contract = health.contract as Record<string, unknown> | undefined;
  const providers = health.providers as Record<string, unknown> | undefined;
  const upstage = providers?.upstage as Record<string, unknown> | undefined;
  return health.asset_integrity === true
    && health.asset_contract === CONTRACT_ASSET_CONTRACT
    && health.asset_manifest_sha256 === CONTRACT_ASSET_MANIFEST_SHA256
    && health.asset_files_verified === CONTRACT_ASSET_FILE_COUNT
    && health.asset_persona_count === CONTRACT_PERSONA_COUNT
    && health.asset_system_blocks === CONTRACT_SYSTEM_BLOCK_COUNT
    && health.asset_few_shot_examples === CONTRACT_FEW_SHOT_EXAMPLE_COUNT
    && health.asset_knowledge_files === CONTRACT_KNOWLEDGE_FILE_COUNT
    && contract?.enabled === true
    && upstage?.key === true;
}
