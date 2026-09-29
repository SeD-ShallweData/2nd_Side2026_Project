# 답변 품질 잔여 작업 4 — provider/RAG 로컬 연결 준비

2026-09-29. 연결 진단만 수행했다. 작업 1~3의 답변 수정, 작업 10 원본 평가·답변·FAIL, 제품 생성 로직, DB/schema/migration, 운영 설정·계정·배포는 변경하지 않았다. 예정했던 최종 답변 품질 회귀는 **작업 5**다.

## 환경·키 로딩과 실행 경로

- 실행 작업 디렉터리는 `product/`다. Next는 그곳의 `.env.local`을 읽고, `SHARED_API_KEY_FILE=../api_key.env`는 **프로젝트 루트**의 파일을 가리킨다. 파일이 존재하며 `Upstage_API_KEY`와 `SKT_API_KEY` 항목이 비어 있지 않다. 셸의 공급자 `process.env` 값은 없었지만, 실제 `getLlmProviderConfigs()` → `getServerSecret()`을 호출한 일회성 Vitest에서 두 `apiKey`가 모두 로드됐다. 테스트 파일은 즉시 제거했다. 값·길이·해시는 출력하거나 저장하지 않았다.
- 별도 Node 프로브는 Next처럼 `.env.local`을 자동으로 읽지 않으므로 `product/`에서 `node --env-file=.env.local ...`로 실행했다. 기존 일부 평가 스크립트는 `.env.local`을 자체 파싱하므로 그 역시 `product/` cwd가 필요하다. `apiKeyLoader.ts`의 상대경로는 `readFileSync` 호출 프로세스의 cwd를 따른다. 작업 1~3의 “공유 키 파일 없음”은 프로젝트 루트에서 상대경로를 해석한 **진단 오류**다. 이전 호출 0회·미검증 기록은 유지한다.
- `.env.local`의 `CHAT_EXECUTION_MODE=dual_api`는 `/api/chat`을 `chatComparisonService`로 보낸다. `compare=false`인 단일 요청은 **Upstage만**, `compare=true`는 **Upstage와 SKT 둘 다** 선택한다. 이번 연결 확인은 각 공급자를 제품의 `OpenAICompatibleChatClient.complete`와 동일한 모델·엔드포인트 설정으로 한 번씩 직접 호출했다. 전체 `/api/chat`, 분류/질문 재작성/가드/저장 경로를 실행했다는 뜻은 아니다.

| 공급자 | 설정 엔드포인트 | 요청 모델 | 실제 반환 모델 |
| --- | --- | --- | --- |
| Upstage | `https://api.upstage.ai/v1/chat/completions` | `solar-pro3` | `solar-pro3-260323` |
| SKT | `https://awf-gw.adot.ai/v1/chat/completions` | `A.X-K1` | `A.X-K1` |

## 외부 요청 권한과 실제 연결

질문은 개인 정보가 없는 짧은 합성 문장 하나였다. `OpenAICompatibleChatClient`의 요청 형식과 각 설정을 사용했고, 답변 본문·인증 헤더·비밀값은 저장하지 않았다. 최초 샌드박스 요청은 양쪽 모두 HTTP 이전 `EACCES`였다. 동일 요청을 도구의 **정식 권한 승인 경로**에서 각 1회 재확인하자 둘 다 HTTP 200이므로, 초기 차단은 실행 샌드박스의 네트워크 권한 경계로 확인됐다. 보안 설정을 바꾸지 않았다.

| 공급자 | 시도 | HTTP 응답 | 비어 있지 않은 답변 | 지연 | 반환 usage | 종료 |
| --- | ---: | --- | --- | ---: | --- | --- |
| Upstage | 1: 샌드박스 | 없음, `EACCES` | 미확인 | 235ms | 없음 | 요청 전 차단 |
| SKT | 1: 샌드박스 | 없음, `EACCES` | 미확인 | 50ms | 없음 | 요청 전 차단 |
| Upstage | 2: 승인 경로 | 200 | 예 | 1,290ms | 입력 80 / 출력 48 / 총 128, cached 48 / reasoning 0 | `length` — 연결 검사에 둔 48토큰 상한 |
| SKT | 2: 승인 경로 | 200 | 예 | 532ms | 입력 20 / 출력 12 / 총 32, cached·reasoning 미제공 | `stop` |

