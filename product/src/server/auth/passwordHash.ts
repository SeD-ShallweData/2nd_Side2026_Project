import "server-only";

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

/*
 * scrypt 는 매개변수를 받는 형태와 받지 않는 형태가 함께 정의돼 있어,
 * promisify 가 매개변수 없는 쪽으로 추론한다. 쓰려는 형태를 명시한다.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/*
 * 비밀번호 저장 형식.
 *
 * scrypt 를 쓴다 — Node 내장이라 의존성이 늘지 않고, 메모리를 많이 쓰도록
 * 설계돼 있어 전용 장비를 동원한 대량 대조에 강하다.
 *
 * 저장 문자열에 알고리즘과 매개변수를 함께 적는다. 나중에 세기를 올리더라도
 * 예전 비밀번호를 그대로 검증할 수 있어야 하기 때문이다. 형식을 바꾸면
 * 나연이 만들 시드·운영 계정과도 어긋나므로, 이 파일이 유일한 기준이다.
 *
 *   scrypt$<N>$<r>$<p>$<salt-base64>$<hash-base64>
 */

const ALGORITHM = "scrypt";
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/*
 * N=16384, r=8 이면 내부적으로 128 * N * r = 16MiB 를 쓴다.
 * Node 기본 상한(32MiB)에 걸리지 않도록 여유를 두고 명시한다.
 */
const MAX_MEMORY = 64 * 1024 * 1024;

async function derive(password: string, salt: Buffer, cost: number, blockSize: number, parallelization: number): Promise<Buffer> {
  return scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: MAX_MEMORY,
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, COST, BLOCK_SIZE, PARALLELIZATION);
  return [
    ALGORITHM,
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

interface ParsedHash {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  hash: Buffer;
}

function parseStoredHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return null;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (![cost, blockSize, parallelization].every((value) => Number.isInteger(value) && value > 0)) {
    return null;
  }
  // 저장된 값이 조작돼 터무니없는 매개변수가 들어와도 서버가 멈추지 않게 상한을 둔다.
  if (cost > 1 << 20 || blockSize > 32 || parallelization > 16) return null;

  try {
    const salt = Buffer.from(parts[4] ?? "", "base64");
    const hash = Buffer.from(parts[5] ?? "", "base64");
    if (salt.length === 0 || hash.length === 0) return null;
    return { cost, blockSize, parallelization, salt, hash };
  } catch {
    return null;
  }
}

/*
 * 저장된 값이 비었거나 형식이 깨져도 false 를 돌려주고 예외를 던지지 않는다.
 * 예외를 던지면 "계정은 있는데 비밀번호 칸이 이상한 경우"가 로그인 실패와
 * 다른 응답으로 갈라져, 계정 존재 여부가 드러난다.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;

  const candidate = await derive(password, parsed.salt, parsed.cost, parsed.blockSize, parsed.parallelization);
  if (candidate.length !== parsed.hash.length) return false;
  return timingSafeEqual(candidate, parsed.hash);
}

/*
 * 존재하지 않는 계정으로 로그인을 시도해도 실제 대조와 비슷한 시간이 걸리게 한다.
 * 응답이 빨리 돌아오는 것만으로 "그 이메일은 가입돼 있지 않다"가 새어 나간다.
 */
export async function burnPasswordComparison(password: string): Promise<void> {
  await derive(password, Buffer.alloc(SALT_LENGTH), COST, BLOCK_SIZE, PARALLELIZATION);
}
