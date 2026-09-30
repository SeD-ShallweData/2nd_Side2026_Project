import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
 * 클라이언트·서버 비밀값 경계를 소스만 읽어 확인한다.
 *
 * Next 16 이 환경 변수 값을 브라우저 번들에 넣는 길은 세 가지다. NEXT_PUBLIC_ 변수,
 * next.config 의 env, next.config 의 compiler.define(node_modules/next/dist/build/define-env.js).
 * 여기에 'use client' 파일이 서버 모듈을 불러와 키를 읽는 코드가 클라이언트 그래프에 들어가는
 * 길을 더해 네 가지를 막는다. 비밀값을 읽는 서버 모듈에 import "server-only" 가 있는지도 본다.
 * 그래야 클라이언트에서 불러오는 순간 next build 가 실패한다.
 *
 * 주석과 문자열에 걸리지 않도록 텍스트 검색 대신 TypeScript 구문 트리를 읽는다.
 * 빌드 산출물 검사는 CI(product-ci.yml)의 scan-secrets 단계가 맡는다.
 */

const PRODUCT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = join(PRODUCT_ROOT, "src");
const CODE_EXTENSIONS = new Set([".ts", ".tsx"]);
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const NODE_BUILTINS = new Set(builtinModules);

// process.env 이름이 이 모양이면 비밀값으로 본다.
const SECRET_ENV_NAME = /(?:API_KEY|_TOKEN|_PASSWORD|_SECRET|DATABASE_URL|_PG_URL|REDIS_URL)$/;

// route.ts 와 proxy.ts 는 Next 가 클라이언트 번들에 넣지 않는다. demoBasicAuth.ts 는 proxy 가 쓰는
// 모듈이라 표시를 달지 않았다(proxy 빌드에서 확인한 뒤에 달 것).
const SERVER_ONLY_EXEMPT = [/^src\/app\/(?:.*\/)?route\.ts$/, /^src\/proxy\.ts$/, /^src\/server\/demoBasicAuth\.ts$/];

// 비밀값을 읽거나 실어 보내는 모듈. 추정 규칙이 못 잡는 모듈(생성자로 토큰을 받는 어댑터 등)도
// 표시가 빠지면 바로 드러나도록 이름으로 고정한다.
const MARKED_SERVER_MODULES = [
  "src/server/apiKeyLoader.ts",
  "src/server/llmConfig.ts",
  "src/server/databaseConfig.ts",
  "src/server/postgres.ts",
  "src/server/postgresWrite.ts",
  "src/services/ragService.ts",
  "src/adapters/real/HttpRagRetriever.ts",
  "src/adapters/real/RealContractReviewProvider.ts",
  "src/adapters/real/OpenAICompatibleChatClient.ts",
];

interface ModuleFacts {
  // 컴파일 뒤에도 남는 import·export from·동적 import·require 지정자. 타입 전용은 뺀다.
  imports: string[];
  // process.env.X 의 X. 동적 접근이나 process.env 통째 사용은 대괄호로 적는다.
  envNames: string[];
  hasServerOnlyImport: boolean;
  callsGetServerSecret: boolean;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function rel(path: string): string {
  return toPosix(relative(PRODUCT_ROOT, path));
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const ALL_SRC_FILES = listFiles(SRC_ROOT);
const CODE_FILES = ALL_SRC_FILES.filter((file) => CODE_EXTENSIONS.has(extname(file)));

function isTestOnlyFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file) || rel(file).startsWith("src/test/");
}

function parseSource(fileName: string, text: string): ts.SourceFile {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

const parsedFiles = new Map<string, ts.SourceFile>();

function parseFile(file: string): ts.SourceFile {
  let sourceFile = parsedFiles.get(file);
  if (!sourceFile) {
    sourceFile = parseSource(file, readFileSync(file, "utf8"));
    parsedFiles.set(file, sourceFile);
  }
  return sourceFile;
}

function isClientModule(sourceFile: ts.SourceFile): boolean {
  // 지시문은 파일 맨 앞 문자열 문장들(directive prologue) 안에만 올 수 있다.
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

function allTypeOnly(elements: ts.NodeArray<ts.ImportSpecifier> | ts.NodeArray<ts.ExportSpecifier>): boolean {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

function envAccessName(node: ts.Node): string | undefined {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "env") return undefined;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "process") return undefined;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return parent.name.text;
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    return ts.isStringLiteralLike(parent.argumentExpression) ? parent.argumentExpression.text : "[동적 접근]";
  }
  return "[process.env 전체]";
}

