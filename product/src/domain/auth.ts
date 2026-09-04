import type { SessionUserDto, UserPersonaRole } from "@/app/api/auth/authApiContract";

/*
 * 인증 저장소 포트.
 *
 * 여기에는 "무엇을 저장하고 꺼내는가"만 둔다. 로그인 입력값 검증, 권한 판정,
 * 응답 DTO 조립 같은 규칙은 서비스 계층에 남긴다. 규칙이 저장소마다 따로 있으면
 * Mock 과 실제 DB 의 동작이 조용히 갈라진다.
 *
 * 반대로 아래 세 가지는 저장소 책임이다.
 *   - 자격 증명 대조 방식 (Mock 은 환경변수, 실제 DB 는 비밀번호 해시)
 *   - 세션 토큰의 보관 형태 (원문은 저장하지 않고 해시만 둔다)
 *   - 사용자당 활성 세션 1개 정책의 실행
 */

export interface IssuedSession {
  token: string;
  user: SessionUserDto;
  expires_at: string;
}

export interface ResolvedSession {
  user: SessionUserDto;
  expires_at: string;
}

export interface NewUser {
  email: string;
  password: string;
  name: string;
  persona_role: UserPersonaRole;
  firm_id: string | null;
}

export interface AuthRepository {
  /*
   * 저장소를 쓸 수 있는 상태인지 확인한다. 쓸 수 없으면 ServiceError 를 던진다.
   * Mock 은 운영 환경 외곽 인증 여부를, 실제 DB 는 접속 설정 여부를 본다.
   */
  assertAvailable(): void;

  /*
   * 계정을 만든다. 권한 등급은 저장소가 'user' 로 고정한다 —
   * 가입으로 관리자·감독관이 만들어지면 안 된다.
   * 이미 있는 이메일이면 ServiceError(EMAIL_ALREADY_REGISTERED).
   */
  register(user: NewUser): Promise<SessionUserDto>;

  /* 이메일·비밀번호를 대조한다. 실패하면 ServiceError(INVALID_CREDENTIALS). */
  authenticate(email: string, password: string): Promise<SessionUserDto>;

  /* 기존 세션을 정리하고 새 세션을 발급한다(사용자당 활성 세션 1개). */
  issueSession(user: SessionUserDto): Promise<IssuedSession>;

  /* 토큰으로 세션을 찾는다. 없거나 만료됐으면 null. */
  resolveSession(token: string): Promise<ResolvedSession | null>;

  revokeSession(token: string): Promise<void>;
}
