import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeContractLegalBasis } from "@/domain/contractLaw";
import {
  CONTRACT_RULE_LEGAL_BASES,
  contractReviewCitations,
  parseContractReviewContext,
  toContractReviewContext,
} from "@/domain/contractReviewContext";
import type { ContractReviewResult } from "@/domain/contract";

const valid = {
  analysis_status: "completed",
  items: [
    { status: "detected", code: "WAGE_PAYDAY", label: "임금 지급일", legal_basis: "근로기준법 제17조" },
    { status: "missing", code: "BREAK_TIME", label: "휴게시간", legal_basis: "근기법 제54조" },
    { status: "review", code: "PENALTY", label: "위약금 예정", legal_basis: "근로기준법 제999조" },
  ],
  suggested_questions: ["휴게시간은 언제 몇 분인가요?"],
};

describe("계약서 진단 요약의 상담 연결", () => {
  it("근거 조문 목록이 계약 규칙 엔진(standards.py LAWS)과 같다", () => {
    const source = readFileSync(
      path.join(process.cwd(), "integrations/contract-api/app/contract/standards.py"),
      "utf8",
    );
    const block = source.slice(source.indexOf("LAWS: dict[str, dict] = {"));
    const keys = [...block.matchAll(/^ {4}"([^"]+)":/gm)].map((match) => normalizeContractLegalBasis(match[1]));
    expect(new Set(CONTRACT_RULE_LEGAL_BASES)).toEqual(new Set(keys));
  });

  it("규칙 엔진 목록 밖의 조문은 버리고 항목은 남긴다", () => {
    const parsed = parseContractReviewContext(valid)!;
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items[1].legal_basis).toBe("근로기준법 제54조");
    expect(parsed.items[2].legal_basis).toBeUndefined();
    expect(contractReviewCitations(parsed)).toEqual(["근로기준법 제17조", "근로기준법 제54조"]);
  });

  it("형식이 맞지 않으면 연결하지 않는다", () => {
    expect(parseContractReviewContext(null)).toBeUndefined();
    expect(parseContractReviewContext({ ...valid, analysis_status: "mocked" })).toBeUndefined();
    expect(parseContractReviewContext({ ...valid, items: [] })).toBeUndefined();
    expect(parseContractReviewContext({ ...valid, items: [{ ...valid.items[0], status: "ok" }] })).toBeUndefined();
    expect(parseContractReviewContext({ ...valid, items: [{ ...valid.items[0], code: "a b" }] })).toBeUndefined();
    expect(parseContractReviewContext({ ...valid, items: Array(31).fill(valid.items[0]) })).toBeUndefined();
  });

  it("원문·설명·파일명은 요약에 넣지 않는다", () => {
    const result: ContractReviewResult = {
      analysis_status: "completed",
      detected_items: [{ code: "WAGE_PAYDAY", label: "임금 지급일", status: "detected", description: "설명",
        legal_basis: "근로기준법 제17조", extracted_text: "매월 10일 홍길동에게 지급" }],
      missing_items: [], review_items: [], warnings: [], suggested_questions: [], limitations: [],
      file_name: "홍길동_근로계약서.pdf",
    };
    const context = toContractReviewContext(result)!;
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("홍길동");
    expect(serialized).not.toContain("설명");
    expect(toContractReviewContext({ ...result, analysis_status: "mocked" })).toBeNull();
  });
});
