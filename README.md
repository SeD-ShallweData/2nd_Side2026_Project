# 2nd_Side2026_Project

AI Rookie & 창의종합설계 경진대회 참여 프로젝트.

현재 리포에 올라온 작업물은 [cshproj/](cshproj/) — **돈워리(Money Worry)** 프로토타입입니다.
커뮤니티 기반 AI 일터위험 조기경보 플랫폼으로, 이전 프로젝트의 임금체불 기업 평가모델과 산재위험 예측 모델을
국내 LLM(Upstage Solar, SKT A.X)에 연결합니다.

| 기능 | 무엇을 | 어떻게 |
|---|---|---|
| **AI 상담** `/chat` | 임금체불·산재 상담 | 같은 질문을 두 모델에 보내 답변을 나란히 비교 |
| **근로계약서 진단** `/contract` | 계약서가 법정 기준에 맞는지 | Document Parse로 읽고 규칙 엔진이 코드로 판정, 해설만 LLM |

## 실행

```bash
cd cshproj
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # 최초 1회
./scripts/fetch_fonts.sh                                            # 최초 1회 (선택)
.venv/bin/python scripts/check_env.py                               # 키·경로·프롬프트·API 점검
./run.sh                                                            # http://localhost:8000
```

API 키는 리포에 없습니다. `cshproj/config.example.env`를 참고해 환경변수(`Upstage_API_KEY`, `SKT_API_KEY`)를 채웁니다.

---

## 파일 설명

### 루트

