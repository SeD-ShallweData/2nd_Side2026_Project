# 자동 배포 (pull 방식)

> **한 줄 요약**
> VM 이 10분마다 `origin/main` 을 보고 새 커밋이 있으면 스스로 배포한다.
> **기본은 꺼져 있다.** 켜는 것은 `sudo moneyworry-autodeploy --arm` 하나,
> 끄는 것은 `--disarm` 하나이고, **만료일이 지나면 스스로 꺼진다.**

기록 시점: 2026-09-12 · 대상 `infra/scripts/autodeploy.sh`,
`infra/systemd/moneyworry-autodeploy.{service.in,timer}`

## 왜 필요한가

### 왜 pull 방식인가 — self-hosted runner 는 안 된다

**이 저장소는 PUBLIC 이다.** 공개 저장소에 self-hosted runner 를 붙이면
**누구나 fork 해서 PR 을 올려 그 러너 위에서 임의 코드를 실행**할 수 있고,
그 러너가 시연 서버이자 DB 호스트다. GitHub 공식 문서도 공개 저장소에는
쓰지 말라고 명시한다.

pull 방식은 GitHub 에 아무것도 노출하지 않고 방화벽도 열지 않는다.
VM 이 07:00~01:00 만 켜지는 것과도 맞는다 — 기동 직후 밀린 것을 따라잡는다.
push 방식이면 꺼져 있는 동안의 배포가 그냥 실패한다.

### 왜 「설치하되 무장하지 않음」인가

`infra/systemd/` 는 **관문 경로**라 유닛 설치 자체가 사람 승인이 필요한
배포다. 그 일을 프리즈 첫날에 하고 싶지 않다. 그래서 유닛과 실행본은 미리
놓아 두되 타이머를 `enable` 하지 않아 **아무것도 돌지 않는 상태**로 둔다.

## 판정 규칙

### 폴링 1회가 하는 일

```
무장 파일 확인 → 만료일 확인 → 시간창 확인 → 사전 점검
  (배포기 존재 · 롤백 표식 · 실행본 해시 대조 · 디스크 여유)
→ git ls-remote origin main
→ 배포된 SHA 와 같으면 조용히 종료
→ 원장에서 이미 시도한 SHA 인지 확인
→ moneyworry-deploy-run --sha <새 SHA> --unattended
```

`git ls-remote` 를 쓰는 이유: **로컬 ref 를 읽으면 캐시된 값**이라 새 커밋을
영영 못 본다. `rev-parse origin/main` 은 네트워크를 타지 않는다.

### 종료 코드

`systemctl is-failed moneyworry-autodeploy.service` 로 문제가 보여야 하므로
분기마다 다른 코드를 낸다. **모든 분기를 0 으로 두면 systemd 관점에서 언제나
성공이라 아무것도 안 보인다.**

| 코드 | 뜻 |
| :---: | --- |
| `0` | 할 일 없음 / 무장 안 됨 / 자동 배포 성공 |
| `1` | 자동 배포가 실패했다 (배포기가 되돌렸다) |
| `2` | 사전 점검이 막았다 — 사람이 봐야 한다 |
| `3` | 관문에 걸렸다 — **스스로 무장을 해제했다** |

### 안전 장치

| 무엇을 막나 | 어떻게 |
| --- | --- |
| **로봇이 관문을 승인** | 폴러 소스에 관문 승인 옵션 문자열이 아예 없다(CI 가 단언) + 래퍼가 `--unattended` 와 함께 오면 거부 |
| **사람 배포와 겹침** | `/var/lock/moneyworry-deploy.lock` — 래퍼와 배포기 양쪽이 잡는다 |
| **배포 중 오탐 재시작** | `/run/moneyworry/deploy-in-progress` 를 감시기가 읽고 비켜선다 ([`HEALTH_WATCH.md`](HEALTH_WATCH.md)) |
| **같은 커밋 무한 재시도** | 원장의 `start` 레코드로 판정. **종료 코드에 의존하지 않는다** — 01:00 강제 종료는 종료 코드를 남기지 않는다 |
| **01:00 정지와 겹침** | `08:00–22:30` 시간창. 22:30 에 시작해도 최대 소요(45분)를 다 써서 23:15 에 끝난다 |
| **해제를 잊음** | `ARM_EXPIRES` 가 지나면 스스로 꺼지고 한 번 알린다 |
| **저장소와 서버가 갈라짐** | 배포 전 실행본 5개의 sha256 을 저장소 정본과 대조 |
| **롤백 안 도는 배포기** | 실행본에 `MW_ROLLBACK_ON_EXIT_V2` 표식이 없으면 무장도 배포도 거부 |
| **디스크가 차서 빌드 실패** | 3GB 미만이면 배포하지 않는다 |

