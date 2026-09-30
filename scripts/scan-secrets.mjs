#!/usr/bin/env node
/*
 * 저장소 비밀값 검사기. 외부 의존성 없이 Node 22 표준 라이브러리만 쓴다.
 *
 *   node scripts/scan-secrets.mjs --all
 *       git 이 추적하는 파일 전체(작업 트리 내용)를 검사한다.
 *   node scripts/scan-secrets.mjs --diff <base> [--head <rev>]
 *       <base>..<head>(기본 HEAD) 커밋들이 새로 넣은 줄만 검사한다. 커밋마다 따로 보므로
 *       한 커밋에서 넣고 다음 커밋에서 지운 값도 잡는다. push 하면 이력에 그대로 남기 때문이다.
 *   node scripts/scan-secrets.mjs --dir <경로> [--dir <경로> ...] [--ext js,css] [--canary <값> ...]
 *       디렉터리(빌드 산출물 등)를 검사한다. --canary 로 준 값이 그대로 보이면 실패한다.
 *
 * 출력에는 경로:줄, 규칙, 값의 앞부분(최대 4자)과 길이만 찍는다. 값 전체는 어디에도 남기지 않는다.
 * 종료 코드: 0 발견 없음, 1 발견, 2 사용법·git 오류.
 *
 * 오탐이면 값을 <설명> 같은 자리표시로 바꾼다. 그럴 수 없으면 같은 줄에 "scan-secrets: allow" 를
 * 적고 PR 에 이유를 남긴다.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOW_MARKER = "scan-secrets: allow";
const MIN_NAMED_VALUE_LENGTH = 8;

// 형식만으로 알아볼 수 있는 키. 테스트 파일이라도 예외를 두지 않는다.
// 왼쪽 경계가 없으면 'risk-', 'task-' 같은 낱말 속 sk- 에도 걸린다.
const TOKEN_RULES = [
  { id: "upstage-api-key", regex: /(?<![A-Za-z0-9_])up_[A-Za-z0-9]{20,}/g, needsDigit: true },
  { id: "sk-api-key", regex: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g, needsDigit: true },
  { id: "google-api-key", regex: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g },
  { id: "github-token", regex: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: "github-fine-grained-token", regex: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}/g },
  { id: "slack-token", regex: /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    id: "discord-webhook",
    regex: /https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,}\/[A-Za-z0-9_-]{20,}/g,
  },
  { id: "private-key", regex: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
];

// 아래 규칙은 이름·URL 문맥으로 비밀값을 짐작한다. 테스트 고정값이 많아 테스트 경로에서는 보지 않는다.
const URL_PASSWORD = /\b(?:postgres(?:ql)?|rediss?):\/\/([^\s:@/'"`]*):([^\s@/'"`]+)@/g;
const SECRET_NAME = String.raw`(?<![A-Za-z0-9_])([A-Za-z0-9_]*(?:API_KEY|_TOKEN|_PASSWORD|_SECRET))(?![A-Za-z0-9_])`;
const QUOTED_VALUE = String.raw`"([^"\n]*)"|'([^'\n]*)'|\x60([^\x60\n]*)\x60`;
// NAME=값 (env 파일, 셸, 코드). 코드 파일에서는 따옴표로 감싼 값만 본다.
const NAME_ASSIGNMENT = new RegExp(
  String.raw`${SECRET_NAME}\s*=(?![=>~])\s*(?:${QUOTED_VALUE}|([^\s"'\x60;,)\]}]+))`,
  "g",
);
// "NAME": "값", NAME: '값' (JSON, YAML, 코드 객체)
const NAME_QUOTED_PAIR = new RegExp(String.raw`${SECRET_NAME}["']?\s*:\s*(?:${QUOTED_VALUE})`, "g");
// YAML 의 NAME: 값 (따옴표 없음). 줄 전체가 한 항목일 때만 본다.
const YAML_NAME_PAIR = new RegExp(String.raw`^\s*(?:-\s+)?${SECRET_NAME}\s*:\s+([^\s"'#][^\s#]*)\s*(?:#.*)?$`);

// 자리표시·참조로 보는 값.
const PLACEHOLDER_START = /^[<{[(%$\\*?:]/;
const PLACEHOLDER_TEXT =
  /x{4,}|\*{3,}|\.{3,}|replace[_-]?with|change[_-]?me|placeholder|your[_-]|example|dummy|synthetic|redacted|ci-canary/i;
const CONSTANT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
// 괄호가 있으면 함수 호출 같은 식으로 본다(문서 속 코드 예시).
const REFERENCE = /process\.env|os\.environ|\(/;
const DUMMY_VALUES = new Set(["password", "passwd", "pass", "secret", "postgres", "root", "test", "admin", "user"]);

const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".py"]);
const YAML_EXTENSIONS = new Set([".yml", ".yaml"]);
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|fixtures?)\/|(?:^|\/)test_[^/]*\.py$|_test\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$/;

function isPlaceholder(value) {
  if (value.length === 0) return true;
  // 한글 안내문(<비밀번호>), 말줄임표(…) 같은 비ASCII 는 실제 키가 아니다.
  if (/[^\x20-\x7e]/.test(value)) return true;
  return (
    PLACEHOLDER_START.test(value) ||
    PLACEHOLDER_TEXT.test(value) ||
    CONSTANT_NAME.test(value) ||
    REFERENCE.test(value) ||
    DUMMY_VALUES.has(value.toLowerCase())
  );
}

function mask(value) {
  const shown = value.slice(0, Math.min(4, Math.floor(value.length / 4)));
  return `${shown}…(${value.length}자)`;
}

function fileContext(path) {
  const normalized = path.split(sep).join("/");
  const extension = extname(normalized).toLowerCase();
  return {
    path: normalized,
    isTest: TEST_PATH.test(normalized),
    isCode: CODE_EXTENSIONS.has(extension),
    isYaml: YAML_EXTENSIONS.has(extension),
  };
}

function scanLine(line, context, canaries, report) {
  // canary 는 빌드 산출물에만 쓰고, 예외 표시와 상관없이 항상 본다.
  for (const canary of canaries) {
    if (line.includes(canary)) report("canary", canary);
  }
  if (line.includes(ALLOW_MARKER)) return;
  for (const rule of TOKEN_RULES) {
    for (const match of line.matchAll(rule.regex)) {
      const value = match[0];
      if (rule.needsDigit && !/\d/.test(value)) continue;
      if (PLACEHOLDER_TEXT.test(value)) continue;
      report(rule.id, value);
    }
  }
  if (context.isTest) return;

  for (const match of line.matchAll(URL_PASSWORD)) {
    const [, user, password] = match;
    // postgres:postgres 처럼 계정명과 같은 비밀번호는 CI 임시 DB 다.
    if (password !== user && !isPlaceholder(password)) report("url-password", password);
  }
  const reportNamed = (name, raw) => {
    const value = raw.trim();
    if (value.length >= MIN_NAMED_VALUE_LENGTH && !isPlaceholder(value)) report(`secret-assignment ${name}`, value);
  };
  for (const match of line.matchAll(NAME_ASSIGNMENT)) {
    const quoted = match[2] ?? match[3] ?? match[4];
    // 코드에서 따옴표 없는 오른쪽은 변수·식이다.
    const value = quoted ?? (context.isCode ? undefined : match[5]);
    if (value !== undefined) reportNamed(match[1], value);
  }
  for (const match of line.matchAll(NAME_QUOTED_PAIR)) {
    reportNamed(match[1], match[2] ?? match[3] ?? match[4]);
  }
  if (context.isYaml) {
    const match = YAML_NAME_PAIR.exec(line);
    if (match) reportNamed(match[1], match[2]);
  }
}

function createCollector() {
  const findings = [];
  const seen = new Set();
  return {
    findings,
    scanLines(context, lines, canaries, origin) {
      for (const { number, text } of lines) {
        scanLine(text.replace(/\r$/, ""), context, canaries, (rule, value) => {
          // 같은 파일의 같은 값은 규칙·커밋·줄이 달라도 처음 한 번만 알린다(형식 규칙이 먼저 걸린다).
          const key = `${context.path}\u0000${value}`;
          if (seen.has(key)) return;
          seen.add(key);
          findings.push({ path: context.path, line: number, rule, masked: mask(value), origin });
        });
      }
    },
  };
}

function numberedLines(text) {
  return text.split("\n").map((line, index) => ({ number: index + 1, text: line }));
}

function readTextFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile()) return {}; // 심볼릭 링크·디렉터리
  if (stat.size > MAX_FILE_BYTES) return { skipped: `${MAX_FILE_BYTES / 1024 / 1024}MB 초과` };
  const buffer = readFileSync(path);
  // 앞 8KB 에 NUL 이 있으면 이미지·DB 같은 바이너리로 본다.
  if (buffer.subarray(0, 8192).includes(0)) return { binary: true };
  return { text: buffer.toString("utf8") };
}

function git(args, cwd) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function scanTracked(root, collector) {
  const paths = git(["ls-files", "-z"], root).split("\u0000").filter(Boolean);
  let scanned = 0;
  for (const path of paths) {
    let file;
    try {
      file = readTextFile(join(root, path));
    } catch {
      continue; // 작업 트리에서 지운 파일
    }
    if (file.skipped) console.warn(`[scan-secrets] 건너뜀 ${path}: ${file.skipped}`);
    if (file.text === undefined) continue;
    scanned += 1;
    collector.scanLines(fileContext(path), numberedLines(file.text), [], undefined);
  }
  return `추적 파일 ${scanned}개`;
}

// "+++ b/경로" 의 경로. 공백이 있으면 git 이 끝에 탭을 붙이고, 특수 문자가 있으면 따옴표로 감싼다.
function diffPath(raw) {
  let path = raw.replace(/\t$/, "");
  if (path.startsWith('"')) {
    try {
      path = JSON.parse(path);
    } catch {
      path = path.slice(1, -1);
    }
  }
  return path.startsWith("b/") ? path.slice(2) : path;
}

// git diff -U0 출력에서 파일별로 새로 들어온 줄만 모은다.
function* addedLines(patch) {
  let path;
  let nextLine = 0;
  let inHunk = false;
  let origin;
  for (const line of patch.split("\n")) {
    if (line.startsWith("\u0000")) {
      origin = line.slice(1, 9);
      inHunk = false;
      continue;
    }
    if (inHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\"))) {
      if (line.startsWith("+") && path !== undefined) yield { path, origin, number: nextLine, text: line.slice(1) };
      if (line.startsWith("+") || line.startsWith(" ")) nextLine += 1;
      continue;
    }
    inHunk = false;
    if (line.startsWith("diff --git ")) path = undefined;
    else if (line.startsWith("+++ ")) path = line === "+++ /dev/null" ? undefined : diffPath(line.slice(4));
    else if (line.startsWith("@@")) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      nextLine = header ? Number(header[1]) : 0;
      inHunk = true;
    }
  }
}

function scanPatch(patch, collector) {
  const groups = new Map();
  for (const added of addedLines(patch)) {
    const key = `${added.origin ?? ""}\u0000${added.path}`;
    if (!groups.has(key)) groups.set(key, { path: added.path, origin: added.origin, lines: [] });
    groups.get(key).lines.push({ number: added.number, text: added.text });
  }
  for (const group of groups.values()) {
    collector.scanLines(fileContext(group.path), group.lines, [], group.origin);
  }
}

function scanDiff(root, base, head, collector) {
  const baseCommit = git(["rev-parse", "--verify", `${base}^{commit}`], root).trim();
  const headCommit = git(["rev-parse", "--verify", `${head}^{commit}`], root).trim();
  // 사용자 git 설정(diff.noprefix 등)과 상관없이 경로가 b/ 로 시작하게 고정한다.
  const diffOptions = ["-p", "--unified=0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
  // 커밋마다 따로 본다. 병합 커밋은 아래의 전체 변경분 검사가 맡는다.
  scanPatch(git(["log", "--no-merges", "--format=%x00%H", ...diffOptions, `${baseCommit}..${headCommit}`], root), collector);
  scanPatch(git(["diff", ...diffOptions, `${baseCommit}...${headCommit}`], root), collector);
  const commits = git(["rev-list", "--count", `${baseCommit}..${headCommit}`], root).trim();
  return `${base}..${head} 커밋 ${commits}개`;
}

function listDirectory(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listDirectory(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function scanDirectories(dirs, extensions, canaries, collector) {
  let scanned = 0;
  for (const dir of dirs) {
    for (const file of listDirectory(resolve(dir))) {
      if (extensions && !extensions.has(extname(file).slice(1).toLowerCase())) continue;
      const result = readTextFile(file);
      if (result.skipped) console.warn(`[scan-secrets] 건너뜀 ${relative(process.cwd(), file)}: ${result.skipped}`);
      if (result.text === undefined) continue;
      scanned += 1;
      collector.scanLines(fileContext(relative(process.cwd(), file)), numberedLines(result.text), canaries, undefined);
    }
  }
  return `디렉터리 ${dirs.join(", ")}의 파일 ${scanned}개`;
}

function usage(message) {
  if (message) console.error(`[scan-secrets] ${message}`);
  console.error(
    [
      "사용법:",
      "  node scripts/scan-secrets.mjs --all",
      "  node scripts/scan-secrets.mjs --diff <base> [--head <rev>]",
      "  node scripts/scan-secrets.mjs --dir <경로> [--dir <경로> ...] [--ext js,css] [--canary <값> ...]",
    ].join("\n"),
  );
  return 2;
}

function parseArgs(argv) {
  const options = { all: false, diff: undefined, head: "HEAD", dirs: [], ext: undefined, canaries: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} 뒤에 값이 필요합니다.`);
      return argv[index];
    };
    if (arg === "--all") options.all = true;
    else if (arg === "--diff") options.diff = next();
    else if (arg === "--head") options.head = next();
    else if (arg === "--dir") options.dirs.push(next());
    else if (arg === "--ext") options.ext = new Set(next().split(",").map((value) => value.trim().replace(/^\./, "")).filter(Boolean));
    else if (arg === "--canary") options.canaries.push(next());
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return usage(error.message);
  }
  const modes = [options.all, options.diff !== undefined, options.dirs.length > 0].filter(Boolean).length;
  if (modes !== 1) return usage("--all, --diff, --dir 중 하나만 고릅니다.");
  // 비어 있거나 짧은 canary 는 아무 데나 걸리거나, env 가 빠져 아무것도 안 보는 채로 통과한다.
  if (options.canaries.some((canary) => canary.trim().length < 8)) {
    return usage("--canary 값이 비었거나 8자보다 짧습니다. CI 의 canary env 가 설정됐는지 확인합니다.");
  }
  if (options.canaries.length > 0 && options.dirs.length === 0) return usage("--canary 는 --dir 와 함께 씁니다.");

  const collector = createCollector();
  let scope;
  try {
    if (options.dirs.length > 0) {
      scope = scanDirectories(options.dirs, options.ext, options.canaries, collector);
    } else {
      const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
      scope = options.all ? scanTracked(root, collector) : scanDiff(root, options.diff, options.head, collector);
    }
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    console.error(`[scan-secrets] 검사를 끝내지 못했습니다: ${detail}`);
    return 2;
  }

  if (collector.findings.length === 0) {
    console.log(`[scan-secrets] 비밀값으로 보이는 값 없음 (${scope})`);
    return 0;
  }
  for (const finding of collector.findings) {
    const origin = finding.origin ? ` (커밋 ${finding.origin})` : "";
    console.error(`[scan-secrets] ${finding.path}:${finding.line}${origin}  ${finding.rule}  ${finding.masked}`);
  }
  console.error(
    [
      `[scan-secrets] 비밀값으로 보이는 값 ${collector.findings.length}건 (${scope}). 값은 앞부분과 길이만 표시했습니다.`,
      "  실제 키라면 커밋에서 지우는 것으로는 부족합니다. 공개 저장소에 push 됐다면 먼저 키를 폐기하고 재발급합니다.",
      `  오탐이면 값을 <설명> 같은 자리표시로 바꾸거나, 같은 줄에 "${ALLOW_MARKER}" 를 적고 PR 에 이유를 남깁니다.`,
    ].join("\n"),
  );
  return 1;
}

process.exitCode = main(process.argv.slice(2));
