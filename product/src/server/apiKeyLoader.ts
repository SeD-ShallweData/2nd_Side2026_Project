import "server-only";

import { readFileSync } from "node:fs";
import { parseEnvText } from "@/server/envText";

export { parseEnvText } from "@/server/envText";

const DEFAULT_SHARED_KEY_FILE = "/data/shared-SeD/api_key.env";

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
