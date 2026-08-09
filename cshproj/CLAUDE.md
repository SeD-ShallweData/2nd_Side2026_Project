# 2nd_Side2026_Project

AI Rookie & 창의종합설계 경진대회 참여 프로젝트. 목표는 웹사이트 구현.

## 작업 환경

공용 리눅스 서버이며, 여러 팀원(csh, hb, hss, jcu0304, tta, y1oo5b)이 같은 서버를 씁니다.

| 경로 | 성격 | 비고 |
|---|---|---|
| `/home/csh/2nd_Side2026_Project/cshproj` | **여기서 작업** | 리포 안 내 작업 폴더. 상위는 개인 전용(`drwxr-x---`) |
| `/data/shared-SeD/` | 팀 공용 | `drwxrwsrwx` — 전원 읽기/쓰기/삭제 가능. **파일 삭제 주의** |

### 디스크 주의

- `/` (홈이 위치) — 21G 남음, 78% 사용. **대용량 데이터를 홈에 두지 말 것**
- `/data` — 427G 남음, 9% 사용. 벡터DB·모델·데이터셋은 여기로

대용량이 필요하면 `/data/shared-SeD/csh/data/`에 두고 프로젝트에 심볼릭 링크를 겁니다.

### 파이썬

시스템 python3에는 패키지가 없습니다. 반드시 venv를 씁니다.

```bash
.venv/bin/python script.py
.venv/bin/pip install <package>
```

## API 키 — 취급 규칙

키 파일은 **복사하지 않고 원본을 절대경로로 참조**합니다. 사본을 만들지 마세요.

```python
from dotenv import load_dotenv
import os

load_dotenv("/data/shared-SeD/api_key.env")

os.getenv("Upstage_API_KEY")   # Upstage. 기본 모델 solar-pro3
os.getenv("SKT_API_KEY")       # SKT.     기본 모델 A.X-K1
```

변수명 대소문자에 주의 — Upstage 쪽만 `Upstage_API_KEY`(CamelCase)입니다.

엔드포인트:
- Upstage: `https://api.upstage.ai/v1/chat/completions`
- SKT: `https://awf-gw.adot.ai/v1/chat/completions`

**금지 사항**

- 키 값을 터미널·로그·코드·커밋에 출력하지 않습니다. 확인이 필요하면 `len()`이나 앞 4글자 마스킹으로 합니다.
- 키를 소스에 하드코딩하지 않습니다.
- `api_key.env`는 root 소유의 팀 공용 파일입니다. 수정·삭제·이동하지 않습니다.
- `~/.claude/settings.json`의 `permissions.deny`가 `*.env` 읽기를 차단합니다. 우회하지 마세요.

### ⚠️ 2026-08-08 — 키 파일 권한이 600으로 바뀌었습니다

```
-rw------- 1 root root 114 /data/shared-SeD/api_key.env    # 이전에는 777
```

ACL도 없어 (`user::rw- / group::--- / other::---`) csh 계정으로는 읽을 수 없습니다.
**root 권한을 가진 사람이 복구해 주어야 합니다.** 우회하지 마세요.

그 사이 서버는 뜹니다 — `config._load_env()`가 실패를 삼키고 사유만 남깁니다.
화면·더미 데이터는 정상이고 LLM을 부르는 기능(상담·계약서 진단)만 막힙니다.
상태는 `scripts/check_env.py` 또는 `GET /api/health`의 `key_file_error`로 확인합니다.

복구 방법 (csh 계정에 sudo 권한이 있는지에 따라 갈립니다):

```bash
sudo chmod 644 /data/shared-SeD/api_key.env    # 비밀번호는 csh 계정 본인 것
# "csh is not in the sudoers file" 이 뜨면 → 서버 관리자에게 요청
```

권한 복구 전까지 키가 필요하면 임시로 `cshproj/config.env`를 씁니다.
`config.py`가 팀 파일 다음에 `override=True`로 읽어 덮어씁니다.

```bash
.venv/bin/python scripts/set_local_keys.py            # 키 입력 (화면에 안 보임, 권한 600)
.venv/bin/python scripts/set_local_keys.py --remove   # 권한 복구 후 삭제
```

**사본 금지 원칙의 예외**입니다. 권한이 복구되면 반드시 지웁니다.

동작 확인은 `test_api.py`로 합니다 (두 API 모두 호출 성공 확인됨).

## git

- 리모트: `git@github.com:SeD-ShallweData/2nd_Side2026_Project.git`
- 작업 브랜치: `csh-branch` (아직 원격에 push되지 않음)
- `main`에 직접 push하거나 `--force`를 쓰지 않습니다
- `.gitignore`가 `*.env`를 차단합니다. 이 항목을 제거하지 마세요

내 작업물은 전부 리포 루트의 `cshproj/` 안에 있습니다. 명령은 그 안에서 실행합니다.

`main`의 현재 HEAD는 `webapp/` 2,436줄을 전부 되돌린 revert 커밋(`4c44183`)입니다.
사이트는 이 상태에서 새로 구현하는 방향으로 진행합니다.
