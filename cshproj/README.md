# 돈워리 (Money Worry)

커뮤니티 기반 AI 일터위험 조기경보 플랫폼.
이전 프로젝트의 **임금체불 기업 평가모델**과 **산재위험 예측 모델**을 국내 LLM(Upstage Solar, SKT A.X)과 연결합니다.

**현재 단계: 프로토타입.** RAG는 아직 없고, 프롬프트 엔지니어링으로 답변 품질을 올리는 중입니다.

기능은 둘입니다.

| | 무엇을 | 어떻게 |
|---|---|---|
| **AI 상담** `/chat` | 임금체불·산재 상담 | 같은 질문을 두 모델에 보내 답변을 나란히 비교 |
| **근로계약서 진단** `/contract` | 내 계약서가 법정 기준에 맞는지 | Document Parse로 읽고 **규칙 엔진이 코드로 판정**, 해설만 LLM |

## 실행

이 프로젝트는 리포지터리 안의 `cshproj/` 폴더입니다. 모든 명령은 이 폴더에서 실행합니다.

```bash
cd cshproj
.venv/bin/pip install -r requirements.txt   # 최초 1회
./scripts/fetch_fonts.sh                    # 최초 1회 (선택) — Noto Sans KR 로컬 서빙
.venv/bin/python scripts/check_env.py       # 키·경로·프롬프트·API 점검
./run.sh
```

| 주소 | 화면 |
|---|---|
| http://localhost:8000 | 랜딩 — 위험카드, 커뮤니티, 서비스 소개 |
| http://localhost:8000/chat | AI 상담 — **두 모델 동시 비교** |
| http://localhost:8000/contract | 근로계약서 진단 — PDF·사진을 올리면 조항을 법정 기준과 대조 |

계약서 진단을 처음 띄울 때는 예시 계약서를 먼저 만들어 두세요.

```bash
.venv/bin/pip install reportlab
.venv/bin/python scripts/make_contract_samples.py --download-font
```

## 이 서비스의 제1원칙

> **특정 사업장에 위험 점수·등급·순위를 붙이지 않는다.**
> 예측은 "무엇을 확인해 보라"는 **질문으로 변환**해서만 사용자에게 전달한다.

아직 체불하지 않은 사업장을 공개적으로 "위험"이라 부르면 사실이라도 명예훼손 소지가 있고,
산재 예측 단위(시도×업종×주차)를 개별 사업장에 적용하면 생태학적 오류입니다.
이건 표현 취향이 아니라 서비스가 존립하기 위한 조건입니다 → [ADR-0001](docs/ADR/0001-위험카드-표시정책.md)

그래서 화면과 답변이 3레이어로 나뉩니다.

```
관측 사실          명단 등재 여부, 가입자 51→38명, 결측 1개월     ← 실명과 함께 말해도 됨
확인 체크리스트     "4대보험 가입 여부를 확인하세요"               ← 예측을 질문으로 변환
지역·업종 맥락      인천 건설업 주의 — 개별 사업장 위험이 아님      ← 집계, 카드와 분리
```

## 구조

```
├── app/                    백엔드 (Flask)
│   ├── config.py             경로·키·모델·스위치
│   ├── llm.py                Upstage/SKT 공통 클라이언트 (스트리밍)
│   ├── prompts.py            프롬프트·지식 조립 (파일 수정 시 자동 반영)
│   ├── chat.py               2회 호출 체이닝 (재작성 → 생성 → 가드레일)
│   ├── guardrails.py         출력 후처리 필터 12규칙
│   ├── demo.py               더미 데이터 (3레이어 스키마)
│   ├── store.py              대화·평가·피드백 로그
│   ├── contract/           ★ 근로계약서 진단
│   │   ├── parse.py            Upstage Document Parse (PDF·사진·HWP → 마크다운)
│   │   ├── schema.py           추출 스키마 · 모델 출력 정규화
│   │   ├── standards.py        법정 기준·조문 단일 출처
│   │   ├── rules.py            ★ 규칙 엔진 — 판정을 코드로 계산
│   │   ├── review.py           파싱 → 추출 → 판정 → 해설
│   │   └── guard.py            계약서 전용 가드레일
│   └── main.py               라우트
│
├── prompts/                ★ 프롬프트 작업 공간
│   ├── registry.json         페르소나 정의 (조립 순서)
│   ├── system/base/          계약 4요소 · 형식 · 가드레일
│   ├── system/persona/       종합 / 임금체불 / 산재 / 계약서 진단
│   ├── contract/extract.md   계약서 조항 구조화 추출
│   ├── rewrite/              멀티턴 질의 재작성
│   └── few_shot/             모범 답변 예시 (페르소나당 3개)
│
├── knowledge/              ★ 사전 투입 지식
│   ├── _source/              업로드 원본 (로드 안 됨)
│   └── common/ wage/ safety/ contract/  정제본 → 프롬프트에 주입
│
├── web/                    프런트 (빌드 없음)
│   ├── index.html  chat.html  contract.html
│   ├── css/                  tokens → base → landing/chat/contract
│   └── assets/             ★ 디자인 리소스
│
├── docs/                   ★ 작업 기록 · 설계 문서 · ADR
├── scripts/                환경 점검 · 프롬프트 평가 · 더미 계약서 생성
├── tests/                  가드레일 · 규칙 엔진 회귀 테스트 + 평가 질문 23문항
│
├── data/    → /data/shared-SeD/csh/data      ★ 원본·정제 데이터
├── outputs/ → /data/shared-SeD/csh/outputs   ★ 대화로그·평가·피드백
└── design/  → /data/shared-SeD/csh/design    ★ 디자인 원본 (Figma 추출물)
```

