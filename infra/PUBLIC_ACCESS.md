# 공개 진입점 (Tailscale Funnel)

데모를 외부에서 접속하는 경로를 기록한다. `infra/gcp/README.md`가 고정한
"공개 ingress는 IAP TCP 22뿐"이라는 사양과 이 문서의 관계는 [거버넌스](#거버넌스)에 적었다.

확인 시점: 2026-09-07 · VM `moneyworry-demo` (asia-northeast3-a, 프로젝트 `sed-coamong`)

## 구조

```text
인터넷
  │  HTTPS 443
  ▼
Tailscale Funnel  (<머신명>.<테일넷>.ts.net)
  │  tailscaled 가 프록시
  ▼
127.0.0.1:3111   moneyworry-web (Next.js)
  ├─ Basic auth (앱 계층)
  └─ /api/health/live, /api/health/ready 는 인증 면제
```

현재 설정은 VM에서 직접 읽는다.

```console
$ tailscale serve status
# Funnel on:
#     - https://<머신명>.<테일넷>.ts.net

https://<머신명>.<테일넷>.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:3111
```

- `tailscale` 1.102.3, `tailscaled` **enabled + active** (부팅 시 자동 시작)
- Funnel 설정은 tailscaled 상태에 저장되므로 **재부팅해도 유지된다.** 매일 07:00 기동 뒤
  별도 조치가 필요 없다.
- Funnel이 받을 수 있는 공개 포트는 **443 · 8443 · 10000** 뿐이다. 로컬 3111을 443으로
  노출하는 현재 구성은 이 제약 안에 있다.

### 왜 GCP 방화벽에 규칙이 없는데 인터넷에서 닿는가

Funnel은 VM에서 **바깥으로 나가는** 연결(egress)로 만들어진다. 인바운드 규칙이 필요 없고,
따라서 `infra/gcp/preflight.sh`의 "공개 ingress 0건" 검사에도 걸리지 않는다.
프로젝트의 유일한 방화벽 규칙은 여전히 `moneyworry-iap-ssh`(IAP → tcp:22) 하나다.

### 실제 주소를 이 파일에 적지 않는 이유

이 저장소는 **공개(public)** 다. 호스트명 자체가 비밀은 아니지만, 저장소에 적으면 스캐너가
자동으로 수집해 Basic auth에 대한 시도가 늘어난다. 저장소 규칙(`infra/README.md`:
"실제 secret 값은 명령행이나 저장소에 쓰지 않는다")과도 같은 취지다.

실제 주소는 `tailscale serve status`로 언제든 확인할 수 있고, 데모 계정 정보와 함께
팀 내부 채널에 둔다.

## 인증

Basic auth는 **앱 계층**(`product/src/proxy.ts`)에서 처리한다. 진입점이 Funnel이든
IAP 포트포워딩이든 동일하게 적용된다.

| 경로 | 인증 | 외부 응답 (2026-09-07 확인) |
| --- | --- | --- |
| `/` 및 대부분 | 필요 | `401` |
| `/api/health/live` | 면제 | `200` `{"api_contract":"donworry.health.v1","status":"live"}` |
| `/api/health/ready` | 면제 | `200` |

면제 경로 덕분에 **자격증명 없이 외부에서 가용성을 감시할 수 있다.**
`infra/scripts/deploy-from-git.sh`가 배포 직후 이 경로로 공개 경로를 검증한다.

## 접속되지 않는 경우 세 가지

| 상황 | 시간대 / 조건 | 증상 |
| --- | --- | --- |
| VM 정지 | 매일 **01:00–07:00 KST** (`moneyworry-18h-daily`) | 연결 실패 |
| 배포 중 | `product/**` 변경 시 10–25분 | `502` |
| web 장애 | 임의 | `502` |

주소는 그대로다. 위 셋 모두 "주소가 바뀐 것"이 아니다.
`db/**`만 바뀌는 배포는 재빌드가 없어 수십 초로 끝난다.

## 노드 키 만료 — 조치 완료 (2026-09-07)

이 머신은 태그가 없어(`tailscale status --json` → `Tags: None`) 사용자 계정에 묶여 있고,
Tailscale 기본 키 만료(**180일**) 대상이었다. 무인 서버이므로 **2026-09-07 관리 콘솔에서
Disable key expiry를 적용했다.** 만료로 인해 공개 주소가 죽는 시나리오는 이로써 제거됐다.

### 왜 껐는가

공식 문서: *"If reauthentication does not occur, keys expire and connections to/from the
given endpoint will stop working."* 노트북이라면 만료 알림을 보고 본인이 재인증하면 된다.
그러나 이 VM은 무인으로 돌기 때문에 재인증해 줄 사람이 없다. 어느 날 조용히 테일넷에서
떨어져 나가고, 코드도 서버도 멀쩡한데 **공개 주소만 죽는다.** 원인을 찾기 가장 어려운
종류의 장애다.

Tailscale 문서도 *"trusted servers, subnet routers, or remote IoT devices that are hard to
reach"* 에 대해 같은 조치를 권한다.

### 대가와 완화책

만료가 없으므로 노드 키가 유출되면 무기한 유효하다. 다만 관리 콘솔에서 기기를 삭제하면
즉시 차단되고, 이 VM은 스케줄 만료(2026-11-23)와 함께 폐기된다.

더 강한 대안은 **태그 부여**다. 태그를 붙이면 키 만료가 기본으로 비활성화되는 동시에
소유권이 개인 계정에서 테일넷으로 옮겨져, 계정 변동(탈퇴·정지)에도 영향을 받지 않는다.
정책 파일 수정이 필요해 이번에는 채택하지 않았다.

### 확인

```bash
tailscale status --json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["Self"]; print("KeyExpiry:", d.get("KeyExpiry", "없음 (만료 비활성화됨)"))'
```

`없음 (만료 비활성화됨)` 이어야 한다. 날짜가 찍히면 설정이 적용되지 않은 것이다.

## 재구축 절차

VM을 새로 만들었거나 Funnel이 사라졌을 때.

```bash
# 1. 사전 조건 (관리 콘솔에서 1회)
#    - MagicDNS 활성화
#    - HTTPS 인증서 활성화
#    - 정책 파일에 funnel nodeAttr (기본값은 autogroup:member 허용)

# 2. VM 에 tailscale 설치 후 tailnet 에 가입
tailscale up

# 3. web 을 공개
tailscale funnel --bg 3111

# 4. 확인
tailscale serve status
curl -s -o /dev/null -w '%{http_code}\n' https://<주소>/api/health/live   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://<주소>/                  # 401
```

호스트명은 `<머신명>.<테일넷>.ts.net`이므로 **머신 이름이나 테일넷 이름을 바꾸면 주소가 바뀐다.**
바꾸지 않는 한 영구 고정이다.

## 폐기: Cloudflare Quick Tunnel

`/etc/systemd/system/moneyworry-tunnel.service` (2026-08-28 작성, 1,473 bytes)는
2026-09-07에 **`disabled`** 처리했다. 유닛 파일은 참고용으로 남겨 두었다.

유닛 자체는 잘 작성돼 있었다 — `DynamicUser`, `ProtectSystem=strict`,
`CapabilityBoundingSet=` 비움, `MemoryDenyWriteExecute` 등 강화 옵션이 충실했다.
문제는 Quick Tunnel이라는 도구의 성질이었다.

- **주소가 고정되지 않는다.** Cloudflare 공식 문서: *"generates a random subdomain on
  `trycloudflare.com`"* — 실행할 때마다 새로 발급된다.
- **SLA가 없다.** *"We don't guarantee any SLA or uptime of TryCloudflare."*
  문서는 *"intended for testing and development only"* 라고 못박는다.
- 동시 요청 200개 하드 리밋(초과 시 `429`), Server-Sent Events 미지원.
- `Requires=moneyworry-web.service` 때문에 **배포로 web을 내릴 때마다 함께 죽고,
  web을 다시 켜도 따라 올라오지 않았다**(의존은 단방향). 배포할 때마다 사람이 손으로
  켜야 했고, 켤 때마다 주소가 바뀌어 공유한 링크가 무효가 됐다.

되살리려면 `systemctl enable --now moneyworry-tunnel.service`. 단 위 성질은 그대로다.

고정 도메인이 필요하고 팀이 Cloudflare에 도메인을 두고 있다면 Quick Tunnel이 아니라
**named tunnel**(`cloudflared tunnel create` → `tunnel route dns`)로 가야 한다.
현재는 Funnel로 충분해 검토하지 않았다.

## 거버넌스

`infra/gcp/README.md`의 "변경할 수 없는 배포 사양"은 공개 ingress를 IAP TCP 22 하나로
고정하고, 생성되는 유일한 ingress가 그것이라고 적고 있다. **Funnel은 그 사양이 쓰인 뒤에
추가된 공개 경로이며, egress 기반이라 `preflight.sh`가 검출하지 못한다.**

즉 현재 상태는 "검사를 통과하지만 문서화된 의도와는 어긋나는" 구성이다. 이 문서는 그 사실을
기록하는 것이지 사양 변경을 승인하는 것이 아니다. 다음 중 하나를 팀이 정해야 한다.

1. `infra/gcp/README.md`의 사양을 개정해 Funnel을 정식 공개 경로로 포함한다.
2. Funnel을 내리고 데모마다 IAP SSH 포트포워딩(`ssh -L 3111:127.0.0.1:3111`)으로 대체한다.
3. 데모 기간(스케줄 만료 2026-11-23)까지 예외로 두고 종료 시 함께 정리한다.

## 검증 명령 모음

```bash
# VM 에서
tailscale serve status
tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"])'
systemctl is-enabled tailscaled; systemctl is-active tailscaled

# 어디서든 (자격증명 불필요)
curl -s -o /dev/null -w '%{http_code}\n' https://<주소>/api/health/live   # 200 이어야 정상
curl -s -o /dev/null -w '%{http_code}\n' https://<주소>/                  # 401 이어야 정상 (200 이면 인증이 꺼진 것)
```

마지막 항목이 `200`이면 **인증 없이 앱 전체가 공개된 상태**이므로 즉시 조치해야 한다.
