import { stat } from "node:fs/promises";
import path from "node:path";

const defaultCandidates = [
  path.join(process.cwd(), ".env.local"),
  process.env.DATABASE_ENV_FILE || "/data/shared-SeD/.env.local",
  process.env.SHARED_API_KEY_FILE || "/data/shared-SeD/api_key.env",
];
const requestedCandidates = process.argv.slice(2).filter(Boolean);
const candidates = requestedCandidates.length > 0 ? requestedCandidates : defaultCandidates;

let checked = 0;
let unsafe = 0;

for (const file of new Set(candidates)) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    process.stderr.write(`[ERROR] ${file}: 상태를 읽지 못했습니다.\n`);
    unsafe += 1;
    continue;
  }

  checked += 1;
  const mode = info.mode & 0o777;
  const octal = mode.toString(8).padStart(3, "0");
  if (!info.isFile()) {
    process.stderr.write(`[ERROR] ${file}: 일반 파일이 아닙니다.\n`);
    unsafe += 1;
    continue;
  }

  // 읽기 전용 변형(0400/0440)과 0600/0640만 허용한다.
  const ownerCanRead = (mode & 0o400) !== 0;
  const forbiddenBits = (mode & 0o137) !== 0; // 실행, 그룹 쓰기, 기타 사용자 접근
  if (!ownerCanRead || forbiddenBits) {
    process.stderr.write(
      `[WARN] ${file}: 권한 ${octal}; 소유자 전용 600 또는 팀 그룹 읽기 640을 권장합니다.\n`,
    );
    unsafe += 1;
  } else {
    process.stdout.write(`[OK] ${file}: 권한 ${octal}\n`);
  }
}

if (checked === 0) {
  process.stdout.write(
    "[INFO] 점검할 로컬 env 파일이 없습니다. 배포 비밀 저장소를 사용하는 환경이면 정상입니다.\n",
  );
}

if (unsafe > 0) process.exitCode = 1;
