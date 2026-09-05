import { describe, expect, it } from "vitest";

import {
  CONTRACT_ASSET_MANIFEST_SHA256,
  isContractHealthReady,
} from "@/server/contractHealth";

const ready = {
  asset_integrity: true,
  asset_contract: "donworry.contract.assets.v1",
  asset_manifest_sha256: CONTRACT_ASSET_MANIFEST_SHA256,
  asset_files_verified: 26,
  asset_persona_count: 4,
  asset_system_blocks: 7,
  asset_few_shot_examples: 9,
  asset_knowledge_files: 13,
  contract: { enabled: true },
  providers: { upstage: { key: true } },
};

describe("contract analysis health contract", () => {
  it("accepts only the exact reviewed asset contract", () => {
    expect(isContractHealthReady(ready)).toBe(true);
  });

  it.each([
    ["missing integrity", { ...ready, asset_integrity: false }],
    ["manifest drift", { ...ready, asset_manifest_sha256: "0".repeat(64) }],
    ["extra or missing asset", { ...ready, asset_files_verified: 25 }],
    ["empty persona", { ...ready, asset_persona_count: 3 }],
    ["disabled contract", { ...ready, contract: { enabled: false } }],
    ["missing provider key", { ...ready, providers: { upstage: { key: false } } }],
  ])("rejects %s", (_label, payload) => {
    expect(isContractHealthReady(payload)).toBe(false);
  });

  it("rejects legacy and malformed payloads", () => {
    expect(isContractHealthReady({ contract: { enabled: true } })).toBe(false);
    expect(isContractHealthReady(null)).toBe(false);
  });
});
