import { describe, expect, it } from "vitest";

import { toPublicIndustry } from "@/services/publicCompanyFields";

describe("public company field boundary", () => {
  it.each(["BIZ_NO미존재사업장", "해당없음", "", "   "])(
    "does not expose the internal missing-industry label %j",
    (value) => {
      expect(toPublicIndustry(value)).toBeNull();
    },
  );

  it("preserves a real public industry label", () => {
    expect(toPublicIndustry(" 건설업 ")).toBe("건설업");
  });
});
