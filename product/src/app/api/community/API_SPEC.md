# 인증·커뮤니티 API 명세

## 1. 문서 상태

| 항목 | 내용 |
| --- | --- |
| 담당 | 정민규 — 커뮤니티 백엔드·인증·권한 API |
| 구현 단계 | 플랫폼 승인 전 Mock 구현 |
| 브랜치 | `task/auth-community-api` |
| 데이터 저장 | 프로세스 메모리, 서버 재시작 시 초기화 |
| 실제 DB | 나연 migration·권한 설정 이후 연결 예정 |
| 프론트 연결 | 지유 담당, 현재 `CommunityBoard`는 정적 데이터 사용 |

이 명세의 타입 기준본은 `authApiContract.ts`와 `communityApiContract.ts`다. 실제 응답 예시는
`sample-responses.json`에서 확인한다.

## 2. 공통 규칙

- API 기준 경로는 현재 웹과 같은 origin이다.
- 인증은 `donworry_session` 쿠키를 사용한다. `HttpOnly`, `SameSite=Lax`, `Path=/`이며 운영에서는
  `Secure`가 추가된다. 프론트에서 토큰을 읽거나 저장하지 않는다.
- 사용자 또는 권한에 따라 달라지는 응답은 `Cache-Control: no-store`다.
- 본문이 있는 변경 요청은 `application/json` 또는 `+json` Content-Type을 지원하며 최대 크기는 64KiB다.
- 다른 origin 또는 `Sec-Fetch-Site: cross-site` 변경 요청은 거부한다.
- `AUTH_DATA_MODE=real` 또는 `COMMUNITY_DATA_MODE=real`에서 실제 provider가 없으면 Mock 성공으로
  대체하지 않고 `503`을 반환한다.
- 공개 게시글 DTO에는 `author_id`, 이메일, 사용자 역할, 세션 토큰을 포함하지 않는다.
- 게시글은 사용자 경험이며 공식 데이터·법률 근거·위험카드·RAG 출처로 사용하지 않는다.

### 역할

| 동작 | `user` | `admin` | `inspector` |
| --- | --- | --- | --- |
| 공개 글 조회 | 가능 | 가능 | 가능 |
| 글 작성 | 가능 | 가능 | 가능 |
| 본인 글 수정·삭제 | 가능 | 가능 | 가능 |
| 타인 글 수정·삭제 | 불가 | 불가 | 불가 |
| 타인 공개 글 신고 | 가능 | 가능 | 가능 |
| 신고 목록·승인·기각 | 불가 | 가능 | 불가 |
| `/api/inspector/*` 접근 | 별도 정책 | 별도 정책 | 이 Mock 역할만으로는 불가 |

### 주요 enum

| 구분 | 값 |
| --- | --- |
| 사용자 역할 | `user`, `admin`, `inspector` |
| 게시글 카테고리 | `pre_employment`, `employment_contract`, `workplace_safety`, `wage` |
| 게시글 상태 | `published`, `hidden`, `deleted` |
| 신고 사유 | `spam`, `abuse`, `privacy`, `misinformation`, `other` |
| 신고 상태 | `pending`, `accepted`, `dismissed` |
| 신고 결정 | `accept`, `dismiss` |

## 3. 인증 API

### `POST /api/auth/login`