function collectFacts(sourceFile: ts.SourceFile): ModuleFacts {
  const facts: ModuleFacts = { imports: [], envNames: [], hasServerOnlyImport: false, callsGetServerSecret: false };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            allTypeOnly(clause.namedBindings.elements)));
      if (!typeOnly) facts.imports.push(node.moduleSpecifier.text);
      if (clause === undefined && node.moduleSpecifier.text === "server-only") facts.hasServerOnlyImport = true;
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && allTypeOnly(node.exportClause.elements));
      if (!typeOnly) facts.imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [firstArgument] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && firstArgument && ts.isStringLiteralLike(firstArgument)) {
        facts.imports.push(firstArgument.text);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "getServerSecret") facts.callsGetServerSecret = true;
    } else {
      const envName = envAccessName(node);
      if (envName !== undefined) facts.envNames.push(envName);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return facts;
}

// 로컬 경로면 파일 경로, 패키지면 undefined, 로컬인데 파일이 없으면 null.
function resolveLocalImport(fromFile: string, specifier: string): string | null | undefined {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC_ROOT, specifier.slice(2));
  else if (specifier.startsWith("./") || specifier.startsWith("../")) base = resolve(dirname(fromFile), specifier);
  else return undefined;
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function forbiddenPackage(specifier: string): string | undefined {
  if (specifier === "server-only") return "server-only 모듈";
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0])) return "Node 내장 모듈";
  if (specifier === "pg" || specifier.startsWith("pg/") || specifier.startsWith("pg-")) return "PostgreSQL 드라이버";
  if (specifier === "redis" || specifier.startsWith("redis/") || specifier.startsWith("@redis/")) return "Redis 클라이언트";
  return undefined;
}

function isServerPath(file: string): boolean {
  const path = rel(file);
  return path.startsWith("src/server/") || path.startsWith("src/adapters/real/");
}

interface ClientGraph {
  clientFiles: string[];
  closure: Set<string>;
  problems: string[];
}

let clientGraph: ClientGraph | undefined;

function analyzeClientGraph(): ClientGraph {
  if (clientGraph) return clientGraph;
  const clientFiles = CODE_FILES.filter((file) => !isTestOnlyFile(file) && isClientModule(parseFile(file)));
  const closure = new Set<string>();
  const problems: string[] = [];
  const queue = [...clientFiles];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (closure.has(file)) continue;
    closure.add(file);
    const facts = collectFacts(parseFile(file));
    for (const specifier of facts.imports) {
      const target = resolveLocalImport(file, specifier);
      if (target === undefined) {
        const reason = forbiddenPackage(specifier);
        if (reason) problems.push(`${rel(file)}: ${reason} import "${specifier}"`);
        continue;
      }
      if (target === null) {
        problems.push(`${rel(file)}: 해석하지 못한 import "${specifier}"`);
        continue;
      }
      if (isServerPath(target)) problems.push(`${rel(file)}: 서버 모듈 import "${specifier}"`);
      if (CODE_EXTENSIONS.has(extname(target))) queue.push(target);
    }
    for (const name of facts.envNames) {
      // NODE_ENV 는 Next 가 빌드 때 "production" 같은 상수로 바꾼다. 나머지는 브라우저에서 읽을 수 없다.
      if (name !== "NODE_ENV") problems.push(`${rel(file)}: process.env 사용 (${name})`);
    }
  }
  clientGraph = { clientFiles, closure, problems };
  return clientGraph;
}

function secretReasons(facts: ModuleFacts): string[] {
  const reasons = facts.envNames
    .filter((name) => name.startsWith("[") || SECRET_ENV_NAME.test(name))
    .map((name) => `process.env ${name}`);
  if (facts.callsGetServerSecret) reasons.push("getServerSecret()");
  for (const specifier of facts.imports) {
    const reason = forbiddenPackage(specifier);
    if (reason === "PostgreSQL 드라이버" || reason === "Redis 클라이언트") reasons.push(`import "${specifier}"`);
  }
  return reasons;
}

