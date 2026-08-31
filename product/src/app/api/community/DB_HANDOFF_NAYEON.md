# 나연 전달용 — 인증·커뮤니티 DB 요청서

## 1. 전달 요약

민규 브랜치의 인증·커뮤니티 API는 현재 프로세스 메모리 Mock 저장소를 사용한다. 실제 DB 연결은
나연의 staging migration·seed·권한 설정이 완료된 뒤 진행한다.

현재 DB에는 `users`, `posts`, `comments`, `reviews`와 `v_posts`, `v_comments`, `v_reviews`가 있지만
세션·게시글 상태·신고·관리자 처리 계약이 부족하다. 기존 migration을 직접 덮어쓰지 않고 새 migration으로
보완해야 한다.

| 전달 항목 | 경로 |
| --- | --- |
| API·필드 기준 | `product/src/app/api/community/API_SPEC.md` |
| 인증 타입 | `product/src/app/api/auth/authApiContract.ts` |
| 커뮤니티 타입 | `product/src/app/api/community/communityApiContract.ts` |
| 기존 통합 설명 | `product/src/app/api/community/INTEGRATION_HANDOFF.md` |

## 2. 기존 구조와 필요한 차이

| 현재 DB | API에 필요한 보완 |
| --- | --- |
| `users.email` 일반 unique | 대소문자 정규화 또는 case-insensitive unique 정책 |
| `users.role` text | API 역할 `user/admin/inspector`와 기존 업무 역할의 변환·제약 확정 |
| `users.password_hash` 존재 | 해시 알고리즘·교체·비활성 계정 정책 확정 |
| 세션 테이블 없음 | 토큰 해시·만료·폐기 가능한 세션 저장소 추가 |
| `posts`에 제목·본문·익명·firm·생성시각 | category, 상태, 수정·삭제 시각 추가 |
| 신고 테이블 없음 | 신고·검토·snapshot 저장소 추가 |
| `v_posts`가 작성자 역할 노출 | 익명 role 제거, 공개 상태 필터, 앱 내부 권한 조회와 분리 |
| `wg_bot` 읽기 전용 | 유지. 앱 쓰기는 별도 최소권한 계정·pool 사용 |

## 3. 사용자·역할 계약

필수 사용자 필드는 현재 `id`, `email`, `name`, `role`, `password_hash`, `created_at`을 기반으로 한다.

결정이 필요한 사항:

1. 기존 사용자 유형을 잃지 않도록 `role`을 바로 덮기보다 별도 `auth_role`을 추가하는 안을 우선 검토한다.
   구직자·사업주는 `user`, 감독관은 `inspector`로 초기 매핑하고 `admin`은 승인 계정에만 부여한다.
2. 허용 역할에 CHECK 제약 또는 enum을 둔다.
3. 이메일 trim·소문자 저장 또는 `citext`/함수 인덱스로 대소문자 중복을 막는다.
4. 비밀번호 해시를 조회하는 인증 계정과 커뮤니티 CRUD 계정을 분리할 수 있는지 검토한다.
5. 계정 비활성·잠금·비밀번호 교체 시 기존 세션을 폐기할 기준을 정한다.

`password_hash`, 이메일, 내부 사용자 ID는 공개 view와 LLM용 view에 포함하지 않는다.

## 4. 세션 테이블 요청

| 필드 | 권장 의미 |
| --- | --- |
| `id` | 세션 레코드 UUID 또는 내부 PK |
| `token_hash` | 원문 세션 토큰의 단방향 해시, unique |
| `user_id` | `users.id` FK |
| `created_at` | 발급 시각 |
| `expires_at` | 만료 시각 |
| `revoked_at` | 명시적 로그아웃·관리자 폐기 시각, nullable |
| `last_seen_at` | 필요 시 최근 사용 시각, nullable |

필수 조건:

- 원문 토큰은 저장하지 않는다.
- `token_hash` unique, `user_id`, `expires_at` 조회 인덱스를 검토한다.
- 만료 또는 폐기 세션을 조회 단계에서 거부한다.
- 현재 Mock 정책처럼 사용자당 활성 세션 하나를 유지할지 다중 기기를 허용할지 합의한다.
- 만료 세션 정리 작업과 보존 기간을 정한다.

