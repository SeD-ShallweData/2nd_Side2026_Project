# 돈워리 RAG 검색 서비스

HB 프로토타입에서 검증된 노동법 Chroma DB와 BGE-M3 검색 정책을 제품용으로 분리한 내부 서비스다.
LLM 답변을 생성하지 않고 `POST /api/retrieve`로 검색 문서와 출처만 반환한다. Next.js가 이 결과를
Upstage와 SKT에 동일하게 전달한다.

```bash
cd product/integrations/rag-api
PYTHON312="${PYTHON312:-python3.12}"
test "$("$PYTHON312" -I -S -c 'import platform, sys; print(sys.implementation.name, platform.python_version())')" = "cpython 3.12.13" || exit 1
"$PYTHON312" -m venv .venv

# CPU index에는 Torch 하나만, dependency 해석 없이 요청한다.
RAG_TORCH_WHEELHOUSE="$(mktemp -d -t moneyworry-rag-torch.XXXXXXXX)"
trap 'rm -rf -- "$RAG_TORCH_WHEELHOUSE"' EXIT HUP INT TERM
.venv/bin/python -m pip --isolated download \
  --no-deps \
  --only-binary=:all: \
  --index-url https://download.pytorch.org/whl/cpu \
  --dest "$RAG_TORCH_WHEELHOUSE" \
  'torch==2.13.0+cpu'
RAG_TORCH_WHEEL="$RAG_TORCH_WHEELHOUSE/torch-2.13.0+cpu-cp312-cp312-manylinux_2_28_x86_64.whl"
test "$(sha256sum -- "$RAG_TORCH_WHEEL" | cut -d ' ' -f 1)" = \
  "4ca4a9394b0c771238a4f73590fdbbc4debad85ed0fa63d026ae1b085da7d6e2"

.venv/bin/python -m pip --isolated install \
  --only-binary=:all: \
  --require-hashes -r requirements.lock \
  --index-url https://pypi.org/simple \
  --find-links "$RAG_TORCH_WHEELHOUSE"

# torch가 요구하는 setuptools 배포판은 잠그되, 일반 Python 시작 때 실행되는
# setuptools .pth hook은 정확한 공식 wheel 내용인지 확인한 뒤 제거한다.
RAG_SETUPTOOLS_PTH="$PWD/.venv/lib/python3.12/site-packages/distutils-precedence.pth"
test "$(sha256sum -- "$RAG_SETUPTOOLS_PTH" | cut -d ' ' -f 1)" = \
  "2638ce9e2500e572a5e0de7faed6661eb569d1b696fcba07b0dd223da5f5d224"
unlink -- "$RAG_SETUPTOOLS_PTH"

python -I -S ../../../infra/scripts/verify-python-runtime.py \
  --venv "$PWD/.venv" \
  --python "$PWD/.venv/bin/python" \
  --lock "$PWD/requirements.lock"

# 모델 자산을 내려받는 유일한 단계다. 정확한 확인 토큰 없이는 실행되지 않는다.
RAG_HF_DIR="$PWD/.cache/huggingface"
.venv/bin/python prepare_rag_assets.py prepare \
  --manifest "$PWD/config/rag_assets.v1.json" \
  --hf-home "$RAG_HF_DIR" \
  --hub-cache "$RAG_HF_DIR/hub" \
  --rag-db "$PWD/data/labor_law_db" \
  --confirm PREPARE_BAAI_BGE_M3_5617A9F6

./run.sh
```

이 release lock은 Linux/amd64, CPython 3.12.13 전용이다. pip은 primary/extra index에 보안 우선순위를
부여하지 않으므로 PyTorch CPU index를 전체 resolver의 extra index로 사용하지 않는다. CPU index에는
`--no-deps`로 `torch==2.13.0+cpu` wheel 하나만 요청하고 공식 wheel SHA-256을 먼저 확인한다. 전체
dependency는 PyPI만 primary index로 사용하고, 검증된 로컬 wheelhouse를 `--find-links`로 결합한다.
설치 시 다시 모든 배포판의 정확한 버전과 SHA-256을 `--require-hashes`로 강제한다. `--isolated`는
사용자 pip 설정과 `PIP_*` 환경변수를 배제하고, `--only-binary=:all:`은 잠금에 없는 build dependency나
sdist 실행을 차단한다.

잠금은 다음 고정 이미지와 컴파일러로만 갱신한다. 생성 후 `cuda*`, `nvidia*`, `triton`이 한 건이라도
나오면 CPU release로 승인하지 않는다.

