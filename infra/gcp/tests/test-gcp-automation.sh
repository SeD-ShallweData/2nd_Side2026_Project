#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GCP_DIR="$(CDPATH= cd -- "$TEST_DIR/.." && pwd -P)"
FAKE_GCLOUD="$TEST_DIR/fake-gcloud.sh"
PREFLIGHT="$GCP_DIR/preflight.sh"
PROVISION="$GCP_DIR/provision.sh"

test_root="$(mktemp -d -t moneyworry-gcp-tests.XXXXXXXX)"
trap 'rm -rf -- "$test_root"' EXIT

tests_run=0

note_pass() {
  tests_run=$((tests_run + 1))
  printf 'ok %d - %s\n' "$tests_run" "$1"
}

fail() {
  printf 'not ok %d - %s\n' "$((tests_run + 1))" "$1" >&2
  if [[ -f "$test_root/stderr" ]]; then
    sed -n '1,40p' "$test_root/stderr" >&2
  fi
  exit 1
}

reset_case() {
  case_dir="$test_root/$1"
  mkdir -p "$case_dir/state"
  log_path="$case_dir/gcloud.log"
  : >"$log_path"
  : >"$test_root/stdout"
  : >"$test_root/stderr"
}

run_preflight() {
  local scenario="$1"
  shift
  env \
    GCLOUD_BIN="$FAKE_GCLOUD" \
    FAKE_GCLOUD_LOG="$log_path" \
    FAKE_GCLOUD_STATE_DIR="$case_dir/state" \
    FAKE_GCLOUD_SCENARIO="$scenario" \
    "$PREFLIGHT" "$@" >"$test_root/stdout" 2>"$test_root/stderr"
}

run_provision() {
  local scenario="$1"
  shift
  env \
    GCLOUD_BIN="$FAKE_GCLOUD" \
    FAKE_GCLOUD_LOG="$log_path" \
    FAKE_GCLOUD_STATE_DIR="$case_dir/state" \
    FAKE_GCLOUD_SCENARIO="$scenario" \
    "$PROVISION" "$@" >"$test_root/stdout" 2>"$test_root/stderr"
}

base_args=(
  --project safe-demo-123
  --zone a
  --expected-monthly-usd 70.00
  --expected-90day-usd 210.00
)
confirm_args=(
  --apply
  --confirm PROVISION:safe-demo-123:asia-northeast3-a:moneyworry-demo
)

reset_case preflight-clean
run_preflight clean "${base_args[@]}" --json || fail "clean read-only preflight succeeds"
python3 - "$test_root/stdout" <<'PY' || fail "clean preflight emits valid policy JSON"
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
assert report["status"] == "ready"
assert report["mode"] == "read-only-preflight"
assert report["region"] == "asia-northeast3"
assert report["zone"] == "asia-northeast3-a"
assert report["budget"]["limit_usd"] == "250.00"
assert report["budget"]["display_name"] == "moneyworry-90day"
assert report["budget"]["period"] == {"start": "2026-08-25", "end": "2026-11-23"}
assert report["budget"]["threshold_percentages"] == [25, 50, 70, 85, 95]
assert report["budget"]["email_recipients"] == ["billing-iam", "project-owners"]
assert report["cost"]["gated_90day_usd"] == "210.00"
assert report["resources"]["image"] == "exact"
assert set(report["resources"].values()) == {"absent", "exact"}
PY
note_pass "clean preflight validates account, project, billing, budget, APIs, and inventory"

while IFS= read -r invocation; do
  case "$invocation" in
    auth\ list*) ;;
    billing\ budgets\ list*)
      [[ "$invocation" == *"--billing-account=000000-111111-222222"* ]] \
        || fail "billing budget query is explicitly scoped"
      [[ "$invocation" == *"--account=operator@example.test"* ]] \
        || fail "billing budget query must pin the validated account"
      ;;
    compute\ images\ describe*)
      [[ "$invocation" == *"--project=ubuntu-os-cloud"* ]] \
        || fail "immutable public image query must pin the image project"
      [[ "$invocation" == *"--account=operator@example.test"* ]] \
        || fail "immutable public image query must pin the validated account"
      ;;
    *)
      [[ "$invocation" == *"--project=safe-demo-123"* ]] \
        || fail "every project-scoped read uses the explicit project"
      [[ "$invocation" == *"--account=operator@example.test"* ]] \
        || fail "every cloud read after auth must pin the validated account"
      ;;
  esac
