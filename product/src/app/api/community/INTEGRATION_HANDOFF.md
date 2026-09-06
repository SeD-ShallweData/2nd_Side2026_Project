# 인증·커뮤니티 API 통합 인계 계약

## 전달용 분리 문서

- 공통 API 명세: `API_SPEC.md`
- 지유 프론트 연결서: `FRONTEND_HANDOFF_JIYU.md`
- 나연 DB 요청서: `DB_HANDOFF_NAYEON.md`
- 응답 예시: `sample-responses.json`

## 1. 현재 브랜치의 범위

이 구현은 AI 루키 제출 기준본 뒤에 추가하는 플랫폼 승인 전 Mock 백엔드다.

- `AUTH_DATA_MODE=mock`, `COMMUNITY_DATA_MODE=mock`에서만 메모리 저장소로 동작한다.
- `real` 모드에서 실제 사용자 DB가 없으면 `503`을 반환하며 Mock 성공으로 자동 전환하지 않는다.
- 회원가입, 비밀번호 변경, 이메일 인증, 댓글 작성, 공감, 리뷰·별점은 이번 범위가 아니다.
- 세션·게시글·신고는 프로세스를 재시작하면 초기화되며 다중 인스턴스 간 공유되지 않는다.
- 기존 `DEMO_BASIC_AUTH_*`는 시연 사이트 외곽 보호이고, 새 사용자 세션과 역할이 다르다.
- Mock `inspector` 역할은 권한 계약 시험용이며 `/api/inspector/*` 접근 권한을 부여하지 않는다.

커뮤니티 게시물은 사용자 경험이다. 공식 데이터, 법률 근거, 위험카드 또는 RAG 출처로 사용하지 않는다.

## 2. 로컬 Mock 설정

비밀번호는 Git이나 이 문서에 기록하지 않고 각자 로컬 환경변수로만 설정한다.

| 환경변수 | 의미 |
| --- | --- |
| `AUTH_DATA_MODE=mock` | 사용자 인증을 Mock 계정으로 실행 |
| `COMMUNITY_DATA_MODE=mock` | 커뮤니티를 메모리 저장소로 실행 |
| `MOCK_AUTH_USER_PASSWORD` | 일반 사용자 Mock 계정의 로컬 비밀번호 |
| `MOCK_AUTH_ADMIN_PASSWORD` | 관리자 Mock 계정의 로컬 비밀번호 |
| `MOCK_AUTH_INSPECTOR_PASSWORD` | 감독관 Mock 계정의 로컬 비밀번호 |
| `AUTH_SESSION_TTL_SECONDS` | 선택 설정, 기본 8시간, 허용 범위 15분~7일 |

Mock 이메일은 각각 `user@mock.donworry.local`, `admin@mock.donworry.local`,
`inspector@mock.donworry.local`이다. 세 계정의 비밀번호는 12자 이상이면서 반드시 서로 다르게 설정한다.

운영 빌드에서 Mock 인증을 사용하려면 `DEMO_BASIC_AUTH_USER`와
`DEMO_BASIC_AUTH_PASSWORD`가 모두 설정되어야 한다. 이 장치는 Mock 역할을 운영 인증으로 승격하기 위한
것이 아니라 외부 노출을 막는 팀 시연용 경계다.

## 3. API 목록

### 인증

| 메서드·경로 | 인증 | 설명 |
| --- | --- | --- |
| `POST /api/auth/login` | 없음 | 이메일·비밀번호 검증 후 HttpOnly 세션 쿠키 발급 |
| `POST /api/auth/logout` | 선택 | 현재 세션 폐기 및 쿠키 삭제, 반복 호출 가능 |
| `GET /api/auth/session` | 선택 | 로그인 여부·현재 사용자·만료 시각 반환 |
| `GET /api/users/me` | 필수 | 로그인 사용자 정보 반환 |

### 커뮤니티

