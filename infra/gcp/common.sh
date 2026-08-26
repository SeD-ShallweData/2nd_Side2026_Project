#!/usr/bin/env bash

# This file is sourced by preflight.sh and provision.sh. Deployment-shaping
# values are deliberately not configurable through the environment or CLI.
readonly MW_REGION="asia-northeast3"
readonly MW_VM_NAME="moneyworry-demo"
readonly MW_MACHINE_TYPE="e2-custom-2-12288"
readonly MW_IMAGE_NAME="ubuntu-2404-noble-amd64-v20260820"
readonly MW_IMAGE_PROJECT="ubuntu-os-cloud"
readonly MW_BOOT_DISK_NAME="moneyworry-demo"
readonly MW_BOOT_DEVICE_NAME="moneyworry-boot"
readonly MW_BOOT_DISK_SIZE_GB="30"
readonly MW_BOOT_DISK_TYPE="pd-standard"
readonly MW_DATA_DISK_NAME="moneyworry-data"
readonly MW_DATA_DEVICE_NAME="moneyworry-data"
readonly MW_DATA_DISK_SIZE_GB="80"
readonly MW_DATA_DISK_TYPE="pd-balanced"
readonly MW_NETWORK_NAME="moneyworry-vpc"
readonly MW_SUBNET_NAME="moneyworry-seoul"
readonly MW_SUBNET_CIDR="10.20.0.0/24"
readonly MW_FIREWALL_NAME="moneyworry-iap-ssh"
readonly MW_IAP_SOURCE_CIDR="35.235.240.0/20"
readonly MW_IAP_TARGET_TAG="moneyworry-iap"
readonly MW_SCHEDULE_NAME="moneyworry-18h-daily"
readonly MW_SCHEDULE_START_CRON="0 7 * * *"
readonly MW_SCHEDULE_STOP_CRON="0 1 * * *"
readonly MW_SCHEDULE_TIMEZONE="Asia/Seoul"
readonly MW_SCHEDULE_INITIATION="2026-08-27T00:00:00+09:00"
readonly MW_SCHEDULE_EXPIRATION="2026-11-24T02:00:00+09:00"
readonly MW_MOUNT_ROOT="/srv/moneyworry"
readonly MW_CONFIRM_PREFIX="PROVISION"

mw_die() {
  printf 'moneyworry-gcp: %s\n' "$*" >&2
  exit 1
}

mw_need_value() {
  (( $# >= 2 )) || mw_die "$1 requires a value"
  [[ -n "$2" && "$2" != --* ]] || mw_die "$1 requires a non-empty value"
}

mw_validate_project_and_zone() {
  local project_id="$1"
  local zone_suffix="$2"

  [[ "$project_id" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] \
    || mw_die "--project must be an explicit 6-30 character Google Cloud project ID"
  [[ "$zone_suffix" =~ ^[abc]$ ]] \
    || mw_die "--zone must be one of: a, b, c"
}

mw_require_local_tools() {
  local gcloud_bin="$1"
  command -v "$gcloud_bin" >/dev/null 2>&1 \
    || mw_die "gcloud executable not found: $gcloud_bin"
  command -v python3 >/dev/null 2>&1 \
    || mw_die "python3 is required"
}

mw_confirmation_token() {
  local project_id="$1"
  local full_zone="$2"
  printf '%s:%s:%s:%s' \
    "$MW_CONFIRM_PREFIX" "$project_id" "$full_zone" "$MW_VM_NAME"
}

mw_print_command() {
  printf '  '
  printf '%q ' "$@"
  printf '\n'
}