done <"$log_path"
note_pass "read-only calls never rely on the configured default project"

if grep -Eq '(^| )compute .* create( |$)|(^| )services enable( |$)' "$log_path"; then
  fail "preflight must not mutate cloud state"
fi
note_pass "preflight gcloud inventory contains no mutation command"

grep -Eq '^compute routes list .*--project=safe-demo-123' "$log_path" \
  || fail "preflight must inventory all routes with the explicit project"
note_pass "preflight inventories the complete project route table"

reset_case dry-run
run_provision clean "${base_args[@]}" || fail "default provision mode succeeds"
grep -Eq 'DRY RUN \(no mutations\)' "$test_root/stdout" \
  || fail "dry-run is visibly labelled"
grep -Eq 'PROVISION:safe-demo-123:asia-northeast3-a:moneyworry-demo' "$test_root/stdout" \
  || fail "dry-run prints the exact confirmation token"
if grep -Eq '^compute .* create ' "$log_path"; then
  fail "dry-run must not call create"
fi
note_pass "provision defaults to a read-only dry-run"

reset_case bad-confirm
if run_provision clean "${base_args[@]}" --apply --confirm WRONG; then
  fail "wrong confirmation token must fail"
fi
[[ ! -s "$log_path" ]] || fail "wrong token must fail before any gcloud call"
note_pass "apply requires an exact project/zone/VM confirmation token"

reset_case over-cost-monthly
if run_provision clean \
  --project safe-demo-123 --zone a \
  --expected-monthly-usd 84.00 --expected-90day-usd 200.00 \
  "${confirm_args[@]}"; then
  fail "monthly times three above USD 250 must fail"
fi
[[ ! -s "$log_path" ]] || fail "over-cost input must fail before gcloud"
grep -Eq 'monthly\*3' "$test_root/stderr" || fail "conservative cost failure must be explicit"
note_pass "monthly-times-three cost gate cannot be bypassed by a lower 90-day input"

reset_case over-cost-90day
if run_provision clean \
  --project safe-demo-123 --zone a \
  --expected-monthly-usd 70.00 --expected-90day-usd 250.01 \
  "${confirm_args[@]}"; then
  fail "explicit 90-day estimate above USD 250 must fail"
fi
[[ ! -s "$log_path" ]] || fail "over-cost input must fail before gcloud"
note_pass "explicit 90-day estimate above USD 250 is rejected"

reset_case unknown-size-input
if run_provision clean "${base_args[@]}" --machine-type e2-standard-8; then
  fail "deployment size override must be rejected"
fi
[[ ! -s "$log_path" ]] || fail "unsupported size input must fail before gcloud"
note_pass "machine and disk specifications have no input override"

reset_case apply-clean
run_provision clean "${base_args[@]}" "${confirm_args[@]}" \
  || fail "confirmed clean apply succeeds"
create_count="$(grep -Ec '^compute .* create ' "$log_path")"
[[ "$create_count" == "5" ]] || fail "apply must create exactly five fixed resources"
for fixed_argument in \
  '--machine-type=e2-custom-2-12288' \
  '--image=ubuntu-2404-noble-amd64-v20260820' \
  '--boot-disk-size=30GB' \
  '--boot-disk-type=pd-standard' \
  '--size=80GB' \
  '--type=pd-balanced' \
  '--source-ranges=35.235.240.0/20' \
  '--rules=tcp:22' \
  'network-tier=PREMIUM\,address=' \
  'enable-oslogin=TRUE' \
  'enable-oslogin-2fa=TRUE' \
  '--no-service-account' \
  '--deletion-protection'; do
  grep -Fq -- "$fixed_argument" "$log_path" \
    || fail "apply command is missing fixed argument $fixed_argument"
