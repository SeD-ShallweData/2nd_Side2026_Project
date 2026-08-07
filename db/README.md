# 돈워리 데이터베이스

사업장 데이터(ML export)와 사용자 데이터(계정·커뮤니티·리뷰)를 담는 PostgreSQL.
이 디렉터리 하나로 자립한다 — 스키마·마이그레이션·적재 스크립트가 모두 여기 있다.

## 빠른 시작

```bash
cd db
cp .env.example .env.local     # 값을 채운다 (아래 참고)
npm install
npm run up                     # Postgres 컨테이너 기동
npm run migrate                # 스키마 적용
./scripts/ingest.sh --bundle ../_service_bundle --model-version 260807
```

### `.env.local` 값

**이 서버는 여러 사람이 함께 쓴다.** Docker 컨테이너·볼륨·포트는 머신 전역이라,
접두사와 포트를 **사람마다 다르게** 잡아야 서로 충돌하지 않는다.

```bash
COMPOSE_PROJECT_NAME=wageguard-<본인>   # 컨테이너·볼륨 접두사
DB_PORT=5433                            # 겹치지 않는 포트
DB_NAME=wageguard
DB_USER=wageguard
DB_PASSWORD=<임의값>
DATABASE_URL=postgresql://wageguard:<DB_PASSWORD>@127.0.0.1:5433/wageguard
```

DB 는 `127.0.0.1` 에만 묶여 있다. 공용 머신이라 사내망에 열지 않는다.

## 스키마

두 갈래다.

### ML 산출물 (앱은 읽기만)

| 테이블 | 행수 | 내용 |
| --- | --- | --- |
| `firms` | 552,500 | 사업장 마스터. **배치 무관·누적.** 커뮤니티 글·리뷰가 이걸 참조 |
| `batches` | 배치당 1 | 적재 단위 — `as_of_date` + `model_version` |
| `scored_active` | 552,500 | 전체 점수 + 39피처 |
| `inspector_queue` | 3,000 | 감독관 위험큐 + SHAP 위험사유 |
| `safe_recommendation` | 501,843 | 구직자 안전추천 판정 |

세 CSV 는 **포함 관계**다: `scored_active ⊃ safe_recommendation ⊃ inspector_queue`.

### 🔑 식별키 — 여기가 가장 중요하다

**`사업자번호`는 식별자가 아니다.** 마스킹 6자리라 32,241개 번호가 552,500행에 재사용된다
(한 번호가 최대 788곳). 번호 단독 키는 절대 금지.

| 컬럼 | 정의 | 용도 |
| --- | --- | --- |
| `firm_id` | `sha1(사업장명‖'|'‖사업자번호)[:16]` — **원본 이름** | 식별 (PK) |
| `corp_key` | `sha1(정규화(사업장명)‖'|'‖사업자번호)[:16]` | 같은 법인의 여러 사업장 묶기 |

> ⚠️ **`DB_BUILD_PROMPT §4` 와 다르다.** 프롬프트는 정규화한 이름으로 `firm_id` 를 만들라고 하지만,
> 그러면 **서로 다른 사업장이 합쳐진다.** 실측 결과 충돌 171건 중 **168건이 별개 사업장**이었다:
>
> ```
> 617810  한국쉘석유(주)      서울특별시  risk 0.163
>         한국쉘석유주식회사   부산광역시  risk 0.107
> ```
>
> 국민연금은 법인이 아니라 **사업장** 단위다. 정규화하면 실제 사업장 175곳이 사라진다.
> `(사업장명, 사업자번호)` 원본 쌍은 552,500행 전부 고유하므로 이게 올바른 식별 단위다.

`firm_id` 는 **불변이 아니다** — 사업장명이 바뀌면 달라진다(월 약 0.24%).
그래서 `firms` 에 원본 `name`·`biz_no` 를 보존한다. ML 팀이 안정 ID 를 export 에 넣으면 교체한다.

### 사용자 생성 데이터

`users` / `posts` / `comments` / `reviews` — 모두 `firm_id` 로 `firms` 를 참조한다.

> ⚠️ **익명 글도 작성자를 저장한다.** 본인 삭제·신고 처리에 필요하다.
> 익명성은 컬럼을 비우는 게 아니라 **조회 계층에서 이름을 빼는 것**으로 지킨다.

## 적재 (`scripts/ingest.sh`)

```bash
./scripts/ingest.sh --bundle ../_service_bundle --model-version 260807
./scripts/ingest.sh --bundle ../_service_bundle --model-version 260807 --as-of 2026-02
```

