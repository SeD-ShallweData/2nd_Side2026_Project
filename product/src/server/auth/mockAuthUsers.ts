import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import { getDemoAuthConfiguration } from "@/server/demoBasicAuth";
import { ServiceError } from "@/utils/errors";

interface MockUserEntry extends SessionUserDto {
  password_environment: "MOCK_AUTH_USER_PASSWORD" | "MOCK_AUTH_ADMIN_PASSWORD" | "MOCK_AUTH_INSPECTOR_PASSWORD";
}

const MOCK_USERS: readonly MockUserEntry[] = [
  {
    user_id: "10000000-0000-4000-8000-000000000001",
    email: "user@mock.donworry.local",
    display_name: "일반 사용자",
    role: "user",
    password_environment: "MOCK_AUTH_USER_PASSWORD",
  },
  {
    user_id: "10000000-0000-4000-8000-000000000002",
    email: "admin@mock.donworry.local",
    display_name: "커뮤니티 관리자",
    role: "admin",
    password_environment: "MOCK_AUTH_ADMIN_PASSWORD",
  },
  {
    user_id: "10000000-0000-4000-8000-000000000003",
    email: "inspector@mock.donworry.local",
    display_name: "근로감독관",
    role: "inspector",
    password_environment: "MOCK_AUTH_INSPECTOR_PASSWORD",
  },
] as const;

function getAuthDataMode(): "mock" | "real" {
  const value = process.env.AUTH_DATA_MODE ?? process.env.APP_DATA_MODE ?? "real";
  return value === "mock" ? "mock" : "real";
}

export function assertMockAuthAvailable(): void {
  if (getAuthDataMode() !== "mock") {
    throw new ServiceError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "사용자 인증 저장소가 아직 연결되지 않았습니다.",
      503,
      true,
    );
  }

  if (process.env.NODE_ENV === "production" && getDemoAuthConfiguration().status !== "enabled") {
    throw new ServiceError(
      "MOCK_AUTH_PERIMETER_REQUIRED",
      "운영 환경의 Mock 인증은 팀 시연용 외곽 인증이 설정된 경우에만 사용할 수 있습니다.",
      503,
      false,
    );
  }
}

function constantTimePasswordEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function toSessionUser(user: MockUserEntry): SessionUserDto {
  return {
    user_id: user.user_id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
  };
}

export function listMockSessionUsers(): readonly SessionUserDto[] {
  return MOCK_USERS.map(toSessionUser);
}

export function findMockSessionUserById(userId: string): SessionUserDto | null {
  const user = MOCK_USERS.find((candidate) => candidate.user_id === userId);
  if (!user) return null;
  return toSessionUser(user);
}

export function authenticateMockUser(email: string, password: string): SessionUserDto {
  assertMockAuthAvailable();

  const configuredPasswords = {
    MOCK_AUTH_USER_PASSWORD: process.env.MOCK_AUTH_USER_PASSWORD,
    MOCK_AUTH_ADMIN_PASSWORD: process.env.MOCK_AUTH_ADMIN_PASSWORD,
    MOCK_AUTH_INSPECTOR_PASSWORD: process.env.MOCK_AUTH_INSPECTOR_PASSWORD,
  };
  const passwordValues = Object.values(configuredPasswords);
  if (
    passwordValues.some((value) => !value || value.length < 12)
    || new Set(passwordValues).size !== passwordValues.length
  ) {
    throw new ServiceError(
      "MOCK_AUTH_NOT_CONFIGURED",
      "로컬 Mock 인증 설정이 준비되지 않았습니다.",
      503,
      false,
    );
  }

  const normalizedEmail = email.trim().toLocaleLowerCase("en-US");
  const user = MOCK_USERS.find((candidate) => candidate.email === normalizedEmail);
  const configuredPassword = user
    ? configuredPasswords[user.password_environment]
    : configuredPasswords.MOCK_AUTH_USER_PASSWORD;
  const passwordMatches = constantTimePasswordEqual(password, configuredPassword ?? "");

  if (!user || !passwordMatches) {
    throw new ServiceError(
      "INVALID_CREDENTIALS",
      "이메일 또는 비밀번호를 확인해 주세요.",
      401,
      false,
    );
  }

  return toSessionUser(user);
}
