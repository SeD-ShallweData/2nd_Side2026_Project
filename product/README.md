# 돈워리 통합 제품 기준본

AI Rookie 및 창의종합설계 경진대회를 위한 구직자·근로자용 노동 정보 서비스입니다. 기본 실행은 명시된 데모 데이터이며, Real 모드에서는 읽기 전용 PostgreSQL·공식 노동법 RAG·계약서 분석 서비스를 Next.js 통합 API 뒤에 연결합니다. 상담 답변은 Upstage Solar와 SKT A.X API를 동시에 호출해 비교합니다.

이 디렉터리는 `jcu_branch`의 통합 프로토타입을 초기 기준으로 만든 팀 공용 제품 작업 공간입니다. 기준 정보와 이후 개발 원칙은 [PRODUCT.md](PRODUCT.md)를 참고하세요.

## 지금 시연할 수 있는 흐름

1. 사업장명 일부 또는 한 글자로 검색
2. 같은 이름의 여러 사업장을 주소·업종으로 구분
3. 임금 정보와 지역×업종 산업안전 참고정보를 별도 카드로 확인
4. 같은 공식 RAG 근거를 사용한 Upstage·SKT 상담 답변과 성능 지표 비교
5. 계약서 파일 형식·크기 검사 후 실제 분석 또는 명시된 데모 검토 결과 확인
6. 담당 개발본 통합 전 커뮤니티 UI 범위 확인

`정상`은 안전 사업장 인증이나 입사 추천을 뜻하지 않습니다. 산업안전 카드는 개별 사업장의 사고 확률이 아니라 지역×업종 단위의 참고 신호이며, 데이터가 없으면 추정하지 않고 `정보 부족`으로 표시합니다.

## 실행 환경

- Node.js 22
- Next.js 16 / React 19 / TypeScript
- 데이터 모드: `mock`(기본값) 또는 `real`, 사업장·계약서 기능별 독립 전환 가능
- 상담 모드: Upstage Solar + SKT A.X 실제 API 병렬 비교

### 전체 기능 실행 방법

상담 RAG와 계약서 분석까지 사용하려면 실행 중인 터미널이 총 3개 필요합니다. Python 패키지 설치는
최초 한 번만 하면 되고, 설치에 사용한 터미널은 설치가 끝난 뒤 실행용 터미널로 다시 사용해도 됩니다.

#### 1. 최초 설치 — 한 번만 수행

먼저 저장소 안의 `product`로 이동합니다. 개인 폴더명과 저장소 위치가 다르면 자신의 경로에 맞게
앞부분만 바꿉니다.

```bash
cd /data/shared-SeD/내폴더/2nd_Side2026_Project/product
```

현재 AI Rookie 서버에서는 프로젝트용 Node.js 22를 PATH에 추가한 뒤 패키지를 설치합니다.

```bash
export PATH=/data/shared-SeD/jcu0304/.local/node-v22.23.2-linux-x64/bin:$PATH
node --version
npm install
```

`node --version`이 `v22`로 시작하면 정상입니다. 개인 PC에서 Node.js 22를 이미 설치했다면 `export`
줄은 필요 없습니다.

환경설정 파일도 최초 한 번만 만듭니다.

```bash
cp .env.example .env.local
```

이미 `.env.local`을 수정했다면 위 명령을 다시 실행하지 않습니다. 다시 복사하면 기존 설정이
`.env.example` 내용으로 초기화됩니다. 기본값은 사업장과 계약서가 Mock이며 RAG와 두 LLM은 실제
서비스 주소를 사용합니다. 실제 계약서 파일 분석도 켜려면 `.env.local`에서 다음 값만 변경합니다.

```env
COMPANY_DATA_MODE=mock
CONTRACT_DATA_MODE=real
```

그러면 계약서만 실제 분석으로 바뀌고 사업장 DB는 Mock으로 유지됩니다.

이어서 같은 설치 터미널에서 RAG와 계약서 분석용 Python 가상환경을 각각 준비합니다.

```bash
cd integrations/rag-api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cd ../contract-api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cd ../..
pwd
```

마지막 `pwd` 결과가 `.../2nd_Side2026_Project/product`인지 확인합니다. `.venv` 폴더는 Git에 올라가지
않으므로 새 서버나 개인 PC에서는 최초 설치를 다시 해야 합니다.

#### 2. 매번 실행 — 터미널 3개 사용

VS Code에서 터미널을 3개 엽니다. 각 터미널의 PATH와 현재 폴더는 서로 독립적일 수 있으므로,
세 터미널 모두 `product`로 이동하고 서버에서는 Node.js PATH를 설정합니다.

터미널 1 — 공식 노동법 RAG:

