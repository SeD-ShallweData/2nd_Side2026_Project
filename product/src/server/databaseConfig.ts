import { readFileSync } from "node:fs";
import { parseEnvText } from "@/server/envText";

const PLACEHOLDER_PATTERN = /READ_ONLY_USER|CHANGE_ME/i;

function validDirectUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || PLACEHOLDER_PATTERN.test(trimmed)) return undefined;
  return /^postgres(?:ql)?:\/\//i.test(trimmed) ? trimmed : undefined;
}

function readDatabaseValues(): Record<string, string> {
  const path = process.env.DATABASE_ENV_FILE?.trim();
  if (!path) return {};
  try {
    return parseEnvText(readFileSync(/* turbopackIgnore: true */ path, "utf8"));
  } catch {
    return {};
  }
}

function buildRoleUrl(
  values: Record<string, string>,
  user: string | undefined,
  password: string | undefined,
): string | undefined {
  const database = values.DB_NAME?.trim();
  const host = values.DB_HOST?.trim() || "127.0.0.1";
  const port = Number(values.DB_PORT ?? 5432);
  const trimmedUser = user?.trim();
  const trimmedPassword = password?.trim();
  if (!trimmedUser || !trimmedPassword || !database) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;

  return `postgresql://${encodeURIComponent(trimmedUser)}:${encodeURIComponent(trimmedPassword)}@${host}:${port}/${encodeURIComponent(database)}`;
}

export function buildBotDatabaseUrl(values: Record<string, string>): string | undefined {
  const direct = validDirectUrl(values.BOT_DATABASE_URL);
  if (direct) return direct;

  return buildRoleUrl(values, values.BOT_USER || values.BOT_NAME, values.BOT_PASSWORD);
}

export function buildAuthDatabaseUrl(values: Record<string, string>): string | undefined {
  return (
    validDirectUrl(values.AUTH_DATABASE_URL) ??
    buildRoleUrl(values, values.AUTH_USER, values.AUTH_PASSWORD)
  );
}

export function buildCommunityDatabaseUrl(values: Record<string, string>): string | undefined {
  return (
    validDirectUrl(values.COMMUNITY_DATABASE_URL) ??
    buildRoleUrl(values, values.COMMUNITY_USER, values.COMMUNITY_PASSWORD)
  );
}

export function getDatabaseConnectionString(): string | undefined {
  return (
    validDirectUrl(process.env.BOT_DATABASE_URL) ??
    validDirectUrl(process.env.DATABASE_URL) ??
    buildBotDatabaseUrl(readDatabaseValues())
  );
}

/*
 * 쓰기 롤은 DATABASE_URL(소유자 계정)로 절대 대체하지 않는다.
 * 대체를 허용하면 wg_auth·wg_community 설정을 빠뜨린 환경에서 앱이 조용히
 * 전체 권한 계정으로 붙어, 나연이 롤을 분리한 이유가 통째로 사라진다.
 * 설정이 없으면 연결하지 않고 실패하는 편이 안전하다.
 */
export function getAuthDatabaseConnectionString(): string | undefined {
  return validDirectUrl(process.env.AUTH_DATABASE_URL) ?? buildAuthDatabaseUrl(readDatabaseValues());
}

export function getCommunityDatabaseConnectionString(): string | undefined {
  return (
    validDirectUrl(process.env.COMMUNITY_DATABASE_URL) ??
    buildCommunityDatabaseUrl(readDatabaseValues())
  );
}
