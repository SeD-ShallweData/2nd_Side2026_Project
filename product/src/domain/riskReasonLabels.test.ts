import { describe, expect, it } from "vitest";
import { labelRiskReason, labelRiskReasons, RISK_REASON_LABELS } from "@/domain/riskReasonLabels";

describe("labelRiskReason", () => {
  it("영문 피처명을 39종 사전의 한글 라벨로 바꾼다", () => {
    expect(labelRiskReason("door1_maxmonths")).toBe("체납 지속기간");
    expect(labelRiskReason("nf_bill_maxdrop")).toBe("고지금액 급락");
  });

  it("이미 한글 라벨로 저장된 값은 그대로 둔다 — 배치마다 원본 저장 형태가 섞여 있다", () => {
    expect(labelRiskReason("체납액")).toBe("체납액");
    expect(labelRiskReason("4대보험 체납이력")).toBe("4대보험 체납이력");
  });

  it("사전에 없는 값은 뜻을 지어내지 않고 확인 필요로 표기한다", () => {
    expect(labelRiskReason("unknown_future_feature")).toBe("사유 확인 필요");
  });

  it("데이터 신뢰도 2종은 사유 목록에서 제외한다(null)", () => {
    expect(labelRiskReason("imputed_ratio")).toBeNull();
    expect(labelRiskReason("imputed_months_count")).toBeNull();
    expect(labelRiskReason("(데이터 결측 비율)")).toBeNull();
    expect(labelRiskReason("(데이터 결측 개월수)")).toBeNull();
  });

  it("39종 전체가 사전에 있다", () => {
    expect(Object.keys(RISK_REASON_LABELS)).toHaveLength(39);
  });
});

describe("labelRiskReasons", () => {
  it("배열을 라벨로 바꾸고 제외 대상을 뺀다", () => {
    expect(labelRiskReasons(["door1_maxmonths", "imputed_ratio", "지역"])).toEqual([
      "체납 지속기간",
      "지역",
    ]);
  });

  it("빈 배열은 빈 배열을 돌려준다", () => {
    expect(labelRiskReasons([])).toEqual([]);
  });
});
