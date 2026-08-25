#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

PROJECT_ID=""
ZONE_SUFFIX=""
EXPECTED_MONTHLY_USD=""
EXPECTED_90DAY_USD=""
APPLY=0
CONFIRM_TOKEN=""
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"

usage() {
  cat <<'EOF'
Usage (safe default: read-only preflight plus dry-run plan):
  infra/gcp/provision.sh \
    --project PROJECT_ID \
    --zone a|b|c \
    --expected-monthly-usd USD \
    --expected-90day-usd USD

Mutation requires both flags and an exact project/zone-specific token:
  --apply \
  --confirm PROVISION:PROJECT_ID:asia-northeast3-ZONE:moneyworry-demo

The machine, disks, image, network, firewall, and metadata are fixed constants;
there are no CLI or environment overrides for deployment size. Apply mode only
creates absent resources after preflight. Exact existing resources are skipped,
while same-name drift fails closed.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --project)
      mw_need_value "$@"
      PROJECT_ID="$2"
      shift 2
      ;;
    --zone)
      mw_need_value "$@"
      ZONE_SUFFIX="$2"
      shift 2
      ;;
    --expected-monthly-usd)
      mw_need_value "$@"
      EXPECTED_MONTHLY_USD="$2"
      shift 2
      ;;
    --expected-90day-usd)
      mw_need_value "$@"
      EXPECTED_90DAY_USD="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --confirm)
      mw_need_value "$@"
      CONFIRM_TOKEN="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      mw_die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$PROJECT_ID" ]] || mw_die "--project is required; configured defaults are never used"
[[ -n "$ZONE_SUFFIX" ]] || mw_die "--zone is required"
[[ -n "$EXPECTED_MONTHLY_USD" ]] || mw_die "--expected-monthly-usd is required"
[[ -n "$EXPECTED_90DAY_USD" ]] || mw_die "--expected-90day-usd is required"
mw_validate_project_and_zone "$PROJECT_ID" "$ZONE_SUFFIX"
mw_require_local_tools "$GCLOUD_BIN"

# The cost gate runs before any gcloud process, including read-only inventory.
python3 "$SCRIPT_DIR/validate-preflight.py" cost \
  --expected-monthly-usd "$EXPECTED_MONTHLY_USD" \
  --expected-90day-usd "$EXPECTED_90DAY_USD" >/dev/null

FULL_ZONE="$MW_REGION-$ZONE_SUFFIX"
EXPECTED_CONFIRM_TOKEN="$(mw_confirmation_token "$PROJECT_ID" "$FULL_ZONE")"
if (( APPLY == 1 )); then
  [[ "$CONFIRM_TOKEN" == "$EXPECTED_CONFIRM_TOKEN" ]] \
    || mw_die "apply requires --confirm $EXPECTED_CONFIRM_TOKEN"
elif [[ -n "$CONFIRM_TOKEN" ]]; then
  mw_die "--confirm is only valid together with --apply"
fi

work_dir="$(mktemp -d -t moneyworry-gcp-provision.XXXXXXXX)"
trap 'rm -rf -- "$work_dir"' EXIT
initial_report="$work_dir/preflight.json"

GCLOUD_BIN="$GCLOUD_BIN" "$SCRIPT_DIR/preflight.sh" \
  --project "$PROJECT_ID" \
  --zone "$ZONE_SUFFIX" \
  --expected-monthly-usd "$EXPECTED_MONTHLY_USD" \
  --expected-90day-usd "$EXPECTED_90DAY_USD" \
  --json >"$initial_report"

state_of() {
  python3 - "$initial_report" "$1" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
state = report["resources"].get(sys.argv[2])
if state not in {"absent", "exact"}:
    raise SystemExit(f"invalid resource state for {sys.argv[2]}: {state!r}")
print(state)
PY
}

ACTIVE_ACCOUNT="$(
  python3 - "$initial_report" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
account = report.get("active_account")
if not isinstance(account, str) or not account or any(ch in account for ch in "\r\n\0"):
    raise SystemExit("invalid active account in preflight report")
