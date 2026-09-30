import { afterEach, describe, expect, it, vi } from "vitest";
import type { FavoriteCompanyDto } from "@/app/api/users/me/favorites/favoriteApiContract";
import {
  favoriteOrderKey,
  readFavoriteOrder,
  reconcileFavoriteOrder,
  reorderVisibleFavorites,
  saveFavoriteOrder,
} from "@/components/favorite/favoriteOrder";

function favorite(id: string): FavoriteCompanyDto {
  return { company_id: id, company_name: id, region: "서울특별시", industry: "제조업", created_at: "2026-09-30T00:00:00.000Z" };
}

afterEach(() => vi.unstubAllGlobals());

describe("계정별 관심 사업장 순서", () => {
  it("숨겨진 항목의 자리는 유지하고 현재 보이는 항목만 이동한다", () => {
    expect(reorderVisibleFavorites(["a", "hidden-1", "b", "hidden-2", "c"], ["a", "b", "c"], "c", "a"))
      .toEqual(["c", "hidden-1", "a", "hidden-2", "b"]);
    expect(reorderVisibleFavorites(["a", "b"], ["a"], "a", "b")).toEqual(["a", "b"]);
  });

  it("관심 해제·중복 저장값을 버리고 새 항목을 끝에 붙인다", () => {
    expect(reconcileFavoriteOrder([favorite("a"), favorite("b"), favorite("new")], ["b", "removed", "b", "a"]))
      .toEqual(["b", "a", "new"]);
  });

  it("같은 브라우저에서도 계정마다 저장 키와 재진입 순서가 분리된다", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
    });
    expect(favoriteOrderKey("user-a")).not.toBe(favoriteOrderKey("user-b"));
    expect(saveFavoriteOrder("user-a", ["b", "a"])).toBe(true);
    expect(saveFavoriteOrder("user-b", ["a", "b"])).toBe(true);
    expect(reconcileFavoriteOrder([favorite("a"), favorite("b")], readFavoriteOrder("user-a"))).toEqual(["b", "a"]);
    expect(reconcileFavoriteOrder([favorite("a"), favorite("b")], readFavoriteOrder("user-b"))).toEqual(["a", "b"]);
  });
});
