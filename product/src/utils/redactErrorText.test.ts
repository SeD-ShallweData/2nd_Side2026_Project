import { describe, expect, it } from "vitest";

import { redactErrorText } from "@/utils/redactErrorText";

describe("서버 로그용 오류 문구 정리", () => {
  it("접속 문자열과 비밀번호를 지운다", () => {
    const text = redactErrorText("could not connect postgresql://bot:secret@db.test/wageguard password=hunter2");

    expect(text).toBe("could not connect [connection-string] password=[redacted]");
  });

  it("사용자 정보가 붙은 다른 주소도 지운다", () => {
    const text = redactErrorText("redis error at redis://default:p4ssw0rd@127.0.0.1:6379/0 while connecting");

    expect(text).not.toContain("p4ssw0rd");
    expect(text).toContain("[credential-url]");
  });

  it("Bearer 토큰과 이름이 붙은 키 값을 지운다", () => {
    const text = redactErrorText('401 Unauthorized: Authorization: Bearer abc.def-ghi_jkl api_key=XYZ12345 "token": "t0k3n"');

    expect(text).toContain("Bearer [redacted]");
    expect(text).toContain("api_key=[redacted]");
    expect(text).not.toContain("abc.def-ghi_jkl");
    expect(text).not.toContain("XYZ12345");
    expect(text).not.toContain("t0k3n");
  });

  it("OpenAI·Upstage 키 모양과 긴 불투명 토큰을 지운다", () => {
    const text = redactErrorText("key sk-proj-AbCdEf123456 and up_4f8a9b2c3d and session QmFzZTY0VG9rZW5WYWx1ZTEyMzQ1Njc4OTAxMjM0NTY");

    expect(text).not.toContain("sk-proj-AbCdEf123456");
    expect(text).not.toContain("up_4f8a9b2c3d");
    expect(text).not.toContain("QmFzZTY0VG9rZW5WYWx1ZTEyMzQ1Njc4OTAxMjM0NTY");
    expect(text).toContain("[redacted-key]");
    expect(text).toContain("[redacted-token]");
  });

  it("원인을 가르는 데 필요한 제약 이름과 관계 이름은 남긴다", () => {
    const text = redactErrorText(
      'update or delete on table "users" violates foreign key constraint "worksite_tips_reporter_id_users_id_fk" on table "worksite_tips"',
    );

    expect(text).toContain("worksite_tips_reporter_id_users_id_fk");
    expect(text).toContain('on table "worksite_tips"');
  });

  it("줄바꿈을 한 줄로 합치고 200자로 자른다", () => {
    const text = redactErrorText(`첫 줄\n둘째 줄\t${"가".repeat(500)}`);

    expect(text.startsWith("첫 줄 둘째 줄 ")).toBe(true);
    expect(text).not.toContain("\n");
    expect(text).toHaveLength(200);
  });
});