print(account)
PY
)"

network_cmd=(
  "$GCLOUD_BIN" compute networks create "$MW_NETWORK_NAME"
  --account="$ACTIVE_ACCOUNT"
  --project="$PROJECT_ID"
  --subnet-mode=custom
  --bgp-routing-mode=regional
  --mtu=1460
  --quiet
)
subnet_cmd=(
  "$GCLOUD_BIN" compute networks subnets create "$MW_SUBNET_NAME"
  --account="$ACTIVE_ACCOUNT"
  --project="$PROJECT_ID"
  --network="$MW_NETWORK_NAME"
  --region="$MW_REGION"
  --range="$MW_SUBNET_CIDR"
  --stack-type=IPV4_ONLY
  --enable-private-ip-google-access
  --quiet
)
firewall_cmd=(
  "$GCLOUD_BIN" compute firewall-rules create "$MW_FIREWALL_NAME"
  --account="$ACTIVE_ACCOUNT"
  --project="$PROJECT_ID"
  --network="$MW_NETWORK_NAME"
  --direction=INGRESS
  --priority=1000
  --action=ALLOW
  --rules=tcp:22
  --source-ranges="$MW_IAP_SOURCE_CIDR"
  --target-tags="$MW_IAP_TARGET_TAG"
  --enable-logging
  --quiet
)
data_disk_cmd=(
  "$GCLOUD_BIN" compute disks create "$MW_DATA_DISK_NAME"
  --account="$ACTIVE_ACCOUNT"
  --project="$PROJECT_ID"
  --zone="$FULL_ZONE"
  --size="${MW_DATA_DISK_SIZE_GB}GB"
  --type="$MW_DATA_DISK_TYPE"
  --quiet
)
instance_cmd=(
  "$GCLOUD_BIN" compute instances create "$MW_VM_NAME"
  --account="$ACTIVE_ACCOUNT"
  --project="$PROJECT_ID"
  --zone="$FULL_ZONE"
  --machine-type="$MW_MACHINE_TYPE"
  --provisioning-model=STANDARD
  --maintenance-policy=MIGRATE
  --restart-on-failure
  --image="$MW_IMAGE_NAME"
  --image-project="$MW_IMAGE_PROJECT"
  --boot-disk-size="${MW_BOOT_DISK_SIZE_GB}GB"
  --boot-disk-type="$MW_BOOT_DISK_TYPE"
  --boot-disk-device-name="$MW_BOOT_DEVICE_NAME"
  --boot-disk-auto-delete
  --disk="name=$MW_DATA_DISK_NAME,device-name=$MW_DATA_DEVICE_NAME,mode=rw,boot=no,auto-delete=no"
  --network-interface="network=$MW_NETWORK_NAME,subnet=$MW_SUBNET_NAME,network-tier=PREMIUM,address="
  --tags="$MW_IAP_TARGET_TAG"
  --metadata="block-project-ssh-keys=TRUE,enable-oslogin=TRUE,enable-oslogin-2fa=TRUE"
  --no-service-account
  --no-scopes
  --shielded-secure-boot
  --shielded-vtpm
  --shielded-integrity-monitoring
  --deletion-protection
  --quiet
)

declare -a plan_names=()
declare -a plan_commands=()

add_plan_if_absent() {
  local state_name="$1"
  local display_name="$2"
  local array_name="$3"
  if [[ "$(state_of "$state_name")" == "absent" ]]; then
    plan_names+=("$display_name")
    plan_commands+=("$array_name")
  fi
}

add_plan_if_absent network "$MW_NETWORK_NAME" network_cmd
add_plan_if_absent subnet "$MW_SUBNET_NAME" subnet_cmd
add_plan_if_absent firewall "$MW_FIREWALL_NAME" firewall_cmd
add_plan_if_absent data_disk "$MW_DATA_DISK_NAME" data_disk_cmd
add_plan_if_absent instance "$MW_VM_NAME" instance_cmd