describe("클라이언트·서버 비밀값 경계", () => {
  it("검사기 자체: 타입 전용 import 는 건너뛰고 값 import·동적 import·process.env 는 잡는다", () => {
    const probe = parseSource(
      "probe.tsx",
      [
        '"use client";',
        'import type { LlmProviderConfig } from "@/server/llmConfig";',
        'import { type ChatRequest } from "@/domain/chat";',
        'import { getServerSecret } from "@/server/apiKeyLoader";',
        'export { formatWon } from "./format";',
        'export type { RiskLevel } from "@/domain/risk";',
        "const lazy = () => import(\"pg\");",
        "// process.env.IN_COMMENT 과 \"server-only\" 는 주석이라 세지 않는다.",
        "const key = process.env.UPSTAGE_API_KEY;",
        'const dynamic = process.env["RAG_" + "INTERNAL_TOKEN"];',
        "const mode = process.env.NODE_ENV;",
      ].join("\n"),
    );
    const facts = collectFacts(probe);
    expect(isClientModule(probe)).toBe(true);
    expect(facts.imports).toEqual(["@/server/apiKeyLoader", "./format", "pg"]);
    expect(facts.envNames).toEqual(["UPSTAGE_API_KEY", "[동적 접근]", "NODE_ENV"]);
    expect(facts.hasServerOnlyImport).toBe(false);
    expect(forbiddenPackage("pg")).toBe("PostgreSQL 드라이버");
    expect(forbiddenPackage("node:fs")).toBe("Node 내장 모듈");
    expect(forbiddenPackage("crypto")).toBe("Node 내장 모듈");
    expect(forbiddenPackage("react")).toBeUndefined();
  });

  it("'use client' 파일과 그 import 폐포를 실제로 찾는다", () => {
    const { clientFiles, closure } = analyzeClientGraph();
    expect(clientFiles.map(rel)).toContain("src/components/chat/ChatPanel.tsx");
    expect(clientFiles.length).toBeGreaterThan(30);
    expect(closure.size).toBeGreaterThan(clientFiles.length);
  });

  it("클라이언트 import 폐포에 서버 모듈·Node 내장 모듈·DB 드라이버·process.env 가 없다", () => {
    expect(analyzeClientGraph().problems).toEqual([]);
  });

  it("NEXT_PUBLIC_ 환경 변수를 쓰지 않는다", () => {
    // 이 파일은 설명과 테스트 이름에 접두사가 들어 있어 뺀다.
    const self = fileURLToPath(import.meta.url);
    const files = [...ALL_SRC_FILES, join(PRODUCT_ROOT, "next.config.ts"), join(PRODUCT_ROOT, ".env.example")];
    const offenders = files
      .filter((file) => file !== self && existsSync(file) && readFileSync(file, "utf8").includes("NEXT_PUBLIC_"))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("next.config.ts 에 브라우저 번들로 값을 넘기는 env·compiler.define 이 없다", () => {
    const keys: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) {
        if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) keys.push(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parseFile(join(PRODUCT_ROOT, "next.config.ts")));
    // 설정 객체를 실제로 읽었는지 확인한다.
    expect(keys).toContain("reactStrictMode");
    expect(keys.filter((key) => key === "env" || key === "define")).toEqual([]);
  });

  it("비밀값을 읽거나 DB·Redis 에 연결하는 서버 모듈은 import \"server-only\" 를 둔다", () => {
    const missing = CODE_FILES.filter((file) => !isTestOnlyFile(file))
      .map((file) => ({ path: rel(file), facts: collectFacts(parseFile(file)) }))
      .filter(({ path }) => !SERVER_ONLY_EXEMPT.some((pattern) => pattern.test(path)))
      .filter(({ path, facts }) => !facts.hasServerOnlyImport && (MARKED_SERVER_MODULES.includes(path) || secretReasons(facts).length > 0))
      .map(({ path, facts }) => `${path}: ${secretReasons(facts).join(", ") || "표시 대상 모듈"}`);
    expect(missing).toEqual([]);
  });

  it("표시 대상으로 고정한 모듈이 모두 존재한다", () => {
    const absent = MARKED_SERVER_MODULES.filter((path) => !existsSync(join(PRODUCT_ROOT, path)));
    expect(absent).toEqual([]);
  });
});