```bash
docker run --rm --platform linux/amd64 \
  -v "$PWD:/work" -w /work \
  python@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2 \
  sh -euc '
    RAG_TORCH_WHEELHOUSE=/tmp/moneyworry-rag-torch-wheelhouse
    install -d -m 0700 "$RAG_TORCH_WHEELHOUSE"
    python -m pip --isolated install --disable-pip-version-check --no-cache-dir \
      --index-url https://pypi.org/simple pip-tools==7.6.1
    python -m pip --isolated download \
      --no-deps \
      --only-binary=:all: \
      --index-url https://download.pytorch.org/whl/cpu \
      --dest "$RAG_TORCH_WHEELHOUSE" \
      "torch==2.13.0+cpu"
    RAG_TORCH_WHEEL="$RAG_TORCH_WHEELHOUSE/torch-2.13.0+cpu-cp312-cp312-manylinux_2_28_x86_64.whl"
    echo "4ca4a9394b0c771238a4f73590fdbbc4debad85ed0fa63d026ae1b085da7d6e2  $RAG_TORCH_WHEEL" |
      sha256sum --check --strict
    python -m piptools compile \
      --resolver=backtracking \
      --generate-hashes \
      --allow-unsafe \
      --strip-extras \
      --no-emit-index-url \
      --no-emit-options \
      --no-emit-trusted-host \
      --pip-args="--only-binary=:all:" \
      --index-url https://pypi.org/simple \
      --find-links "$RAG_TORCH_WHEELHOUSE" \
      --output-file requirements.lock \
      requirements.txt
    grep -Eq "^torch==2\\.13\\.0\\+cpu " requirements.lock
    ! grep -Ei "^(cuda|nvidia|triton)[A-Za-z0-9._-]*==" requirements.lock
  '
```

기본 주소는 `http://127.0.0.1:5051`이다. 이 서버의 기존 프로토타입이 사용하는 `5050`과 분리했다.
모든 경로는 웹과 공유한 전용 `RAG_INTERNAL_TOKEN`을 `Authorization: Bearer ...`로
보내야 하며, 계약 분석 token과는 공유하지 않는다. 따라서 Next readiness가 token 일치도 검증한다.
서버 실행 중에는 모델을 내려받거나 `main`을 해석하지 않는다. 콘솔에
`RAG 모델·컬렉션 무결성과 고정 질의 호환성을 검증했습니다.`가 표시된 뒤에만 Next.js 상태 API가
`ready`로 판정한다.

```bash
curl -X POST http://127.0.0.1:5051/api/retrieve \
  -H "Authorization: Bearer $RAG_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"임금이 밀렸을 때 어떻게 해야 하나요?","limit":5}'
```

벡터 DB는 제품에 포함된 `data/labor_law_db`를 sealed source로 사용한다. 다른 source를 검증할 때만
`RAG_DB_SOURCE`를 지정하되, `config/rag_assets.v1.json`의 다섯 파일만 정확히 존재하고 SHA-256까지
같지 않으면 부팅이 차단된다. 실행 시에는 source를 임시 writable directory로 복사하므로 SQLite가
WAL/SHM을 만들어도 sealed source와 다음 부팅 검증에는 영향을 주지 않는다.

현재 번들 DB는 806개 청크(조문 단위가 기본, 정의 조항 일부만 호 단위)와 다음 법령을 포함한다.

| 법령 | 청크 |
|---|---:|
| 근로기준법 / 근로기준법 시행령 | 140 / 75 |
| 최저임금법 · 임금채권보장법 · 근로자퇴직급여 보장법 | 32 · 40 · 83 |
| 고용보험법 | 142 |
| 남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률 | 71 |
| 산업재해보상보험법 (2026-10 추가, 시행 2026-07-01) | 159 |
| 산업재해보상보험법 시행령 (위임 조문만) | 13 |
| 외국인근로자의 고용 등에 관한 법률 (2026-10 추가, 시행 2025-10-01) | 44 |
| 외국인근로자의 고용 등에 관한 법률 시행령 (위임 조문만) | 7 |

