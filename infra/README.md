# 배포·운영 설정

최종 통합 제품의 Docker, 배포, 환경변수 템플릿과 운영 문서를 관리하는 공간입니다.

API 키와 실제 비밀번호는 커밋하지 않습니다. 재현 가능한 예제 설정만 추적합니다.

- [서버 종료 전 보존·배포·운영 런북](OPERATIONS.md)
- 제품별 실행·feature flag: [`product/README.md`](../product/README.md)
- DB migration 운영: [`db/docs/`](../db/docs/)

## 단일 VM systemd 설치

`systemd/`의 네 템플릿은 `/srv/moneyworry` 데이터 디스크에 배치한 단일 VM 구성을 대상으로 한다.
PostgreSQL은 `db/docker-compose.yml`의 로컬 Docker 컨테이너로 실행하며, RAG와 계약 분석은 각각
단일 Gunicorn worker, Next.js는 `127.0.0.1:3111` production 서버로 실행한다. 모든 네트워크
listener는 loopback에만 바인딩된다.

먼저 CI와 동일한 Node.js `22.23.2` production build, 정확한 CPython `3.12.13`으로 만든 두 Python
가상환경, `/srv/moneyworry/rag-db`에 복원한 검증된
Chroma RAG DB, `/srv/moneyworry/hf`를 준비한다. 모델 준비는
[`product/integrations/rag-api/README.md`](../product/integrations/rag-api/README.md)의 명시적
확인 gate를 먼저 통과해야 한다. 이후 `/srv/moneyworry/hf`와 sealed
`/srv/moneyworry/rag-db`는 RAG 계정에 read-only다. systemd가 시작할 때 exact-tree/hash 검증 후
Chroma를 `/run/moneyworry-rag/chroma`에 복사하고, SQLite metadata와 WAL은 이 폐기 가능한 runtime
copy에만 쓰게 한다.
두 `.venv`는 각 서비스의 `requirements.lock`을
`.venv/bin/python -m pip install --require-hashes -r requirements.lock`으로 설치한다. RAG lock은
Linux/amd64에서 생성·검증된 CPU release lock이어야 하며, RAG 설치에는 추가로 `--isolated`,
`--only-binary=:all:`을 사용한다. PyTorch CPU index에서는 `--no-deps`로 고정 Torch wheel 하나만
받아 SHA-256을 검증하고, 전체 dependency resolver는 PyPI primary index와 그 로컬 wheelhouse만
사용한다. CPU index를 전체 resolver의 extra index로 두지 않는다. Torch가 요구해 lock에 포함된
`setuptools`의 `distutils-precedence.pth`는 RAG README에 고정한 SHA-256과 일치하는 경우에만 제거한
뒤 exact runtime attestation을 수행한다. CUDA/NVIDIA/Triton 배포판이 설치 목록에 있으면 실패다.
설치 후 venv 전체는 root 소유이면서
group/world non-writable이어야 하고, 각 서비스 primary group에는 read/execute만 허용한다. lock,
`infra/scripts/verify-python-runtime.py`, 그리고 그 project-relative ancestor도 root가 소유하고
group/world가 쓸 수 없어야 한다. 설치기는 trusted OS Python의 `-I -S`로 이 조건과 exact installed
distribution set을 먼저 확인하며 pip 자체의 설치 버전만 비교 대상에서 제외한다.
RAG unit의 시작 timeout은 cold hash/stage와 CPU model warmup을 포함해 15분이며, 이 시간이 지나면
준비되지 않은 worker를 살려 두지 않고 시작 실패로 처리한다.
서비스 권한은 반드시 네 Linux 계정과 네 env 파일로 분리한다. DB 계정만 `docker` 그룹에 속하고,
웹·RAG·계약 계정은 서로 다른 UID/GID를 사용하며 `docker` 그룹에 속하지 않는다. 이렇게 해야 외부
요청 처리 코드의 취약점이 Docker socket이나 PostgreSQL 관리자 비밀번호로 이어지지 않는다.

```text
/etc/moneyworry/db.env        DB compose/admin 값, DB 계정만 읽기 가능
/etc/moneyworry/web.env       BOT_DATABASE_URL + 웹/LLM/Basic/internal Auth 값, root:root 0600
/etc/moneyworry/rag.env       RAG 튜닝값 + RAG 전용 internal token, root:root 0600
/etc/moneyworry/contract.env  계약 분석 API 키/튜닝값 + 전용 internal token, root:root 0600
```

키별 최소 예시는 [`systemd/ENVIRONMENT_FILES.md`](systemd/ENVIRONMENT_FILES.md)에 있다.

`db.env`는 DB 계정 소유 `0600` 또는 `root:DB_GROUP 0640`이어야 한다. 나머지 세 파일은
`root:root 0600`이어야 하며 systemd PID 1만 읽어서 각 프로세스에 전달한다. `web.env`에는
`DATABASE_URL`, `DB_PASSWORD` 등 관리자 연결값을 넣지 않고 `BOT_DATABASE_URL`만 둔다.
`rag.env`에는 RAG 전용 internal token 외의 비밀번호·token·API key를 넣지 않는다. PostgreSQL이 부트 디스크의 Docker 기본
volume으로 빠지지 않도록 `db.env`의 `POSTGRES_DATA_DIR`은 반드시
`/srv/moneyworry/postgres`로 지정한다. 실제 secret 값은 명령행이나 저장소에 쓰지 않는다.

예를 들어 `moneyworry-db`, `moneyworry-web`, `moneyworry-rag`, `moneyworry-contract` 시스템
계정을 각각 만든 뒤 다음과 같이 설치한다.

```bash
sudo infra/scripts/install-systemd-units.sh \
  --db-service-user moneyworry-db \
  --web-service-user moneyworry-web \
  --rag-service-user moneyworry-rag \
  --contract-service-user moneyworry-contract \
  --project-root /srv/moneyworry/repo/2nd_Side2026_Project \
  --db-env-file /etc/moneyworry/db.env \
  --web-env-file /etc/moneyworry/web.env \
  --rag-env-file /etc/moneyworry/rag.env \
  --contract-env-file /etc/moneyworry/contract.env
```

기본 실행은 unit을 검증·설치만 한다. 기존의 다른 unit은 덮어쓰지 않으며, 서비스 활성화와 시작은
각각 `--enable`, `--start`를 명시해야 한다. `--start`는 DB → RAG·계약 분석 → 웹 순서로 시작하고,
5분 안에 loopback `/api/health/ready`가 HTTP 200이 되지 않으면 성공으로 보고하지 않는다.
설치기는 env 내용을 출력하거나 source하지 않는다. 네 계정·그룹·파일 경계, read-only bot URL,
loopback 주소, 금지된 관리자/secret 변수, Docker Compose 유효성을 모두 fail-closed로 확인한다.
RAG는 추가로 sealed BGE-M3 snapshot과 Chroma 다섯 파일의 hash를 읽기 전용 검증하고, worker가 실제
1024차원 embedding과 `labor_law` query를 통과해 정확히 583건을 확인해야 ready가 된다.
계약 분석 서비스도 시작 전에 고정 manifest로 prompt·few-shot·knowledge 26개 파일의 exact tree,
size, SHA-256과 JSON/JSONL 구조를 검증하며, manifest digest가 Next readiness pin과 다르면 준비 상태로
인정하지 않는다. 네 unit 모두 `LimitCORE=0`으로 provider key, internal token, 계약 원문이 core dump에
남지 않게 한다.
