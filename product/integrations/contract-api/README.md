# 돈워리 계약서 분석 서비스

CSH 프로토타입에서 검증한 Document Parse → 구조화 추출 → 결정적 규칙 엔진을 제품 내부 서비스로
가져온 사본이다. 원본 `prototypes/csh`는 수정하지 않는다.

```bash
cd product/integrations/contract-api
PYTHON312="${PYTHON312:-python3.12}"
test "$("$PYTHON312" -I -S -c 'import platform, sys; print(sys.implementation.name, platform.python_version())')" = "cpython 3.12.13" || exit 1
"$PYTHON312" -m venv .venv
.venv/bin/python -m pip install --require-hashes -r requirements.lock
API_KEY_ENV_FILE=/data/shared-SeD/api_key.env ./run.sh
```

운영 설치에서는 `.venv` 전체를 `root:<CONTRACT_GROUP>` 소유로 바꾸고
`chmod -R u=rwX,g=rX,o=`로 봉인한다. 설치기는 서비스 계정이 전체 트리를 읽고 실행할 수 있지만 어느
항목도 쓸 수 없는지, CPython과 lock의 installed set이 정확히 일치하는지를 unit 설치 전에 확인한다.

Upstage 비밀 이름은 배포 환경에서 `UPSTAGE_API_KEY`를 사용한다. 기존 팀 파일의
`Upstage_API_KEY`도 fallback으로 지원한다.

배포 시 `CONTRACT_INTERNAL_TOKEN`을 웹 서비스와 이 서비스에 동일하게 넣는다. 모든 경로는 정확한
`Authorization: Bearer ...` 헤더가 없으면 401로 닫히므로 readiness가 token 일치도 검증한다. 이 token은
RAG 서비스 token과 공유하지 않는다.

기본 내부 주소는 `http://127.0.0.1:8000`이며 Next.js는
`POST /api/contract/review`만 호출한다. 계약서 원문과 원문 인용은 로그에 저장하지 않고,
캐시와 계약 분석 로그도 기본 실행 설정에서는 비활성화한다.

## 프롬프트·지식 자산 gate

[`config/contract_assets.v1.json`](config/contract_assets.v1.json)은 `registry.json`과 registry가
실제로 참조하는 system prompt 7개, few-shot JSONL 3개, knowledge 13개 및 rewrite·contract extract
prompt를 byte size와 SHA-256으로 고정한다. manifest 자체 SHA-256도 애플리케이션과 Next readiness에
`1df5825a76b24c961f8a8f49f72c07d0e1f70a06c6f3e0912c265f91e7af4a1a`로 고정되어 있다.

```bash
.venv/bin/python verify_contract_assets.py
```

검증기는 외부 패키지나 네트워크를 사용하지 않는다. 참조 대상의 추가·누락·변조, symlink, 잘못된
JSON/JSONL, 빈 system·few-shot·knowledge·rewrite·extract 블록, registry와 manifest 참조 불일치를
모두 실패로 처리한다. systemd는 worker 시작 전에 이 명령을 실행하고, 실행 스크립트도 같은 검사를
반복한다. 실행 중 변경이 감지되면 `/api/health`는 `asset_integrity=false`와 HTTP 503을 반환하며
나머지 endpoint도 503으로 닫힌다. 자산을 의도적으로 변경하는 release는 파일과 manifest 항목,
manifest SHA pin, Python·Next 회귀 테스트를 한 번에 갱신해야 한다.

이 코드는 CSH 프로토타입의 2026-08-11 통합 시점 사본이다. 이후 제품 수정은 이 디렉터리에서 수행한다.
