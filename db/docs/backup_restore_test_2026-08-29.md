# 로컬 DB 백업·복원 시험 기록 (2차 — 스키마 재설계 이후)

- 시험일: 2026-08-29
- 환경: 로컬 Docker PostgreSQL (postgres:16-alpine)
- 컨테이너: wageguard-nayeon-db-1 (compose project: wageguard-nayeon)
- 대상 DB: wageguard (migration 0000~0009 적용, 테이블 13개)
- 시험자: 나연 (task/user-db-migration)
- 관련 기록: `backup_restore_test_2026-08-28.md` (1차 시험, 스키마 재설계 이전 상태)

## 1. 목적

민규의 `DB_HANDOFF_NAYEON.md`·`API_SPEC.md` 기준으로 users/posts/reports를
재설계하고 sessions 테이블을 추가한 뒤, 백업·복원 절차가 새 스키마에서도
여전히 정상 작동하는지 재검증한다.

## 2. 1차 시험(8/28) 이후 변경된 스키마

| 항목 | 8/28 | 8/29 |
|---|---|---|
| 테이블 개수 | 12개 | 13개 (sessions 신규) |
| posts.status 값 | 공개/신고접수/블라인드/삭제 | published/hidden/deleted |
| reports 구조 | target_type/target_id 다형적 | post_id 전용, snapshot 필드 추가 |
| users.auth_role | 없음 | 신규(user/admin/inspector) |
| v_posts | 존재(필터 없음) | 삭제, v_posts_public으로 대체 |

## 3. 시험 절차

### 3-1. 백업

- 결과: `wageguard_backup_0829.dump` 정상 생성 확인

### 3-2. 복원 테스트용 DB 생성

- 결과: `CREATE DATABASE` 성공

### 3-3. 복원 실행

- 결과: 에러 없이 완료 (첫 시도에서 명령어 두 줄이 한 줄로 합쳐져 실행되는
  실수가 있었으나, 한 줄씩 나눠 재실행 후 정상 처리)

### 3-4. 복원 결과 검증
| 항목 | 원본(wageguard) | 복원본(wageguard_restore_test) | 일치 여부 |
|---|---|---|---|
| 테이블 개수 | 13개 | 13개 | ✅ |

### 3-5. 정리

- 결과: `DROP DATABASE` 성공

## 4. 결론

재설계된 스키마(sessions 신규 추가, reports 구조 변경, users.auth_role 추가
등)에서도 백업(pg_dump, custom format) → 복원(pg_restore) 절차가 이상 없이
작동함을 재확인했다. 테이블 13개 전부 구조 손실 없이 복원됐다.

## 5. 한계 및 후속 과제 (1차 시험과 동일)

- 이번 로컬 DB도 여전히 seed 데이터가 없는 빈 상태다. 실제 데이터가 채워진
  뒤 동일 절차로 다시 검증할 필요가 있다.
- 운영 환경 백업은 이번 로컬 절차와 별개로 팀과 별도로 정해야 한다.

## 6. 작업 중 겪은 실수 (기록용)

명령어 두 줄을 터미널에 붙여넣을 때 줄바꿈이 무시되고 한 줄로 합쳐져,
`pg_dump`가 다음 줄의 `docker`까지 자기 인자로 잘못 받아들이는 에러가
발생했다. 여러 줄의 셸 명령어는 반드시 한 줄씩 나눠 입력·실행해야
안전하다는 걸 재확인했다.
