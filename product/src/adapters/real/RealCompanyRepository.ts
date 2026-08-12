import type { Company, CompanyMatchType, CompanyRepository, CompanySearchResult } from "@/domain/company";
import { LATEST_BATCH_ORDER_SQL } from "@/server/latestBatchSql";
import { queryReadOnly } from "@/server/postgres";

interface FirmRow {
  firm_id: string;
  name: string;
  sido: string | null;
  industry: string | null;
  as_of_date?: string | null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function matchType(name: string, query: string): CompanyMatchType {
  return name.localeCompare(query, "ko", { sensitivity: "base" }) === 0 ? "exact" : "partial";
}

function toCompany(row: FirmRow): Company {
  return {
    company_id: row.firm_id,
    company_name: row.name,
    address: null,
    region: row.sido,
    industry: row.industry,
    size_label: null,
    aliases: [],
    data_as_of: row.as_of_date ?? null,
  };
}

export class RealCompanyRepository implements CompanyRepository {
  async search(query: string, limit = 10, offset = 0): Promise<CompanySearchResult[]> {
    const rows = await queryReadOnly<FirmRow>(
      `SELECT f.firm_id, f.name, f.sido, f.industry
         FROM public.firms AS f
        WHERE f.name ILIKE $1 ESCAPE '\\'
        ORDER BY CASE WHEN lower(f.name) = lower($2) THEN 0 ELSE 1 END,
                 f.name,
                 f.firm_id
        LIMIT $3
       OFFSET $4`,
      [`%${escapeLike(query)}%`, query, limit, offset],
    );

    return rows.map((row) => ({
      company_id: row.firm_id,
      company_name: row.name,
      address: null,
      region: row.sido,
      industry: row.industry,
      size_label: null,
      matched_name: row.name,
      match_type: matchType(row.name, query),
    }));
  }

  async count(query: string): Promise<number> {
    const rows = await queryReadOnly<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM public.firms AS f
        WHERE f.name ILIKE $1 ESCAPE '\\'`,
      [`%${escapeLike(query)}%`],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async getById(companyId: string): Promise<Company | null> {
    const rows = await queryReadOnly<FirmRow>(
      `WITH latest_batch AS (
         SELECT as_of_date
           FROM public.batches
          ${LATEST_BATCH_ORDER_SQL}
       )
       SELECT f.firm_id,
              f.name,
              f.sido,
              f.industry,
              latest_batch.as_of_date::text AS as_of_date
         FROM public.firms AS f
         LEFT JOIN latest_batch ON true
        WHERE f.firm_id = $1
        LIMIT 1`,
      [companyId],
    );
    return rows[0] ? toCompany(rows[0]) : null;
  }
}
