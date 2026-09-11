# 헬스 감시와 알림

`moneyworry-health.timer` 가 1분마다 웹을 찔러 보고, 죽었으면 살리고, 사람에게 Discord 로 알린다.

기록 2026-09-11 · 대상 VM `moneyworry-demo`

## 왜 필요한가

systemd 의 `Restart=always` 는 **프로세스가 죽었을 때만** 살린다. 프로세스는 살아 있는데
응답만 못 하는 상태 — DB 커넥션 고갈, 이벤트 루프 블로킹 — 는 잡지 못한다. 그리고 무엇보다
**죽어도 아무도 모른다.** 배포 스크립트는 배포할 때만 확인하고, 그 외에는 보는 사람이 없다.

## 두 엔드포인트를 나눠 쓴다

고칠 수 있는 고장과 아닌 고장이 다르기 때문이다.

| 검사 | 뜻 | 실패하면 |
| --- | --- | --- |
| `/api/health/live` | 앱이 요청을 받기는 하는가 | **재시작한다.** 이건 재시작으로 고쳐진다 |
| `/api/health/ready` | DB·RAG·계약서 분석이 다 붙었는가 | **알리기만 한다.** 웹을 재시작해도 DB 가 살아나지 않는다 |

`ready` 실패에 재시작을 걸면, 멀쩡한 웹을 1분마다 흔들면서 정작 원인은 그대로 둔다.

## 판정 규칙

- **3분 연속** 실패해야 움직인다. 배포 중 재시작(`ready` 까지 최대 300초)을 장애로 오인하지 않기 위함이다
- 알림은 **상태가 바뀔 때만** 보낸다. 1분마다 같은 말을 하면 아무도 안 읽는다
- 재시작은 **한 번만** 한다. 살아나지 않으면 「사람이 봐야 합니다」를 보내고 멈춘다. 계속 흔들면 상황이 나빠진다
- 복구되면 복구됐다고 알린다

상태는 `/run/moneyworry/health-watch.state` 에 둔다. `/run` 이라 재부팅하면 지워진다 —
껐다 켠 뒤 옛 장애 알림이 되살아나면 안 되므로 의도한 것이다.

## 설치

```bash
sudo install -m 0755 -o root -g root \
  /srv/moneyworry/repo/infra/scripts/health-watch.sh \
  /usr/local/sbin/moneyworry-health-watch

sudo sed 's|@PROJECT_ROOT@|/srv/moneyworry/repo|g' \
  /srv/moneyworry/repo/infra/systemd/moneyworry-health.service.in \
  | sudo tee /etc/systemd/system/moneyworry-health.service >/dev/null

sudo install -m 0644 -o root -g root \
  /srv/moneyworry/repo/infra/systemd/moneyworry-health.timer \
  /etc/systemd/system/moneyworry-health.timer

sudo systemctl daemon-reload
sudo systemctl enable --now moneyworry-health.timer
```

배포 스크립트가 코드를 갱신해도 `/usr/local/sbin` 의 사본은 안 바뀐다.
`health-watch.sh` 를 고치면 위 `install` 줄을 다시 돌린다 — `deploy-from-git.sh` 를
`/usr/local/sbin/moneyworry-deploy` 로 설치해 두는 것과 같은 이유다.

## 웹훅 주소

**저장소에 넣지 않는다.** VM 에 root 만 읽는 파일로 둔다.

```bash
sudo install -d -m 0755 /etc/moneyworry
sudo touch /etc/moneyworry/alert.env
sudo chmod 600 /etc/moneyworry/alert.env
sudo chown root:root /etc/moneyworry/alert.env
sudo nano /etc/moneyworry/alert.env
```

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

이 파일이 없거나 비어 있으면 알림만 건너뛰고 감시·재시작은 그대로 돈다.
`validate-service-envs.py` 의 검사 대상이 아니므로 배포에는 영향이 없다.

## 확인

```bash
sudo /usr/local/sbin/moneyworry-health-watch --test      # 알림 경로 시험
sudo /usr/local/sbin/moneyworry-health-watch --status    # 지금 상태
sudo systemctl list-timers moneyworry-health.timer       # 다음 실행 시각
sudo journalctl -u moneyworry-health.service -n 30 --no-pager
```

## 끄기

시연 중이거나 계획된 작업으로 알림을 멈추고 싶을 때.

```bash
sudo systemctl disable --now moneyworry-health.timer
```

## 알려진 한계

- **서버가 통째로 죽으면 이 감시도 같이 죽는다.** 그래서 서버 밖에서 보는 눈이 따로 필요하다 —
  UptimeRobot 으로 `/api/health/live` 를 감시한다(이 경로는 Basic auth 면제)
- VM 이 07:00~01:00 만 켜진다. 외부 감시에는 **01:00~07:00 유지보수 창**을 걸어야
  매일 밤 오탐이 오지 않는다
- `systemctl restart` 를 부르려면 root 여야 한다. 대신 `ProtectSystem=strict`,
  `ReadWritePaths=/run/moneyworry` 로 쓸 수 있는 곳을 상태 파일 하나로 묶었다
