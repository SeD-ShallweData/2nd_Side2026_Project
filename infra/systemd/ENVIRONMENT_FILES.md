# systemd 환경 파일 분리 계약

네 파일은 저장소 밖 `/etc/moneyworry`에 만들고 아래 `<...>`는 충분히 긴 실제 secret으로 반드시
대체한다. literal placeholder나 짧은 비밀번호, 동일 파일 재사용은 installer가 거부한다.

## `db.env`

```dotenv
COMPOSE_PROJECT_NAME=moneyworry-production
DB_PORT=5433
DB_NAME=wageguard
DB_USER=pathb_admin
DB_PASSWORD=<DB_ADMIN_SECRET>
BOT_USER=wg_bot
POSTGRES_DATA_DIR=/srv/moneyworry/postgres
```

DB 서비스 계정 소유 `0600` 또는 `root:DB_GROUP 0640`만 허용한다. `DATABASE_URL`과 외부 API
key는 넣지 않는다.

## `web.env`

```dotenv
BOT_DATABASE_URL=postgresql://wg_bot:<URL_ENCODED_BOT_SECRET>@127.0.0.1:5433/wageguard?sslmode=disable
RAG_API_URL=http://127.0.0.1:5051
CONTRACT_ANALYSIS_URL=http://127.0.0.1:8000
RAG_INTERNAL_TOKEN=<RAG_INTERNAL_SECRET>
CONTRACT_INTERNAL_TOKEN=<CONTRACT_INTERNAL_SECRET>
APP_DATA_MODE=real
CHAT_EXECUTION_MODE=dual_api
UPSTAGE_API_KEY=<UPSTAGE_SECRET>
SKT_API_KEY=<SKT_SECRET>
DEMO_BASIC_AUTH_USER=<DEMO_USER>
DEMO_BASIC_AUTH_PASSWORD=<DEMO_PASSWORD>
SAVE_COMPARISON_FEEDBACK=false
```

`root:root 0600`으로 둔다. 두 internal token은 서로 달라야 하며 각각 `rag.env`,
`contract.env`의 같은 이름 값과 정확히 일치해야 한다. `DATABASE_URL`, `DB_USER`, `DB_PASSWORD`, `BOT_PASSWORD`,
`DATABASE_ENV_FILE`, `SHARED_API_KEY_FILE`은 금지된다. bot 비밀번호는 URL component로
percent-encode해야 한다. 문서에 적힌 키 외의 임의 키는 거부하며, provider URL을 명시해야
한다면 Upstage/SKT의 코드 기본 HTTPS endpoint와 정확히 같아야 한다.

## `rag.env`

```dotenv
RAG_DEVICE=cpu
RAG_GUNICORN_THREADS=2
RAG_GUNICORN_TIMEOUT=180
RAG_INTERNAL_TOKEN=<RAG_INTERNAL_SECRET>
```

`root:root 0600`으로 둔다. RAG 서비스는 전용 내부 호출 token 외에는 DB나 외부 API secret이
필요하지 않으며 password, secret, token, API key 계열 변수와 `RAG_DB_PATH`를 넣으면 installer가 거부한다. production
unit은 sealed Chroma source를 `/srv/moneyworry/rag-db`, 매 부팅 writable copy를
`/run/moneyworry-rag/chroma`로 고정한다. 허용된 튜닝 키
외의 임의 환경변수도 거부한다. 모델 ID/revision, manifest, `HF_HOME`, offline/local-only,
collection 583건과 1024차원 계약은 unit과 `run-gunicorn.sh`가 고정하므로 이 파일에 다시 쓰지
않는다. `/srv/moneyworry/hf`와 `/srv/moneyworry/rag-db`는 사전 준비가 끝난 뒤 RAG 계정에
read-only여야 한다.

## `contract.env`

```dotenv
UPSTAGE_API_KEY=<UPSTAGE_SECRET>
SKT_API_KEY=<SKT_SECRET>
DEFAULT_PROVIDER=upstage
CONTRACT_GUNICORN_THREADS=2
CONTRACT_GUNICORN_TIMEOUT=300
CONTRACT_INTERNAL_TOKEN=<CONTRACT_INTERNAL_SECRET>
```

`root:root 0600`으로 둔다. DB 연결 변수, `API_KEY_ENV_FILE`, `LOCAL_CONFIG_ENV_FILE`은
금지된다. 전용 token은 `web.env`의 같은 이름 값과 일치하고 RAG token과 달라야 한다. 위 목록 외의 endpoint override도 거부한다. production unit이 두 file fallback을
`/dev/null`로 고정하며 로그·계약서 캐시는 비활성화한다.

## 인증·커뮤니티·현장 제보 (2026-09-11 추가)

PR #40·#45 로 `web.env` 에 키가 늘었다. **세 모드 키는 생략할 수 없다** —
생략하면 `APP_DATA_MODE=real` 을 따라가는데, 연결 문자열 없이 real 이 되면
로그인·글쓰기가 조용히 503 이 된다. `validate-service-envs.py` 가 명시를 강제한다.

| 키 | 값 | 비고 |
| --- | --- | --- |
| `AUTH_DATA_MODE` | `real` 또는 `mock` | real 이면 `AUTH_DATABASE_URL` 필수 |
| `COMMUNITY_DATA_MODE` | `real` 또는 `mock` | real 이면 `COMMUNITY_DATABASE_URL` 필수 |
| `WORKSITE_TIP_DATA_MODE` | **`mock` 고정** | real 어댑터가 아직 없다. `worksiteTipService.ensureMockMode()` 가 503 을 던진다 |
| `AUTH_DATABASE_URL` | `postgresql://wg_auth:…@127.0.0.1:5433/wageguard?sslmode=disable` | mock 일 때는 **두면 안 된다** |
| `COMMUNITY_DATABASE_URL` | `postgresql://wg_community:…@127.0.0.1:5433/wageguard?sslmode=disable` | 〃 |
| `MOCK_AUTH_*_PASSWORD` 3종 | mock 일 때만 | real 로 바꾸면 **지워야 한다** |

쓰기 롤 URL 은 **소유자(`DB_USER`)나 읽기 전용(`BOT_USER`)을 쓸 수 없다.** 검증기가 막는다.
앱이 조용히 전체 권한 계정으로 붙으면 롤을 분리한 이유가 사라지기 때문이고,
`product/src/server/databaseConfig.ts` 도 같은 이유로 소유자 URL 대체를 거부한다.

비밀번호는 `db/.env.local` 의 `AUTH_PASSWORD`·`COMMUNITY_PASSWORD` 다.
