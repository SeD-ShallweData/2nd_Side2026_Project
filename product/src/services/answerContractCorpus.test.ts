import { describe, expect, it } from "vitest";

import answerCases from "../../eval/answer-contract-cases.json";
import continuityCases from "../../eval/conversation-continuity-cases.json";

const MANUAL_DEVELOPMENT_IDS = [
  "AQ07-independent-company-no-certainty",
  "AQ11-manual-corrected-payday-recall",
  "AQ12-manual-small-workplace-night-premium",
  "AQ13-manual-1350-filing-boundary",
  "AQ14-manual-list-numbering",
  "AQ15-certificate-purpose-procedure",
  "AQ16-night-after-five",
  "AQ17-night-four-agreement",
  "AQ18-night-size-unknown",
  "AQ19-positive-not-arrears-proof",
  "AQ20-positive-but-unpaid",
  "AQ21-public-context-history",
  "AQ22-online-complaint",
  "AQ23-payday-and-promise-recall",
  "AQ24-recall-unknown",
];

describe("manual QA regression corpus", () => {
  it("keeps every known-failure regression in the development split", () => {
    const byId = new Map(answerCases.map((item) => [item.id, item]));
    for (const id of MANUAL_DEVELOPMENT_IDS) {
      expect(byId.get(id), id).toMatchObject({ split: "development" });
    }
    const ids = answerCases.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps continuity cases synthetic, development-only, and bounded to twelve distinct turns", () => {
    expect(continuityCases.length).toBeGreaterThan(0);
    for (const item of continuityCases) {
      expect(item).toMatchObject({
        split: "development",
        evidence: "synthetic_from_confirmed_manual_failure",
      });
      expect(item.steps.length).toBeGreaterThan(0);
      expect(item.steps.length).toBeLessThanOrEqual(12);
    }
  });
});
