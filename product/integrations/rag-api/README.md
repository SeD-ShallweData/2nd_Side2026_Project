# 돈워리 RAG 검색 서비스

HB 프로토타입에서 검증된 노동법 Chroma DB와 BGE-M3 검색 정책을 제품용으로 분리한 내부 서비스다.
LLM 답변을 생성하지 않고 `POST /api/retrieve`로 검색 문서와 출처만 반환한다. Next.js가 이 결과를
Upstage와 SKT에 동일하게 전달한다.

```bash
cd product/integrations/rag-api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
HF_HOME=/data/shared-SeD/jcu0304/.cache/huggingface ./run.sh
```

기본 주소는 `http://127.0.0.1:5051`이다. 이 서버의 기존 프로토타입이 사용하는 `5050`과 분리했다.
최초 실행은 BGE-M3와 컬렉션을 미리 올린 뒤 서버를 열기 때문에 시간이 걸릴 수 있다. 콘솔에
`RAG 모델과 노동법 컬렉션을 불러왔습니다.`가 표시된 뒤 Next.js의 상태 API가 `ready`로 판정한다.

```bash
curl -X POST http://127.0.0.1:5051/api/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"query":"임금이 밀렸을 때 어떻게 해야 하나요?","limit":5}'
```

벡터 DB는 제품에 포함된 `data/labor_law_db`를 기본으로 사용한다. 다른 DB를 검증할 때만
`RAG_DB_PATH`를 지정한다.
