# 단일 GCP VM Path B 인프라 자동화

이 디렉터리는 MoneyWorry 데모를 **Cloud SQL 없이 단일 Compute Engine VM**에 배치하기 위한
fail-closed CLI 계층이다. PostgreSQL 16은 VM 내부 Docker로 실행하고 영속 데이터는
`/srv/moneyworry`에 둔다. 기본 실행은 조회와 명령 출력만 하며, `--apply`와 정확한 확인 토큰을
동시에 주기 전에는 Compute 리소스를 변경하지 않는다.

이 자동화는 프로젝트 생성, 결제 계정 생성·연결, 무료 체험 활성화, 예산 생성, API 활성화,
프로젝트 Owner/IAM 변경, DNS·인증서·외부 URL 공개를 수행하지 않는다. 모두 사용자 승인과
권한 있는 관리자의 별도 작업으로 남는다.

## 변경할 수 없는 배포 사양

| 항목 | 고정값 |
| --- | --- |
| region | `asia-northeast3` (서울) |
| zone | 실행 시 `a`, `b`, `c` 중 하나를 명시 |
| VM | `moneyworry-demo`, `e2-custom-2-12288` (2 vCPU, 12 GiB) |
| image | immutable `ubuntu-os-cloud/ubuntu-2404-noble-amd64-v20260820` |
| boot disk | 30 GB `pd-standard`, VM과 함께 삭제 |
| data disk | `moneyworry-data`, 80 GB `pd-balanced`, VM 삭제 시 보존 |
| network | custom VPC `moneyworry-vpc`, subnet `10.20.0.0/24` |
| SSH ingress | IAP `35.235.240.0/20`에서 대상 tag의 TCP 22만 허용 |
| login | OS Login + OS Login 2FA, project SSH key 차단 |
| workload identity | VM service account와 OAuth scope 없음 |
| instance schedule | 매일 `07:00` 시작, 다음 날 `01:00` 종료 (`Asia/Seoul`, 18시간) |
| schedule period | `2026-08-27T00:00:00+09:00` ~ `2026-11-24T02:00:00+09:00` |
| application root | `/srv/moneyworry` |

machine type, 이미지, 디스크 용량·종류, VPC CIDR, 방화벽, 운영 schedule은 CLI 인자나 환경변수로
바꿀 수 없다.
다른 사양이나 Cloud NAT가 필요하면 먼저 설계와 비용을 다시 승인하고 이 자동화 자체를 코드 리뷰한다.

VM에는 외부 패키지와 외부 AI API로 나가는 통신을 위해 ephemeral external access configuration을
하나 둔다. 이것은 공개 서비스용 방화벽이나 URL을 만들지 않는다. 프로젝트의 모든 공개 ingress는
preflight가 거부하고, 생성되는 유일한 ingress는 IAP TCP 22이다. PostgreSQL `5433`, RAG `5051`,
계약 분석 `8000`, 웹 `3111`은 GCP 방화벽으로 열지 않으며 프로세스도 loopback에 바인딩해야 한다.
외부 IP 자체를 제거하려면 Cloud NAT 등 별도 egress 설계와 재견적이 필요하므로 이 스크립트가
임의로 전환하지 않는다.
비용 견적에는 실행 중인 VM의 external IPv4 비용도 포함해야 한다.
VM이 예약 종료된 동안 ephemeral external IPv4 주소 값은 사라질 수 있지만 access configuration은
유지되어야 한다. 일반 preflight는 정확한 schedule이 연결되고 현재 시각이 `01:00` 이상
`07:00` 미만이거나 schedule 만료 뒤인 경우에만 `TERMINATED`를 정상 상태로 허용하며, 새 VM
생성 직후 postflight는 별도로 `RUNNING`을 요구한다.

매일 사람이 start/stop하는 방식은 누락을 자동 검증할 수 없으므로 기본안으로 사용하지 않는다.
regional instance schedule을 코드로 고정하면 시간대·cron·연결 여부를 preflight에서 재검증할 수
있다. 다만 Google 문서상 예약 작업은 최대 약 15분 늦을 수 있고 시작 capacity를 보장하지 않으므로,
시연일에는 audit log와 VM 상태를 확인하고 필요할 때만 수동 시작한다. 마지막 `01:00` 종료가 처리될
여유를 두기 위해 schedule 만료는 `02:00`으로 고정했다.

## 반드시 먼저 사람이 확인할 항목

1. Google Cloud 프로젝트와 결제 계정/무료 체험 상태를 Console에서 확인한다. 이 자동화는 연결이나
   활성화를 대신하지 않는다.
