export const USER_ROLES = ["user", "admin", "inspector"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export interface SessionUserDto {
  user_id: string;
  email: string;
  display_name: string;
  role: UserRole;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  authenticated: true;
  user: SessionUserDto;
  expires_at: string;
}

export type SessionResponse =
  | { authenticated: true; user: SessionUserDto; expires_at: string }
  | { authenticated: false; user: null; expires_at: null };

export interface LogoutResponse {
  logged_out: true;
}

/*
 * 직업 구분. DB users.role 과 같은 값이며 AI 상담 페르소나로도 쓰인다.
 *
 * 위의 UserRole(권한 등급)과 이름이 비슷하지만 전혀 다른 것이다.
 * 권한 등급은 화면 접근을 가르고, 직업 구분은 사용자가 어떤 처지인지를 나타낸다.
 * 섞이면 일반 사용자에게 감독관 화면이 열리므로 계약에서부터 이름을 갈라 둔다.
 */
export const USER_PERSONA_ROLES = [
  "구직자",
  "재직 근로자",
  "기업/노무 담당자",
  "사업주",
  "감독관",
] as const;

export type UserPersonaRole = (typeof USER_PERSONA_ROLES)[number];

/* 사업장을 연결할 수 있는 직업 구분. DB users_firm_scope_ck 와 같은 목록이다. */
export const FIRM_LINKABLE_PERSONA_ROLES: readonly UserPersonaRole[] = [
  "사업주",
  "기업/노무 담당자",
];

export interface SignupRequest {
  email: string;
  password: string;
  name: string;
  persona_role: UserPersonaRole;
  /* 사업주·기업/노무 담당자로 가입할 때만 보낼 수 있다. */
  firm_id?: string | null;
}

/*
 * 가입하면 곧바로 로그인 상태가 된다. 가입 직후 다시 로그인하게 만들 이유가 없다.
 * 그래서 응답이 로그인과 같은 모양이고, 세션 쿠키도 함께 내려간다.
 */
export interface SignupResponse {
  authenticated: true;
  user: SessionUserDto;
  expires_at: string;
}
