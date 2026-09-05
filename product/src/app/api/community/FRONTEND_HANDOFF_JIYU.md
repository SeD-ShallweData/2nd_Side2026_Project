# 지유 전달용 — 인증·커뮤니티 프론트 연결서

## 1. 전달 요약

민규 브랜치에는 로그인·세션과 커뮤니티 게시글·신고·관리자 검토 Mock API가 구현되어 있다.
현재 `product/src/components/community/CommunityBoard.tsx`는 네 개의 정적 게시물을 직접 사용하므로
API 연결은 지유 작업 범위다.

| 전달 항목 | 경로 |
| --- | --- |
| 전체 API 명세 | `product/src/app/api/community/API_SPEC.md` |
| 인증 타입 | `product/src/app/api/auth/authApiContract.ts` |
| 커뮤니티 타입 | `product/src/app/api/community/communityApiContract.ts` |
| 응답 예시 | `product/src/app/api/community/sample-responses.json` |
| 통합 배경 | `product/src/app/api/community/INTEGRATION_HANDOFF.md` |

## 2. 연결 순서

1. 앱 또는 커뮤니티 첫 진입에서 `GET /api/auth/session`으로 세션을 복원한다.
2. `GET /api/community/posts`로 목록을 가져와 정적 `POSTS`를 교체한다.
3. `source`, `capabilities`, `viewer_permissions`로 DEMO·버튼·HUD 상태를 결정한다.
4. 로그인·로그아웃 UI를 `POST /api/auth/login`, `POST /api/auth/logout`에 연결한다.
5. 글 작성·수정·삭제·신고 UI를 연결하고 성공 후 세션 또는 목록을 다시 조회한다.
6. 관리자 화면 담당이 확정되면 신고 목록·승인·기각 API를 연결한다.
7. 플랫폼 승인 뒤 API 호출 코드는 유지하고 Mock provider가 실제 DB provider로 바뀌는지 회귀 확인한다.

세션 토큰은 HttpOnly 쿠키이므로 프론트 상태·localStorage·URL에 저장하지 않는다. 같은 웹 origin에서
일반 `fetch`를 사용하고 로그인 성공 후 세션을 다시 조회한다.

목록을 렌더링할 때 React key는 수정될 수 있는 제목이 아니라 `post_id`를 사용한다.

## 3. 현재 화면 필드 매핑

| 현재 `CommunityBoard` 표시 | API 사용 |
| --- | --- |
| 카테고리 버튼 | 요청 `category`, 응답 `category`, `category_label` |
| 검색 입력 | `q` query |
| 지역 · 업종 | `company_context.region`, `company_context.industry` |
| 작성자 | `author_label`; null이면 `익명` |
| 12분 전 같은 시간 | `created_at`을 상대 시간으로 변환 |
| 댓글 수 | `comment_count`; 작성 기능은 `comments=false`이면 비활성화 |
| 공감 수 | `like_count`; `reactions=false`이면 버튼 비활성화 |
| 수정·삭제·신고 | `viewer_permissions` 값을 그대로 사용 |
| DEMO 안내 | `source=mock_memory`이면 유지 |

`company_context` 전체가 null이면 연결 사업장 없음으로 표시한다. 객체는 있지만 지역 또는 업종이
null이면 각각 `지역 미확인`, `업종 미확인`으로 표시한다.

## 4. HUD·버튼 기준

| 조건 | 화면 처리 |
| --- | --- |
| `capabilities.write=false` | 글쓰기 UI 숨김 또는 로그인 유도 |
| `capabilities.comments=false` | 댓글 작성 UI 비활성화, 기존 count는 표시 가능 |
| `capabilities.reactions=false` | 공감 버튼 비활성화, 예시 count를 실제 반응으로 오해하지 않도록 표시 |
| `capabilities.reports=false` | 신고 진입 숨김 |
| `capabilities.moderation=false` | 관리자 HUD 숨김 |
| `viewer_permissions.can_edit=true` | 수정 버튼 노출 |
| `viewer_permissions.can_delete=true` | 삭제 버튼 노출 |
| `viewer_permissions.can_report=true` | 신고 버튼 노출 |

프론트에서 사용자 ID와 게시글 작성자를 비교해 권한을 다시 계산하지 않는다. 서버가 제공한 권한값을
사용하고, 서버의 `401/403`도 최종 권한 판단으로 처리한다.

`capabilities.reports=true`는 로그인 사용자의 전역 기능 상태이고 특정 글의 버튼은
`viewer_permissions.can_report`가 기준이다. 현재 `can_report`에는 과거 중복 신고 여부가 반영되지 않으므로
재신고 시 `409 DUPLICATE_REPORT`를 받아 버튼 상태를 갱신해야 한다.

## 5. 필요한 화면 상태

| 상태 | 기준 | 권장 처리 |
| --- | --- | --- |
| 초기 로딩 | 세션·목록 요청 중 | skeleton 또는 로딩 안내 |
| 빈 목록 | `items=[]`, `total=0` | 검색·분류 조건에 맞는 글 없음 |
| 로그인 필요 | `401` | 로그인 UI로 연결, 성공 후 원래 동작 재시도 여부 결정 |
| 권한 부족 | `403` | 기능을 사용할 권한 없음 |
| 대상 없음 | `404` | 삭제·숨김·존재하지 않는 글 안내 |
| 상태 충돌 | `409` | 중복 신고, 이미 처리됨, 수정 불가 상태를 코드별 안내 |
| 입력 오류 | `400`, `413`, `415` | `error.details`를 해당 입력 근처에 표시 |
| provider 미연결 | `503` | 실제 기능 준비 중 또는 잠시 사용할 수 없음, Mock 성공으로 표시하지 않음 |
| 예상 밖 오류 | `500` | 재시도 안내와 `request_id` 보존 |