## 5. 게시글 테이블 보완 요청

현재 `posts`를 기준으로 다음 필드를 보완한다.

| 필드 | 권장 형식·의미 |
| --- | --- |
| `category` | 안정적인 코드, API enum CHECK |
| `status` | `published`, `hidden`, `deleted`, 기본 `published` |
| `updated_at` | 마지막 수정 시각 |
| `deleted_at` | 작성자 삭제 시각, nullable |
| `hidden_at` | 관리자 숨김 시각, nullable |
| `hidden_by` | 처리 관리자 FK, nullable |

기존 `firm_id`는 API의 `company_id`와 이름을 다르게 사용하므로 adapter 변환을 명시한다. 사용자 요청의
지역·업종 문자열은 저장 근거로 신뢰하지 않고 `firms`에서 조회한다.

권장 제약·인덱스:

- category·status CHECK 또는 enum
- `status, created_at DESC` 공개 목록 인덱스
- `category, status, created_at DESC` 분류 목록 인덱스
- `author_id, status, created_at DESC` 작성자 조회 인덱스
- 검색 방식이 확정되면 제목·본문 검색 인덱스 별도 검토

작성자 삭제는 물리 삭제보다 상태 변경을 우선하되, 개인정보 보존·삭제 정책은 윤빈과 확정한다.

## 6. 신고 테이블 요청

| 필드 | 권장 의미 |
| --- | --- |
| `id` | 신고 UUID |
| `post_id` | 게시글 FK |
| `reporter_id` | 신고자 사용자 FK |
| `reason` | `spam`, `abuse`, `privacy`, `misinformation`, `other` |
| `detail` | 신고 상세, nullable |
| `status` | `pending`, `accepted`, `dismissed` |
| `created_at` | 신고 시각 |
| `reviewed_at` | 관리자 처리 시각, nullable |
| `reviewed_by` | 관리자 FK, nullable |
| `resolution_note` | 처리 메모, nullable |
| `snapshot_title` | 신고 당시 제목 |
| `snapshot_body` | 신고 당시 본문 |
| `snapshot_post_updated_at` | 신고 당시 게시글 수정 시각 |

필수 조건:

- 동일 `reporter_id, post_id` 중복 신고 방지 unique 정책
- `status, created_at DESC` 관리자 대기 목록 인덱스
- `post_id, created_at DESC` 게시글별 신고 조회 인덱스
- 본인 글 신고와 공개 상태가 아닌 글 신고는 애플리케이션과 DB 함수 중 어디에서 보장할지 합의
- snapshot은 신고 후 작성자가 글을 수정해도 바뀌지 않게 저장

신고 기각 후 같은 사용자의 재신고를 허용할지 현재 Mock처럼 계속 막을지도 확정이 필요하다.

## 7. 공개 view와 내부 조회 분리

현재 `v_posts`는 익명 글에서도 `author_role`을 노출한다. 역할 수가 적으면 재식별 단서가 될 수 있으므로
익명일 때 작성자 이름과 역할을 모두 null 처리해야 한다.

권장 분리:

| 조회 경로 | 목적 | 포함·제외 |
| --- | --- | --- |
| `v_posts_public` | 공개 웹·LLM용 | `published`만, author_id·이메일·비밀번호 제외, 익명 이름·역할 null |
| 앱 내부 ownership 조회 | 수정·삭제 권한 검사 | `author_id`, 상태 포함, 앱 최소권한 계정만 접근 |
| 앱 내부 moderation 조회 | 신고 검토·숨김 처리 | 현재 글과 snapshot, 검토 필드 포함, 관리자 서비스만 접근 |

기존 `wg_bot`에는 공개·신원 제거 view의 SELECT만 유지한다. 원본 `users`, `posts`, 신고 테이블이나 내부
권한 view를 부여하지 않는다.

## 8. 쓰기 계정·트랜잭션 요청