★ 표시가 자료를 넣는 곳입니다. 각 폴더의 `README.md`에 방법이 적혀 있습니다.

| 넣을 것 | 어디에 |
|---|---|
| 챗봇이 알아야 할 지식 | [knowledge/](knowledge/README.md) |
| 원본 CSV·PDF·대용량 데이터 | [data/raw/](data/) |
| 웹에서 쓰는 로고·아이콘·폰트 | [web/assets/](web/assets/README.md) |
| 디자인 원본 (Figma·PSD) | [design/source/](design/) |
| (자동) 대화·평가·피드백 | [outputs/](outputs/) |

## 프롬프트 고치기

```bash
vi prompts/system/persona/wage_arrears.md              # 고치고
.venv/bin/python scripts/eval_prompts.py \
    --persona wage_arrears --compare --name v2         # 두 모델로 바로 확인
```

서버 재시작 없이 반영됩니다. 요령은 [docs/프롬프트_가이드.md](docs/프롬프트_가이드.md).

## 문서

작업 과정과 결정 근거를 전부 남겼습니다 — [docs/README.md](docs/README.md)

| | |
|---|---|
| [00-작업기록.md](docs/00-작업기록.md) | 무엇을 언제 왜 했는지, 실패한 것 포함 |
| [10-프롬프트-설계.md](docs/10-프롬프트-설계.md) | 계약 4요소 · 조립 순서 · 체이닝 |
| [11-프롬프트-개선이력.md](docs/11-프롬프트-개선이력.md) | 평가에서 발견한 실패와 수정 |
| [20-가드레일.md](docs/20-가드레일.md) | 후처리 필터 12규칙 |
| [30-디자인-반영.md](docs/30-디자인-반영.md) | Figma → 코드, 시안과 달라진 부분 |
| [40-평가-방법.md](docs/40-평가-방법.md) | 무엇을 어떻게 측정하는가 |
| [80-근로계약서-진단.md](docs/80-근로계약서-진단.md) | Document Parse + 규칙 엔진 · 판정 4단계 |
| [ADR/](docs/ADR/) | 되돌리기 어려운 결정 |

## API

| 경로 | 설명 |
|---|---|
| `GET /api/health` | 키·프롬프트·지식·스위치 상태 |
| `GET /api/personas` | 페르소나·모델 목록 |
| `POST /api/rewrite` | 호출 ① 후속 질문 → 독립 질문 |
| `POST /api/chat` | 한 번에 응답 |
| `POST /api/chat/stream` | SSE 스트리밍 (모델 비교는 이걸 2번 병렬 호출) |
| `POST /api/feedback` | "이쪽이 낫다" 투표 |
| `GET /api/demo/workplaces` | 더미 위험카드 (3레이어) |
| `GET /api/demo/community` | 더미 커뮤니티 글·지표 |
| `GET /api/contract/samples` | 더미 근로계약서 3종 (정상·부당·경계) |
| `POST /api/contract/review` | 계약서 파일 → Document Parse → 조항 추출 → **규칙 엔진 판정** |
| `POST /api/contract/explain/stream` | 판정 결과 → SSE 해설 (모델 비교는 이걸 2번 병렬 호출) |

## 규칙

- API 키는 팀 공용 원본 `/data/shared-SeD/api_key.env`를 절대경로로 참조합니다. **사본을 만들지 않습니다.**
- 대용량 파일은 홈이 아니라 `/data`에 둡니다 (홈 여유 20G).
- 작업 브랜치는 `csh-branch`. `main`에 직접 push하지 않습니다.