### 관문을 만나면 스스로 물러난다

배포기 `exit 3` → 래퍼가 `guarded-halt` 기록 → **폴러가 스스로 무장을
해제하고 한 번만 알린다. 재시도하지 않는다.**

재시도해도 소용이 없기 때문이다. 변경 목록은 두 커밋의 **누적 diff** 라
사람이 절차를 끝내도 줄지 않고, 10분마다 같은 알림만 쏟아진다.

### Discord 알림 빈도

| 상황 | 보내나 |
| --- | :---: |
| 새 커밋 없음 (대부분의 주기) | ❌ 10분마다 "할 일 없음"은 소음이다 |
| 무장 중 **하루 첫** 실행 | ✅ 1건. 침묵하는 자동화는 사람이 하는 것보다 나쁘다 |
| 자동 배포 성공 / 실패 / 관문 정지 / 자동 해제 | ✅ |
| `--arm` / `--disarm` | ✅ 누가 켜고 껐는지 남아야 한다 |
| 수동 배포 성공 | ❌ 화면 앞에 사람이 있다 |

웹훅 주소는 `/etc/moneyworry/alert.env` 의 `DISCORD_WEBHOOK_URL` 을 그대로
쓴다(감시기와 같은 파일). 없거나 비어 있으면 알림만 건너뛰고 배포는 돈다.

## 일정 — 이 판의 만료일

**`ARM_EXPIRES = 2026-09-12`**

원래 설계는 `09-23` 프리즈 이후 무장하고 `09-28` 에 자동 해제하는 것이었다.
운영자 결정으로 **09-28 에 하기로 했던 일을 09-12(오늘) 안에 전부 끝내기로**
바꿨다. 그래서 만료일이 오늘이다.

> **그 결과:** 오늘 무장하면 오늘 하루만 동작하고 **내일(09-13) 첫 폴링에서
> 스스로 꺼진다.** 그 뒤에도 자동 배포를 쓰려면 소스의 `ARM_EXPIRES` 를 고쳐
> **PR 을 올려 병합·배포**해야 한다. 서버에서 파일 하나 고치는 것으로는
> 바뀌지 않는다 — 그게 이 설계의 요점이다(사람이 끄는 것을 잊어도 꺼진다).

### 날짜 불일치 기록

앞선 문서 두 개가 하루 어긋나 있었다.

| 문서 | 자동 배포 정지 시점 |
| --- | --- |
| 주간회의 브리핑 (`0911_주간회의_브리핑_배포자동화.md:252`) | 09-28 |
| 실무배포 과업정리 (`0909_실무배포_과업정리.md:278`) | 09-29 최종 배포 직후 |

어느 쪽이든 **심사 기간(09-29~10-01)에는 반드시 꺼져 있어야 한다**는 것이
공통이다. CI 테스트가 `ARM_EXPIRES` 가 그 경계를 넘지 못하도록 단언한다.
(두 문서는 저장소 밖에 있어 여기에 기록만 남긴다.)

## 설치

**무장하지 않는다.** 유닛과 실행본만 놓는다.

```bash
# 1. 실행본
sudo install -m 0755 -o root -g root \
  /srv/moneyworry/repo/infra/scripts/autodeploy.sh \
  /usr/local/sbin/moneyworry-autodeploy

# 2. 유닛 (감시기와 같은 방식 — @PROJECT_ROOT@ 치환)
sudo sed 's|@PROJECT_ROOT@|/srv/moneyworry/repo|g' \
  /srv/moneyworry/repo/infra/systemd/moneyworry-autodeploy.service.in \
  | sudo tee /etc/systemd/system/moneyworry-autodeploy.service >/dev/null

sudo install -m 0644 -o root -g root \
  /srv/moneyworry/repo/infra/systemd/moneyworry-autodeploy.timer \
  /etc/systemd/system/moneyworry-autodeploy.timer

sudo systemctl daemon-reload
# ★ enable 하지 않는다. 여기서 멈춘다.
```