| 파일 | 설명 |
|---|---|
| [README.md](README.md) | 이 문서 |
| [.gitignore](.gitignore) | Python 표준 규칙 + 프로젝트 전용 제외 항목 (아래 [추적하지 않는 것](#추적하지-않는-것)) |
| [cshproj/](cshproj/) | csh 작업물 전부 — 백엔드·프런트·프롬프트·지식·문서 |

### cshproj/ — 최상위

| 파일 | 설명 |
|---|---|
| [README.md](cshproj/README.md) | 프로젝트 상세 문서. 설계 원칙, 구조, API 목록 |
| [CLAUDE.md](cshproj/CLAUDE.md) | 작업 환경 규약 — 서버 경로, venv, API 키 취급 규칙, git 규칙 |
| [requirements.txt](cshproj/requirements.txt) | 의존성. Flask / requests / python-dotenv (+ 더미 PDF 생성용 reportlab) |
| [run.sh](cshproj/run.sh) | 개발 서버 실행 스크립트. venv 확인 후 `app.main` 기동 |
| [config.example.env](cshproj/config.example.env) | 로컬 설정 템플릿. 실제 키가 든 `config.env`는 추적하지 않음 |
| [test_api.py](cshproj/test_api.py) | 두 LLM API가 실제로 응답하는지 확인하는 연결 테스트 |

### cshproj/app/ — 백엔드 (Flask)

| 파일 | 설명 |
|---|---|
| [main.py](cshproj/app/main.py) | 라우트 정의 및 앱 엔트리포인트 |
| [config.py](cshproj/app/config.py) | 경로·API 키·모델명·기능 스위치의 단일 출처. 키 파일 로딩 실패를 삼키고 사유만 기록 |
| [llm.py](cshproj/app/llm.py) | Upstage / SKT 공통 클라이언트. 스트리밍(SSE) 지원 |
| [prompts.py](cshproj/app/prompts.py) | 프롬프트와 지식 문서를 조립. 파일을 고치면 서버 재시작 없이 반영 |
| [chat.py](cshproj/app/chat.py) | 상담 파이프라인 — 질의 재작성 → 답변 생성 → 가드레일 (2회 호출 체이닝) |
| [guardrails.py](cshproj/app/guardrails.py) | 출력 후처리 필터 12규칙. 위험 점수·등급 표현 차단 등 |
| [demo.py](cshproj/app/demo.py) | 더미 데이터. 관측 사실 / 확인 체크리스트 / 지역·업종 맥락의 3레이어 스키마 |
| [store.py](cshproj/app/store.py) | 대화·평가·피드백 로그 저장 |

### cshproj/app/contract/ — 근로계약서 진단

| 파일 | 설명 |
|---|---|
| [parse.py](cshproj/app/contract/parse.py) | Upstage Document Parse 호출. PDF·사진·HWP → 마크다운 |
| [schema.py](cshproj/app/contract/schema.py) | 조항 추출 스키마와 모델 출력 정규화 |
| [standards.py](cshproj/app/contract/standards.py) | 최저임금·근로시간 등 법정 기준과 근거 조문의 단일 출처 |
| [rules.py](cshproj/app/contract/rules.py) | **규칙 엔진** — 판정을 LLM이 아니라 코드로 계산 |
| [review.py](cshproj/app/contract/review.py) | 진단 흐름 조립: 파싱 → 추출 → 판정 → 해설 |
| [guard.py](cshproj/app/contract/guard.py) | 계약서 답변 전용 가드레일 |

### cshproj/prompts/ — 프롬프트 작업 공간

| 경로 | 설명 |
|---|---|
| [registry.json](cshproj/prompts/registry.json) | 페르소나 정의 — 조립 순서, 지식 범위, 추천 질문 |
| [system/base/](cshproj/prompts/system/base/) | 모든 페르소나 공통. `00-계약.md`(4요소) · `10-형식.md` · `20-가드레일.md` |
| [system/persona/](cshproj/prompts/system/persona/) | 종합 / 임금체불 / 산재 / 계약서 진단 4종 |
| [contract/extract.md](cshproj/prompts/contract/extract.md) | 계약서 조항 구조화 추출 프롬프트 |
| [rewrite/query_rewrite.md](cshproj/prompts/rewrite/query_rewrite.md) | 멀티턴 후속 질문 → 독립 질문 재작성 |
| [few_shot/](cshproj/prompts/few_shot/) | 페르소나별 모범 답변 예시 (각 3개, JSONL) |

### cshproj/knowledge/ — 사전 투입 지식

프롬프트에 주입되는 정제 문서입니다. `_source/`는 업로드 원본이며 로드되지 않습니다.

| 폴더 | 설명 |
|---|---|
| [common/](cshproj/knowledge/common/) | 서비스 정의 · 상담 창구 · 표현 규칙 |
| [wage/](cshproj/knowledge/wage/) | 임금체불 — 관측지표 · 확인 체크리스트 · 대응절차 · 제도기준 |
| [safety/](cshproj/knowledge/safety/) | 산재 — 경보체계 · 신호해석 · 산재절차 |
| [contract/](cshproj/knowledge/contract/) | 계약서 — 법정기준 · 독소조항 · 대응절차 |
| [_source/](cshproj/knowledge/_source/) | 원본 자료 (발표자료, 예시집, 학습노트) |

### cshproj/web/ — 프런트엔드 (빌드 없음)

| 경로 | 설명 |
|---|---|
| [index.html](cshproj/web/index.html) | 랜딩 — 위험카드, 커뮤니티, 서비스 소개 |
| [chat.html](cshproj/web/chat.html) | AI 상담 — 두 모델 동시 비교 |
| [contract.html](cshproj/web/contract.html) | 근로계약서 진단 — 파일 업로드 후 판정 결과 |
| [css/](cshproj/web/css/) | `tokens.css` → `base.css` → 화면별(`landing`/`chat`/`contract`) 순서로 계단식 |
| [js/](cshproj/web/js/) | 화면별 스크립트 + 공용 `icons.js` |
| [assets/logo/](cshproj/web/assets/logo/) | 돈워리 로고·파비콘 (SVG) |
| [assets/figma/](cshproj/web/assets/figma/) | Figma에서 추출한 아이콘·일러스트 21종 |

### cshproj/scripts/ — 도구

| 파일 | 설명 |
|---|---|
| [check_env.py](cshproj/scripts/check_env.py) | 키·경로·프롬프트·API를 한 번에 점검. 문제 발생 시 첫 번째로 실행 |
| [eval_prompts.py](cshproj/scripts/eval_prompts.py) | 프롬프트 평가. `--compare`로 두 모델 답변을 나란히 확인 |
| [check_consistency.py](cshproj/scripts/check_consistency.py) | 같은 질문을 반복해 답변 일관성 측정 |
| [compare_models.py](cshproj/scripts/compare_models.py) | Upstage vs SKT 부문별 성능 비교 |
| [make_contract_samples.py](cshproj/scripts/make_contract_samples.py) | 더미 근로계약서 3종(정상·부당·경계) PDF 생성 |
| [check_contract_api.py](cshproj/scripts/check_contract_api.py) | 계약서 진단 API 동작 확인 |
| [build_static.py](cshproj/scripts/build_static.py) | 정적 산출물 빌드 |
| [set_local_keys.py](cshproj/scripts/set_local_keys.py) | 팀 공용 키 파일을 못 읽을 때 로컬 `config.env`를 임시 생성 |
| [fetch_fonts.sh](cshproj/scripts/fetch_fonts.sh) | Noto Sans KR 웹폰트 내려받기 (3.7MB, 리포에는 없음) |

### cshproj/tests/ — 테스트

| 파일 | 설명 |
|---|---|
| [test_guardrails.py](cshproj/tests/test_guardrails.py) | 출력 필터 12규칙 회귀 테스트 |
| [test_contract_rules.py](cshproj/tests/test_contract_rules.py) | 규칙 엔진 판정 로직 |
| [test_contract_guard.py](cshproj/tests/test_contract_guard.py) | 계약서 전용 가드레일 |
| [test_contract_samples.py](cshproj/tests/test_contract_samples.py) | 더미 계약서 3종에 대한 기대 판정 |
| [questions.jsonl](cshproj/tests/questions.jsonl) | 프롬프트 평가용 질문 23문항 |

### cshproj/docs/ — 작업 기록

코드만 봐서는 알 수 없는 결정과 근거, 실패한 시도까지 남긴 곳입니다. 목차는 [docs/README.md](cshproj/docs/README.md).

| 문서 | 설명 |
|---|---|
| [00-작업기록.md](cshproj/docs/00-작업기록.md) | 무엇을 언제 왜 했는지, 시간순 기록 |
| [10-프롬프트-설계.md](cshproj/docs/10-프롬프트-설계.md) | 계약 4요소 · 조립 순서 · 체이닝 |
| [11-프롬프트-개선이력.md](cshproj/docs/11-프롬프트-개선이력.md) | 평가에서 발견한 실패와 수정 내역 |
| [20-가드레일.md](cshproj/docs/20-가드레일.md) | 후처리 필터 12규칙과 설계 이유 |
| [30-디자인-반영.md](cshproj/docs/30-디자인-반영.md) | Figma → 코드 매핑, 시안과 달라진 부분 |
| [40-평가-방법.md](cshproj/docs/40-평가-방법.md) | 무엇을 어떻게 측정하는가 |
| [50-더미데이터.md](cshproj/docs/50-더미데이터.md) | 가상 기업 14건의 필드·출처 |
| [60-답변-일관성.md](cshproj/docs/60-답변-일관성.md) | 같은 질문에 같은 답이 나오게 한 방법 |
| [70-모델-비교.md](cshproj/docs/70-모델-비교.md) | Upstage vs SKT 8개 부문 비교 |
| [80-근로계약서-진단.md](cshproj/docs/80-근로계약서-진단.md) | Document Parse + 규칙 엔진, 판정 4단계 |
| [프롬프트_가이드.md](cshproj/docs/프롬프트_가이드.md) | 실무용 — 프롬프트를 고칠 때 보는 문서 |
| [ADR/](cshproj/docs/ADR/) | 되돌리기 어려운 결정 3건 (위험카드 표시정책, 스택 선택, 계약서 판정 표현) |

---

## 설계 제1원칙

> **특정 사업장에 위험 점수·등급·순위를 붙이지 않는다.**
> 예측은 "무엇을 확인해 보라"는 **질문으로 변환**해서만 사용자에게 전달한다.

아직 체불하지 않은 사업장을 공개적으로 "위험"이라 부르면 사실이라도 명예훼손 소지가 있고,
산재 예측 단위(시도×업종×주차)를 개별 사업장에 적용하면 생태학적 오류입니다.
표현 취향이 아니라 서비스 존립 조건입니다 → [ADR-0001](cshproj/docs/ADR/0001-위험카드-표시정책.md)

## 추적하지 않는 것

| 대상 | 이유 |
|---|---|
| `*.env` (단 `*.example.env`는 제외) | API 키 유출 방지 |
| `cshproj/.venv/`, `__pycache__/` | 로컬 환경 산출물 |
| `cshproj/logs/` | 로컬 실행 로그 |
| `cshproj/data`, `outputs`, `design` | `/data/shared-SeD/csh/`로 이어지는 심볼릭 링크. 대용량 데이터·로그·디자인 원본 |
| `cshproj/web/assets/fonts/`, `web/css/fonts.css` | 웹폰트 3.7MB — `scripts/fetch_fonts.sh`로 내려받음 |

## git

- 작업 브랜치는 `csh-branch`. `main`에 직접 push하거나 `--force`를 쓰지 않습니다.
- `.gitignore`의 `*.env` 규칙은 제거하지 않습니다.
