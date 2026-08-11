import { readFileSync } from "node:fs";
import { parseEnvText } from "@/server/envText";

const DEFAULT_DATABASE_ENV_FILE = "/data/shared-SeD/.env.local";
const PLACEHOLDER_PATTERN = /READ_ONLY_USER|CHANGE_ME/i;

function validDirectUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || PLACEHOLDER_PATTERN.test(trimmed)) return undefined;
  return /^postgres(?:ql)?:\/\//i.test(trimmed) ? trimmed : undefined;
}

function readDatabaseValues(): Record<string, string> {
  const path = process.env.DATABASE_ENV_FILE?.trim() || DEFAULT_DATABASE_ENV_FILE;
  try {
    return parseEnvText(readFileSync(/* turbopackIgnore: true */ path, "utf8"));
  } catch {
    return {};
  }
}

export function buildBotDatabaseUrl(values: Record<string, string>): string | undefined {
  const direct = validDirectUrl(values.BOT_DATABASE_URL);
  if (direct) return direct;

  const user = values.BOT_NAME?.trim();
  const password = values.BOT_PASSWORD?.trim();
  const database = values.DB_NAME?.trim();
  const host = values.DB_HOST?.trim() || "127.0.0.1";
  const port = Number(values.DB_PORT ?? 5432);
  if (!user || !password || !database || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

export function getDatabaseConnectionString(): string | undefined {
  return (
    validDirectUrl(process.env.DATABASE_URL) ??
    validDirectUrl(process.env.BOT_DATABASE_URL) ??
    buildBotDatabaseUrl(readDatabaseValues())
  );
}
