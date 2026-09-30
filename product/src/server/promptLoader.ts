import "server-only";

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { isOpsConsoleEnabled } from "@/server/ops/opsMode";
import { queryWrite } from "@/server/postgresWrite";

/**
 * 시스템 프롬프트 로더.
 *
 * 프롬프트를 코드에서 분리해 `prompts/` 아래 파일로 둡니다. 답변 문구를 고칠 때
 * TypeScript를 건드리지 않아도 되고, 프롬프트 변경 이력이 코드 diff에 섞이지
 * 않습니다. 파일 수정 시각(mtime)이 바뀌면 다시 읽으므로 개발 중에는 서버를
 * 재시작하지 않아도 반영됩니다.
 *
 * 컨텍스트 JSON·정책 버전처럼 요청마다 달라지는 값은 파일에 넣지 않고 호출부에서
 * 뒤에 덧붙입니다. 파일에는 사람이 읽고 고칠 지침만 남깁니다.
 *
 * 경로는 `PROMPT_DIR` 로 바꿀 수 있습니다. 지정하지 않으면 프로세스 작업
 * 디렉터리의 `prompts/` 를 씁니다(`npm run dev`·`npm start` 모두 `product/`).
 */

interface CacheEntry {
  mtimeMs: number;
  text: string;
}

const cache = new Map<string, CacheEntry>();

/** 코드에 고정된 네 가지 프롬프트. 운영 콘솔도 이 이름만 받는다. */
export const REQUIRED_PROMPTS = ["chat/system", "inspector/system", "rewrite/system", "translate/system"] as const;
export type PromptName = (typeof REQUIRED_PROMPTS)[number];

export function isPromptName(value: string): value is PromptName {
  return (REQUIRED_PROMPTS as readonly string[]).includes(value);
}

export interface PromptOverride {
  version: number;
  body: string;
  sha256: string;
  activatedAt: string | null;
}

/*
 * 운영 콘솔에서 적용한 DB 버전. 파일보다 우선한다.
 *
 * loadPrompt 는 동기 함수라 DB를 기다리지 않는다. 적용 직후에는 운영 콘솔이
 * refreshPromptOverrides(true) 로 즉시 채우고, 그 뒤로는 loadPrompt 가 부를 때마다
 * 30초가 지났으면 백그라운드로 다시 읽는다(여러 웹 프로세스 사이의 반영).
 * DB를 읽지 못하면 표를 비우지 않고 마지막 값을 유지한다. 한 번도 읽지 못했으면 파일이 쓰인다.
 */
let overrides: ReadonlyMap<PromptName, PromptOverride> = new Map();

export function setPromptOverrides(next: ReadonlyMap<PromptName, PromptOverride>): void {
  overrides = next;
}

export function getPromptOverride(name: string): PromptOverride | undefined {
  return isPromptName(name) ? overrides.get(name) : undefined;
}

const OVERRIDE_REFRESH_INTERVAL_MS = 30_000;
let lastRefreshAt = 0;
let refreshInFlight: Promise<void> | null = null;

export async function refreshPromptOverrides(force = false): Promise<void> {
  if (!isOpsConsoleEnabled()) return;
  if (!force && (refreshInFlight || Date.now() - lastRefreshAt < OVERRIDE_REFRESH_INTERVAL_MS)) {
    return refreshInFlight ?? undefined;
  }
  lastRefreshAt = Date.now();
  const run = (async () => {
    try {
      const rows = await queryWrite<{ name: string; version: number; body: string; body_sha256: string; activated_at: string | null }>(
        "ops",
        "SELECT name, version, body, body_sha256, activated_at::text AS activated_at FROM ops_active_prompts()",
      );
      const next = new Map<PromptName, PromptOverride>();
      for (const row of rows) {
        if (isPromptName(row.name)) {
          next.set(row.name, { version: row.version, body: row.body, sha256: row.body_sha256, activatedAt: row.activated_at });
        }
      }
      setPromptOverrides(next);
    } catch (error) {
      console.warn("[prompt] 적용된 DB 프롬프트를 읽지 못해 이전 값을 유지합니다:", (error as Error)?.message);
    }
  })();
  refreshInFlight = run;
  try {
    await run;
  } finally {
    if (refreshInFlight === run) refreshInFlight = null;
  }
}

function promptRoot(): string {
  const configured = process.env.PROMPT_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), "prompts");
}

/** 경로 조작을 막는다. 프롬프트 이름은 코드에 고정된 값만 쓴다. */
function assertSafeName(name: string): void {
  if (!/^[a-z0-9]+(?:\/[a-z0-9-]+)*$/.test(name)) {
    throw new Error(`허용되지 않는 프롬프트 이름입니다: ${name}`);
  }
}

/**
 * 프롬프트 파일을 읽어 돌려줍니다.
 *
 * 시스템 프롬프트에는 가드레일 지침이 들어 있어, 이것 없이 모델을 호출하면
 * 정책이 적용되지 않은 답변이 나갑니다. 그래서 파일이 없거나 비어 있으면
 * 조용히 넘어가지 않고 즉시 실패시킵니다.
 */
export function loadPrompt(name: string): string {
  assertSafeName(name);
  void refreshPromptOverrides();
  const override = getPromptOverride(name);
  if (override) return override.body;
  return loadPromptFile(name);
}

/** 파일 기본값만 읽는다. 운영 콘솔이 "파일과 다름"을 보여줄 때 쓴다. */
export function loadPromptFile(name: string): string {
  assertSafeName(name);
  const file = path.join(promptRoot(), `${name}.md`);

  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    throw new Error(`프롬프트 파일을 찾을 수 없습니다: ${file}`);
  }

  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.text;

  const text = readFileSync(file, "utf8").trimEnd();
  if (!text) {
    throw new Error(`프롬프트 파일이 비어 있습니다: ${file}`);
  }

  cache.set(file, { mtimeMs, text });
  return text;
}

/** 파일에서 읽은 지침 뒤에 요청마다 달라지는 값을 덧붙입니다. */
export function withRuntimeContext(prompt: string, lines: string[]): string {
  return [prompt, ...lines.filter((line) => line.length > 0)].join("\n");
}
