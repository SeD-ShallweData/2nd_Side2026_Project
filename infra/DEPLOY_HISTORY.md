# 배포 이력

> **한 줄 요약**
> 배포는 이제 `moneyworry-deploy-run` 으로 한다. 한 번의 배포가
> `/srv/moneyworry/deploy.log` 에 **두 줄**(`start` / `finish`)로 남고,
> `moneyworry-deploy-log` 로 읽는다.

기록 시점: 2026-09-12 · 대상 `infra/scripts/deploy-run.sh`, `infra/scripts/deploy-log.sh`

## 왜 필요한가

### 1. 팀에 한 약속을 지키기 위해

주간회의 브리핑에 *"승인 내역은 배포 기록에 남습니다"* 라고 공지했습니다.
그런데 `deploy-from-git.sh` 는 승인 목록을 **stdout 에 한 줄 찍는 것이 전부**였고,
배포는 사람이 SSH 로 돌리므로 **창을 닫으면 사라졌습니다.**

관문(`--ack-guarded`)은 *"사람이 별도 절차를 끝냈다"* 는 선언입니다. 그 선언이
아무 데도 남지 않으면 나중에 **"왜 그날 그냥 넘어갔지"** 를 답할 수 없습니다.
`guarded_ack` 필드가 그 공지를 사후에 참으로 만듭니다.

```bash
moneyworry-deploy-log --acks
```

### 2. 자동 배포가 같은 커밋을 무한 재시도하지 않게

VM 은 매일 **01:00 에 꺼집니다.** 빌드 한가운데서 꺼지면 **종료 코드 자체가 없습니다.**
폴러가 종료 코드로 "이 SHA 를 시도했는가"를 판단하면, 그런 배포는 영원히
시도되지 않은 것이 되어 10분마다 다시 시작하고 매번 01:00 에 죽습니다.

그래서 **시도하기 전에** `start` 를 씁니다. `finish` 없는 `start` 가 남으면

- 사람에게는 **「중단」** 으로 보이고
- 폴러에게는 **"이미 시도했다"** 는 근거가 됩니다

### 3. C3 규격

실무배포 과업정리의 C3 은 `sha·시각·소요·결과` 를 요구합니다.
각각 `target_sha`/`prev_sha` · `ts` · `duration_s` · `result` 입니다.

## 형식

`/srv/moneyworry/deploy.log` — **JSONL**, 배포 1회에 두 줄.

```jsonc
// 시도 직전
{"event":"start","run_id":"20260912-143000-991","ts":"2026-09-12T14:30:00+09:00",
 "actor":"yoonseung","unattended":false,
 "prev_sha":"4ee1c2c…","target_sha":"9ea4e5e…","deploy_exec_sha256":"9e1f94…"}

// 끝난 뒤
{"event":"finish","run_id":"20260912-143000-991","ts":"2026-09-12T14:42:22+09:00",
 "duration_s":742,"result":"success","exit_code":0,"phase":"done","reason":"",
 "prev_sha":"4ee1c2c…","target_sha":"9ea4e5e…",
 "guarded_ack":["infra/scripts/"],"guarded_halt":[],
 "built":true,"restarted":["moneyworry-web"],"rolled_back":false,"drift":"aligned"}
```

| `result` | 뜻 | 배포기 종료 코드 |
| --- | --- | :---: |
| `success` | 성공 | 0 |
| `failed` | 실패 (체크아웃 이후였다면 롤백됨 — `rolled_back` 확인) | 1 |
| `guarded-halt` | 관문 정지. 사람의 승인이 필요하다 | 3 |
| `noop` | 할 일 없음 (이미 그 커밋 / 변경 없음) | 5 |
| **`중단`** | `start` 만 있고 `finish` 가 없다 | — |

### 왜 JSONL 인가

사람이 읽는 표는 조회 명령이 만들면 됩니다. 하지만 폴러가 *"이 SHA 를 이미
시도했는가"* 를 묻고 감사 기록을 뒤지려면 **기계 판독이 필요합니다.**
사람용 포맷으로 저장하면 그 질의가 전부 정규식 문제가 됩니다.

### 왜 `/srv` 인가

`/srv/moneyworry` 는 **데이터 디스크**(VM 을 지워도 남음),
`/var/lib` 는 VM 과 함께 지워지는 **부팅 디스크**입니다.
원장은 관문 승인의 감사 기록이므로 살아남아야 합니다.

### 왜 배포기 안이 아니라 바깥 래퍼인가

배포기는 실행 도중 `git checkout` 으로 **자기가 들어 있는 트리를 갈아엎고**,
실행본이 트리 밖(`/usr/local/sbin`)에 있어 *"지금 도는 나는 어느 판인가"* 를
스스로 적을 수 없습니다. 래퍼는 트리를 건드리지 않으므로 실행본 해시
(`deploy_exec_sha256`)를 정직하게 기록할 수 있고, 배포기가 어떻게 죽든
(`die`·`SIGKILL`·VM 정지) **바깥에서** 그 사실을 남길 수 있습니다.

### 보존

| 대상 | 정책 | 이유 |
| --- | --- | --- |
| 원장 `deploy.log` | **로테이션하지 않는다** | 1000회 배포해도 1MB 미만이고, 승인 감사 기록이다 |
| 전문 `deploy-logs/<run_id>.log` | 최근 **30개** | 빌드 출력 전문. 오래된 것은 가치가 급락한다 |
| 롤백 백업 `rollback/next-<sha>` | 최근 **2개** (배포기가 정리) | 1회당 약 237MB. [`OPERATIONS.md`](OPERATIONS.md) §5-1 |

## 판정 규칙

