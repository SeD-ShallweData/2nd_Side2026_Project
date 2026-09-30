import "server-only";

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

import { ServiceError } from "@/utils/errors";

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

/*
 * scrypt 동시 실행 상한.
 *
 * scrypt 는 libuv 작업 스레드(기본 4개)에서 돈다. 로그인·가입 요청이 몰리면 해시 계산이 스레드를
 * 모두 차지해 파일 저장·DNS 조회 같은 다른 작업까지 멈춘다. 그래서 한 번에 2개만 계산하고 나머지는
 * 줄을 세운다. 줄이 가득 찼으면 곧바로, 5초 넘게 기다렸으면 그때 503 AUTH_BUSY 로 돌려보낸다.
 * 이 오류는 자격 증명 실패가 아니므로 로그인 잠금 횟수에 넣지 않는다(authService.loginUser).
 * 계정이 없을 때의 대조(burnPasswordComparison)도 같은 줄을 서므로 응답으로 계정 존재 여부가
 * 갈리지 않는다.
 */
const MAX_CONCURRENT_HASHES = 2;
const MAX_QUEUED_HASHES = 50;
const MAX_HASH_QUEUE_WAIT_MS = 5_000;

interface HashWaiter {
  start: () => void;
  timer: ReturnType<typeof setTimeout>;
}

let activeHashes = 0;
const hashQueue: HashWaiter[] = [];

function authBusy(): ServiceError {
  return new ServiceError(
    "AUTH_BUSY",
    "지금은 로그인·가입 요청이 많아 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    503,
    true,
  );
}

async function acquireHashSlot(): Promise<void> {
  if (activeHashes < MAX_CONCURRENT_HASHES) {
    activeHashes += 1;
    return;
  }
  if (hashQueue.length >= MAX_QUEUED_HASHES) throw authBusy();
  await new Promise<void>((resolve, reject) => {
    const waiter: HashWaiter = {
      start: resolve,
      timer: setTimeout(() => {
        const index = hashQueue.indexOf(waiter);
        if (index >= 0) hashQueue.splice(index, 1);
        reject(authBusy());
      }, MAX_HASH_QUEUE_WAIT_MS),
    };
    hashQueue.push(waiter);
  });
}

/* 기다리는 요청이 있으면 자리를 그대로 넘기고, 없으면 자리를 비운다. */
function releaseHashSlot(): void {
  const next = hashQueue.shift();
  if (next) {
    clearTimeout(next.timer);
    next.start();
    return;
  }
  activeHashes -= 1;
}

async function derive(password: string, salt: Buffer, cost: number, blockSize: number, parallelization: number): Promise<Buffer> {
  await acquireHashSlot();
  try {
    return await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: MAX_MEMORY,
    });
  } finally {
    releaseHashSlot();
  }
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
