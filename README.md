# 돈워리 통합 프로토타입

AI Rookie 및 창의종합설계 경진대회를 위한 구직자·근로자용 노동 정보 서비스입니다. 현재 버전은 실제 ML·LLM·RAG가 없어도 전체 사용자 흐름을 시연할 수 있는 Mock 기반 프로토타입입니다.

## 지금 시연할 수 있는 흐름

1. 사업장명 일부 또는 한 글자로 검색
2. 같은 이름의 여러 사업장을 주소·업종으로 구분
3. 임금 정보와 지역×업종 산업안전 참고정보를 별도 카드로 확인
4. 사업장 맥락이 포함된 상담과 다음 행동 체크리스트 확인
5. 계약서 파일 형식·크기 검사 후 Mock 검토 결과 확인

`정상`은 안전 사업장 인증이나 입사 추천을 뜻하지 않습니다. 산업안전 카드는 개별 사업장의 사고 확률이 아니라 지역×업종 단위의 참고 신호이며, 데이터가 없으면 추정하지 않고 `정보 부족`으로 표시합니다.

## 실행 환경

- Node.js 22
- Next.js 16 / React 19 / TypeScript
- 데이터 모드: `mock`(기본값) 또는 `real`

이 서버에서 프로젝트 전용 Node.js를 사용할 때:

```bash
cd /data/shared-SeD/jcu0304/2nd_Side2026_Project
export PATH=/data/shared-SeD/jcu0304/.local/node-v22.23.2-linux-x64/bin:$PATH
npm install
cp .env.example .env.local
npm run dev
```

브라우저에서 `http://서버주소:3000`으로 접속합니다. 다른 포트를 사용하려면 `npm run dev -- -p 3001`처럼 실행합니다.

## 검증 명령

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

## Mock 시연 데이터

- `OO건설`: 동명 사업장 2개가 검색되는 중복명 시나리오
- `한빛테크` / `Hanbit Tech`: 한글·영문 별칭 검색 시나리오
- `새봄서비스`: 임금 정보 부족 시나리오
- `푸른건설`: 산업안전 정보 부족 시나리오
- `미래산업`: 두 카드 모두 정보 부족인 시나리오
- `오래된물류`: 데이터 기준일 만료 시나리오
- 검색어 `error`: 검색 API 장애 화면 시연

사업장 상세 상담에서 “이 회사 안전해?”, “입사해도 돼?”처럼 결론을 요구하면 단정하지 않고 확인 기준과 행동 순서를 안내합니다. 긴급한 체불·산재 표현은 공식 상담·신고 경로를 우선 안내합니다.

## API

- `GET /api/companies/search?q=사업장명`
- `GET /api/companies/{company_id}/risk`
- `POST /api/chat`
- `POST /api/contracts/review`

상세 요청·응답 형식과 정책은 [API 계약](docs/api-contract.md), [서비스 정책](docs/service-policy.md)을 참고하세요.

## 실제 데이터 연결 위치

UI와 서비스 계층은 그대로 두고 `src/adapters/real`의 네 어댑터를 구현하면 됩니다.

- `RealCompanyRepository.ts`: DB 사업장 검색
- `MlRiskProvider.ts`: 임금 모델 및 산업안전 참고정보 변환
- `RealChatProvider.ts`: LLM/RAG 상담
- `RealContractReviewProvider.ts`: 계약서 분석

`.env.local`에서 `APP_DATA_MODE=real`로 바꾸기 전에는 연결되지 않은 어댑터가 명시적인 `503`을 반환합니다. API 키나 원본 계약서는 Git에 저장하지 않습니다.

## 설계 문서

- [MVP 범위](docs/mvp-scope.md)
- [시스템 구조](docs/system-architecture.md)
- [API 계약](docs/api-contract.md)
- [서비스 정책](docs/service-policy.md)
- [데모 시나리오](docs/demo-scenarios.md)
