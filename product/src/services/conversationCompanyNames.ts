import "server-only";
import type { StoredConversationDetail } from "@/domain/conversation";
import { getCompanyById } from "@/services/companyService";
import type { RecallCompany } from "@/services/conversationCompanyScope";

/** Public names only, for IDs already in this owned conversation/current selection. */
export async function companyNamesForDetail(value: StoredConversationDetail, extraId?: string): Promise<Map<string, string>> {
  return new Map((await companyContextsForDetail(value, extraId))
    .map((company) => [company.company_id, company.company_name]));
}

/** Owner-scoped IDs only; public location resolves identical display names. */
export async function companyContextsForDetail(value: StoredConversationDetail, extraId?: string): Promise<RecallCompany[]> {
  const ids = [...new Set([extraId, value.active_company_id, ...value.turns.map((turn) => turn.company_id)]
    .filter((id): id is string => Boolean(id)))];
  const companies: RecallCompany[] = [];
  await Promise.all(ids.map(async (id) => {
    try {
      const company = await getCompanyById(id);
      companies.push({ company_id: id, company_name: company.company_name,
        region: company.region ?? undefined, address: company.address ?? undefined });
    }
    catch { /* Public lookup failure must not block owned history or invent a name. */ }
  }));
  return ids.flatMap((id) => companies.filter((company) => company.company_id === id));
}