| 메서드·경로 | 인증 | 설명 |
| --- | --- | --- |
| `GET /api/community/posts` | 선택 | `q`, `category`, `page`, `limit` 목록 조회 |
| `POST /api/community/posts` | 필수 | 게시글 작성 |
| `GET /api/community/posts/{postId}` | 선택 | 게시글 상세 조회 |
| `PATCH /api/community/posts/{postId}` | 작성자 | 본인 게시글 수정 |
| `DELETE /api/community/posts/{postId}` | 작성자 | 본인 게시글 삭제 |
| `POST /api/community/posts/{postId}/reports` | 필수 | 타인 게시글 신고 |
| `GET /api/community/moderation/reports` | 관리자 | 신고 목록 조회 |
| `PATCH /api/community/moderation/reports/{reportId}` | 관리자 | 신고 승인·기각 |

본문이 있는 상태 변경 요청은 JSON Content-Type만 허용하고 64KiB를 넘는 본문과 다른 출처의 브라우저
요청을 거부한다. 로그아웃과 게시글 삭제는 본문 없이 호출한다.
세션 응답과 사용자별 권한이 포함된 커뮤니티 응답에는 `Cache-Control: no-store`를 사용한다.

### 역할·권한 기준

| 동작 | 일반 사용자 | 관리자 | 감독관 |
| --- | --- | --- | --- |
| 공개 글 조회 | 가능 | 가능 | 가능 |
| 글 작성·본인 글 수정·삭제 | 가능 | 가능 | 가능 |
| 타인 공개 글 신고 | 가능 | 가능 | 가능 |
| 타인 글 수정·삭제 | 불가 | 불가 | 불가 |
| 신고 목록·승인·기각 | 불가 | 가능 | 불가 |
| `/api/inspector/*` 접근 | 별도 정책 | 별도 정책 | 이 Mock 역할만으로는 불가 |

오류 응답은 기존 제품의 `errorPayload` 구조를 그대로 사용한다. 주요 상태는 다음과 같다.

- `400 VALIDATION_ERROR`, `INVALID_JSON`: 요청값 또는 JSON 오류
- `401 AUTHENTICATION_REQUIRED`, `INVALID_CREDENTIALS`: 로그인 필요 또는 로그인 실패
- `403 FORBIDDEN`, `RESOURCE_OWNERSHIP_REQUIRED`, `CROSS_SITE_REQUEST_REJECTED`: 역할·작성자·출처 오류
- `404 COMPANY_NOT_FOUND`, `COMMUNITY_POST_NOT_FOUND`, `COMMUNITY_REPORT_NOT_FOUND`: 대상 없음
- `409 DUPLICATE_REPORT`, `SELF_REPORT_NOT_ALLOWED`, `COMMUNITY_POST_NOT_EDITABLE`,
  `COMMUNITY_POST_NOT_REPORTABLE`, `COMMUNITY_REPORT_ALREADY_REVIEWED`: 상태 충돌
- `413 REQUEST_BODY_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`
- `500 INTERNAL_ERROR`: 예상하지 못한 서버 오류
- `503 AUTH_PROVIDER_UNAVAILABLE`, `COMMUNITY_PROVIDER_UNAVAILABLE`, `MOCK_AUTH_NOT_CONFIGURED`,
  `MOCK_AUTH_PERIMETER_REQUIRED`: 저장소 또는 Mock 보안 설정 미연결

## 4. 지유 프론트엔드 인계

`communityApiContract.ts`를 커뮤니티 클라이언트의 타입 기준으로 사용한다.

현재 `CommunityBoard`의 표시값은 다음처럼 연결한다.

| 현재 화면 | API 필드·처리 |
| --- | --- |
| 카테고리 한글 | `category_label` |
| 지역 · 업종 | `company_context`가 `null`이면 연결 사업장 없음, 개별 필드가 `null`이면 각각 지역·업종 미확인 표시 |
| 작성자 | `author_label`; `null`이면 `익명` 표시 |
| 상대 시간 | `created_at`을 프론트에서 상대 시간으로 변환 |
| 댓글 수 | `comment_count`; 댓글 API는 아직 제공하지 않으므로 작성 UI 비활성화 |
| 공감 수 | Mock에서만 예시값, `capabilities.reactions=false`이면 공감 HUD 비활성화 |
| 수정·삭제·신고 버튼 | `viewer_permissions` 값을 그대로 사용 |

