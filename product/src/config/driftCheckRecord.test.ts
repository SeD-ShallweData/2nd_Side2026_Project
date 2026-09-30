import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LATEST_DRIFT_CHECK } from "@/config/driftCheckRecord";

const journalPath = fileURLToPath(new URL("../../../db/migrations/meta/_journal.json", import.meta.url));
const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
const tags = journal.entries.sort((a, b) => a.idx - b.idx).map((entry) => entry.tag);

describe("드리프트 검사 수동 기록", () => {
  it("기록한 마지막 migration 이 저장소 journal 의 같은 위치와 맞다", () => {
    const expected = LATEST_DRIFT_CHECK.migrations_expected;
    expect(expected).not.toBeNull();
    expect(expected!).toBeLessThanOrEqual(tags.length);
    expect(LATEST_DRIFT_CHECK.last_migration).toBe(tags[expected! - 1]);
  });

  it("기록 이후 병합된 migration 은 빠짐없이 '적용 여부 미확인'으로 적혀 있다", () => {
    // 새 migration 을 병합하고 이 기록을 갱신하지 않으면 여기서 실패한다.
    // 재검사 결과를 기록하거나, 최소한 unrecorded_migrations 에 추가해 화면이 정직하게 보이게 한다.
    expect(LATEST_DRIFT_CHECK.unrecorded_migrations).toEqual(tags.slice(LATEST_DRIFT_CHECK.migrations_expected ?? 0));
  });

  it("정상(aligned) 기록이면 적용 수와 후조건 수가 모두 맞는다", () => {
    if (LATEST_DRIFT_CHECK.result !== "aligned") return;
    expect(LATEST_DRIFT_CHECK.migrations_applied).toBe(LATEST_DRIFT_CHECK.migrations_expected);
    expect(LATEST_DRIFT_CHECK.postconditions_passed).toBe(LATEST_DRIFT_CHECK.postconditions_total);
    expect(LATEST_DRIFT_CHECK.source).toBe("manual");
  });
});
