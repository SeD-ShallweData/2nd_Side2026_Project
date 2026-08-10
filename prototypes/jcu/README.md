# 돈워리 통합 프로토타입

AI Rookie 및 창의종합설계 경진대회를 위한 구직자·근로자용 노동 정보 서비스입니다. 사업장·Risk·계약서 데이터는 Mock 기반이며, 상담 답변은 실제 Upstage Solar와 SKT A.X API를 동시에 호출해 비교합니다.

## 지금 시연할 수 있는 흐름

1. 사업장명 일부 또는 한 글자로 검색
2. 같은 이름의 여러 사업장을 주소·업종으로 구분
3. 임금 정보와 지역×업종 산업안전 참고정보를 별도 카드로 확인
4. 사업장 맥락이 포함된 Upstage·SKT 상담 답변과 성능 지표 비교
5. 계약서 파일 형식·크기 검사 후 Mock 검토 결과 확인

`정상`은 안전 사업장 인증이나 입사 추천을 뜻하지 않습니다. 산업안전 카드는 개별 사업장의 사고 확률이 아니라 지역×업종 단위의 참고 신호이며, 데이터가 없으면 추정하지 않고 `정보 부족`으로 표시합니다.

## 실행 환경

- Node.js 22
- Next.js 16 / React 19 / TypeScript
- 데이터 모드: `mock`(기본값) 또는 `real`
- 상담 모드: Upstage Solar + SKT A.X 실제 API 병렬 비교

이 서버에서 프로젝트 전용 Node.js를 사용할 때:

```bash
cd /data/shared-SeD/jcu0304/2nd_Side2026_Project
export PATH=/data/shared-SeD/jcu0304/.local/node-v22.23.2-linux-x64/bin:$PATH
npm install
cp .env.example .env.local
npm run dev
```

브라우저에서 `http://서버주소:3000`으로 접속합니다. 다른 포트를 사용하려면 `npm run dev -- -p 3001`처럼 실행합니다.

## 팀 시연용 임시 배포

현재 서버의 실제 LLM 연동을 유지한 채 외부에 잠시 공개할 때는 Cloudflare Quick Tunnel을 사용합니다. 공개 전에 반드시 팀 전용 Basic 인증을 설정합니다.

```bash
export DEMO_BASIC_AUTH_USER="팀에 공유할 아이디"
export DEMO_BASIC_AUTH_PASSWORD="충분히 긴 임시 비밀번호"
npm run build
npm run start -- -H 127.0.0.1 -p 3111
```

별도 터미널에서 프로젝트 외부의 개인 도구 폴더에 설치한 `cloudflared`로 터널을 실행합니다.

```bash
/data/shared-SeD/jcu0304/.local/bin/cloudflared tunnel \
  --url http://127.0.0.1:3111 \
  --no-autoupdate
```

출력된 `https://...trycloudflare.com` 주소와 시연 계정만 팀원에게 전달합니다. 이 주소는 터널 프로세스가 실행되는 동안만 유효하며 재실행할 때 바뀔 수 있습니다. API 키는 URL, 브라우저 코드 또는 Git에 넣지 않습니다.

현재 AI Rookie 서버에서는 Cloudflare Tunnel 연결에 필요한 외부 7844 포트가 차단되어 있어 위 방식이 바로 동작하지 않습니다. 서버 관리자에게 네트워크 정책을 확인하기 전에는 아래 단일 HTML 시연본을 사용합니다.

### 서버 없는 단일 HTML 시연본

`exports/돈워리-통합프로토타입.html`을 내려받아 브라우저로 열면 됩니다. 사업장 검색, 정보 카드, 두 모델의 사전 생성 답변 비교, 계약서 Mock 검토가 파일 안에서 동작합니다.

- 실제 API와 LLM을 호출하지 않습니다.
- API 키나 내부 프롬프트를 포함하지 않습니다.
- 질문과 파일이 외부로 전송되지 않습니다.
- 답변 지연시간과 토큰 수는 실제 서비스 화면을 설명하기 위한 고정 예시입니다.

실제 LLM이 동작하는 공개 사이트 구조와 배포 선택지는 [배포 가이드](docs/deployment-guide.md)를 참고하세요.

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
- `오류확인사업장`: 상세 Risk 공급자 장애와 다시 시도 화면 시연
- 검색어 `error`: 검색 API 장애 화면 시연

사업장 상세 상담에서 “이 회사 안전해?”, “입사해도 돼?”처럼 결론을 요구하면 단정하지 않고 확인 기준과 행동 순서를 안내합니다. 두 모델에는 동일한 질문·컨텍스트·temperature·max token 설정을 적용합니다.

각 답변 카드에서 다음 비교 정보를 확인할 수 있습니다.

- 실제 응답 모델명과 성공·가드레일 교체·fallback 상태
- 전체 지연시간, 입력·출력·전체·캐시·추론 토큰
- 종료 사유, 답변 길이, 컨텍스트 연결 여부
- 정책 버전, 가드레일 탐지 규칙, 공급자 요청 추적 ID
- 출처, 다음 행동, 답변 한계

API 키와 숨은 시스템 프롬프트는 브라우저로 전송하지 않습니다. “더 유용한 답변” 평가는 질문·답변 원문 없이 `.runtime/comparison-feedback.jsonl`에 선택과 성능 지표만 저장합니다.

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
- `DualLlmChatProvider.ts`: Upstage·SKT 실제 병렬 상담 및 가드레일
- `RealChatProvider.ts`: 향후 RAG 오케스트레이션을 위한 자리표시자
- `RealContractReviewProvider.ts`: 계약서 분석

상담 키는 기본적으로 `/data/shared-SeD/api_key.env`에서 서버 런타임에만 읽습니다. 이 파일을 프로젝트로 복사하지 않으며 API 키나 원본 계약서는 Git에 저장하지 않습니다. 실제 DB/ML 어댑터는 `.env.local`에서 `APP_DATA_MODE=real`로 전환하기 전까지 Mock을 사용합니다.

## 설계 문서

- [MVP 범위](docs/mvp-scope.md)
- [시스템 구조](docs/system-architecture.md)
- [API 계약](docs/api-contract.md)
- [서비스 정책](docs/service-policy.md)
- [데모 시나리오](docs/demo-scenarios.md)