- 첫 진입 때 `GET /api/auth/session`으로 로그인 상태를 복원한다.
- `source=mock_memory`이면 현재 DEMO 배너를 유지한다.
- `capabilities`는 현재 로그인 사용자가 쓸 수 있는 기능을 나타낸다. `moderation=true`일 때만 관리 HUD를 노출한다.
- 로딩, 빈 목록, `401`, `403`, `404`, `409`, `500/503` 화면을 구분한다.
- 로그인·로그아웃 후 세션과 게시글 목록을 다시 조회한다.
- 공개 DTO에 없는 `author_id`, 이메일 또는 역할을 추정하거나 저장하지 않는다.

`sample-responses.json`은 클라이언트 Mock과 화면 상태 시험에 사용할 수 있다.

## 5. 나연 DB 인계

현재 `users`, `posts`, `comments`, `reviews`와 신원 제거 읽기 view는 기반으로 활용할 수 있지만 다음 차이를
검토된 migration으로 보완해야 한다.

1. `users.role`의 기존 의미(구직자·사업주·감독관)와 API 역할(`user`, `admin`, `inspector`)을 통일하거나
   명시적인 변환표와 CHECK 제약조건을 둔다.
2. 사용자 이메일 대소문자 중복을 막고 비밀번호 해시 형식·교체 정책을 확정한다.
3. 세션 테이블에는 원문 토큰이 아니라 토큰 해시, 사용자 FK, 생성·만료·폐기 시각을 저장한다.
4. `posts`에 안정적인 category 코드, 공개·숨김·삭제 상태, 수정·삭제 시각을 추가한다.
5. 신고 테이블에 게시글·신고자 FK, 사유, 상세, 대기·승인·기각 상태, 검토자와 처리 시각을 저장한다.
   신고 시점의 제목·본문·게시글 수정 시각 snapshot도 보존해 이후 수정과 검토 증거를 구분한다.
6. 동일 사용자의 동일 게시글 중복 신고 방지 조건과 목록·신고 조회 인덱스를 검토한다.
7. 공개 읽기는 계속 신원을 제거한 `v_posts_public` 같은 전용 view를 사용하고 category·상태·댓글 집계
   계약을 view에 반영한다. 앱의 작성자 권한·숨김 검토용 조회는 별도 보안 view/함수로 분리한다.
   익명 글은 작성자 역할도 `NULL` 처리하고, `hidden`·`deleted` 글은 공개 view에서 제외한다.
8. 공감은 대응 테이블이 없으므로 합의 전까지 실제 응답에서 `null`로 두고 UI를 비활성화한다.

기존 `wg_bot`과 `product/src/server/postgres.ts`의 읽기 전용 보장은 완화하지 않는다. 실제 쓰기는 별도
애플리케이션 연결과 최소권한 DB 계정을 만들고, 인증의 비밀번호 해시 조회와 커뮤니티 CRUD 권한도
가능하면 계정·pool 또는 컬럼 권한으로 분리한다. 신고 검토와 게시글 숨김은 하나의 트랜잭션에서 현재
상태를 조건부 확인한 뒤 처리한다.

## 6. 윤빈 통합 검토 요청

다음은 민규 담당 경로 밖이므로 이 브랜치에서 수정하지 않았다.

- 공용 `.env.example`, `product/README.md`, `product/docs/api-contract.md`에 새 계약 반영
- 실제 쓰기 DB 환경변수와 별도 connection pool·adapter 위치 확정
- `product/src/domain/**`에 공통 타입을 옮길지 여부
- `/api/system/status`에 인증·커뮤니티 상태를 추가할지 여부
- 기존 Basic 인증과 향후 역할 기반 감독관 접근의 전환 순서
- 운영 rate limit, 감사 로그, CSRF 추가 정책과 secret 등록
- Windows 한글 경로에서 `vitest.config.ts`의 URL pathname 별칭이 깨지는 문제를 `fileURLToPath` 방식으로 수정
- 현재 lockfile의 `nanoid@3.3.17` high 등급 의존성 경고를 공용 lockfile 갱신으로 해소

실제 DB 연결은 나연 migration·seed·최소권한 계정이 staging에서 확인된 뒤 진행한다.
