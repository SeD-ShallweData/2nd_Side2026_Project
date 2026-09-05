#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

PROJECT_ID=""
ZONE_SUFFIX=""
EXPECTED_MONTHLY_USD=""
EXPECTED_90DAY_USD=""
JSON_OUTPUT=0
REQUIRE_COMPLETE=0
REQUIRE_RUNNING=0
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"

usage() {
  cat <<'EOF'
Usage:
  infra/gcp/preflight.sh \
    --project PROJECT_ID \
    --zone a|b|c \
    --expected-monthly-usd USD \
    --expected-90day-usd USD \
    [--json] [--require-complete [--require-running]]

Runs read-only gcloud inventory calls and fails closed on authentication,
billing, budget, API, firewall, or same-name resource drift. It never enables
an API, creates a budget, changes IAM, or creates/updates a Compute resource.

--require-complete additionally requires every fixed resource to exist exactly;
it is used by provision.sh for post-apply verification.
--require-running also requires the scheduled VM to be RUNNING. Normal
preflight accepts TERMINATED only during the exact daily schedule's off-hours.
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
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    --require-complete)
      REQUIRE_COMPLETE=1
      shift
      ;;
    --require-running)
      REQUIRE_RUNNING=1
      shift
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
(( REQUIRE_RUNNING == 0 || REQUIRE_COMPLETE == 1 )) \
  || mw_die "--require-running is only valid together with --require-complete"
mw_require_local_tools "$GCLOUD_BIN"

# Reject malformed or over-ceiling cost inputs before contacting Google Cloud.
python3 "$SCRIPT_DIR/validate-preflight.py" cost \
  --expected-monthly-usd "$EXPECTED_MONTHLY_USD" \
  --expected-90day-usd "$EXPECTED_90DAY_USD" >/dev/null

FULL_ZONE="$MW_REGION-$ZONE_SUFFIX"
inventory_dir="$(mktemp -d -t moneyworry-gcp-preflight.XXXXXXXX)"
trap 'rm -rf -- "$inventory_dir"' EXIT

readonly_query() {
  local output_path="$1"
  local label="$2"
  shift 2
  if ! "$GCLOUD_BIN" "$@" --quiet >"$output_path"; then
    mw_die "read-only gcloud check failed: $label"
  fi
}

readonly_query "$inventory_dir/auth.json" "active account" \
  auth list \
  --filter=status:ACTIVE \
  --format=json\(account,status\)
ACTIVE_ACCOUNT="$(
  python3 "$SCRIPT_DIR/validate-preflight.py" active-account \
    --path "$inventory_dir/auth.json"
)"

readonly_query "$inventory_dir/project.json" "project" \
  projects describe "$PROJECT_ID" \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format=json\(projectId,projectNumber,lifecycleState\)

readonly_query "$inventory_dir/billing-project.json" "billing linkage" \
  billing projects describe "$PROJECT_ID" \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format=json\(projectId,billingEnabled,billingAccountName\)

BILLING_ACCOUNT="$(
  python3 "$SCRIPT_DIR/validate-preflight.py" billing-account \
    --path "$inventory_dir/billing-project.json" \
    --project "$PROJECT_ID"
)"
BILLING_ACCOUNT_ID="${BILLING_ACCOUNT#billingAccounts/}"

readonly_query "$inventory_dir/budgets.json" "billing budgets" \
  billing budgets list \
  --account="$ACTIVE_ACCOUNT" \
  --billing-account="$BILLING_ACCOUNT_ID" \
  --format=json

readonly_query "$inventory_dir/services.json" "enabled APIs" \
  services list \
  --enabled \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format=json\(config.name,state\)

readonly_query "$inventory_dir/project-metadata.json" "project common instance metadata" \
  compute project-info describe \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format=json\(commonInstanceMetadata\)

readonly_query "$inventory_dir/image.json" "immutable Ubuntu boot image" \
  compute images describe "$MW_IMAGE_NAME" \
  --account="$ACTIVE_ACCOUNT" \
  --project="$MW_IMAGE_PROJECT" \
  --format=json