오류 문구 비교 대신 `error.code`를 사용한다. 성공·실패 후 화면 갱신 중 버튼을 중복 클릭하지 못하게 한다.
장애 문의 화면에서는 `request_id`를 복사할 수 있게 하는 방안을 권장한다. 빈 목록은 `page=1`이면서
`total_pages=0`일 수 있으므로 페이지 버튼을 만들지 않는다.

## 6. 권장 사용자 시나리오 테스트

1. 비로그인 목록 조회: 글쓰기·신고·관리 HUD가 권한에 맞게 보이는지 확인한다.
2. 일반 사용자 로그인: 세션 복원과 본인 글 작성·수정·삭제를 확인한다.
3. 타인 글 신고: 본인 글에는 신고 버튼이 없고 동일 글 중복 신고는 `409`인지 확인한다.
4. 감독관 로그인: 커뮤니티 일반 기능은 가능하지만 감독관 전용 API 접근으로 오해하지 않는지 확인한다.
5. 관리자 로그인: 신고 목록을 조회하고 승인 시 공개 목록에서 글이 사라지는지 확인한다.
6. 로그아웃: 사용자별 버튼이 즉시 사라지고 세션이 복원되지 않는지 확인한다.
7. 서버 재시작: Mock 게시글·신고가 seed 상태로 초기화되는 DEMO 한계를 표시한다.

## 7. 현재 제한과 지유에게 필요한 결정

- 댓글·공감 API는 이번 범위가 아니므로 작성 UI는 아직 연결하지 않는다.
- 목록 API는 공개 글만 반환한다. 숨김 글은 ID를 아는 작성자·관리자만 상세 조회할 수 있다.
- 회원가입·비밀번호 재설정·이메일 인증 화면은 이번 범위가 아니다.
- 관리자 신고 HUD를 지유가 맡을지 별도 담당자가 맡을지 윤빈과 확정이 필요하다.
- 로그인 UI 위치, 모바일 동작, 성공 toast, 오류 문구는 지유 디자인 기준으로 결정이 필요하다.
- 공통 API client·공통 타입 위치 변경은 윤빈 검토 후 진행한다.
- 현재 UI와 API seed의 사업장 표시는 일부 다르다. 서울·서비스업 글은 API에서 서울특별시·정보통신업,
  경기·제조업 글은 충청남도·제조업으로 나온다. API는 기존 Mock 사업장 기준이므로 최종 표시 기준을
  윤빈과 확정한다.
- 현재 UI의 작성자 표시는 다양하지만 API seed 네 글은 모두 익명이라 연결 후 모두 `익명`으로 보인다.
- 작성 화면의 사업장 선택 목록은 커뮤니티 API가 별도로 제공하지 않는다. 기존 사업장 검색을 연결하거나
  이번 단계에서는 `company_id=null`을 허용한다.
- 관리자 신고 응답에는 신고자 신원과 `reviewed_by`가 없다. 관리자 HUD에서 필요하면 개인정보 목적과
  사용 화면을 명시해 계약 변경을 요청한다.
- 같은 Mock 계정의 새 로그인은 이전 세션을 폐기한다. 여러 사람이 같은 계정으로 동시에 시험하지 않는다.
- 별도 프론트 개발 서버처럼 다른 origin에서 API를 호출하면 변경 요청이 `403`이 된다. 현재는 동일 Next.js
  웹의 상대경로 호출을 기준으로 한다.
- 신고 사유·처리 상태의 한글 표시명은 아직 공통 계약이 없다. 지유가 필요한 문구안을 윤빈에게 확인한다.
- 현재 GitHub 계정 쓰기 권한 문제로 브랜치 push가 보류되어 있다. push 완료 전에는 로컬 문서로만 검토한다.

정적 화면을 API로 교체할 때 기존 DEMO 배너의 “작성·댓글·신고는 제공하지 않는다” 문구와
`aria-label="더미 커뮤니티 게시물"`도 실제 지원 범위에 맞게 수정한다.

## 8. 지유에게 확인 요청

- API 연결을 시작할 브랜치명과 예상 완료일
- 로그인 UI와 관리자 HUD의 담당 범위
- 현재 응답 필드로 구현하기 어려운 UI 상태
- 필요한 추가 endpoint·필드와 사용 화면
- `401`, `403`, `404`, `409`, `503`별 화면 처리안
- Mock 연결 완료 후 민규에게 필요한 API 수정 요청
- 현재 UI와 API seed 중 어느 사업장·작성자 표시를 기준으로 할지
- 신고 사유·처리 상태 한글 문구와 관리자 화면의 신고자·검토자 표시 필요 여부

## 9. 전달 메시지

지유님, `task/auth-community-api`에 인증·커뮤니티 Mock API를 구현했습니다. 현재 커뮤니티 화면은 정적
데이터이므로 `API_SPEC.md`와 `FRONTEND_HANDOFF_JIYU.md` 기준으로 연결 부탁드립니다. 세션 토큰은
HttpOnly 쿠키라 프론트에 저장하지 않고, 버튼은 `capabilities`와 `viewer_permissions`로 노출해 주세요.
댓글·공감은 아직 미지원입니다. 연결 전에 부족한 필드나 상태가 있으면 어느 화면에서 어떤 형식으로
필요한지 알려주세요. commit/PR 링크는 GitHub 권한 승인 후 전달하겠습니다.