HB 검증 결과를 반영해 사용자 표현과 법령 용어가 다른 실업급여·구어체 해고·연차 질문은
검색 질의만 확장한다. 자영업자·예술인·노무제공자·도급 특례 조문은 질문이 해당 대상을
직접 언급할 때 우선 노출한다. 같은 방식으로 산재보험법 조문은 질문에 산재·업무상 재해·부상·요양
같은 맥락이 있을 때, 외국인고용법 조문은 외국인·E-9·고용허가·사업장 변경 같은 맥락이 있을 때만
먼저 고르고, 그렇지 않으면 빈자리만 채운다(휴업수당 질문에 산재 휴업급여가 앞서지 않게). DB 밖인
산업안전보건법·중대재해처벌법·4대보험(국민연금 등)·노동조합·파견·연말정산 주제는 강한 직접 일치가
없는 한 `no_match`로 돌려보낸다.

## 법령 코퍼스 재구성

[`build_law_corpus.py`](build_law_corpus.py)는 583건 sealed 번들 위에 산재보험법·외국인고용법을
얹는 재현 가능한 빌더다. 운영 서버에서는 실행하지 않는다.

- `data/law_xml/`: law.go.kr DRF(`lawService.do?OC=test&target=law&MST=…&type=XML`)에서 받은 공식
  XML과 `lock.json`(법령일련번호 MST, 공포번호, 시행일자, SHA-256, 청크 수). `chunks`/`build`는
  SHA-256이 lock과 다르면 멈춘다.

  | 법령 | MST | 공포번호 | 시행일 |
  |---|---|---|---|
  | 산업재해보상보험법 | 283459 | 21375 | 2026-07-01 |
  | 산업재해보상보험법 시행령 | 287491 | 36473 | 2026-07-01 |
  | 외국인근로자의 고용 등에 관한 법률 | 276857 | 21065 | 2025-10-01 |
  | 외국인근로자의 고용 등에 관한 법률 시행령 | 244037 | 32844 | 2022-08-02 (XML 기본정보 기준. 제13조의4제5·6호만 2023-02-03 시행이며 수록하지 않음) |

- 청크 규칙은 기존 코퍼스와 같다. 조문 하나가 청크 하나이고, 조문내용→항→호→목 원문 줄을 그대로
  잇는다(개정 표기 유지). 부칙과 별표 서식은 넣지 않고 "제N조 삭제" 조문은 건너뛴다. 본법은 장·절을
  `chapter`에 두고, 시행령은 기존 `kise_*`처럼 비운다. 조문이 "별표 N에 따른"이라고만 하는 곳 가운데
  상담에 수치가 필요한 산재보험법 제57조(별표 2 장해급여표)와 제62조(별표 3 유족급여)는 고용보험법
  제50조처럼 표를 한 줄 요약으로 붙인다. 이때 옮긴 수치가 모두 XML 별표내용에 있는지 빌드 전에 확인한다.
- 시행령은 본법 상담에 필요한 위임 조문만 둔다. 산재보험법 시행령은 제2조·제2조의2(적용 제외 사업·
  상시근로자 수), 제21조(보험급여 청구), 제27조~제36조(업무상 재해 인정 기준)이다. 외국인고용법
  시행령은 제2조(적용 제외), 제21조·제22조(출국만기·귀국비용보험), 제25조(고용 제한), 제27조·제28조
  (보증·상해보험), 제30조(사업장 변경)이다.
- `build`는 기존 583건의 id·본문·메타데이터·임베딩이 한 비트도 바뀌지 않았는지, 새 223건이 청크와
  같은지 검증한다. 새 문서만 runtime과 같은 BGE-M3 고정 revision, `normalize_embeddings=True`로
  임베딩한다. 고정 probe(`kis_a43`) 임베딩이 바뀌지 않으므로 서버의 고정 질의 호환성 검사는 기존
  번들과 같은 조건으로 통과한다.

```bash
cd product/integrations/rag-api
BASE="$(mktemp -d)"; WORK="$(mktemp -d)"
git archive 3f7e499 product/integrations/rag-api/data/labor_law_db | tar -x -C "$BASE"
.venv/bin/python build_law_corpus.py chunks            # 모델·네트워크 없이 청크 수 확인
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv/bin/python build_law_corpus.py build \
  --base-db "$BASE/product/integrations/rag-api/data/labor_law_db" \
  --output "$WORK/labor_law_db" --work-dir "$WORK"
# 출력의 files 목록으로 config/rag_assets.v1.json의 size·sha256을 갱신하고
# retriever.py·src/server/ragHealth.ts의 manifest SHA-256 pin을 함께 바꾼다.
```

HNSW `data_level0.bin`은 빈 용량 영역이 초기화되지 않아 빌드마다 hash가 달라진다(헤더상 원소 0개,
벡터는 SQLite `embeddings_queue`에서 부팅 때 다시 올린다). 따라서 같은 입력으로 다시 빌드해도 manifest
hash는 새로 계산해야 한다.