# Inventory all regional policies so a same-name policy outside the target
# region cannot be mistaken for the fixed Seoul instance schedule.
readonly_query "$inventory_dir/resource-policies.json" "regional resource policies" \
  compute resource-policies list \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format=json

readonly_query "$inventory_dir/networks.json" "VPC networks" \
  compute networks list \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format=json

# Inventory all project routes and filter by exact network identity in the
# validator. A server-side name filter could hide a malformed or unexpected
# route because route.network is a fully-qualified resource URL.
readonly_query "$inventory_dir/routes.json" "VPC routes" \
  compute routes list \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format=json

readonly_query "$inventory_dir/routers.json" "Cloud Routers" \
  compute routers list \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format=json

readonly_query "$inventory_dir/policy-based-routes.json" "policy-based routes" \
  network-connectivity policy-based-routes list \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format=json

# With no region/global selector, gcloud inventories spokes from every
# location. This catches VPC, VPN, Interconnect, and router-appliance links.
readonly_query "$inventory_dir/ncc-spokes.json" "Network Connectivity Center spokes" \
  network-connectivity spokes list \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format=json

if python3 - "$inventory_dir/networks.json" "$MW_NETWORK_NAME" <<'PY'
import json
import sys
from pathlib import Path

items = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
name = sys.argv[2]
if not isinstance(items, list) or not any(
    isinstance(item, dict) and item.get("name") == name for item in items
):
    raise SystemExit(1)
PY
then
  readonly_query "$inventory_dir/effective-firewalls.json" "effective firewall policies" \
    compute network-firewall-policies get-effective-firewalls \
    --account="$ACTIVE_ACCOUNT" \
    --project="$PROJECT_ID" \
    --network="$MW_NETWORK_NAME" \
    --region="$MW_REGION" \
    --format=json
else
  # There is no target network on a fresh dry-run. Apply mode creates it and
  # performs this effective-policy inventory again before it creates the VM.
  printf '[]\n' >"$inventory_dir/effective-firewalls.json"
fi

readonly_query "$inventory_dir/subnets.json" "regional subnets" \
  compute networks subnets list \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --regions="$MW_REGION" \
  --format=json

readonly_query "$inventory_dir/firewalls.json" "firewall rules" \
  compute firewall-rules list \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --format=json

readonly_query "$inventory_dir/disks.json" "zonal disks" \
  compute disks list \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --zones="$FULL_ZONE" \
  --format=json

readonly_query "$inventory_dir/instances.json" "zonal instances" \
  compute instances list \
  --account="$ACTIVE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --zones="$FULL_ZONE" \
  --format=json

validator_args=(
  validate
  --inventory-dir "$inventory_dir"
  --project "$PROJECT_ID"
  --zone "$ZONE_SUFFIX"
  --expected-monthly-usd "$EXPECTED_MONTHLY_USD"
  --expected-90day-usd "$EXPECTED_90DAY_USD"
)
(( REQUIRE_COMPLETE == 0 )) || validator_args+=(--require-complete)
(( REQUIRE_RUNNING == 0 )) || validator_args+=(--require-running)

report_path="$inventory_dir/report.json"
python3 "$SCRIPT_DIR/validate-preflight.py" "${validator_args[@]}" >"$report_path"

if (( JSON_OUTPUT == 1 )); then
  python3 -m json.tool "$report_path"
else
  python3 - "$report_path" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print("MoneyWorry GCP preflight: READY (read-only)")
print(f"  active account : {report['active_account']}")
print(f"  project        : {report['project_id']} ({report['project_number']})")
print(f"  region / zone  : {report['region']} / {report['zone']}")
print(
    "  billing budget : "
    f"{report['budget']['currency_code']} {report['budget']['amount']} "
    "(project-scoped, gross cost)"
)
print(
    "  estimated cost: "
    f"USD {report['cost']['monthly_usd']}/month, "
    f"USD {report['cost']['gated_90day_usd']}/90-day gate"
)
print("  resource state :")
for name, state in sorted(report["resources"].items()):
    print(f"    {name:12} {state}")
PY
fi