합계 **시도 4, HTTP 응답 2, 정상 인증 및 비어 있지 않은 생성 2**다. Upstage 답변은 토큰 상한에서 잘렸으므로 완성도 평가에 쓰지 않는다. 공급자 계정·계약 정책, 원시 답변의 사실 정확성, 비용은 판정하지 않았다. 같은 조건의 실패를 추가 재시도하지 않았다.

## 실제 HTTP RAG

- 시작 전 `127.0.0.1:5051`에는 수신 서버가 없었다. 기존 `run.sh`는 Linux/CPython 3.12.13용이다. 이번 Windows 로컬에서는 이미 설치된 `.venv/Scripts/python.exe` **3.12.10**과 설치된 Flask/Chroma/Torch/Transformers를 사용했다. `prepare_rag_assets.py verify`가 봉인 모델·원본 Chroma 다섯 파일과 manifest SHA-256 `f67ceeb88695eb9f681839bee857ea00e6b8f59853981180a13df547323b30d0`을 확인했다.
- 기존 `stage-runtime`으로 원본 Chroma 다섯 파일을 `product/.runtime/aq04-rag-local/chroma`에 복제하고, 프로세스 전용 `RAG_INTERNAL_TOKEN`·오프라인 모델·`RAG_DB_PATH` 등을 지정해 Flask를 **127.0.0.1:5051만** 수신하도록 임시 기동했다. 다운로드·원본 인덱스 재생성·영구 등록은 없었다. 기동 시 모델/컬렉션 고정 질의 호환성 검사가 통과했다.
- 실제 `POST /api/retrieve` **6회**(아래 서로 다른 합성 질문 4개, URL 확인을 위한 2회 반복)는 모두 HTTP 200이었다. 앱 내부 `reviewed_applicability_bundle`이나 정책 대체 답변은 이 수치에 넣지 않았다.

| 합성 검색 질문 | 실제 HTTP 결과와 출처 적합성 |
| --- | --- |
| 정기 급여일·미지급액 확인 | `matched`, `official_guide`, 2건. 근로기준법 제43조의 정기 지급과 고용노동부 노동포털의 진정 절차가 질문의 두 부분에 직접 맞고 공식 URL이 있다. |
| 퇴직 뒤 미지급 임금 기한 | `matched`, 벡터 5건. **제36조 금품 청산**만 질문의 14일 임금 지급 기한을 직접 뒷받침한다. 앞의 대지급금·지연이자·퇴직금/연금 문서는 이 정확한 주장에 바로 쓰면 안 되고, 이 5건의 반환 source URL은 비어 있었다. HTTP 연결 성공을 다섯 근거의 적합성 PASS로 세지 않는다. 실제 제품은 이 유형을 별도 검토한 bundle로 처리할 수 있으나, 그것도 이번 HTTP 벡터 결과로 세지 않았다. |
| 산업재해보상보험 신청 기준 | `no_match`, `out_of_scope`, 0건. 현재 Chroma 범위 밖이라는 처리와 일치한다. |
| S17 원문에 포함된 근무시간 누락 | `no_match`, `distance_threshold`, 0건. 연결은 성공했지만 사용할 공식 근거는 확보하지 못했다. 작업 3의 근거 없는 제한 응답 경로가 적용될 수 있다. |

기동한 프로세스는 종료했고 5051 수신이 해제됐다. 생성한 임시 Chroma 복제본만 경로 확인 후 제거했다. 종료 후 원본 봉인 검증 재통과, 원본 DB 파일 5개 유지. 현재 **RAG 프로세스는 실행 중이지 않다**.

