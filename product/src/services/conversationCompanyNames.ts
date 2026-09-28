import "server-only";
import type { StoredConversationDetail } from "@/domain/conversation";
import { getCompanyById } from "@/services/companyService";

/** Public names only, for IDs already in this owned conversation/current selection. */
export async function companyNamesForDetail(value: StoredConversationDetail, extraId?: string): Promise<Map<string, string>> {
  const ids = [...new Set([extraId, value.active_company_id, ...value.turns.map((turn) => turn.company_id)]
    .filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  await Promise.all(ids.map(async (id) => {
    try { names.set(id, (await getCompanyById(id)).company_name); }
    catch { /* Public lookup failure must not block owned history or invent a name. */ }
  }));
  return names;
}
