import "server-only";

import { readFileSync } from "node:fs";

const DEFAULT_SHARED_KEY_FILE = "/data/shared-SeD/api_key.env";

export function parseEnvText(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value) values[key] = value;
  }
  return values;
}

function readSharedValues(): Record<string, string> {
  const path = process.env.SHARED_API_KEY_FILE || DEFAULT_SHARED_KEY_FILE;
  try {
    return parseEnvText(readFileSync(/* turbopackIgnore: true */ path, "utf8"));
  } catch {
    return {};
  }
}

export function getServerSecret(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  const shared = readSharedValues();
  for (const name of names) {
    if (shared[name]) return shared[name];
  }
  return undefined;
}