| 항목 | 내용 |
| --- | --- |
| 인증 | 불필요 |
| 요청 | `email: string`, `password: string` |
| 성공 | `200`, `authenticated: true`, 사용자 정보, `expires_at` |
| 부가 동작 | HttpOnly 세션 쿠키 발급, 같은 사용자의 이전 Mock 세션 폐기 |
| 주요 오류 | `400 VALIDATION_ERROR`, `401 INVALID_CREDENTIALS`, `403 CROSS_SITE_REQUEST_REJECTED`, `413 REQUEST_BODY_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `503 AUTH_PROVIDER_UNAVAILABLE`, `503 MOCK_AUTH_NOT_CONFIGURED`, `503 MOCK_AUTH_PERIMETER_REQUIRED` |

이메일은 trim·소문자 정규화 후 비교한다. 비밀번호는 응답·로그·샘플 파일에 포함하지 않는다.
이메일 입력은 최대 254자이며 비밀번호 입력은 1~256자다. Mock 환경변수의 세 역할 비밀번호는 각각
12자 이상이며 서로 달라야 한다.

### `POST /api/auth/logout`

| 항목 | 내용 |
| --- | --- |
| 인증 | 선택, 반복 호출 가능 |
| 요청 | 본문 없음 |
| 성공 | `200`, `logged_out: true` |
| 부가 동작 | 현재 세션 폐기, 세션 쿠키 만료 |
| 주요 오류 | `403 CROSS_SITE_REQUEST_REJECTED` |

### `GET /api/auth/session`

| 항목 | 내용 |
| --- | --- |
| 인증 | 선택 |
| 로그인 성공 응답 | `authenticated: true`, 사용자 정보, `expires_at` |
| 비로그인 응답 | `authenticated: false`, `user: null`, `expires_at: null` |
| 주요 오류 | 기존 Mock 쿠키가 있지만 provider가 비활성화된 경우 `503` |

### `GET /api/users/me`

| 항목 | 내용 |
| --- | --- |
| 인증 | 필수 |
| 성공 | `200`, `user` |
| 주요 오류 | `401 AUTHENTICATION_REQUIRED`, provider 미연결 시 `503` |

### 세션 사용자 필드

| 필드 | 타입 | 의미 |
| --- | --- | --- |
| `user_id` | string | 내부 사용자 UUID. 자기 세션 응답에만 제공 |
| `email` | string | 로그인 사용자 이메일. 공개 게시글에는 제공하지 않음 |
| `display_name` | string | 로그인 사용자 표시 이름 |
| `role` | enum | `user`, `admin`, `inspector` |

## 4. 커뮤니티 게시글 API

### `GET /api/community/posts`

| 항목 | 내용 |
| --- | --- |
| 인증 | 선택 |
| query | `q`, `category`, `page`, `limit` |
| 기본값 | `q=""`, 전체 카테고리, `page=1`, `limit=10` |
| 제한 | `q` 최대 100자, `page` 1~100000, `limit` 1~20 |
| 성공 | `200`, 검색 조건·페이지 정보·게시글 DTO 목록 |
| 공개 범위 | `published` 게시글만 반환 |
| 주요 오류 | `400 VALIDATION_ERROR`, `503 COMMUNITY_PROVIDER_UNAVAILABLE` |

검색 대상은 제목, 본문, 서버가 확인한 사업장 지역·업종이다.

### `POST /api/community/posts`

| 항목 | 내용 |
| --- | --- |
| 인증 | 필수 |
| 필수 요청 | `category`, `title`, `body` |
| 선택 요청 | `company_id`, `anonymous` |
| 제한 | 제목 2~120자, 본문 10~5000자, `company_id` 최대 64자 |
| 기본값 | `anonymous=true` |
| 성공 | `201`, 생성된 게시글 DTO |
| 주요 오류 | `400 VALIDATION_ERROR`, `401 AUTHENTICATION_REQUIRED`, `404 COMPANY_NOT_FOUND`, 공통 변경 요청 오류, `503` |

Mock 모드의 `company_id`는 기존 `MOCK_COMPANIES` 기준으로 검증하고 지역·업종은 서버가 채운다.

### `GET /api/community/posts/{postId}`

| 항목 | 내용 |
| --- | --- |
| 인증 | 선택 |
| 성공 | `200`, 게시글 DTO |
| 숨김 글 | 작성자 또는 관리자만 조회 가능 |
| 삭제 글 | 항상 `404` |
| 주요 오류 | `400 VALIDATION_ERROR`, `404 COMMUNITY_POST_NOT_FOUND`, `503` |

### `PATCH /api/community/posts/{postId}`

| 항목 | 내용 |
| --- | --- |
| 인증 | 필수, 작성자 본인만 가능 |
| 선택 요청 | `category`, `title`, `body`, `company_id`, `anonymous` 중 하나 이상 |
| 성공 | `200`, 수정된 게시글 DTO |
| 주요 오류 | `400 VALIDATION_ERROR`, `401 AUTHENTICATION_REQUIRED`, `403 RESOURCE_OWNERSHIP_REQUIRED`, `404 COMMUNITY_POST_NOT_FOUND`, `404 COMPANY_NOT_FOUND`, `409 COMMUNITY_POST_NOT_EDITABLE`, 공통 변경 요청 오류, `503` |

### `DELETE /api/community/posts/{postId}`

| 항목 | 내용 |
| --- | --- |
| 인증 | 필수, 작성자 본인만 가능 |
| 요청 | 본문 없음 |
| 성공 | `200`, `deleted: true`, `post_id` |
| 처리 | 물리 삭제가 아니라 `deleted` 상태로 변경 |
| 주요 오류 | `401 AUTHENTICATION_REQUIRED`, `403 RESOURCE_OWNERSHIP_REQUIRED`, `404 COMMUNITY_POST_NOT_FOUND`, `403 CROSS_SITE_REQUEST_REJECTED`, `503` |

유효하지 않은 `postId` 형식은 `400`이 될 수 있다.

### 게시글 DTO 필드

| 필드 | 타입 | 프론트 사용 |
| --- | --- | --- |
| `source` | `mock_memory` 또는 `database` | DEMO 표시 여부 |
| `capabilities` | object | 현재 사용자가 쓸 수 있는 전체 기능 |
| `post_id` | string | 상세·수정·삭제·신고 경로 |
| `category` | enum | 필터·내부 코드 |
| `category_label` | string | 화면의 한글 카테고리 |
| `title`, `body` | string | 게시글 내용 |
| `company_context` | object 또는 null | `company_id`, `region`, `industry` |
| `anonymous` | boolean | 익명 여부 |
| `author_label` | string 또는 null | null이면 `익명` 표시 |
| `created_at`, `updated_at` | ISO 8601 string | 프론트에서 상대 시간 변환 |
| `comment_count` | number | 현재 seed 표시값. 댓글 작성 API는 미지원 |
| `like_count` | number 또는 null | `reactions=false`이면 HUD 비활성화 |
| `status` | enum | 공개·숨김·삭제 상태 |
| `viewer_permissions` | object | `can_edit`, `can_delete`, `can_report` |

`capabilities.write`, `reports`, `moderation`은 현재 세션 권한에 따라 달라진다. `comments`와
`reactions`는 현재 항상 `false`다.

`capabilities.reports=true`는 로그인 사용자가 신고 기능을 사용할 수 있다는 전역 상태다. 특정 글의
버튼은 `viewer_permissions.can_report`를 추가로 사용한다. 다만 현재 DTO는 과거 중복 신고 여부까지
반영하지 않으므로, 이미 신고한 글도 버튼이 보일 수 있고 재요청 시 `409 DUPLICATE_REPORT`가 최종
판단이 된다.

## 5. 신고·관리 API

### `POST /api/community/posts/{postId}/reports`

| 항목 | 내용 |
| --- | --- |
| 인증 | 필수 |
| 요청 | `reason`, 선택 `detail` |
| 제한 | `detail`을 보내면 1~500자 |
| 성공 | `201`, `report_id`, `post_id`, 상태·시각 |
| 차단 | 본인 글, 동일 사용자의 중복 신고, 숨김·삭제 글 |
| 주요 오류 | `400 VALIDATION_ERROR`, `401 AUTHENTICATION_REQUIRED`, `404 COMMUNITY_POST_NOT_FOUND`, `409 SELF_REPORT_NOT_ALLOWED`, `409 DUPLICATE_REPORT`, `409 COMMUNITY_POST_NOT_REPORTABLE`, 공통 변경 요청 오류, `503` |

신고 접수 시 제목·본문·게시글 수정 시각 snapshot을 저장한다.

### `GET /api/community/moderation/reports`

| 항목 | 내용 |
| --- | --- |
| 인증 | `admin` 필수 |
| query | 선택 `status`, `page`, `limit` |
| 성공 | `200`, 신고 목록·페이지 정보 |
| 응답 내용 | 신고 사유·상세·처리 메모, 현재 글 상태, 신고 당시 snapshot |
| 주요 오류 | `400 VALIDATION_ERROR`, `401 AUTHENTICATION_REQUIRED`, `403 FORBIDDEN`, `503` |

### `PATCH /api/community/moderation/reports/{reportId}`

| 항목 | 내용 |
| --- | --- |
| 인증 | `admin` 필수 |
| 요청 | `decision: accept 또는 dismiss`, 선택 `resolution_note` |
| 제한 | `resolution_note`를 보내면 1~500자 |
| 승인 동작 | 신고 `accepted`, 게시글이 현재 `published`이면 `hidden`으로 변경 |
| 기각 동작 | 신고 `dismissed`, 게시글 상태 유지 |
| 성공 | `200`, 처리된 관리자 신고 DTO |
| 주요 오류 | `400 VALIDATION_ERROR`, `401 AUTHENTICATION_REQUIRED`, `403 FORBIDDEN`, `404 COMMUNITY_REPORT_NOT_FOUND`, `409 COMMUNITY_REPORT_ALREADY_REVIEWED`, 공통 변경 요청 오류, `503` |

`resolution_note`는 승인·기각 모두 선택값이다. 여러 신고가 걸렸거나 게시글 상태가 먼저 변경된 경우
신고는 `accepted`가 되어도 게시글 상태 변경이 발생하지 않을 수 있다.

관리자 신고 DTO는 신고 ID·게시글 ID·사유·상세·상태·접수/검토 시각·처리 메모, 현재 게시글 제목·상태,
신고 당시 제목·본문·수정 시각 snapshot을 제공한다. 신고자 신원과 `reviewed_by`는 현재 공개하지 않는다.
관리자 화면에서 필요하면 개인정보 목적과 최소 노출 범위를 합의한 뒤 계약을 변경한다.

## 6. 오류 응답

모든 오류는 다음 필드를 가진다.

| 필드 | 의미 |
| --- | --- |
| `error.code` | 프론트 분기용 안정적인 코드 |
| `error.message` | 사용자에게 표시할 수 있는 한국어 메시지 |
| `error.details` | 입력 필드별 상세, 없을 수 있음 |
| `error.retryable` | 재시도 가능성 |
| `error.request_id` | 로그 연계용 요청 식별값 |

프론트는 메시지 문자열이 아니라 `error.code` 또는 HTTP 상태로 화면을 분기한다.

현재 입력 parser는 정의되지 않은 추가 JSON 필드를 무시한다. 프론트는 명세된 필드만 보내고, 실제 DB
연결 전 strict validation 적용 여부를 윤빈과 확정한다.

## 7. 현재 제외 범위

- 회원가입, 이메일 인증, 비밀번호 변경·재설정
- 댓글 작성·수정·삭제
- 공감·반응 처리
- 리뷰·별점
- 실제 사용자·세션·게시글·신고 DB adapter
- 운영 rate limit, 영구 감사 로그, 최종 CSRF 정책

`source=database` 타입은 실제 adapter 연결을 위한 예약값이다. 현재 Real 모드는 데이터를 반환하지 않고
`503`만 반환한다. 세션 쿠키가 없는 `GET /api/auth/session`은 Real provider 미연결 상태에서도 익명 `200`을
반환할 수 있지만, 기존 쿠키가 남아 있으면 provider 검증 과정에서 `503`이 될 수 있다.

## 8. 관련 파일

- `../auth/authApiContract.ts`
- `communityApiContract.ts`
- `sample-responses.json`
- `FRONTEND_HANDOFF_JIYU.md`
- `DB_HANDOFF_NAYEON.md`
- `INTEGRATION_HANDOFF.md`