- `product/src/server/postgres.ts`의 SELECT-only 보장은 완화하지 않는다.
- 실제 쓰기는 별도 환경변수, connection pool, 최소권한 DB role을 사용한다.
- 인증 계정은 사용자 인증과 세션에 필요한 최소 컬럼·테이블만 접근한다.
- 커뮤니티 계정은 게시글·신고에 필요한 CRUD만 접근한다.
- migration role, 애플리케이션 role, loader role, `wg_bot`을 분리한다.
- 신고 승인과 게시글 숨김은 한 트랜잭션에서 처리한다.
- 처리 전 신고가 `pending`이고 게시글이 현재 숨김 가능한 상태인지 조건부 확인해 중복 처리를 막는다.
- 게시글 수정·삭제도 현재 상태 조건을 포함해 동시 요청 충돌을 감지한다.

## 9. migration drift 주의

`db/docs/MIGRATION_OPERATIONS.md` 기준 현재 상태는 다음과 같다.

- 로컬 journal은 `0000`~`0008`이다.
- 운영 DB ledger는 `0000`~`0005`다.
- `0006`, `0007`의 주요 객체는 실제 schema에 이미 존재한다.
- `0008`은 아직 적용되지 않은 상태로 기록되어 있다.

따라서 운영 DB에서 곧바로 migrate를 실행하거나 `drizzle-kit push`로 맞추지 않는다. 먼저 read-only drift
검사와 ledger reconciliation 절차를 완료한 뒤, 과거 migration을 수정하지 않고 다음 사용 가능한 번호의
새 migration을 추가한다. `schema.ts`, migration SQL, journal 변경은 같은 변경으로 관리하고 PostgreSQL 16
빈 DB 재현 시험과 staging backup·rollback 확인을 거친다. 이 경로는 공통 파일이므로 윤빈 검토가 필수다.

## 10. staging seed 요청

최소 seed는 다음 계정을 포함하되 비밀번호 원문은 migration이나 Git에 넣지 않는다.

- 일반 사용자 1명
- 관리자 1명
- 감독관 1명
- 공개 게시글 각 카테고리 1개 이상
- 숨김·삭제 게시글 상태 검증용 데이터
- 대기·승인·기각 신고 각 1개 이상
- 익명·실명 공개 view 검증 데이터

seed 비밀번호 해시는 승인된 별도 절차와 secret로 만든다. 실제 이메일 또는 개인식별정보 대신 staging 전용
식별값을 사용한다.

## 11. 나연 완료 후 민규에게 필요한 전달물

- migration 파일과 적용 순서
- staging 적용 결과와 rollback 방법
- 확정된 테이블·컬럼·enum·제약·인덱스 목록
- 앱 인증·커뮤니티용 DB 환경변수명과 권한 설명
- seed 계정 식별값과 secret 전달 방식
- 공개 view·내부 view/함수 명세
- 신고 승인 트랜잭션 호출 방식
- 최소권한 검증 결과
- 민규가 real adapter를 연결할 수 있는 시점

## 12. 나연에게 확인 요청

- 기존 `users.role`과 API 역할의 최종 매핑
- case-insensitive 이메일 unique 구현 방식
- 사용자당 활성 세션 수와 만료 세션 정리 정책
- 신고 기각 후 재신고 정책
- 상태 변경을 SQL 함수로 제공할지 애플리케이션 트랜잭션으로 처리할지
- 공개 view와 앱 내부 ownership·moderation 조회의 이름과 권한
- staging migration·seed 예상 완료일

## 13. 전달 메시지

나연님, `task/auth-community-api`에 인증·커뮤니티 Mock API를 구현했습니다. 실제 DB 연결을 위해
`DB_HANDOFF_NAYEON.md` 기준으로 사용자 역할·세션·게시글 상태·신고 snapshot·공개/내부 view·최소권한
쓰기 계정 설계를 검토 부탁드립니다. 기존 `wg_bot`과 `product/src/server/postgres.ts`의 읽기 전용 보장은
유지해야 합니다. migration·seed·환경변수명·권한 검증 결과가 나오면 그 계약에 맞춰 real adapter를
연결하겠습니다. commit/PR 링크는 GitHub 권한 승인 후 전달하겠습니다.
