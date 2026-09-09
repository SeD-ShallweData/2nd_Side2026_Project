# 로컬 DB 백업·복원 시험 기록

- 시험일: 2026-08-28
- 환경: 로컬 Docker PostgreSQL (postgres:16-alpine)
- 컨테이너: wageguard-nayeon-db-1 (compose project: wageguard-nayeon)
- 대상 DB: wageguard (migration 0000~0009 적용, 테이블 12개)
- 시험자: 나연 (task/user-db-migration)

## 1. 목적

로컬 개발 환경에서 데이터베이스 백업(pg_dump)과 복원(pg_restore)이
정상적으로 작동하는지 검증한다. 실제 운영 배포 전, 백업 절차 자체가
믿을 수 있는지 미리 확인해두는 것이 목적이다.

## 2. 시험 절차

### 2-1. 백업- 포맷: custom format (`-F c`, 압축·pg_restore 전용)
- 결과: `wageguard_backup.dump` 139,787 bytes 생성 확인 (0바이트 아님)

### 2-2. 복원 테스트용 DB 생성- 결과: `CREATE DATABASE` 성공, 원본 `wageguard` DB는 그대로 유지

### 2-3. 복원 실행- 결과: 에러 없이 완료

### 2-4. 복원 결과 검증
| 항목 | 원본(wageguard) | 복원본(wageguard_restore_test) | 일치 여부 |
|---|---|---|---|
| 테이블 개수 | 12개 | 12개 | ✅ |
| users 행 수 | 0 | 0 | ✅ |
| firms 행 수 | 0 | 0 | ✅ |

### 2-5. 정리- 결과: `DROP DATABASE` 성공

## 3. 결론

백업(pg_dump, custom format) → 복원(pg_restore) 절차가 에러 없이
작동하며, 테이블 구조(12개 전부)가 원본과 복원본에서 완전히 일치함을
확인했다.

## 4. 한계 및 후속 과제

- 이번 로컬 DB는 migration(스키마)만 적용된 상태로, **실제 ML 데이터
  (firms 등)와 seed 데이터가 아직 채워지지 않았다.** 그래서 이번 시험은
  "구조가 정확히 복원되는지"는 확실히 검증했지만, "대용량 실데이터가
  손실 없이 복원되는지"까지는 검증하지 못했다.
- 후속 과제: seed 데이터(또는 실제 ML 데이터) 적재 후 동일 절차로
  재시험해, 행 단위 데이터까지 손실 없이 복원되는지 확인 필요.
- 운영 환경 백업은 이번 로컬 절차와 별개로, 접근 권한·보관 위치·
  주기 등을 팀과 별도로 정해야 한다.