- **종료 코드가 정본**입니다. `##MW result=` 는 교차 검증에만 씁니다 —
  배포기가 죽는 방식은 여러 가지지만 종료 코드는 언제나 있습니다.
  둘이 어긋나면 `reason` 에 남기고 종료 코드를 따릅니다.
- **`--dry-run` 은 원장을 건드리지 않습니다.** 아무것도 하지 않은 실행이 `success`
  로 남으면, 그 기록을 믿은 사람이 "배포됐다"고 판단하고 폴러는 그 SHA 를
  시도 완료로 봅니다.
- **`--unattended` 와 `--ack-guarded` 는 함께 올 수 없습니다.** 관문은 사람이
  승인합니다. 폴러 소스에 `--ack-guarded` 문자열이 없는 것과 이중 장치입니다.
- **실행본에 `MW_ROLLBACK_ON_EXIT_V2` 표식이 없으면 배포를 거부합니다.**
  롤백이 돌지 않는 구판으로는 이력을 남길 가치가 없습니다 — 실패해도
  되돌아가지 않기 때문입니다. 저장소를 고쳐도 `install` 을 다시 돌리지 않으면
  서버는 옛 판 그대로라는 것이 이 검사의 요점입니다.
- **모든 시각은 `Asia/Seoul`** 입니다. VM OS 는 UTC 로 도는 일이 흔하고, 팀이 쓰는
  일정(프리즈·심사·VM 가동창)은 전부 KST 입니다. 섞이면 최대 9시간 어긋납니다.

## 설치

```bash
sudo install -m 0755 -o root -g root \
  /srv/moneyworry/repo/infra/scripts/deploy-run.sh /usr/local/sbin/moneyworry-deploy-run
sudo install -m 0755 -o root -g root \
  /srv/moneyworry/repo/infra/scripts/deploy-log.sh /usr/local/bin/moneyworry-deploy-log
```

`infra/scripts/` 는 관문 경로입니다. 배포할 때 `--ack-guarded infra/scripts/` 로
승인하고, **배포 후 위 `install` 을 반드시 다시 돌립니다.**

## 쓰기

이제부터 배포는 이것으로 합니다.

```bash
sudo systemctl stop moneyworry-health.timer
sudo git -C /srv/moneyworry/repo fetch -q --prune origin
MAIN_SHA=$(sudo git -C /srv/moneyworry/repo rev-parse origin/main)
sudo /usr/local/sbin/moneyworry-deploy-run --sha "$MAIN_SHA"
sudo systemctl start moneyworry-health.timer
```

`moneyworry-deploy` 를 직접 불러도 배포는 됩니다(락·깃발·롤백 모두 동작).
다만 **이력이 남지 않습니다.**

## 확인

```bash
moneyworry-deploy-log              # 최근 15건 표
moneyworry-deploy-log --limit 50
sudo moneyworry-deploy-log --last  # 마지막 1건 전체 + 전문 꼬리 (전문은 root 만)
moneyworry-deploy-log --failures   # 실패·관문정지·중단만
moneyworry-deploy-log --sha 9ea4e5e
moneyworry-deploy-log --acks       # 관문 승인 감사 기록
```

```
시각           실행        커밋              결과      소요     비고
────────────────────────────────────────────────────────────────────────
09-12 14:42:22 yoonseung   4ee1c2c→9ea4e5e   성공      12분22초 승인 infra/scripts/
09-12 15:10:03 autodeploy  9ea4e5e→a11b2c3   실패      3분41초  롤백함 · ready 가 200 이…
09-13 01:00:00 autodeploy  a11b2c3→b22c3d4   중단      -        phase=build 이후 기록 없음
```

## 끄기

끌 것이 없습니다. 래퍼를 안 쓰면 기록이 안 남을 뿐입니다.
원장을 지우려면 그냥 파일을 지우면 되지만, **감사 기록이므로 권하지 않습니다.**

## 알려진 한계

- **`moneyworry-deploy` 를 직접 부른 배포는 기록되지 않습니다.** 래퍼를 쓰도록
  강제하지 않은 것은 의도입니다 — 장애 상황에서 배포기를 직접 부를 수 있어야
  합니다. 대신 `deploy_exec_sha256` 으로 "그때 어떤 판이 돌았는가"는 남습니다.
- **`중단` 은 "실패"와 다릅니다.** 무슨 일이 있었는지 원장은 모릅니다.
  `phase` 필드가 마지막으로 도달한 단계를 알려주는 것이 전부입니다.
  그 이상은 `journalctl -u moneyworry-web` 과 전문을 봐야 합니다.
- **전문에는 빌드 출력이 통째로 들어갑니다.** 무엇이 섞여 들어올지 미리 알 수
  없어 `0640` root 전용으로 둡니다. 원장(`0644`)은 구조화된 필드만 담습니다.
- **원장은 append 전용이고 잠금이 없습니다.** 배포가 겹치면 줄이 섞일 수
  있지만, 배포 자체가 `flock` 으로 직렬화되므로 실제로는 겹치지 않습니다.
- 깨진 줄이 섞여도 조회 명령은 나머지를 보여주고 개수만 경고합니다.
  원장이 한 줄 때문에 통째로 못 읽히는 일은 없어야 합니다.

## 관련 문서

- [`infra/OPERATIONS.md`](OPERATIONS.md) §5-1 — 배포기 계약(종료 코드·관문·실행본 재설치)
- [`infra/HEALTH_WATCH.md`](HEALTH_WATCH.md) — 배포와의 상호 배제(`deploy-in-progress` 깃발)
- [`infra/scripts/deploy-from-git.sh`](scripts/deploy-from-git.sh) — `##MW` 줄을 뿜는 쪽
