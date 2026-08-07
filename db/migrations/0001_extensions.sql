-- pgcrypto: firm_id 계산에 sha1 필요 (Postgres 기본엔 sha1 없음)
-- pg_trgm : 552,500행 사업장명 부분일치 검색. B-tree 로는 `LIKE '%X%'` 를 못 탄다.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "firms_name_trgm_idx" ON "firms" USING gin ("name" gin_trgm_ops);