## 작업 5 재현과 판정

1. `product/`를 cwd로 사용한다. Next 앱은 `.env.local`을 읽는다. 별도 Node 프로브는 `node --env-file=.env.local --experimental-transform-types --input-type=module -`로 시작해 `src/server/envText.ts`의 `parseEnvText`, `src/adapters/real/OpenAICompatibleChatClient.ts`를 import한다. `process.env.SHARED_API_KEY_FILE`을 그대로 읽고 공급자별 `apiKey`의 **존재 여부만** 확인한 후 합성 메시지 하나를 `complete`에 보낸다. 코드의 `server-only`/별칭 경로를 벗어나 직접 실행한 진단이며, 실제 제품 로더는 위 Vitest로 따로 확인했다. `--experimental-strip-types`만 쓰면 클라이언트의 TypeScript parameter property 때문에 실행 전에 실패한다. 토큰·헤더·답변 원문을 출력하지 않는다.
2. RAG는 `product/integrations/rag-api/`를 cwd로 사용한다. Windows 로컬의 기존 Python은 `.venv/Scripts/python.exe`; Linux 재현은 기존 `./run.sh`와 고정 CPython 3.12.13을 따른다. Windows에서는 `prepare_rag_assets.py verify` 후 `stage-runtime --manifest <절대 manifest> --hf-home <절대 .cache/huggingface> --hub-cache <그 하위 hub> --rag-db <절대 data/labor_law_db> --runtime-rag-db <새 임시 디렉터리/chroma>`로 복제한다. `RAG_INTERNAL_TOKEN`은 `product/.env.local`에서 **프로세스 환경으로만** 읽고 명령 인자에 넣지 않는다. `RAG_DB_PATH`는 복제본, `HF_HOME`/`HF_HUB_CACHE`는 기존 봉인 모델, `RAG_HOST=127.0.0.1`, `RAG_PORT=5051`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `RAG_MODEL_LOCAL_ONLY=1`, `RAG_REQUIRE_ASSET_SEAL=1`, `RAG_ASSET_MANIFEST`는 기존 manifest로 지정한다. 나머지 모델/문서 수/거리 pin은 `run.sh`와 manifest를 따른다. 이어 `.venv/Scripts/python.exe app.py`를 실행하고 동일 토큰으로 `POST http://127.0.0.1:5051/api/retrieve`에 `{"query":"임금이 밀렸을 때 어떻게 해야 하나요?","limit":5}`를 보낸다. 원본 DB를 실행 경로에 직접 지정하지 않는다.
3. 외부 공급자 요청은 이 환경의 기본 샌드박스에서 HTTP 전 `EACCES`이므로, 작업 5에서도 허용된 **정식 권한 경로**가 필요하다. 키·토큰을 인자/로그/보고서에 넣지 않는다. 임시 RAG 복제본과 자신이 시작한 프로세스만 종료·제거하고, 본 검증의 결과를 작업 10 PASS로 소급하지 않는다.

**작업 5 연결 준비 판정:** Upstage와 SKT의 제품 클라이언트 수준 인증·비어 있지 않은 생성, 로컬 RAG의 실제 HTTP 검색이 각각 확인돼 제한된 실제 provider/RAG 회귀를 시작할 수 있다. 단, RAG를 다시 임시 기동해야 하고, 퇴직 기한 벡터 검색처럼 문서별 적합성·URL을 직접 걸러야 한다. 전체 `/api/chat`·비교 동시 실행·원시/가드/최종 답변 품질은 아직 미검증이다. 이번 원인은 경로 해석·샌드박스 권한·미기동 서버로 구분됐으므로 현재 **Astra High 전환을 요하는 미규명 원인은 없다**. 작업 5에서 원문→검색→생성 입력→원시→가드→최종을 추적해도 원인이 계속 불명확하면 구조 변경 전에 Astra High 재진단을 사용자에게 알린다.
