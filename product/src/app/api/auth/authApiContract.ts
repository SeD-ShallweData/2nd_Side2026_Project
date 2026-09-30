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
export interface DeleteAccountResponse { deleted: true }

/*
 * 가입 화면의 숨은 입력칸(허니팟) 이름.
 *
 * 화면에는 보이지 않고 탭 이동·보조기기로도 닿지 않아 사람은 채울 수 없다. 칸을 모두 채우는
 * 봇만 값을 넣는다. 서버는 값이 있으면 이유를 밝히지 않고 거절한다. 자동완성이 알아보지 못하게
 * 뜻 없는 이름을 쓴다. 칸을 보내지 않는 요청(검증 스크립트 등)은 빈 값과 같게 본다.
 */
export const SIGNUP_HONEYPOT_FIELD = "mw_hp";

/*
 * 가입에서 받는 값은 이 셋뿐이다.
 *
 * 직업 구분(구직자·사업주 등 5종)과 사업장 연결은 받지 않는다. 역할을
 * 위의 UserRole 3종으로 통일하면서 DB 에서도 users.role·users.firm_id 가
 * 사라졌다(0011).
 *
 * 권한 등급도 받지 않는다. 받는 순간 가입 요청 하나로 관리자·감독관 계정이
 * 만들어지므로, 저장소가 항상 'user' 로 고정한다. 승격은 DB 에서 직접 한다.
 */
export interface SignupRequest {
  email: string;
  password: string;
  name: string;
  /** 숨은 칸(허니팟) 값. 위 SIGNUP_HONEYPOT_FIELD 설명 참고. 사람이 쓰는 화면에서는 늘 빈 값이다. */
  [SIGNUP_HONEYPOT_FIELD]?: string;
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