```bash
cd /data/shared-SeD/내폴더/2nd_Side2026_Project/product
export PATH=/data/shared-SeD/jcu0304/.local/node-v22.23.2-linux-x64/bin:$PATH
npm run dev:rag
```

최초 실행은 BGE-M3 모델을 올리느라 시간이 걸립니다. 아래 두 문구가 나온 뒤 다음 단계로 갑니다.

```text
RAG 모델과 노동법 컬렉션을 불러왔습니다.
Running on http://127.0.0.1:5051
```

`unauthenticated requests to the HF Hub` 경고는 모델 다운로드 속도·한도 안내이며, 위 정상 문구가
나오면 실행에는 문제가 없습니다.

터미널 2 — 계약서 분석:

```bash
cd /data/shared-SeD/내폴더/2nd_Side2026_Project/product
export PATH=/data/shared-SeD/jcu0304/.local/node-v22.23.2-linux-x64/bin:$PATH
npm run dev:contract
```

다음처럼 프로바이더와 `8000` 포트가 표시되면 정상입니다.

```text
프로바이더: upstage, skt
Running on http://127.0.0.1:8000
```

브라우저가 이 포트의 `/`에 접근해 `404`를 남겨도 정상입니다. 계약서 서버는 홈페이지가 아니라
Next.js가 호출하는 내부 API를 제공합니다.

터미널 3 — 통합 웹 UI와 API:

```bash
cd /data/shared-SeD/내폴더/2nd_Side2026_Project/product
export PATH=/data/shared-SeD/jcu0304/.local/node-v22.23.2-linux-x64/bin:$PATH
npm run dev
```

`Ready`와 `http://localhost:3000`이 표시되면 브라우저에서 `http://서버주소:3000`으로 접속합니다.
다른 포트를 사용하려면 `npm run dev -- -p 3001`처럼 실행합니다. 세 프로세스는 터미널을 닫거나
`Ctrl+C`를 누를 때까지 계속 실행되어 있어야 합니다.

#### 3. 연결 상태와 RAG 확인

브라우저에서 `http://서버주소:3000/api/system/status`를 열면 비밀값 없이 연결 상태를 확인할 수
있습니다. 정상적인 실제 연동 예시는 다음과 같습니다.

```json
{
  "integrations": {
    "rag": "ready",
    "contract_analysis": "ready",
    "dual_llm": "ready"
  }
}
```

노동 상담 화면에서는 다음처럼 구체적인 법률 질문을 입력해 RAG를 확인합니다.

```text
임금이 체불됐을 때 체불임금 확인서는 어떻게 발급받나요? 공식 법령 근거와 함께 알려주세요.
```

정상이라면 비교 결과에 `공식 근거 N개 연결`, 두 모델의 동일한 국가법령정보센터 출처가 표시되고,
RAG 터미널에는 `POST /api/retrieve ... 200` 로그가 남습니다. 응답 상세의 `공식 근거 검색`도
`matched`로 표시됩니다. RAG는 상담 데이터 모드와 무관하게 한 번 검색한 같은 근거를 두 LLM에
전달합니다.

실행 중 `npm: command not found`가 나오면 그 터미널에서 Node.js PATH의 `export` 명령을 다시
실행합니다. `가상환경이 없습니다`가 나오면 1단계의 `python3 -m venv`와 `pip install`을 다시
확인합니다.

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

실제 데이터는 `src/adapters/real`의 어댑터와 `integrations`의 내부 서비스로 연결합니다.

- `RealCompanyRepository.ts`: DB 사업장 검색
- `MlRiskProvider.ts`: 임금 모델 및 산업안전 참고정보 변환
- `DualLlmChatProvider.ts`: Upstage·SKT 실제 병렬 상담 및 가드레일
- `HttpRagRetriever.ts`: 제품 내부 RAG 검색 서비스 연결
- `RealContractReviewProvider.ts`: 계약서 분석

상담 키는 기본적으로 `/data/shared-SeD/api_key.env`에서 서버 런타임에만 읽습니다. 이 파일을 프로젝트로 복사하지 않으며 API 키나 원본 계약서는 Git에 저장하지 않습니다. 실제 DB/ML 어댑터는 `.env.local`에서 `COMPANY_DATA_MODE=real`, 계약서 분석은 `CONTRACT_DATA_MODE=real`로 독립 전환하며 자동 Mock fallback은 기본적으로 꺼져 있습니다.

## 설계 문서

- [MVP 범위](docs/mvp-scope.md)
- [시스템 구조](docs/system-architecture.md)
- [API 계약](docs/api-contract.md)
- [서비스 정책](docs/service-policy.md)
- [데모 시나리오](docs/demo-scenarios.md)
