# 돈워리 계약서 분석 서비스

CSH 프로토타입에서 검증한 Document Parse → 구조화 추출 → 결정적 규칙 엔진을 제품 내부 서비스로
가져온 사본이다. 원본 `prototypes/csh`는 수정하지 않는다.

```bash
cd product/integrations/contract-api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
API_KEY_ENV_FILE=/data/shared-SeD/api_key.env ./run.sh
```

기본 내부 주소는 `http://127.0.0.1:8000`이며 Next.js는
`POST /api/contract/review`만 호출한다. 계약서 원문과 원문 인용은 로그에 저장하지 않고,
캐시와 계약 분석 로그도 기본 실행 설정에서는 비활성화한다.

이 코드는 CSH 프로토타입의 2026-08-11 통합 시점 사본이다. 이후 제품 수정은 이 디렉터리에서 수행한다.
