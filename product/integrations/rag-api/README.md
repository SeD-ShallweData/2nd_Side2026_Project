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

현재 번들 DB는 583개 청크와 다음 7개 법령을 포함한다.

- 근로기준법, 근로기준법 시행령
- 최저임금법, 임금채권보장법, 근로자퇴직급여 보장법
- 고용보험법
- 남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률

HB 검증 결과를 반영해 사용자 표현과 법령 용어가 다른 실업급여·구어체 해고·연차 질문은
검색 질의만 확장한다. 자영업자·예술인·노무제공자·도급 특례 조문은 질문이 해당 대상을
직접 언급할 때 우선 노출하고, 현재 DB 밖인 산재보험·4대보험·노동조합·파견 주제는 강한
직접 일치가 없는 한 `no_match`로 돌려보낸다.

검색 정책 단위 테스트는 모델을 내려받지 않고 실행할 수 있다.

```bash
cd product/integrations/rag-api
.venv/bin/python -m unittest -v test_retriever.py
```
