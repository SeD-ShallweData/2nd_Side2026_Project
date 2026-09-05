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
