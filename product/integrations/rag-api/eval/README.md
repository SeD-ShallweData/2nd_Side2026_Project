# Product RAG 품질 게이트

HB에서 검증한 positive 90건, negative 16건, narrow 7건을 Product 내부에 복제해 독립적으로 관리한다. 여기에 팀원이 제보한 생활어 2건을 별도 회귀셋으로 둔다.

평가는 실제 Product `retriever.py`를 사용한다. Chroma는 읽기만 해도 메타데이터 파일을 갱신할 수 있으므로 실행기가 DB를 임시 디렉터리에 복제한 뒤 검사한다.

```bash
cd product/integrations/rag-api
.venv/bin/python eval/run_product_eval.py
```

CI 하한은 기존 확인값인 top-1 74.4%, top-5 92.2%, negative 16/16이다. 임계값을 낮추려면 평가 근거와 리뷰가 필요하다.

## 2026-10 산재보험법·외국인고용법 수록셋

- negative 16건 가운데 "산재 신청은 근로복지공단에 어떻게 하나요?"는 산재보험법을 수록하면서 정상 답변 대상이 됐다. 그래서 신규 개발셋으로 옮기고, 그 자리에는 여전히 DB 밖인 산업안전보건법 질문("사업장 안전보건교육은 1년에 몇 시간 받아야 하나요?")을 넣었다. 16건 규모와 16/16 하한은 그대로다.
- `NEW_LAW_POSITIVES` 21건은 검색 질의 확장 규칙을 설계하며 본 개발셋이다. `NEW_LAW_VALIDATION` 10건은 규칙 설계 뒤에 따로 적은 다른 표현이다. 두 셋 모두 기본 정답 조문과, 함께 정답으로 인정하는 위임 시행령 조문(`also`)을 둔다.
- `NEW_LAW_NEGATIVES` 4건은 산업안전보건법·중대재해처벌법처럼 가까운 주제이며 여전히 `no_match`여야 한다.
- 게이트: 신규 개발셋과 검증셋을 합친 top-5가 90% 이상이어야 하고(`--min-new-law-top5`), 인접 주제 4건은 모두 막혀야 한다. HB 90/16/7과 생활어 2건 하한은 바뀌지 않는다. 수치와 근거는 `docs/qa/2026-09-30-rag-foreign-employment-iaci.md`에 있다.
