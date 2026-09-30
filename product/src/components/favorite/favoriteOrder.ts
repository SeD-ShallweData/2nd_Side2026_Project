import type { FavoriteCompanyDto } from "@/app/api/users/me/favorites/favoriteApiContract";

const STORAGE_PREFIX = "money-worry:favorite-order:v1:";

export function favoriteOrderKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

export function readFavoriteOrder(userId: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(favoriteOrderKey(userId)) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveFavoriteOrder(userId: string, ids: string[]): boolean {
  try {
    localStorage.setItem(favoriteOrderKey(userId), JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}

export function reconcileFavoriteOrder(items: FavoriteCompanyDto[], storedIds: string[]): string[] {
  const available = new Set(items.map((item) => item.company_id));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of [...storedIds, ...items.map((item) => item.company_id)]) {
    if (available.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

// 보이는 항목이 차지한 자리만 다시 채운다. 숨겨진 항목의 위치와 상대 순서는 유지된다.
export function reorderVisibleFavorites(
  allIds: string[],
  visibleIds: string[],
  sourceId: string,
  targetId: string,
): string[] {
  const from = visibleIds.indexOf(sourceId);
  const to = visibleIds.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return allIds;
  const moved = [...visibleIds];
  moved.splice(from, 1);
  moved.splice(to, 0, sourceId);
  const visible = new Set(visibleIds);
  let next = 0;
  return allIds.map((id) => visible.has(id) ? moved[next++] : id);
}
