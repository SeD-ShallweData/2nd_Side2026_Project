# Product RAG 품질 게이트

HB에서 검증한 positive 90건, negative 16건, narrow 7건을 Product 내부에 복제해 독립적으로 관리한다. 여기에 팀원이 제보한 생활어 2건을 별도 회귀셋으로 둔다.

평가는 실제 Product `retriever.py`를 사용한다. Chroma는 읽기만 해도 메타데이터 파일을 갱신할 수 있으므로 실행기가 DB를 임시 디렉터리에 복제한 뒤 검사한다.

```bash
cd product/integrations/rag-api
.venv/bin/python eval/run_product_eval.py
```

CI 하한은 기존 확인값인 top-1 74.4%, top-5 92.2%, negative 16/16이다. 임계값을 낮추려면 평가 근거와 리뷰가 필요하다.