검색 정책 단위 테스트는 모델을 내려받지 않고 실행할 수 있다.

```bash
cd product/integrations/rag-api
.venv/bin/python -m unittest -v test_retriever.py test_asset_manifest.py test_app.py
```

## 고정 자산과 운영 준비 gate

[`config/rag_assets.v1.json`](config/rag_assets.v1.json)은 다음 계약을 동시에 고정한다.

manifest 자체 SHA-256도 application readiness에
`7ac893fba1819472129ac6056ca91a73edcc32e1746ce50de282668a85ead4ea`으로 고정되어 있으므로,
자산 교체는 manifest만 바꾸는 작업이 아니라 코드 pin과 회귀 검증을 함께 바꾸는 명시적 release다.

- `BAAI/bge-m3` revision `5617a9f61b028005a4858fdac845db406aefb181`
- 런타임에 필요한 모델 10개 파일의 byte size와 SHA-256(가중치 포함)
- Chroma 다섯 파일의 byte size와 SHA-256
- collection `labor_law`, 문서 수 정확히 `806`, embedding dimension `1024`
- 실제 임베딩과 Chroma를 함께 통과해 `kis_a43`/근로기준법 제43조가 거리 `0.0001` 이하로
  돌아와야 하는 고정 한국어 probe query

운영 서버에서는 `/srv/moneyworry/rag-db`를 먼저 복원한 뒤, 서비스 계정을 쓰지 않는 배포 권한으로
모델을 한 번 준비한다. 아래 `<RAG_GROUP>`은 RAG 서비스 계정의 primary group으로 바꾼다.
`.venv`도 위의 CPython 3.12.13과 hashed lock으로 설치한 뒤 root 소유로 봉인해야 한다.

```bash
sudo install -d -o root -g '<RAG_GROUP>' -m 0750 \
  /srv/moneyworry/hf /srv/moneyworry/hf/hub
sudo chown -R root:'<RAG_GROUP>' /srv/moneyworry/rag-db
sudo chmod -R u=rwX,g=rX,o= /srv/moneyworry/rag-db
sudo chown -R root:'<RAG_GROUP>' \
  /srv/moneyworry/repo/2nd_Side2026_Project/product/integrations/rag-api/.venv
sudo chmod -R u=rwX,g=rX,o= \
  /srv/moneyworry/repo/2nd_Side2026_Project/product/integrations/rag-api/.venv

sudo /srv/moneyworry/repo/2nd_Side2026_Project/product/integrations/rag-api/.venv/bin/python \
  /srv/moneyworry/repo/2nd_Side2026_Project/product/integrations/rag-api/prepare_rag_assets.py prepare \
  --manifest /srv/moneyworry/repo/2nd_Side2026_Project/product/integrations/rag-api/config/rag_assets.v1.json \
  --hf-home /srv/moneyworry/hf \
  --hub-cache /srv/moneyworry/hf/hub \
  --rag-db /srv/moneyworry/rag-db \
  --confirm PREPARE_BAAI_BGE_M3_5617A9F6

sudo chown -R root:'<RAG_GROUP>' /srv/moneyworry/hf
sudo chmod -R u=rwX,g=rX,o= /srv/moneyworry/hf
```

`prepare`만 외부 Hugging Face에 접근한다. 정확한 revision의 필요한 파일만 받은 뒤 모든 hash를 다시
계산하고 `moneyworry-rag-assets.v1.seal.json`을 원자적으로 기록한다. 설치기와 systemd
`ExecStartPre`는 local-only 검증 뒤 sealed `/srv/moneyworry/rag-db`를
`/run/moneyworry-rag/chroma`로 복사하며 네트워크를 사용하지도, 손상 파일을 자동 복구하지도 않는다.
model snapshot에 `model.safetensors` 같은 추가 파일이 있거나 Chroma source에 WAL/SHM·추가 segment가
있어도 exact-tree gate가 거부한다. writable runtime copy는 서비스 종료 시 systemd가 폐기한다.
검증 실패 시 파일을 임의로 지우지 말고 복원 원본과 manifest를 확인한 다음 `prepare`를 다시 수행한다.

운영 worker에는 `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`,
`RAG_MODEL_LOCAL_ONLY=1`과 모델 revision/count/dimension이 실행 스크립트와 unit 양쪽에서 고정된다.
이 값은 사용자 튜닝값이 아니므로 `/etc/moneyworry/rag.env`에 중복해 넣지 않는다.
