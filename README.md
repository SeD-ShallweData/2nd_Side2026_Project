# 돈워리 (Money Worry)

AI Rookie 및 창의종합설계 경진대회를 위한 팀 프로젝트 저장소입니다.

이 저장소는 팀원별 프로토타입을 원형에 가깝게 보존하고, 검토가 끝난 기능만 별도의 통합 제품으로 발전시키는 구조를 사용합니다.

## 저장소 구조

| 경로 | 역할 |
| --- | --- |
| [`prototypes/`](prototypes/) | 팀원별 프로토타입과 작업 기록 보존 |
| [`product/`](product/) | 최종 통합 제품 개발 공간 |
| [`db/`](db/) | PostgreSQL 스키마·마이그레이션·ML 결과 적재 도구 |
| [`docs/`](docs/) | 팀 공용 회의록·API 계약·통합 설계 문서 |
| [`infra/`](infra/) | 배포·컨테이너·운영 설정 |

## 보존된 프로토타입

| 프로토타입 | 원본 | 주요 내용 |
| --- | --- | --- |
| [`prototypes/jcu/`](prototypes/jcu/) | `jcu_branch` | Next.js 기반 통합 UI, Mock/Real 어댑터, 두 LLM 비교 |
| [`prototypes/csh/`](prototypes/csh/) | PR #1의 `cshproj/` | Flask 상담, 프롬프트·가드레일, 계약서 규칙 엔진 |
| [`prototypes/hb-rag/`](prototypes/hb-rag/) | `hb-rag-bot`의 `webapp/` | 법령 Chroma RAG, 계약서 검토, 검색·생성 평가 |
| [`prototypes/hss-db/`](prototypes/hss-db/) | `feat/db` | DB 기여 범위와 원본 커밋 안내 |

프로토타입은 개인 작업을 보존하고 비교하기 위한 공간입니다. 실제 통합 개발은 [`product/`](product/)에서 진행하며, 프로토타입을 직접 운영 코드로 간주하지 않습니다.

## 개발 흐름

1. 최신 `main`에서 기능 브랜치를 만듭니다.
2. 통합 제품 변경은 주로 `product/`에서 진행합니다.
3. 필요한 경우 `db/`, `docs/`, `infra/`를 함께 수정합니다.
4. 검증 후 Pull Request로 `main`에 반영합니다.
5. `main` 직접 push와 force push는 사용하지 않습니다.

## 보안과 데이터

- API 키, `.env`, 원본 계약서와 개인정보는 Git에 저장하지 않습니다.
- 가상환경, 모델 캐시, 실행 로그와 재생성 가능한 대용량 산출물은 추적하지 않습니다.
- ML 운영 DB(PostgreSQL)와 노동법 RAG DB(Chroma)는 역할과 접근 권한을 분리합니다.
- 대용량 원본 데이터는 별도 저장소에 보관하고 복원 절차만 문서화합니다.

각 프로토타입의 실행법과 제약은 해당 폴더의 README를 참고하세요.