print_planned_command() {
  case "$1" in
    network_cmd) mw_print_command "${network_cmd[@]}" ;;
    subnet_cmd) mw_print_command "${subnet_cmd[@]}" ;;
    firewall_cmd) mw_print_command "${firewall_cmd[@]}" ;;
    data_disk_cmd) mw_print_command "${data_disk_cmd[@]}" ;;
    instance_cmd) mw_print_command "${instance_cmd[@]}" ;;
    *) mw_die "internal error: unknown plan command $1" ;;
  esac
}

run_planned_command() {
  case "$1" in
    network_cmd) "${network_cmd[@]}" ;;
    subnet_cmd) "${subnet_cmd[@]}" ;;
    firewall_cmd) "${firewall_cmd[@]}" ;;
    data_disk_cmd) "${data_disk_cmd[@]}" ;;
    instance_cmd) "${instance_cmd[@]}" ;;
    *) mw_die "internal error: unknown plan command $1" ;;
  esac
}

if (( APPLY == 0 )); then
  printf 'MoneyWorry GCP provisioning: DRY RUN (no mutations)\n'
  printf '  project / zone : %s / %s\n' "$PROJECT_ID" "$FULL_ZONE"
  printf '  fixed VM       : %s, %s, Ubuntu 24.04 x86_64\n' "$MW_VM_NAME" "$MW_MACHINE_TYPE"
  printf '  fixed disks    : %sGB %s boot, %sGB %s data\n' \
    "$MW_BOOT_DISK_SIZE_GB" "$MW_BOOT_DISK_TYPE" \
    "$MW_DATA_DISK_SIZE_GB" "$MW_DATA_DISK_TYPE"
  printf '  workload root  : %s on the data disk (post-provision step)\n' "$MW_MOUNT_ROOT"
  printf '  service ports  : no public ingress rules\n'
  if (( ${#plan_names[@]} == 0 )); then
    printf '  plan           : no changes; all resources already match\n'
  else
    printf '  create plan    :\n'
    for index in "${!plan_names[@]}"; do
      command_name="${plan_commands[$index]}"
      printf '  [%s]\n' "${plan_names[$index]}"
      print_planned_command "$command_name"
    done
  fi
  printf 'Apply token (not executed): %s\n' "$EXPECTED_CONFIRM_TOKEN"
  exit 0
fi

if (( ${#plan_names[@]} == 0 )); then
  printf 'MoneyWorry GCP provisioning: no changes; exact resources already exist.\n'
else
  printf 'MoneyWorry GCP provisioning: APPLY (%s resources)\n' "${#plan_names[@]}"
  for index in "${!plan_names[@]}"; do
    command_name="${plan_commands[$index]}"
    if [[ "$command_name" == "instance_cmd" ]]; then
      # Re-inventory immediately before the first runnable workload exists.
      # This closes most of the window in which a broad firewall or resource
      # collision could appear after the initial preflight.
      printf 'Rechecking policy immediately before VM creation\n'
      GCLOUD_BIN="$GCLOUD_BIN" "$SCRIPT_DIR/preflight.sh" \
        --project "$PROJECT_ID" \
        --zone "$ZONE_SUFFIX" \
        --expected-monthly-usd "$EXPECTED_MONTHLY_USD" \
        --expected-90day-usd "$EXPECTED_90DAY_USD" \
        --json >"$work_dir/pre-vm-preflight.json"
    fi
    printf 'Creating %s\n' "${plan_names[$index]}"
    run_planned_command "$command_name"
  done
fi

# A second, independent read-only inventory must see every fixed resource in
# the exact state. A create command returning zero without the postcondition is
# never considered successful.
GCLOUD_BIN="$GCLOUD_BIN" "$SCRIPT_DIR/preflight.sh" \
  --project "$PROJECT_ID" \
  --zone "$ZONE_SUFFIX" \
  --expected-monthly-usd "$EXPECTED_MONTHLY_USD" \
  --expected-90day-usd "$EXPECTED_90DAY_USD" \
  --require-complete >/dev/null

printf 'MoneyWorry GCP provisioning: COMPLETE and postflight-verified\n'
printf 'No service port, public URL, IAM role, billing account, or free-trial state was changed.\n'