- CSV 를 **전부 TEXT 인 staging 테이블**에 `\copy` 로 벌크 적재 후 SQL 로 변환. 552,500행에 약 90초.
- **멱등하다.** 같은 `(as_of_date, model_version)` 을 다시 적재하면 그 batch 만 갈아끼운다.
- **행수를 단언한다.** staging 과 적재 결과가 다르면 예외를 던지고 롤백한다.
  (조용히 버리면 데이터가 사라진 걸 아무도 모른다 — 실제로 처음에 175행을 잃었다.)
- 빈 값은 **NULL** 로. `risk_full` 은 50,657곳(9.2%)이 NULL 이다 — **0 으로 채우지 말 것.**

### `as_of_date` 가 뭔가

이 출력이 **어느 국민연금 데이터로 채점됐는지**다. 파일 생성일이 아니다.
모델은 `[t-18, t-6]` 창의 피처로 시점 `t` 를 예측하므로, 데이터가 언제 것인지 모르면
화면에 "언제 기준 위험도"인지 말할 수 없다.

미확정이면 생략해도 되고(NULL), 확인되면 채운다:
```sql
UPDATE batches SET as_of_date='2026-02' WHERE id=2;
```

### Python 에서 적재해도 된다

스키마는 언어 중립이다. 다만 **`사업자번호`·`sido_code`·`industry_category` 는 반드시 `str`** 로 읽어야 한다
(`dtype=str`). `sido_code` 를 int 로 읽으면 모델이 문자열 `'11'` 로 학습한 것과 어긋난다.

**스키마 변경은 반드시 마이그레이션 파일로.** 컨테이너에 직접 `ALTER TABLE` 을 치면 다른 사람 DB 와 조용히 어긋난다.
```bash
npm run generate   # schema.ts 수정 후 → migrations/ 에 SQL 생성 → 커밋
npm run migrate
```

## 챗봇·LLM 에이전트용 읽기 전용 롤

```bash
echo "BOT_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)" >> .env.local
./scripts/create-bot-role.sh
```

`wg_bot` 롤이 만들어진다. 접속: `psql -h 127.0.0.1 -p 5433 -U wg_bot -d wageguard`

| 접근 가능 | 접근 불가 |
| --- | --- |
| `firms`, `scored_active`, `inspector_queue`, `safe_recommendation`, `batches` | `users` (이메일·비밀번호 해시) |
| `v_posts`, `v_comments`, `v_reviews` — 신원 제거 뷰 | `posts`/`comments`/`reviews` **원본** |

> 🔴 **왜 원본이 아니라 뷰인가**: 커뮤니티 원본에는 `author_id` 가 있다.
> 그게 보이면 **익명 글을 작성자와 연결할 수 있어 익명성이 깨진다.**
> 웹은 직렬화 단계에서 실명을 지우는데, DB 직접 조회가 그걸 우회하면 안 된다.
> 뷰는 `author_id` 를 아예 노출하지 않고, 익명 글의 `author_name` 은 NULL 이다.

안전장치: `default_transaction_read_only=on` · `statement_timeout=15s` ·
`idle_in_transaction_session_timeout=30s`.

**LLM 은 프롬프트 인젝션에 취약하다.** 커뮤니티 글에 "테이블을 지워라" 가 심어져 있어도
권한이 없으면 아무 일도 일어나지 않는다. 모델을 믿는 대신 DB 권한으로 막는다.

`ALTER DEFAULT PRIVILEGES` 는 일부러 쓰지 않았다 — 앞으로 만들 테이블에 권한이 자동으로 붙으면
민감한 테이블이 생겼을 때 아무도 모르게 열린다. **새 테이블은 매번 명시적으로 GRANT 한다.**

## 살펴보기

```bash
npm run studio      # 브라우저 GUI
docker compose --env-file .env.local exec db psql -U wageguard -d wageguard
```

## 검색 성능 메모

`migrations/0001_extensions.sql` 이 `pg_trgm` 확장과 사업장명 GIN 인덱스를 건다.
552,500행에서 `name LIKE '%삼성전자%'` 는 B-tree 로는 인덱스를 못 타고 전체 스캔이 되지만,
trigram GIN 으로는 **4ms** 에 끝난다. trigram 은 3글자 단위로 분해하므로 한글에도 동작한다.

측정값(552,500행 기준):

| 쿼리 | 시간 |
| --- | --- |
| 회사명 부분일치 | 4 ms |
| 감독관 큐 top-N + 사유 | 38 ms |
| 지역별 안정신호 정렬 | 39 ms |
| corp_key 로 같은 법인 묶기 | 1 ms |