> `install-systemd-units.sh` 는 네 개의 **서비스** 유닛(db·rag·contract·web)만
> 다룬다. 타이머가 딸린 보조 유닛은 `moneyworry-health` 도 그렇듯 각 기능
> 문서에서 손으로 설치한다. 설치기를 건드리지 않는 것이 의도다 —
> 네 서비스의 렌더링·검증 경로에 보조 유닛을 섞으면 그쪽이 복잡해진다.

## 확인

```bash
sudo moneyworry-autodeploy --status              # DISARMED 여야 한다
systemctl is-enabled moneyworry-autodeploy.timer # disabled 여야 한다
sudo systemctl start moneyworry-autodeploy.service  # 1회 시험 — 무장 파일이 없어 즉시 종료
journalctl -t moneyworry-autodeploy -n 20 --no-pager
```

`--status` 는 sudo 없이도 돈다. 출력 예:

```
── 돈워리 자동 배포 상태 ──
  상태      DISARMED
  만료      2026-09-12 (오늘 2026-09-12)
  시간창    08:00–22:30 KST (지금 12:00 — 안)
  타이머    disabled / inactive
  배포기    MW_ROLLBACK_ON_EXIT_V2 있음 (롤백 동작)
  디스크    48828MB 여유 (최소 3072MB)
  실행본    저장소와 일치
  배포됨    9ea4e5e
  origin    9ea4e5e (할 일 없음)
```

## 무장

```bash
sudo moneyworry-autodeploy --arm
```

`--arm` 은 사전 점검을 전부 통과해야 성공한다. 통과하면 무장 파일을 쓰고
타이머를 켜고 Discord 로 알린다. 만료일이 이미 지났으면 **거부한다.**

## 끄기

```bash
sudo moneyworry-autodeploy --disarm
```

무장 파일을 지우고 타이머를 정지·disable 한다. 폴러가 이미 돌고 있는
배포를 중간에 끊지는 않는다 — 그건 `systemctl stop moneyworry-autodeploy.service`
이고, 그러면 배포기가 SIGTERM 을 받아 되돌린다.

완전히 걷어내려면:

```bash
sudo systemctl disable --now moneyworry-autodeploy.timer
sudo rm -f /etc/systemd/system/moneyworry-autodeploy.{service,timer}
sudo rm -f /usr/local/sbin/moneyworry-autodeploy /var/lib/moneyworry-deploy/autodeploy-*
sudo systemctl daemon-reload
```

## 알려진 한계

- **SIGKILL 은 못 잡는다.** 유닛 타임아웃(`TimeoutStartSec=50min`)을 넘기면
  systemd 가 SIGTERM 을 보내고 배포기가 그 신호에 종료 코드를 만들어 되돌리지만
  (`deploy-from-git.sh` 의 `on_signal`), bash 는 전경 명령이 끝나야 트랩을
  처리한다. 20분짜리 빌드 한가운데면 되돌리기가 늦고, SIGKILL 이면 아예 없다.
  그래서 배포 깃발에 만료 시각을 적고 원장에 시도 **전에** `start` 를 쓴다.
- **`--status` 는 원격을 조회한다.** 네트워크가 없으면 `origin` 줄만 실패로
  나온다. 판정에는 영향이 없다.
- **폴러는 `main` 만 본다.** 다른 브랜치를 자동 배포하는 경로는 없다(의도).
- **`--arm` 이후 첫 실제 배포는 사람이 지켜보는 것을 권한다.** 유닛 하드닝
  (`NoNewPrivileges` / `ProtectSystem=strict` / `ProtectHome`) 아래에서 배포기의
  `runuser` 권한 검증과 `npm ci` 가 도는 것은 이 판에서 처음이다.
  `journalctl -t moneyworry-autodeploy -f` 로 따라가면 된다.
- **알림이 실패해도 배포는 돈다.** 웹훅이 죽었을 때 배포까지 멈추는 것이
  더 나쁘다고 봤다. 대신 알림 실패는 journal 에 남는다.

## 관련 문서

- [`infra/DEPLOY_HISTORY.md`](DEPLOY_HISTORY.md) — 원장 형식, `--unattended` 규칙
- [`infra/HEALTH_WATCH.md`](HEALTH_WATCH.md) — 배포 중 감시 억제
- [`infra/OPERATIONS.md`](OPERATIONS.md) §5-1 — 배포기 계약(종료 코드·관문)
