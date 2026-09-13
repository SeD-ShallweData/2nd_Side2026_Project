# 현장 제보 API 명세

## 1. 목적과 분리 원칙

현장 제보는 사용자가 현장의 문제를 글이나 사진으로 비공개 접수하고 근로감독관이 확인하는 기능이다.
일반 커뮤니티 게시글과 게시글 신고(`community/posts/*/reports`)에는 저장하거나 노출하지 않는다.

- API 리소스명: `worksite-tips`
- 고정 분류값: `worksite_tip`
- 현재 저장소: 용량이 제한된 프로세스 메모리 Mock, 서버 재시작 시 초기화
- 실제 저장소: 별도 DB 테이블과 비공개 파일 저장소 설계 후 연결
- 프론트에서 분류값을 보내지 않고 서버가 고정한다.

## 2. 역할과 공개 범위

| 동작 | 비로그인 | `user` | `admin` | `inspector` |
| --- | --- | --- | --- | --- |
| 제보 접수 | 불가 | 가능 | 불가 | 불가 |
| 목록 조회 | 불가 | 불가 | 불가 | 가능 |
| 상세 조회 | 불가 | 불가 | 불가 | 가능 |
| 사진 조회 | 불가 | 불가 | 불가 | 가능 |

제보자는 접수 성공 영수증만 받는다. 현재 범위에는 본인 제보 목록·수정·삭제·철회와 감독관 처리 상태
변경이 포함되지 않는다. 제출자의 내부 ID는 저장하지만 응답에는 이메일·내부 사용자 ID·원본 파일명을
포함하지 않는다.

## 3. API 목록

| 메서드·경로 | 권한 | 설명 |
| --- | --- | --- |
| `POST /api/worksite-tips` | `user` | 글·사진 현장 제보 접수 |
| `GET /api/worksite-tips` | `inspector` | 최신순 제보 목록 |
| `GET /api/worksite-tips/{tipId}` | `inspector` | 제보 본문·사진 메타데이터 상세 |
| `GET /api/worksite-tips/{tipId}/attachments/{attachmentId}` | `inspector` | 인증된 사진 원본 조회 |

모든 응답은 `Cache-Control: no-store`를 사용한다. 사진 응답은 추가로
`X-Content-Type-Options: nosniff`를 사용한다.

## 4. 제보 접수

`multipart/form-data`만 지원한다.

| 필드 | 필수 | 제한 |
| --- | --- | --- |
| `title` | 필수 | 공백 제거 후 2~120자 |
| `body` | 선택 | 공백 제거 후 최대 5,000자 |
| `company_id` | 선택 | 최대 64자, Mock 사업장 기준 검증 |
| `photos` | 선택·복수 | JPEG·PNG·WebP, 최대 3장 |

본문과 사진 중 하나 이상은 반드시 있어야 한다. 사진은 장당 최대 5MiB, 전체 합계 최대 10MiB다.
브라우저가 선언한 MIME 타입과 실제 디코딩 결과가 일치해야 한다. 서버는 이미지 전체를 디코딩해 손상 여부를
확인하며, 한 변 10,000px 또는 전체 25MP를 넘는 이미지와 다중 프레임 이미지를 거부한다. SVG·HTML·PDF와
빈 파일은 받지 않는다. 한 요청에 첨부한 모든 사진의 픽셀 합계는 최대 40MP다.

접수 성공은 `201`이며 다음 값만 반환한다.

- `source`
- `tip_id`
- `category=worksite_tip`
- `title`
- `submitted_at`
- `attachment_count`

## 5. 감독관 조회

목록은 `page`와 `limit`을 지원한다. 기본값은 각각 1과 10이며 `limit`은 최대 20이다. 목록에는 본문 전체가
아니라 최대 160자의 `body_preview`와 사진 개수만 포함한다.

상세 응답에는 본문과 다음 사진 메타데이터가 포함된다.

- `attachment_id`
- `media_type`
- `size_bytes`
- 인증이 필요한 `content_url`

사진 URL도 세션의 `inspector` 권한을 다시 확인한다. URL의 제보 ID와 사진 ID가 실제 부모·자식 관계가
아니면 `404`를 반환한다.

## 6. 오류 계약

| 상태 | 주요 코드 | 의미 |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR`, `INVALID_MULTIPART`, `INVALID_IMAGE_FILE` | 입력·파일 형식 오류 |
| `401` | `AUTHENTICATION_REQUIRED` | 로그인 필요 |
| `403` | `FORBIDDEN`, `CROSS_SITE_REQUEST_REJECTED` | 역할 또는 요청 출처 오류 |
| `404` | `COMPANY_NOT_FOUND`, `WORKSITE_TIP_NOT_FOUND`, `WORKSITE_TIP_ATTACHMENT_NOT_FOUND` | 대상 없음 |
| `413` | `REQUEST_BODY_TOO_LARGE` | 사진 또는 요청 크기 초과 |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | multipart가 아니거나 지원하지 않는 사진 형식 |
| `503` | `WORKSITE_TIP_PROVIDER_UNAVAILABLE` | 실제 저장소 미연결 |
| `507` | `MOCK_STORAGE_LIMIT_REACHED` | 로컬 Mock 저장 한도 도달 |

## 7. Mock·Real 전환

- `WORKSITE_TIP_DATA_MODE=mock`: 메모리 Mock 저장소 사용
- 값이 없으면 `APP_DATA_MODE`를 따른다.
- Real 모드에서 실제 provider가 없으면 Mock 성공으로 대체하지 않고 `503`을 반환한다.

Mock 저장소는 프로세스 전체 100건, 제보자당 25건, 사진 원본 전체 50MiB, 제보자당 20MiB로 제한한다.
한도에 도달하면 기존 제보를 몰래 삭제하지 않고 `507`로 거부한다. 이는 로컬 개발 중 메모리 고갈을 막기 위한
정책이며 운영 저장·보존 정책으로 사용하지 않는다.

`0009` migration에는 현장 제보와 사진 테이블이 없다. 기존 migration을 수정하지 않고 나연 검토를 거친
새 forward migration과 비공개 파일 저장소가 준비된 후 Real adapter를 연결한다.

현재 Mock은 증거 원본 확인을 위해 업로드된 사진 바이트를 그대로 보관하므로 EXIF의 촬영 위치·시각·기기정보가
감독관에게 전달될 수 있다. 실제 저장소 연결 전 원본 증거 보존과 제보자 개인정보 보호 정책을 확정하고,
필요하면 접근 통제된 원본과 메타데이터를 제거한 표시용 사본을 분리한다.
