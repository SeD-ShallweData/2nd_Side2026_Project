import "server-only";

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

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

/** 배포 전 점검용. 필요한 프롬프트가 모두 읽히는지 확인합니다. */
export const REQUIRED_PROMPTS = ["chat/system", "inspector/system", "rewrite/system"] as const;
