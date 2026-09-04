# 나연 전달용 — 현장 제보 DB·파일 저장 요청서

## 1. 전달 요약

현장 제보 API는 일반 커뮤니티 게시글·게시글 신고와 분리된 Mock 저장소로 구현했다. 로그인한 일반 사용자가
글·사진을 접수하고, 근로감독관만 목록·상세·사진을 조회한다.

기준 파일:

- API 계약: `product/src/app/api/worksite-tips/API_SPEC.md`
- 타입 계약: `product/src/app/api/worksite-tips/worksiteTipApiContract.ts`
- Mock 서비스: `product/src/services/worksiteTipService.ts`

## 2. 기존 `0009`와의 관계

`0009`의 `reports`는 커뮤니티 게시글 신고 전용이며 `post_id`를 필수로 요구한다. 현장 제보는 일반 게시글이
아니므로 해당 테이블을 재사용하지 않는다. `0009`를 수정하거나 재실행하지 않고, 다음 사용 가능한 번호의
forward migration으로 별도 테이블을 추가해야 한다.

## 3. 필요한 DB 구조

### `worksite_tips`

| 필드 | 의미 |
| --- | --- |
| `id` | 제보 UUID |
| `reporter_id` | 제보자 `users.id` FK, 내부에서만 사용 |
| `category` | `worksite_tip` 고정값 또는 CHECK |
| `title` | 제목 |
| `body` | 본문, 사진만 접수한 경우 nullable |
| `firm_id` | 연결 사업장 FK, nullable |
| `submitted_at` | 접수 시각 |

본문과 첨부사진이 모두 없는 제보를 DB에서도 막을지, 애플리케이션에서만 보장할지 검토가 필요하다.

### `worksite_tip_attachments`

| 필드 | 의미 |
| --- | --- |
| `id` | 사진 UUID |
| `tip_id` | `worksite_tips.id` FK |
| `storage_key` | 비공개 객체 저장소 키, unique |
| `media_type` | `image/jpeg`, `image/png`, `image/webp` |
| `size_bytes` | 파일 크기 |
| `sha256` | 파일 무결성·중복 확인용 해시 |
| `created_at` | 저장 시각 |

사진 원본 바이트나 base64를 일반 API DTO에 넣지 않는다. DB에는 객체 저장소 키와 검증된 메타데이터를
저장하는 방식을 우선 검토한다.

## 4. 권한 요청

- 일반 공개·LLM용 DB 계정에는 두 테이블 접근권한을 주지 않는다.
- 제보 접수·감독관 조회용 최소권한 앱 계정 또는 분리된 계정을 결정한다.
- 앱은 인증 세션의 `auth_role=user`만 INSERT, `auth_role=inspector`만 SELECT를 수행하도록 제한한다.
- 사이트 관리자 `admin`에게 감독관 조회 권한을 자동으로 부여하지 않는다.
- `firms`는 사업장 표시를 위한 SELECT만 허용한다.

현재 `wg_community`를 확장할지 민감 제보용 별도 DB role을 만들지는 나연·윤빈 검토가 필요하다.

## 5. 비공개 사진 저장소 요청

- 공개 URL이 아닌 비공개 객체 저장소를 사용한다.
- 원본 파일명이 아니라 서버가 만든 저장 키를 사용한다.
- 사진 다운로드는 현재 API처럼 매 요청마다 감독관 세션을 확인하거나 짧은 만료시간의 서명 URL을 사용한다.
- 업로드 실패 시 DB 행과 객체가 서로 남지 않도록 보상 삭제 또는 트랜잭션 순서를 정한다.
- 악성 파일 검사, EXIF 위치정보 처리, 보존기간과 삭제·철회 정책을 운영 전 확정한다.
- 현재 API의 JPEG·PNG·WebP 실제 디코딩, 단일 프레임, 최대 10,000px·25MP·5MiB/장 검증과 같거나 더
  엄격한 검증을 Real 업로드 경로에도 적용한다.
- Mock의 메모리 저장 한도와 `507`은 개발 환경 보호용이므로 운영 DB의 제보 보존·할당량 정책으로 복사하지 않는다.

## 6. Real adapter 연결 전 필요한 전달물

- 새 migration 파일과 staging 적용 결과
- 확정된 테이블·컬럼·제약·인덱스
- 제보용 DB 계정과 실제 권한 검증 결과
- 앱이 사용할 DB 환경변수명
- 객체 저장소 업로드·다운로드 방식과 secret 전달 경로
- seed 사용자와 사업장 식별값
- 백업·rollback·테스트 데이터 초기화 방법

## 7. 현재 미포함 범위

- 제보자 본인 목록·상세 조회
- 제보 수정·삭제·철회
- 감독관 접수·처리·종결 상태 변경
- 사진 외 동영상·문서
- 제보자 이메일·연락처 노출

위 기능은 개인정보·증거 보존·행정 처리 정책을 먼저 정한 뒤 별도 계약으로 추가한다.
