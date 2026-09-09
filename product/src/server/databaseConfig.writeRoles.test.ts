import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthDatabaseUrl,
  buildCommunityDatabaseUrl,
  getAuthDatabaseConnectionString,
  getCommunityDatabaseConnectionString,
  getDatabaseConnectionString,
} from "@/server/databaseConfig";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("쓰기 롤 접속 정보", () => {
  it("공유 DB 파일 값으로 인증·커뮤니티 접속 문자열을 만든다", () => {
    const values = {
      DB_NAME: "wageguard",
      DB_HOST: "127.0.0.1",
      DB_PORT: "5433",
      AUTH_USER: "wg_auth",
      AUTH_PASSWORD: "auth-secret",
      COMMUNITY_USER: "wg_community",
      COMMUNITY_PASSWORD: "community-secret",
    };

    expect(buildAuthDatabaseUrl(values)).toBe(
      "postgresql://wg_auth:auth-secret@127.0.0.1:5433/wageguard",
    );
    expect(buildCommunityDatabaseUrl(values)).toBe(
      "postgresql://wg_community:community-secret@127.0.0.1:5433/wageguard",
    );
  });

  it("비밀번호의 예약문자를 인코딩한다", () => {
    expect(
      buildAuthDatabaseUrl({
        DB_NAME: "wageguard",
        DB_PORT: "5433",
        AUTH_USER: "wg_auth",
        AUTH_PASSWORD: "pass:word@host/db",
      }),
    ).toBe("postgresql://wg_auth:pass%3Aword%40host%2Fdb@127.0.0.1:5433/wageguard");
  });

  /*
   * 이 세 건이 이 파일의 핵심이다.
   * 쓰기 롤 설정이 없을 때 소유자 계정으로 조용히 대체되면, 나연이 롤을 나눈
   * 이유(인증은 게시글을 못 보고 커뮤니티는 회원을 못 본다)가 통째로 무효가 된다.
   * 설정이 없으면 연결하지 않고 실패해야 한다.
   */
  it("설정이 없으면 소유자 DATABASE_URL로 대체하지 않는다", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://wageguard:owner-secret@127.0.0.1:5433/wageguard");

    expect(getAuthDatabaseConnectionString()).toBeUndefined();
    expect(getCommunityDatabaseConnectionString()).toBeUndefined();
  });

  it("설정이 없으면 읽기 전용 BOT_DATABASE_URL로도 대체하지 않는다", () => {
    vi.stubEnv("BOT_DATABASE_URL", "postgresql://wg_bot:bot-secret@127.0.0.1:5433/wageguard");

    expect(getAuthDatabaseConnectionString()).toBeUndefined();
    expect(getCommunityDatabaseConnectionString()).toBeUndefined();
  });

  it("인증과 커뮤니티는 서로의 접속 문자열을 쓰지 않는다", () => {
    vi.stubEnv("AUTH_DATABASE_URL", "postgresql://wg_auth:auth-secret@127.0.0.1:5433/wageguard");

    expect(getAuthDatabaseConnectionString()).toContain("wg_auth");
    expect(getCommunityDatabaseConnectionString()).toBeUndefined();
  });

  it("읽기 전용 경로는 기존 동작을 유지한다", () => {
    vi.stubEnv("BOT_DATABASE_URL", "postgresql://wg_bot:bot-secret@127.0.0.1:5433/wageguard");
    vi.stubEnv("AUTH_DATABASE_URL", "postgresql://wg_auth:auth-secret@127.0.0.1:5433/wageguard");

    expect(getDatabaseConnectionString()).toBe(
      "postgresql://wg_bot:bot-secret@127.0.0.1:5433/wageguard",
    );
  });

  it("자리표시자와 postgres 형식이 아닌 값은 접속 문자열로 받지 않는다", () => {
    vi.stubEnv("AUTH_DATABASE_URL", "postgresql://CHANGE_ME@127.0.0.1:5433/wageguard");
    expect(getAuthDatabaseConnectionString()).toBeUndefined();

    vi.stubEnv("COMMUNITY_DATABASE_URL", "wg_community@127.0.0.1:5433");
    expect(getCommunityDatabaseConnectionString()).toBeUndefined();
  });

  it("사용자나 비밀번호가 비면 접속 문자열을 만들지 않는다", () => {
    expect(
      buildAuthDatabaseUrl({ DB_NAME: "wageguard", AUTH_USER: "wg_auth" }),
    ).toBeUndefined();
    expect(
      buildCommunityDatabaseUrl({ DB_NAME: "wageguard", COMMUNITY_PASSWORD: "secret" }),
    ).toBeUndefined();
    expect(
      buildAuthDatabaseUrl({ AUTH_USER: "wg_auth", AUTH_PASSWORD: "secret" }),
    ).toBeUndefined();
  });
});
