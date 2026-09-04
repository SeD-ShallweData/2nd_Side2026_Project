import "server-only";

import { MockAuthRepository } from "@/adapters/mock/MockAuthRepository";
import { MockCommunityRepository } from "@/adapters/mock/MockCommunityRepository";
import { RealAuthRepository } from "@/adapters/real/RealAuthRepository";
import { getAuthDataMode, getCommunityDataMode } from "@/config/dataMode";
import type { AuthRepository } from "@/domain/auth";
import type { CommunityRepository } from "@/domain/community";
import { ServiceError } from "@/utils/errors";

/*
 * 사용자 데이터(회원·세션·게시글·신고) 저장소 선택.
 *
 * services/providers.ts 와 나눠 둔 이유가 있다. 그쪽은 사업장·위험도·상담처럼
 * 화면 어디서나 쓰는 공용 조회 어댑터를 모아 두는 곳이고, 이 파일이 다루는
 * 저장소는 자격 증명과 쓰기 권한을 쥐고 있어 server-only 경계 안에 있어야 한다.
 * 한 파일로 합치면 사업장 조회만 필요한 모듈까지 인증 코드를 끌고 들어온다.
 */

const mockAuthRepository = new MockAuthRepository();
const realAuthRepository = new RealAuthRepository();
const mockCommunityRepository = new MockCommunityRepository();

/*
 * 실제 DB 어댑터가 아직 없는 기능은 Mock 으로 조용히 대체하지 않고 거부한다.
 * 대체하면 저장한 줄 알았던 글이 재시작과 함께 사라진다.
 */
function assertRealAdapterExists(
  mode: string,
  code: string,
  message: string,
): void {
  if (mode === "real") {
    throw new ServiceError(code, message, 503, true);
  }
}

export function getAuthRepository(): AuthRepository {
  return getAuthDataMode() === "real" ? realAuthRepository : mockAuthRepository;
}

export function getCommunityRepository(): CommunityRepository {
  assertRealAdapterExists(
    getCommunityDataMode(),
    "COMMUNITY_PROVIDER_UNAVAILABLE",
    "커뮤니티 저장소가 아직 연결되지 않았습니다.",
  );
  return mockCommunityRepository;
}
