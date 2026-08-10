# RAG 검증 / 평가 도구

법령 벡터DB(`labor_law`)의 **데이터 정합성**과 **검색 성능**을 확인하는 스크립트 모음.

## 공통 준비

```bash
cd webapp
export PYTHONPATH="$PWD/pylibs:$PWD/eval:$PYTHONPATH"
export HF_HOME="$PWD/hf_cache"
```

DB 경로는 `DONWORRY_DB_PATH` 환경변수로 지정한다(미지정 시 개발 서버 기본값).
`.env.example`을 `.env`로 복사해 쓰면 된다.

## 1-1. 법령 원문 대조

```bash
python3 eval/verify_laws.py         # 5개 법령 전체
python3 eval/verify_definitions.py  # 제2조(정의) 호 단위 분리 결과
```

`law.go.kr` Open API에서 원문 XML을 받아 DB chunk와 1:1로 비교한다.
파서 버그가 그대로 통과하는 걸 막기 위해 **`add_laws.parse_law`를 쓰지 않고**
원문 XML의 텍스트 노드에서 직접 기준값을 만든다.

검사 항목: 현행 MST/공포번호 · 조문번호 집합 · 본문 내용 · 조문 제목 · 시행일.
본문 불일치는 원인별로 자동 분류된다(조문내용 누락 / 인접 텍스트 혼입 / 부칙 혼입 / 구버전 잔존).

새 법령을 추가했다면 `verify_laws.py`의 `LAW_MST`에도 MST를 등록해야 한다.

## 1-2. 검색 성능 평가

```bash
python3 eval/run_eval.py
```

`questions.py`의 질문셋을 실제 검색 파이프라인(`bot.retrieve_context`)에 태워 채점한다.

- **POSITIVES**: 질문 + 검색되어야 할 조문(허용 집합). top-1/3/5 정답률 산출
- **NEGATIVES**: DB 범위 밖 질문. 게이트에 막혀야 정상
- **NARROW_CASES**: 도급/하도급/건설업 조항 필터가 맥락 없을 때 걸러내는지 확인

라벨에 적힌 조문이 DB에 실제로 있는지 먼저 검증하므로, 오탈자나 없는 조문을
라벨로 쓰면 실행 시 바로 경고가 뜬다.

결과는 `eval/results/eval_raw.json`에 저장된다.

질문을 추가할 때는 `questions.py`에 한 줄 추가하면 된다. 실제 사용자 말투로 쓰고,
정답 조문은 조문 제목을 보고 판단해서 `articles`에 넣는다(복수 허용).

## 1-3. 게이트 임계값 재튜닝

```bash
python3 eval/tune_threshold.py
```

`eval_raw.json`의 거리 분포로 `NO_MATCH_DISTANCE_THRESHOLD` 후보를 계산한다.
법률 상담 특성상 "틀린 답"이 "모른다"보다 위험하다고 보고, negative 오통과에
2배 가중치를 준 지표(`FP_WEIGHT`)를 기본 권장 기준으로 쓴다.

**DB 데이터나 법령 구성이 바뀌면 임계값도 다시 잡아야 한다.**
순서는 `run_eval.py` → `tune_threshold.py` → `bot.py` 수정 → `run_eval.py` 재실행.

## 생성 단계 검증 - 조항·수치 환각

```bash
python3 eval/check_citations.py --limit 12      # 답변 생성 후 채점 (LLM 호출 발생)
python3 eval/check_citations.py --reanalyze     # 저장된 답변만 다시 채점 (호출 0회)
```

위 1-1~1-3이 **검색**을 본다면 이쪽은 **생성된 답변**을 본다. 심판 LLM을 쓰지 않고
규칙으로만 판정하므로 결과가 흔들리지 않는다.

- **조항 인용**: 답변의 `근로기준법 제36조` 같은 인용을 전부 뽑아
  `OK`(검색된 조항) / `근거없음`(DB엔 있으나 미검색) / `존재안함`(DB에 없음)으로 분류
- **수치**: 기간·금액·비율(`14일`, `100분의 50`, `30일분`)이 검색된 조항 원문에
  실제로 있는지 대조. `100분의 50 ↔ 50%`, `2주 ↔ 14일` 같은 환산은 인정한다
- **창구 번호**: 1350·132 외의 번호가 나오면 표시

수치 검사의 `확인필요`는 환각 확정이 아니라 **선별 결과**다. 조문을 요약하거나
환산해서 쓴 경우도 걸리므로 사람이 한 번 봐야 한다.

규칙을 고쳤을 때는 `--reanalyze`로 다시 돌리면 된다. 답변을 새로 만들지 않으므로
API 비용이 들지 않는다.
