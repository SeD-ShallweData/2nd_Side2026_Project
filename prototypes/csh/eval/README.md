# 측정 스크립트

제품(`product/`)의 상담 파이프라인이 실제로 어떻게 동작하는지 재는 도구들입니다.
프롬프트를 고칠 때 "좋아진 것 같다"가 아니라 숫자로 확인하려고 만들었습니다.

원본 프로토타입 코드가 아니라 **제품 경계를 향해** 측정합니다. HB의
[`prototypes/hb/eval/`](../../hb/eval/)이 프로토타입 내부 함수를 직접 부르는 것과
다릅니다. 질문셋은 HB가 라벨링한 것을 그대로 가져다 씁니다.

## 준비

측정 대상 서비스를 먼저 띄웁니다. 주소는 환경변수로 바꿀 수 있습니다.

| 스크립트 | 필요한 서비스 | LLM 호출 |
| --- | --- | --- |
| `rag_hitrate.py` | rag-api (5051) | 없음 |
| `threshold_band.py` | rag-api (5051) | 없음 |
| `relevance_eval.py` | product (3001) + rag-api | **있음** |
| `prompt_quality.py` | product (3001) + rag-api | **있음** |
| `citation_attach.py` | product (3001) + rag-api | **있음** |

```bash
RAG_API_URL=http://127.0.0.1:5051      # 기본값
PRODUCT_URL=http://127.0.0.1:3001      # 기본값
RAG_DISTANCE_THRESHOLD=0.42            # threshold_band.py 의 구간 기준
```

## rag_hitrate.py — 검색 적중률

HB 질문셋(POSITIVES/NEGATIVES)을 제품이 쓰는 HTTP 경로에 태워 top-1/3/5 적중률과
게이트 차단율을 냅니다.

```bash
python3 eval/rag_hitrate.py
```

## threshold_band.py — 임계값 부근 분포

`no_match` 임계값 근처에 어떤 질문이 몰려 있는지 봅니다. 평가셋(법령 용어에 가까운
문장)과 실사용 말투의 분포가 다른지 확인하는 용도입니다. 같은 시스템이라도 입력
말투에 따라 탈락 비율이 크게 달라집니다.

```bash
python3 eval/threshold_band.py
```

## relevance_eval.py — 답변 품질 회귀

**LLM을 호출합니다.** 공용 API 키를 쓰므로 팀 시연 시간대는 피하고, 돌리기 전에
공유하세요. 8케이스 × 2모델 = 16회 호출입니다.

프롬프트를 고치기 전후로 두 번 돌려 비교합니다.

```bash
python3 eval/relevance_eval.py before   # 개선 전 기준선
# prompts/chat/system.md 수정
python3 eval/relevance_eval.py after
python3 eval/relevance_eval.py compare
```

판정은 규칙으로만 합니다(심판 LLM 없음). 프롬프트를 고쳐도 채점 기준이 흔들리지
않게 하려는 것입니다. 케이스마다 "이 질문에 나올 이유가 없는 제도" 목록을 두고,
답변이 그것을 끌어다 쓰는지 셉니다.

결과는 `results/` 에 JSON으로 남고 git에 올라가지 않습니다.

## prompt_quality.py — 상담 프롬프트 종합 회귀

**LLM을 호출합니다.** 16케이스 × 2모델 = 32회입니다.

프롬프트를 크게 고칠 때 쓰는 넓은 게이트입니다. RAG가 돌려주는 검색 경로
네 가지(조문 matched / 공식 안내만 matched / 수록 범위 밖 / 서비스 범위 밖)를
나눠서, 경로마다 다른 합격 조건으로 봅니다. 한쪽을 고치다 다른 쪽을 무너뜨리는
것을 잡으려는 것입니다.

```bash
python3 eval/prompt_quality.py paths    # LLM 없이 검색 경로만 확인
python3 eval/prompt_quality.py before
python3 eval/prompt_quality.py after
python3 eval/prompt_quality.py compare
```

## citation_attach.py — 법령 인용 부착

**LLM을 호출합니다.** 20케이스 × 2모델 = 40회입니다.

인용 하나를 깊게 봅니다. 검색 거리 0.35 미만 안정 구간만 써서, 인용을 안 붙인
것과 붙일 근거가 없었던 것을 구분합니다.

```bash
python3 eval/citation_attach.py before
python3 eval/citation_attach.py after
python3 eval/citation_attach.py compare
```

두 스크립트로 무엇을 찾아 어떻게 고쳤는지는 [PROMPT.md](PROMPT.md) 에 있습니다.

## 주의

`rag-api` 를 실행하면 제품에 포함된 벡터DB 파일이 변경된 것으로 표시됩니다.
읽기만 해도 Chroma가 파일을 건드리기 때문입니다. **커밋하지 마세요.**

```bash
git checkout -- product/integrations/rag-api/data/labor_law_db/
```
