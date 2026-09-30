import type {
  Company,
  CompanyFilterOptions,
  CompanyMatchType,
  CompanyRepository,
  CompanySearchFilters,
  CompanySearchResult,
} from "@/domain/company";
import { LATEST_BATCH_ORDER_SQL } from "@/server/latestBatchSql";
import { queryReadOnly } from "@/server/postgres";
import { toPublicIndustry } from "@/services/publicCompanyFields";
import { canonicalRegion, regionDatabaseValues } from "@/domain/region";

// Read-time compatibility while an older DB or source batch still uses a former name.
const CANONICAL_SIDO_SQL = `CASE f.sido
  WHEN '광주광역시' THEN '전남광주통합특별시'
  WHEN '전라남도' THEN '전남광주통합특별시'
  WHEN '광주특별시' THEN '전남광주통합특별시'
  WHEN '강원도' THEN '강원특별자치도'
  WHEN '전라북도' THEN '전북특별자치도'
  WHEN '제주도' THEN '제주특별자치도'
  WHEN '세종시' THEN '세종특별자치시'
  ELSE f.sido END`;

interface FirmRow {
  firm_id: string;
  name: string;
  sido: string | null;
  industry: string | null;
  as_of_date?: string | null;
}

interface FilterOptionRow {
  value: string;
  count: string;
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
    region: row.sido ? canonicalRegion(row.sido) : null,
    industry: toPublicIndustry(row.industry),
    size_label: null,
    aliases: [],
    data_as_of: row.as_of_date ?? null,
  };
}

export class RealCompanyRepository implements CompanyRepository {
  async search(
    query: string,
    limit = 10,
    offset = 0,
    filters: CompanySearchFilters = {},
  ): Promise<CompanySearchResult[]> {
    const rows = await queryReadOnly<FirmRow>(
      `SELECT f.firm_id, f.name, f.sido, f.industry
         FROM public.firms AS f
        WHERE f.name ILIKE $1 ESCAPE '\\'
          AND ($5::text[] IS NULL OR f.sido = ANY($5::text[]))
          AND ($6::text IS NULL OR f.industry = $6)
        ORDER BY CASE WHEN lower(f.name) = lower($2) THEN 0 ELSE 1 END,
                 f.name,
                 f.firm_id
        LIMIT $3
       OFFSET $4`,
      [`%${escapeLike(query)}%`, query, limit, offset,
        filters.region ? regionDatabaseValues(filters.region) : null, filters.industry ?? null],
    );

    return rows.map((row) => ({
      company_id: row.firm_id,
      company_name: row.name,
      address: null,
      region: row.sido ? canonicalRegion(row.sido) : null,
      industry: toPublicIndustry(row.industry),
      size_label: null,
      matched_name: row.name,
      match_type: matchType(row.name, query),
    }));
  }

  async count(query: string, filters: CompanySearchFilters = {}): Promise<number> {
    const rows = await queryReadOnly<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM public.firms AS f
        WHERE f.name ILIKE $1 ESCAPE '\\'
          AND ($2::text[] IS NULL OR f.sido = ANY($2::text[]))
          AND ($3::text IS NULL OR f.industry = $3)`,
      [`%${escapeLike(query)}%`, filters.region ? regionDatabaseValues(filters.region) : null, filters.industry ?? null],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async listFilterOptions(): Promise<Omit<CompanyFilterOptions, "total">> {
    const [regionRows, industryRows] = await Promise.all([
      queryReadOnly<FilterOptionRow>(
        `SELECT ${CANONICAL_SIDO_SQL} AS value, count(*)::text AS count
           FROM public.firms AS f
          WHERE f.sido IS NOT NULL AND btrim(f.sido) <> ''
          GROUP BY ${CANONICAL_SIDO_SQL}
          ORDER BY value`,
      ),
      queryReadOnly<FilterOptionRow>(
        `SELECT f.industry AS value, count(*)::text AS count
           FROM public.firms AS f
          WHERE f.industry IS NOT NULL AND btrim(f.industry) <> ''
            AND f.industry NOT IN ('BIZ_NO미존재사업장', '해당없음')
          GROUP BY f.industry
          ORDER BY count(*) DESC, f.industry`,
      ),
    ]);

    const toOptions = (rows: FilterOptionRow[]) => rows.map((row) => ({
      value: row.value,
      count: Number(row.count),
    }));
    return { regions: toOptions(regionRows), industries: toOptions(industryRows) };
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