done
create_count_with_account="$(grep -Ec '^compute .* create .*--account=operator@example.test' "$log_path")"
[[ "$create_count_with_account" == "5" ]] \
  || fail "every mutation must pin the account validated by preflight"
if grep -Eq -- '0\.0\.0\.0/0|::/0|tcp:(5433|5051|8000|3111)' "$log_path"; then
  fail "apply must not create public service ingress"
fi
note_pass "confirmed apply creates only the fixed VM, disks, network, subnet, and IAP firewall"

: >"$log_path"
run_provision clean "${base_args[@]}" "${confirm_args[@]}" \
  || fail "second confirmed apply succeeds"
if grep -Eq '^compute .* create ' "$log_path"; then
  fail "second apply must not recreate exact resources"
fi
grep -Eq 'no changes' "$test_root/stdout" || fail "idempotent apply should report no changes"
note_pass "second apply is idempotent after exact postflight inventory"

reset_case pre-vm-race
if run_provision broad-after-firewall-create "${base_args[@]}" "${confirm_args[@]}"; then
  fail "a public firewall appearing after initial preflight must abort apply"
fi
if grep -Eq '^compute instances create ' "$log_path"; then
  fail "pre-VM recheck must stop before instance creation"
fi
grep -Eq 'dangerous public ingress firewall' "$test_root/stderr" \
  || fail "pre-VM firewall race failure must be explicit"
note_pass "policy is re-inventoried after network creation and before VM creation"

reset_case already-existing
run_provision existing "${base_args[@]}" "${confirm_args[@]}" \
  || fail "exact existing inventory succeeds"
if grep -Eq '^compute .* create ' "$log_path"; then
  fail "exact existing inventory must not call create"
fi
note_pass "independently existing exact resources are reused without mutation"

for scenario in \
  unauthenticated bad-budget unscoped-budget filtered-budget monthly-budget \
  wrong-budget-dates wrong-budget-thresholds forecast-budget-threshold no-budget-recipients \
  missing-api broad-firewall \
  split-public-ingress drift \
  extra-boot-user extra-data-user stopped-vm readonly-boot readonly-data missing-nat-ip \
  wrong-source-image project-startup-metadata inherited-firewall-policy \
  missing-default-route custom-next-hop-route egress-deny effective-egress-deny \
  missing-image bad-image-status deprecated-image arm-image wrong-image-license \
  target-cloud-router target-policy-based-route target-ncc-spoke; do
  reset_case "reject-$scenario"
  if run_preflight "$scenario" "${base_args[@]}"; then
    fail "$scenario must fail preflight"
  fi
  note_pass "preflight rejects $scenario state"
done

reset_case invalid-zone
if run_preflight clean \
  --project safe-demo-123 --zone d \
  --expected-monthly-usd 70 --expected-90day-usd 210; then
  fail "unsupported zone suffix must fail"
fi
[[ ! -s "$log_path" ]] || fail "invalid zone must fail before gcloud"
note_pass "zone is constrained to asia-northeast3 a/b/c"

reset_case implicit-project
if run_preflight clean \
  --zone a --expected-monthly-usd 70 --expected-90day-usd 210; then
  fail "missing explicit project must fail"
fi
[[ ! -s "$log_path" ]] || fail "missing project must fail before gcloud"
note_pass "configured gcloud project can never substitute for --project"

for forbidden in \
  'billing accounts create' \
  'billing projects link' \
  'services enable' \
  'projects add-iam-policy-binding' \
  'add-access-config' \
  'firewall-rules update'; do
  if grep -Fq "$forbidden" "$GCP_DIR"/preflight.sh "$GCP_DIR"/provision.sh; then
    fail "automation contains forbidden mutation: $forbidden"
  fi
done
note_pass "billing creation, free-trial activation, API enabling, IAM, and public URL changes remain manual gates"

printf '1..%d\n' "$tests_run"