2. 운영할 사용자가 맞는지 확인한 뒤 별도로 `gcloud auth login`한다. Owner 변경은 하지 않는다.
3. 결제 계정에 **`sed-coamong` 프로젝트 하나의 전체 비용만 scope로 갖는 KRW 350,000 예산**을
   만든다. 비반복 custom period는 API 값 기준 `startDate=2026-08-26`,
   `endDate=2026-11-24`이고, `creditTypesTreatment=EXCLUDE_ALL_CREDITS`여야 한다. service, label,
   subaccount, 특정 credit type 같은 축소 필터를 두지 않는다. Google Cloud
   예산은 비용 상한이나 자동 차단 장치가 아니라 알림/모니터링 장치라는 점에 유의한다.
4. 공식 Pricing Calculator 또는 동등한 승인 자료에서 월 예상액과 90일 예상액을 기록한다.
   스크립트는 두 값을 검증하지만 가격 카탈로그를 조회하거나 견적의 진위를 대신 판단하지 않는다.
5. 다음 API가 프로젝트에 이미 활성화되어 있어야 한다. 스크립트는 활성화하지 않는다.

   - `billingbudgets.googleapis.com`
   - `cloudbilling.googleapis.com`
   - `cloudresourcemanager.googleapis.com`
   - `compute.googleapis.com`
   - `iap.googleapis.com`
   - `logging.googleapis.com`
   - `monitoring.googleapis.com`
   - `networkconnectivity.googleapis.com`
   - `oslogin.googleapis.com`
   - `secretmanager.googleapis.com`
   - `serviceusage.googleapis.com`
   - `storage.googleapis.com`

6. OS Login 사용자에게 필요한 최소 IAM 역할과 Google 계정 2단계 인증, IAP 터널 권한은 관리자가
   별도로 검토·부여한다. 자동화는 IAM binding을 만들지 않는다.

관련 공식 문서:

- [IAP TCP forwarding 방화벽 범위](https://cloud.google.com/iap/docs/using-tcp-forwarding#create-firewall-rule)
- [OS Login과 2단계 인증 설정](https://cloud.google.com/compute/docs/oslogin/set-up-oslogin)
- [Cloud Billing 예산은 지출을 자동 제한하지 않음](https://cloud.google.com/billing/docs/how-to/budgets)
- [Compute Engine instance schedule](https://cloud.google.com/compute/docs/instances/schedule-instance-start-stop)
- [`gcloud compute instances create` 옵션](https://cloud.google.com/sdk/gcloud/reference/compute/instances/create)

## 1. 조회 전용 preflight

프로젝트는 항상 명시한다. 설정된 gcloud 기본 프로젝트를 대신 사용하지 않는다.

```bash
infra/gcp/preflight.sh \
  --project sed-coamong \
  --zone a \
  --expected-monthly-usd 71.09 \
  --expected-90day-usd 206.39
```

preflight는 다음을 조회하고 하나라도 불명확하면 실패한다.

- active gcloud account가 정확히 하나인지
- 명시한 프로젝트가 `ACTIVE`이고 billing linkage가 활성인지
- 다른 service/label/credit-type 축소 필터가 없는 `sed-coamong` 프로젝트 전체 scope에
  `moneyworry-90day` 예산이 존재하는지
- 해당 예산이 API 값 기준 `2026-08-26`부터 `endDate=2026-11-24`까지의 비반복 사용자 지정 기간,
  KRW 350,000, `EXCLUDE_ALL_CREDITS`를 정확히 사용하는지
- 실제 지출 기준 25%, 50%, 70%, 85%, 95% 규칙이 모두 있으며 Billing IAM 수신자와 프로젝트 Owner 이메일이 모두 활성인지
- 필수 API가 모두 활성인지
- 프로젝트 공통 instance metadata가 비어 있어 inherited startup/user-data가 없는지
- immutable image가 `READY` x86_64 Ubuntu 24.04 LTS이고 폐기 상태나 예상 밖 라이선스가 없는지
- 프로젝트에 `0.0.0.0/0`, `::/0` 또는 암묵적 전체 공개 ingress가 없는지
- 기존 대상 VPC에는 hierarchical/global/regional firewall policy가 적용되지 않는지
- 대상 VPC에 명시적 egress 방화벽, Cloud Router, policy-based route, NCC spoke가 없는지
- 대상 VPC route가 정확히 하나의 IPv4 default internet gateway와 예상 subnet route뿐인지
- 대상 VM에 IAP 이외 SSH 규칙이나 `5433/5051/8000/3111` 규칙이 적용되지 않는지
- 같은 이름의 VPC, subnet, firewall, disk, VM이 없거나 고정 사양과 정확히 같은지
- `moneyworry-18h-daily` schedule이 서울 region에서 매일 `07:00` 시작/`01:00` 종료,
  `Asia/Seoul`과 한정된 유효기간을 정확히 사용하는지
- 기존 VM이 schedule을 정확히 하나만 연결하고 boot/data attachment가 `READ_WRITE`인지
- 실행 중이면 외부 통신 가능한 ephemeral external IPv4가 있는지, 예약 종료 상태이면
  `TERMINATED`이며 ephemeral 주소 값만 비어 있는지

머신이 이미 있으면 network, subnet, firewall, boot/data disk도 모두 정확해야 한다. 다른 크기의
동명 disk처럼 부분 충돌이 있으면 생성·수정하지 않고 중단한다. `--json`은 검토 가능한 정책 결과를
출력하고, `--require-complete`는 모든 리소스가 존재하는 배포 후 상태까지 요구한다.

## 2. dry-run 계획

`provision.sh`도 기본은 조회 전용이다. 예상 비용 gate는
`max(명시한 90일 예상액, 월 예상액 × 3) <= USD 250.00`일 때만 통과한다. 이 USD 250은
KRW 예산 검증과 분리된 보수적 견적 상한이다. 두 견적은 매일 18시간 VM 실행과 정지 중에도 계속
청구되는 disk 등 잔여 비용을 모두 반영해야 한다. 잘못된 형식, 0 이하,
소수점 셋째 자리, 또는 상한 초과 입력은 **첫 gcloud 프로세스 전에** 거부한다.

```bash
infra/gcp/provision.sh \
  --project sed-coamong \
  --zone a \
  --expected-monthly-usd 71.09 \
  --expected-90day-usd 206.39
```

출력된 프로젝트, zone, 리소스와 shell-escaped 생성 명령을 검토한다. dry-run은 마지막에 해당 실행에
필요한 확인 토큰을 출력한다.

## 3. 명시적 apply

dry-run 결과와 별도 견적을 승인한 경우에만 정확한 토큰을 그대로 전달한다.

```bash
infra/gcp/provision.sh \
  --project sed-coamong \
  --zone a \
  --expected-monthly-usd 71.09 \
  --expected-90day-usd 206.39 \
  --apply \
  --confirm 'PROVISION:sed-coamong:asia-northeast3-a:moneyworry-demo'
```

생성 순서는 VPC → subnet → IAP firewall → 18시간 instance schedule → data disk → VM이다.
schedule은 VM 생성과 동시에 연결한다. 정확히 존재하는 리소스는 건너뛰므로
부분 실패 뒤에도 다시 preflight/dry-run을 거쳐 안전하게 재실행할 수 있다. create가 모두 성공한 뒤
VM 생성 직전에 공개 방화벽과 중간 리소스를 다시 조회하며, 마지막 독립 preflight가 모든 리소스를
`exact`로 확인해야만 완료로 보고한다. update와 delete는 구현하지 않는다.

인프라 생성 뒤의 data disk 포맷·마운트, Docker/PostgreSQL 16 설치, 저장소 배치, 비밀 파일 준비,
분리된 DB 전용/애플리케이션 전용 서비스 계정과 systemd 설치는 VM 내부의 별도 승인 단계다.
특히 DB를 실행하는 계정만 Docker 접근을 가져야 하며 web/RAG/contract 환경 파일을 공용으로
합치지 않는다. 이 GCP 자동화는 VM 내부 설치기를 호출하거나 비밀 값을 인자로 받지 않는다.

## 로컬 정적 검증

다음 검증은 실제 `gcloud` 대신 상태를 기록하는 fake를 사용한다. 인증되지 않은 로컬 gcloud 설정이나
Google Cloud 리소스를 읽거나 변경하지 않는다.

```bash
bash -n \
  infra/gcp/common.sh \
  infra/gcp/preflight.sh \
  infra/gcp/provision.sh \
  infra/gcp/tests/fake-gcloud.sh \
  infra/gcp/tests/test-gcp-automation.sh

python3 -m py_compile infra/gcp/validate-preflight.py
infra/gcp/tests/test-gcp-automation.sh
git diff --check -- infra/gcp
```

fake suite는 clean dry-run, 확인 토큰 실패, 비용 상한 실패, 고정 사양 apply, postflight,
재실행 멱등성, 예약 종료 exact 상태, schedule 누락·drift, 미인증,
잘못된/무범위/축소필터/credit-treatment 예산, API 누락, 공개 ingress,
초기 조회 뒤 VM 생성 전에 생긴 공개 ingress, 리소스 drift, boot/data disk의 예상 밖 두 번째
attachment, immutable source image, VM 실행/attachment/NAT 상태, project metadata, inherited/network
firewall policy를 검증한다.
