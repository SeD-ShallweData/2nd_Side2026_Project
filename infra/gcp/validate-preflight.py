#!/usr/bin/env python3
"""Validate MoneyWorry's read-only Google Cloud inventory.

The Bash entrypoints collect JSON using gcloud. Keeping the policy checks in
one small Python program makes malformed, missing, and type-confused API output
fail closed instead of being silently treated as an absent resource.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import sys
from datetime import datetime, time, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, NoReturn
from zoneinfo import ZoneInfo


REGION = "asia-northeast3"
VM_NAME = "moneyworry-demo"
MACHINE_TYPE = "e2-custom-2-12288"
IMAGE_NAME = "ubuntu-2404-noble-amd64-v20260820"
IMAGE_PROJECT = "ubuntu-os-cloud"
IMAGE_FAMILY = "ubuntu-2404-lts-amd64"
IMAGE_LICENSE = "ubuntu-2404-lts"
BOOT_DISK_NAME = "moneyworry-demo"
BOOT_DEVICE_NAME = "moneyworry-boot"
BOOT_DISK_SIZE_GB = 30
BOOT_DISK_TYPE = "pd-standard"
DATA_DISK_NAME = "moneyworry-data"
DATA_DEVICE_NAME = "moneyworry-data"
DATA_DISK_SIZE_GB = 80
DATA_DISK_TYPE = "pd-balanced"
NETWORK_NAME = "moneyworry-vpc"
SUBNET_NAME = "moneyworry-seoul"
SUBNET_CIDR = "10.20.0.0/24"
FIREWALL_NAME = "moneyworry-iap-ssh"
IAP_SOURCE_CIDR = "35.235.240.0/20"
IAP_TARGET_TAG = "moneyworry-iap"
SCHEDULE_NAME = "moneyworry-18h-daily"
SCHEDULE_START_CRON = "0 7 * * *"
SCHEDULE_STOP_CRON = "0 1 * * *"
SCHEDULE_TIMEZONE = "Asia/Seoul"
SCHEDULE_ZONE = ZoneInfo(SCHEDULE_TIMEZONE)
SCHEDULE_DAILY_START = time(7, 0)
SCHEDULE_DAILY_STOP = time(1, 0)
SCHEDULE_INITIATION = datetime(2026, 8, 26, 15, 0, tzinfo=timezone.utc)
SCHEDULE_EXPIRATION = datetime(2026, 11, 23, 17, 0, tzinfo=timezone.utc)
COST_CEILING_USD = Decimal("250.00")
BUDGET_AMOUNT = Decimal("350000")
BUDGET_CURRENCY = "KRW"
BUDGET_DISPLAY_NAME = "moneyworry-90day"
BUDGET_START_DATE = {"year": 2026, "month": 8, "day": 26}
BUDGET_END_DATE = {"year": 2026, "month": 11, "day": 24}
BUDGET_CREDIT_TREATMENT = "EXCLUDE_ALL_CREDITS"
BUDGET_THRESHOLDS = {
    Decimal("0.25"),
    Decimal("0.50"),
    Decimal("0.70"),
    Decimal("0.85"),
    Decimal("0.95"),
}
REQUIRED_APIS = {
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "networkconnectivity.googleapis.com",
    "oslogin.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
}


def fail(message: str) -> NoReturn:
    raise ValueError(message)


def load_json(path: Path, expected: type | tuple[type, ...]) -> Any:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        fail(f"invalid gcloud JSON in {path.name}: {exc}")
    if not isinstance(value, expected):
        expected_types = expected if isinstance(expected, tuple) else (expected,)
        expected_names = "/".join(item.__name__ for item in expected_types)
        fail(f"unexpected JSON type in {path.name}; expected {expected_names}")
    return value


def basename(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.rstrip("/").rsplit("/", 1)[-1]


def parse_usd(raw: str, label: str) -> Decimal:
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?", raw):
        fail(f"{label} must be a positive USD amount with at most two decimals")
    try:
        value = Decimal(raw)
    except InvalidOperation:
        fail(f"{label} is not a valid USD amount")
    if not value.is_finite() or value <= 0:
        fail(f"{label} must be greater than zero")
    return value


def validate_cost(monthly_raw: str, ninety_day_raw: str) -> dict[str, str]:
    monthly = parse_usd(monthly_raw, "--expected-monthly-usd")
    ninety_day = parse_usd(ninety_day_raw, "--expected-90day-usd")
    conservative_ninety_day = max(ninety_day, monthly * 3)
    if monthly > COST_CEILING_USD:
        fail(f"monthly estimate {monthly} USD exceeds the 250 USD ceiling")
    if conservative_ninety_day > COST_CEILING_USD:
        fail(
            "90-day cost gate exceeds 250 USD: "
            f"max(explicit={ninety_day}, monthly*3={monthly * 3})"
        )
    return {
        "monthly_usd": f"{monthly:.2f}",
        "explicit_90day_usd": f"{ninety_day:.2f}",
        "gated_90day_usd": f"{conservative_ninety_day:.2f}",
        "ceiling_usd": f"{COST_CEILING_USD:.2f}",
    }


def one_named(items: list[Any], name: str, label: str) -> dict[str, Any] | None:
    matches = [item for item in items if isinstance(item, dict) and item.get("name") == name]
    if len(matches) > 1:
        fail(f"multiple {label} resources named {name!r} were returned")
    return matches[0] if matches else None


def require_equal(actual: Any, expected: Any, message: str) -> None:
    if actual != expected:
        fail(f"{message}: expected {expected!r}, found {actual!r}")


def resource_state(resource: dict[str, Any] | None, checker: Any) -> str:
    if resource is None:
        return "absent"
    checker(resource)
    return "exact"


def validate_network(item: dict[str, Any]) -> None:
    require_equal(item.get("autoCreateSubnetworks"), False, "network subnet mode drift")
    require_equal(item.get("mtu"), 1460, "network MTU drift")
    routing = item.get("routingConfig")
    if not isinstance(routing, dict):
        fail("network routingConfig is missing")
    require_equal(routing.get("routingMode"), "REGIONAL", "network routing mode drift")
    require_equal(item.get("peerings", []), [], "network peering drift")


ROUTE_NEXT_HOP_FIELDS = (
    "nextHopInstance",
    "nextHopIp",
    "nextHopNetwork",
    "nextHopGateway",
    "nextHopPeering",
    "nextHopIlb",
    "nextHopVpnTunnel",
    "nextHopHub",
    "nextHopInterconnectAttachment",
)


def resource_url_matches(value: Any, expected_path: str) -> bool:
    if not isinstance(value, str):
        return False
    normalized = expected_path.lstrip("/")
    return value == normalized or value.endswith(f"/{normalized}")


def validate_route_common(item: dict[str, Any], project: str) -> None:
    name = item.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z]([-a-z0-9]*[a-z0-9])?", name):
        fail("target VPC route name is missing or malformed")
    expected_network_path = f"projects/{project}/global/networks/{NETWORK_NAME}"
    if not resource_url_matches(item.get("network"), expected_network_path):
        fail(f"route {name} does not belong to the exact target project/VPC")
    require_equal(item.get("tags", []), [], f"route {name} network tag drift")
    warnings = item.get("warnings", [])
    if warnings not in (None, []):
        fail(f"route {name} contains a warning and is not deployable")
    require_equal(item.get("routeStatus", "ACTIVE"), "ACTIVE", f"route {name} status drift")


def require_only_next_hop(item: dict[str, Any], expected_field: str) -> None:
    populated = {
        field
        for field in ROUTE_NEXT_HOP_FIELDS
        if item.get(field) not in (None, "")
    }
    require_equal(
        populated,
        {expected_field},
        f"route {item.get('name', '<unknown>')} next-hop drift",
    )


def validate_routes(
    items: list[Any],
    *,
    project: str,
    network_exists: bool,
    subnet_exists: bool,
) -> str:
    target_routes: list[dict[str, Any]] = []
    for raw in items:
        if not isinstance(raw, dict):
            fail("route inventory contains a malformed record")
        if basename(raw.get("network")) == NETWORK_NAME:
            target_routes.append(raw)

    if not network_exists:
        if target_routes:
            fail("target VPC routes exist while the network is absent")
        return "absent"

    internet_routes: list[dict[str, Any]] = []
    subnet_routes: list[dict[str, Any]] = []
    for route in target_routes:
        validate_route_common(route, project)
        destination = route.get("destRange")
        if destination == "0.0.0.0/0":
            internet_routes.append(route)
            require_equal(route.get("priority"), 1000, "default internet route priority drift")
            if "routeType" in route:
                require_equal(route.get("routeType"), "STATIC", "default internet route type drift")
            require_only_next_hop(route, "nextHopGateway")
            expected_gateway = f"projects/{project}/global/gateways/default-internet-gateway"
            if not resource_url_matches(route.get("nextHopGateway"), expected_gateway):
                fail("default IPv4 route does not use the exact project internet gateway")
        elif destination == SUBNET_CIDR and subnet_exists:
            subnet_routes.append(route)
            require_equal(route.get("priority"), 0, "local subnet route priority drift")
            if "routeType" in route:
                require_equal(route.get("routeType"), "SUBNET", "local subnet route type drift")
            require_only_next_hop(route, "nextHopNetwork")
            expected_network = f"projects/{project}/global/networks/{NETWORK_NAME}"
            if not resource_url_matches(route.get("nextHopNetwork"), expected_network):
                fail("local subnet route does not use the exact target VPC next hop")
        else:
            fail(
                "unexpected route exists in the target VPC: "
                f"{route.get('name', '<unknown>')} -> {destination!r}"
            )

    if len(internet_routes) != 1:
        fail("target VPC requires exactly one default IPv4 internet-gateway route")
    expected_subnet_routes = 1 if subnet_exists else 0
    if len(subnet_routes) != expected_subnet_routes:
        fail("target VPC local subnet route inventory is incomplete or duplicated")
    return "exact"


def validate_no_alternate_routing(
    routers: list[Any], policy_based_routes: list[Any], ncc_spokes: list[Any]
) -> None:
    for router in routers:
        if not isinstance(router, dict):
            fail("Cloud Router inventory contains a malformed record")
        if basename(router.get("network")) == NETWORK_NAME:
            fail(
                "Cloud Router is forbidden on the exact target VPC: "
                f"{router.get('name', '<unknown>')}"
            )

    for route in policy_based_routes:
        if not isinstance(route, dict):
            fail("policy-based route inventory contains a malformed record")
        if basename(route.get("network")) == NETWORK_NAME:
            fail(
                "policy-based route is forbidden on the exact target VPC: "
                f"{route.get('name', '<unknown>')}"
            )

    linked_network_fields = (
        ("linkedVpcNetwork", "uri"),
        ("linkedVpnTunnels", "vpcNetwork"),
        ("linkedInterconnectAttachments", "vpcNetwork"),
        ("linkedRouterApplianceInstances", "vpcNetwork"),
        ("linkedProducerVpcNetwork", "network"),
    )
    for spoke in ncc_spokes:
        if not isinstance(spoke, dict):
            fail("NCC spoke inventory contains a malformed record")
        for object_name, network_field in linked_network_fields:
            linked = spoke.get(object_name)
            if linked is None:
                continue
            if not isinstance(linked, dict):
                fail(f"NCC spoke {object_name} is malformed")
            if basename(linked.get(network_field)) == NETWORK_NAME:
                fail(
                    "Network Connectivity Center spoke is forbidden on the "
                    f"exact target VPC: {spoke.get('name', '<unknown>')}"
                )


def validate_project_metadata(item: dict[str, Any]) -> None:
    common = item.get("commonInstanceMetadata")
    if common is None:
        return
    if not isinstance(common, dict):
        fail("project common instance metadata is malformed")
    entries = common.get("items", [])
    if not isinstance(entries, list):
        fail("project common instance metadata items are malformed")
    if entries:
        keys = sorted(
            str(entry.get("key", "<malformed>"))
            if isinstance(entry, dict)
            else "<malformed>"
            for entry in entries
        )
        fail(
            "project common instance metadata must be empty; inherited metadata "
            f"can execute or reconfigure guests: {', '.join(keys)}"
        )


def validate_image(item: dict[str, Any]) -> None:
    require_equal(item.get("name"), IMAGE_NAME, "immutable image name drift")
    require_equal(item.get("status"), "READY", "immutable image status drift")
    require_equal(item.get("architecture"), "X86_64", "immutable image architecture drift")
    require_equal(item.get("sourceType"), "RAW", "immutable image source type drift")
    require_equal(item.get("family"), IMAGE_FAMILY, "immutable image family drift")
    if item.get("deprecated") not in (None, {}):
        fail("immutable image is deprecated or scheduled for deprecation")
    self_link = item.get("selfLink")
    expected_image_path = f"projects/{IMAGE_PROJECT}/global/images/{IMAGE_NAME}"
    if not resource_url_matches(self_link, expected_image_path):
        fail("immutable image selfLink does not match the exact public image")
    licenses = item.get("licenses")
    if not isinstance(licenses, list):
        fail("immutable image licenses are missing or malformed")
    expected_license_path = f"projects/{IMAGE_PROJECT}/global/licenses/{IMAGE_LICENSE}"
    if len(licenses) != 1 or not resource_url_matches(licenses[0], expected_license_path):
        fail("immutable image must carry only the Ubuntu 24.04 LTS free license")
    guest_features = item.get("guestOsFeatures")
    if not isinstance(guest_features, list):
        fail("immutable image guest OS features are missing or malformed")
    feature_names = {
        feature.get("type")
        for feature in guest_features
        if isinstance(feature, dict) and isinstance(feature.get("type"), str)
    }
    required_features = {"UEFI_COMPATIBLE", "VIRTIO_SCSI_MULTIQUEUE"}
    if not required_features.issubset(feature_names):
        fail("immutable image lacks required UEFI or SCSI guest features")


def validate_subnet(item: dict[str, Any], zone: str) -> None:
    del zone
    require_equal(basename(item.get("region")), REGION, "subnet region drift")
    require_equal(basename(item.get("network")), NETWORK_NAME, "subnet network drift")
    require_equal(item.get("ipCidrRange"), SUBNET_CIDR, "subnet CIDR drift")
    require_equal(item.get("privateIpGoogleAccess"), True, "private Google access drift")
    stack_type = item.get("stackType", "IPV4_ONLY")
    require_equal(stack_type, "IPV4_ONLY", "subnet IP stack drift")
    require_equal(item.get("purpose", "PRIVATE"), "PRIVATE", "subnet purpose drift")


def normalized_allow(entry: Any) -> tuple[str, tuple[str, ...]]:
    if not isinstance(entry, dict):
        return "", ()
    protocol = entry.get("IPProtocol", entry.get("ipProtocol", ""))
    ports = entry.get("ports", [])
    if not isinstance(protocol, str) or not isinstance(ports, list):
        return "", ()
    return protocol.lower(), tuple(sorted(str(port) for port in ports))


def validate_firewall(item: dict[str, Any]) -> None:
    require_equal(item.get("disabled", False), False, "IAP firewall disabled state drift")
    require_equal(item.get("direction"), "INGRESS", "IAP firewall direction drift")
    require_equal(item.get("priority", 1000), 1000, "IAP firewall priority drift")
    require_equal(basename(item.get("network")), NETWORK_NAME, "IAP firewall network drift")
    require_equal(item.get("sourceRanges"), [IAP_SOURCE_CIDR], "IAP source range drift")
    require_equal(item.get("targetTags"), [IAP_TARGET_TAG], "IAP target tag drift")
    allowed = item.get("allowed")
    if not isinstance(allowed, list):
        fail("IAP firewall allowed rules are missing")
    require_equal(
        sorted(normalized_allow(entry) for entry in allowed),
        [("tcp", ("22",))],
        "IAP firewall protocol drift",
    )
    log_config = item.get("logConfig")
    if not isinstance(log_config, dict) or log_config.get("enable") is not True:
        fail("IAP firewall logging must remain enabled")


def port_range_contains(raw: str, port: int) -> bool:
    try:
        if "-" in raw:
            low_raw, high_raw = raw.split("-", 1)
            low, high = int(low_raw), int(high_raw)
            return low <= port <= high
        return int(raw) == port
    except ValueError:
        return True


def allows_tcp_port(rule: dict[str, Any], port: int) -> bool:
    allowed = rule.get("allowed", [])
    if not isinstance(allowed, list):
        return False
    for entry in allowed:
        protocol, ports = normalized_allow(entry)
        if protocol == "all":
            return True
        if protocol == "tcp" and (not ports or any(port_range_contains(raw, port) for raw in ports)):
            return True
    return False


def ranges_cover_entire_address_space(raw_ranges: list[Any]) -> bool:
    networks: dict[int, list[ipaddress.IPv4Network | ipaddress.IPv6Network]] = {
        4: [],
        6: [],
    }
    for raw in raw_ranges:
        if not isinstance(raw, str):
            fail("firewall sourceRanges contains a non-string value")
        try:
            network = ipaddress.ip_network(raw, strict=False)
        except ValueError:
            fail(f"firewall sourceRanges contains malformed CIDR: {raw!r}")
        networks[network.version].append(network)
    return any(
        collapsed.prefixlen == 0
        for family in networks.values()
        for collapsed in ipaddress.collapse_addresses(family)
    )


def validate_project_firewalls(items: list[Any]) -> None:
    for raw in items:
        if not isinstance(raw, dict):
            fail("firewall inventory contains a malformed rule")
        if raw.get("disabled", False):
            continue
        direction = raw.get("direction", "INGRESS")
        if direction not in {"INGRESS", "EGRESS"}:
            fail(f"firewall {raw.get('name', '<unknown>')} has malformed direction")
        allowed = raw.get("allowed", [])
        denied = raw.get("denied", [])
        if not isinstance(allowed, list) or not isinstance(denied, list):
            fail(f"firewall {raw.get('name', '<unknown>')} has malformed action rules")
        if bool(allowed) == bool(denied):
            fail(f"firewall {raw.get('name', '<unknown>')} must have exactly one action")
        source_ranges = raw.get("sourceRanges", [])
        source_tags = raw.get("sourceTags", [])
        source_accounts = raw.get("sourceServiceAccounts", [])
        target_tags = raw.get("targetTags", [])
        target_accounts = raw.get("targetServiceAccounts", [])
        for field_name, field_value in (
            ("sourceRanges", source_ranges),
            ("sourceTags", source_tags),
            ("sourceServiceAccounts", source_accounts),
            ("targetTags", target_tags),
            ("targetServiceAccounts", target_accounts),
        ):
            if not isinstance(field_value, list):
                fail(
                    f"firewall {raw.get('name', '<unknown>')} has malformed {field_name}"
                )

        # The VM deliberately has no service account. Rules restricted to a
        # target service account cannot apply; an empty target or the exact VM
        # network tag does apply.
        # The VM deliberately has no service account, so a rule explicitly
        # limited to target service accounts cannot apply to it.
        applies_to_vm = not target_accounts and (
            not target_tags or IAP_TARGET_TAG in target_tags
        )
        applies_to_target_vpc = basename(raw.get("network")) == NETWORK_NAME

        if direction == "EGRESS":
            if applies_to_target_vpc and applies_to_vm:
                fail(
                    f"unexpected egress firewall applies to {VM_NAME}: "
                    f"{raw.get('name', '<unknown>')}"
                )
            continue

        implicit_public = not source_ranges and not source_tags and not source_accounts
        public = implicit_public or ranges_cover_entire_address_space(source_ranges)
        if allowed and public:
            fail(
                "dangerous public ingress firewall exists: "
                f"{raw.get('name', '<unknown>')}"
            )

        if applies_to_target_vpc and applies_to_vm and raw.get("name") != FIREWALL_NAME:
            fail(
                f"unexpected ingress firewall applies to {VM_NAME}: "
                f"{raw.get('name', '<unknown>')}"
            )
        if applies_to_target_vpc and applies_to_vm and allows_tcp_port(raw, 22):
            if raw.get("name") != FIREWALL_NAME or source_ranges != [IAP_SOURCE_CIDR]:
                fail(f"non-IAP SSH firewall applies to {VM_NAME}: {raw.get('name', '<unknown>')}")

        if applies_to_target_vpc and applies_to_vm:
            for port in (5433, 5051, 8000, 3111):
                if allows_tcp_port(raw, port):
                    fail(
                        f"firewall {raw.get('name', '<unknown>')} exposes forbidden service port {port}"
                    )


def effective_target_values(item: dict[str, Any], field: str) -> list[str]:
    value = item.get(field, [])
    if value in (None, ""):
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(entry, str) for entry in value):
        return value
    fail(f"effective firewall has malformed {field}")


def validate_legacy_effective_firewalls(
    items: list[Any], *, network_exists: bool, firewall_exists: bool
) -> None:
    if not network_exists:
        if items:
            fail("effective firewall inventory exists while the target network is absent")
        return

    effective_iap_rules = 0
    for raw in items:
        if not isinstance(raw, dict):
            fail("effective firewall inventory contains a malformed rule")
        rule_type = raw.get("type")
        if rule_type != "network-firewall":
            fail(
                "inherited, system, or network firewall policy applies to the "
                f"target VPC: {rule_type!r}"
            )
        disabled = raw.get("disabled", False)
        if not isinstance(disabled, bool):
            fail("effective firewall disabled state is malformed")
        if disabled:
            continue
        direction = raw.get("direction")
        action = raw.get("action")
        if direction not in {"INGRESS", "EGRESS"} or action not in {"ALLOW", "DENY"}:
            fail("effective network firewall direction/action is malformed")
        target_tags = effective_target_values(raw, "target_tags")
        target_accounts = effective_target_values(raw, "target_svc_acct")
        applies_to_vm = not target_accounts and (
            not target_tags or IAP_TARGET_TAG in target_tags
        )
        if direction == "EGRESS" and applies_to_vm:
            fail(
                f"effective egress firewall applies to {VM_NAME}: "
                f"{raw.get('name', '<unknown>')}"
            )
        if direction == "INGRESS" and applies_to_vm:
            if raw.get("name") != FIREWALL_NAME:
                fail(
                    f"unexpected effective ingress firewall applies to {VM_NAME}: "
                    f"{raw.get('name', '<unknown>')}"
                )
            effective_iap_rules += 1
            require_equal(action, "ALLOW", "effective IAP firewall action drift")
            require_equal(raw.get("ip_ranges"), [IAP_SOURCE_CIDR], "effective IAP source drift")
            require_equal(target_tags, [IAP_TARGET_TAG], "effective IAP target drift")

    expected_iap_rules = 1 if firewall_exists else 0
    if effective_iap_rules != expected_iap_rules:
        fail("effective IAP firewall inventory is incomplete or duplicated")


def validate_raw_classic_effective_firewall(
    item: Any, *, project: str
) -> None:
    if not isinstance(item, dict):
        fail("raw effective firewall inventory contains a malformed classic rule")
    require_equal(item.get("name"), FIREWALL_NAME, "raw effective IAP firewall name drift")
    require_equal(item.get("disabled"), False, "raw effective IAP disabled state drift")
    require_equal(item.get("direction"), "INGRESS", "raw effective IAP direction drift")
    require_equal(item.get("priority"), 1000, "raw effective IAP priority drift")
    expected_network = f"projects/{project}/global/networks/{NETWORK_NAME}"
    if not resource_url_matches(item.get("network"), expected_network):
        fail("raw effective IAP firewall belongs to an unexpected project/VPC")
    for field in (
        "sourceTags",
        "sourceServiceAccounts",
        "targetServiceAccounts",
        "destinationRanges",
        "denied",
    ):
        if item.get(field) not in (None, []):
            fail(f"raw effective IAP firewall has unexpected {field}")
    validate_firewall(item)


def validate_raw_effective_firewalls(
    wrapper: dict[str, Any],
    *,
    project: str,
    network_exists: bool,
    firewall_exists: bool,
) -> None:
    allowed_keys = {"firewalls", "firewallPolicys"}
    unknown_keys = sorted(set(wrapper) - allowed_keys)
    if unknown_keys:
        fail(
            "raw effective firewall wrapper has unknown fields: "
            + ", ".join(unknown_keys)
        )
    if "firewalls" not in wrapper:
        fail("raw effective firewall wrapper is missing firewalls")
    firewalls = wrapper.get("firewalls")
    policies = wrapper.get("firewallPolicys", [])
    if not isinstance(firewalls, list):
        fail("raw effective firewall wrapper firewalls must be a list")
    if not isinstance(policies, list):
        fail("raw effective firewall wrapper firewallPolicys must be a list")
    if policies:
        fail("hierarchical, global, regional, or system firewall policy applies to the target VPC")
    if not network_exists:
        if firewalls:
            fail("effective firewall inventory exists while the target network is absent")
        return
    expected_count = 1 if firewall_exists else 0
    if len(firewalls) != expected_count:
        fail("raw effective IAP firewall inventory is incomplete or duplicated")
    for item in firewalls:
        validate_raw_classic_effective_firewall(item, project=project)


def validate_effective_firewalls(
    inventory: list[Any] | dict[str, Any],
    *,
    project: str,
    network_exists: bool,
    firewall_exists: bool,
) -> None:
    if isinstance(inventory, list):
        validate_legacy_effective_firewalls(
            inventory,
            network_exists=network_exists,
            firewall_exists=firewall_exists,
        )
        return
    if isinstance(inventory, dict):
        validate_raw_effective_firewalls(
            inventory,
            project=project,
            network_exists=network_exists,
            firewall_exists=firewall_exists,
        )
        return
    fail("effective firewall inventory must be a raw wrapper or legacy flattened list")


def validate_disk(item: dict[str, Any], zone: str, *, boot: bool) -> None:
    expected_name = BOOT_DISK_NAME if boot else DATA_DISK_NAME
    expected_size = BOOT_DISK_SIZE_GB if boot else DATA_DISK_SIZE_GB
    expected_type = BOOT_DISK_TYPE if boot else DATA_DISK_TYPE
    require_equal(item.get("name"), expected_name, "disk name drift")
    require_equal(basename(item.get("zone")), zone, f"{expected_name} zone drift")
    try:
        size = int(item.get("sizeGb"))
    except (TypeError, ValueError):
        fail(f"{expected_name} size is missing or malformed")
    require_equal(size, expected_size, f"{expected_name} size drift")
    require_equal(basename(item.get("type")), expected_type, f"{expected_name} type drift")
    if boot:
        users = item.get("users", [])
        if not isinstance(users, list) or [basename(user) for user in users] != [VM_NAME]:
            fail("boot disk is not attached exclusively to the expected VM")
        source_image = item.get("sourceImage")
        expected_image_path = f"/projects/{IMAGE_PROJECT}/global/images/{IMAGE_NAME}"
        if not isinstance(source_image, str) or not source_image.endswith(expected_image_path):
            fail(
                "boot disk source image drift: expected the immutable image "
                f"{IMAGE_PROJECT}/{IMAGE_NAME}"
            )
        licenses = item.get("licenses", [])
        if not isinstance(licenses, list) or "ubuntu-2404-lts" not in {
            basename(license_url) for license_url in licenses
        }:
            fail("boot disk does not carry the Ubuntu 24.04 LTS license")


def metadata_map(item: dict[str, Any]) -> dict[str, str]:
    metadata = item.get("metadata")
    if not isinstance(metadata, dict):
        fail("instance metadata is missing")
    entries = metadata.get("items", [])
    if not isinstance(entries, list):
        fail("instance metadata items are malformed")
    result: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("key"), str):
            fail("instance metadata entry is malformed")
        key = entry["key"]
        if key in result:
            fail(f"duplicate instance metadata key: {key}")
        result[key] = str(entry.get("value", ""))
    return result


def exact_rfc3339_timestamp(value: Any, expected: datetime) -> bool:
    if not isinstance(value, str):
        return False
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return False
    if parsed.tzinfo is None:
        return False
    return parsed.astimezone(timezone.utc) == expected


def validate_schedule(item: dict[str, Any]) -> None:
    require_equal(item.get("name"), SCHEDULE_NAME, "instance schedule name drift")
    require_equal(basename(item.get("region")), REGION, "instance schedule region drift")
    require_equal(item.get("status"), "READY", "instance schedule readiness drift")
    for alternate_policy in (
        "snapshotSchedulePolicy",
        "groupPlacementPolicy",
        "diskConsistencyGroupPolicy",
        "workloadPolicy",
    ):
        if item.get(alternate_policy) not in (None, {}):
            fail(f"instance schedule has unexpected {alternate_policy}")
    policy = item.get("instanceSchedulePolicy")
    if not isinstance(policy, dict):
        fail("instance schedule policy is missing")
    start = policy.get("vmStartSchedule")
    stop = policy.get("vmStopSchedule")
    if not isinstance(start, dict) or not isinstance(stop, dict):
        fail("instance schedule start/stop policy is missing")
    require_equal(start.get("schedule"), SCHEDULE_START_CRON, "instance start cron drift")
    require_equal(stop.get("schedule"), SCHEDULE_STOP_CRON, "instance stop cron drift")
    require_equal(policy.get("timeZone"), SCHEDULE_TIMEZONE, "instance schedule timezone drift")
    if not exact_rfc3339_timestamp(policy.get("startTime"), SCHEDULE_INITIATION):
        fail("instance schedule initiation time drift")
    if not exact_rfc3339_timestamp(policy.get("expirationTime"), SCHEDULE_EXPIRATION):
        fail("instance schedule expiration time drift")


def scheduled_termination_expected(now: datetime) -> bool:
    if now.tzinfo is None:
        fail("runtime validation clock must include a timezone")
    utc_now = now.astimezone(timezone.utc)
    if utc_now < SCHEDULE_INITIATION:
        return False
    if utc_now >= SCHEDULE_EXPIRATION:
        return True
    local_time = utc_now.astimezone(SCHEDULE_ZONE).time().replace(tzinfo=None)
    return SCHEDULE_DAILY_STOP <= local_time < SCHEDULE_DAILY_START


def validate_instance(
    item: dict[str, Any],
    zone: str,
    *,
    require_running: bool,
    allow_terminated: bool,
) -> None:
    require_equal(basename(item.get("zone")), zone, "instance zone drift")
    require_equal(basename(item.get("machineType")), MACHINE_TYPE, "machine type drift")
    runtime_status = item.get("status")
    if require_running:
        require_equal(runtime_status, "RUNNING", "instance runtime status drift")
    elif runtime_status == "TERMINATED":
        if not allow_terminated:
            fail("instance is TERMINATED during its scheduled operating window")
    elif runtime_status != "RUNNING":
        fail(
            "instance runtime status drift: expected scheduled RUNNING/TERMINATED, "
            f"found {runtime_status!r}"
        )
    require_equal(item.get("deletionProtection"), True, "instance deletion protection drift")
    require_equal(item.get("canIpForward", False), False, "instance IP forwarding drift")
    resource_policies = item.get("resourcePolicies")
    if not isinstance(resource_policies, list):
        fail("instance resource policy attachments are missing")
    require_equal(
        [basename(policy) for policy in resource_policies],
        [SCHEDULE_NAME],
        "instance schedule attachment drift",
    )

    tags = item.get("tags")
    if not isinstance(tags, dict):
        fail("instance network tags are missing")
    require_equal(tags.get("items", []), [IAP_TARGET_TAG], "instance network tag drift")
    require_equal(
        metadata_map(item),
        {
            "block-project-ssh-keys": "TRUE",
            "enable-oslogin": "TRUE",
            "enable-oslogin-2fa": "TRUE",
        },
        "instance OS Login metadata drift",
    )

    service_accounts = item.get("serviceAccounts", [])
    require_equal(service_accounts, [], "instance service account drift")

    shielded = item.get("shieldedInstanceConfig")
    if not isinstance(shielded, dict):
        fail("Shielded VM configuration is missing")
    for key in ("enableSecureBoot", "enableVtpm", "enableIntegrityMonitoring"):
        require_equal(shielded.get(key), True, f"Shielded VM {key} drift")

    scheduling = item.get("scheduling")
    if not isinstance(scheduling, dict):
        fail("instance scheduling policy is missing")
    require_equal(
        scheduling.get("provisioningModel", "STANDARD"),
        "STANDARD",
        "instance provisioning model drift",
    )
    require_equal(
        scheduling.get("onHostMaintenance"),
        "MIGRATE",
        "instance maintenance policy drift",
    )
    require_equal(
        scheduling.get("automaticRestart"),
        True,
        "instance automatic restart drift",
    )
    require_equal(scheduling.get("preemptible", False), False, "instance preemptible drift")

    interfaces = item.get("networkInterfaces")
    if not isinstance(interfaces, list) or len(interfaces) != 1:
        fail("instance must have exactly one network interface")
    interface = interfaces[0]
    if not isinstance(interface, dict):
        fail("instance network interface is malformed")
    require_equal(basename(interface.get("network")), NETWORK_NAME, "instance network drift")
    require_equal(basename(interface.get("subnetwork")), SUBNET_NAME, "instance subnet drift")
    require_equal(interface.get("stackType", "IPV4_ONLY"), "IPV4_ONLY", "instance IP stack drift")
    access_configs = interface.get("accessConfigs")
    if not isinstance(access_configs, list) or len(access_configs) != 1:
        fail("instance must retain exactly one ephemeral egress access configuration")
    access_config = access_configs[0]
    if not isinstance(access_config, dict):
        fail("instance access configuration is malformed")
    require_equal(access_config.get("type"), "ONE_TO_ONE_NAT", "instance access type drift")
    require_equal(access_config.get("networkTier", "PREMIUM"), "PREMIUM", "network tier drift")
    nat_ip_raw = access_config.get("natIP", "")
    if runtime_status == "TERMINATED" and nat_ip_raw in (None, ""):
        # A stopped VM releases its ephemeral external IPv4. The access config
        # itself must remain exact so the next scheduled start receives one.
        pass
    else:
        try:
            nat_ip = ipaddress.ip_address(nat_ip_raw)
        except ValueError:
            fail("instance ephemeral external IPv4 address is missing or malformed")
        if (
            nat_ip.version != 4
            or nat_ip.is_private
            or nat_ip.is_loopback
            or nat_ip.is_link_local
            or nat_ip.is_multicast
            or nat_ip.is_unspecified
        ):
            fail("instance ephemeral external IPv4 address is not externally routable")

    disks = item.get("disks")
    if not isinstance(disks, list) or len(disks) != 2:
        fail("instance must have exactly one boot disk and one data disk")
    by_source = {basename(entry.get("source")): entry for entry in disks if isinstance(entry, dict)}
    if set(by_source) != {BOOT_DISK_NAME, DATA_DISK_NAME}:
        fail("instance disk attachments drifted")
    boot = by_source[BOOT_DISK_NAME]
    data = by_source[DATA_DISK_NAME]
    require_equal(boot.get("boot"), True, "boot disk attachment drift")
    require_equal(boot.get("autoDelete"), True, "boot disk auto-delete drift")
    require_equal(boot.get("deviceName"), BOOT_DEVICE_NAME, "boot device name drift")
    require_equal(boot.get("mode"), "READ_WRITE", "boot disk attachment mode drift")
    require_equal(data.get("boot", False), False, "data disk boot flag drift")
    require_equal(data.get("autoDelete"), False, "data disk auto-delete drift")
    require_equal(data.get("deviceName"), DATA_DEVICE_NAME, "data device name drift")
    require_equal(data.get("mode"), "READ_WRITE", "data disk attachment mode drift")


def decimal_from_money(value: Any, expected_currency: str) -> Decimal | None:
    if not isinstance(value, dict):
        return None
    currency = value.get("currencyCode")
    if currency != expected_currency:
        return None
    try:
        units = Decimal(str(value.get("units", "0")))
        nanos = Decimal(str(value.get("nanos", 0))) / Decimal(1_000_000_000)
        result = units + nanos
    except (InvalidOperation, TypeError):
        return None
    return result if result.is_finite() else None


def decimal_from_json_number(value: Any) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        return None
    return result if result.is_finite() else None


def exact_budget_date(value: Any, expected: dict[str, int]) -> bool:
    if not isinstance(value, dict) or set(value) != set(expected):
        return False
    return all(
        isinstance(value[key], int)
        and not isinstance(value[key], bool)
        and value[key] == expected[key]
        for key in expected
    )


def valid_budget_alerts(budget: dict[str, Any]) -> bool:
    rules = budget.get("thresholdRules")
    if not isinstance(rules, list) or len(rules) != len(BUDGET_THRESHOLDS):
        return False
    thresholds: list[Decimal] = []
    for rule in rules:
        if not isinstance(rule, dict):
            return False
        if rule.get("spendBasis", "CURRENT_SPEND") not in (
            "BASIS_UNSPECIFIED",
            "CURRENT_SPEND",
        ):
            return False
        threshold = decimal_from_json_number(rule.get("thresholdPercent"))
        if threshold is None:
            return False
        thresholds.append(threshold)
    if len(set(thresholds)) != len(thresholds) or set(thresholds) != BUDGET_THRESHOLDS:
        return False

    notifications = budget.get("notificationsRule")
    if not isinstance(notifications, dict):
        return False
    # Both role-based audiences must receive the alerts: billing-account IAM
    # recipients (the API default) and the single project's Owners.
    if notifications.get("disableDefaultIamRecipients", False) is not False:
        return False
    if notifications.get("enableProjectLevelRecipients") is not True:
        return False
    return True


def validate_inventory(args: argparse.Namespace) -> dict[str, Any]:
    if args.require_running and not args.require_complete:
        fail("--require-running is only valid together with --require-complete")
    root = Path(args.inventory_dir)
    cost = validate_cost(args.expected_monthly_usd, args.expected_90day_usd)
    full_zone = f"{REGION}-{args.zone}"

    auth = load_json(root / "auth.json", list)
    active_accounts = [
        row.get("account")
        for row in auth
        if isinstance(row, dict) and row.get("status") == "ACTIVE" and row.get("account")
    ]
    if len(active_accounts) != 1:
        fail("exactly one active gcloud account is required")

    project = load_json(root / "project.json", dict)
    require_equal(project.get("projectId"), args.project, "gcloud project mismatch")
    require_equal(project.get("lifecycleState"), "ACTIVE", "project lifecycle state")
    project_number = str(project.get("projectNumber", ""))
    if not re.fullmatch(r"[1-9][0-9]+", project_number):
        fail("project number is missing or malformed")

    billing = load_json(root / "billing-project.json", dict)
    require_equal(billing.get("projectId"), args.project, "billing project mismatch")
    require_equal(billing.get("billingEnabled"), True, "project billing linkage")
    billing_account = str(billing.get("billingAccountName", ""))
    if not re.fullmatch(r"billingAccounts/[A-Z0-9-]+", billing_account):
        fail("billing account linkage is missing or malformed")

    budgets = load_json(root / "budgets.json", list)
    expected_project_refs = {
        f"projects/{args.project}",
        f"projects/{project_number}",
    }
    matching_budgets: list[tuple[dict[str, Any], str]] = []
    for budget in budgets:
        if not isinstance(budget, dict):
            continue
        amount = budget.get("amount")
        if not isinstance(amount, dict):
            continue
        specified = decimal_from_money(amount.get("specifiedAmount"), BUDGET_CURRENCY)
        budget_filter = budget.get("budgetFilter")
        if not isinstance(budget_filter, dict):
            continue
        projects = budget_filter.get("projects")
        has_narrower_filter = any(
            budget_filter.get(key) not in (None, [], {})
            for key in ("resourceAncestors", "services", "subaccounts", "labels", "creditTypes")
        )
        custom_period = budget_filter.get("customPeriod")
        exact_period = (
            isinstance(custom_period, dict)
            and exact_budget_date(custom_period.get("startDate"), BUDGET_START_DATE)
            and exact_budget_date(custom_period.get("endDate"), BUDGET_END_DATE)
            and budget_filter.get("calendarPeriod") in (None, "CALENDAR_PERIOD_UNSPECIFIED")
        )
        if (
            specified == BUDGET_AMOUNT
            and budget.get("displayName") == BUDGET_DISPLAY_NAME
            and isinstance(projects, list)
            and len(projects) == 1
            and projects[0] in expected_project_refs
            and not has_narrower_filter
            and budget_filter.get("creditTypesTreatment") == BUDGET_CREDIT_TREATMENT
            and exact_period
            and valid_budget_alerts(budget)
        ):
            matching_budgets.append((budget, projects[0]))
    if not matching_budgets:
        fail(
            "no exact moneyworry-90day budget exists: require project-only scope, "
            "2026-08-26..API endDate 2026-11-24 custom period, KRW 350000, "
            "EXCLUDE_ALL_CREDITS, current-spend "
            "thresholds 25/50/70/85/95%, and both billing-IAM and project-owner email recipients"
        )
    matching_budgets.sort(key=lambda row: str(row[0].get("name", "")))
    selected_budget, budget_scope = matching_budgets[0]
    budget_name = str(selected_budget.get("name", ""))
    if not budget_name.startswith(f"{billing_account}/budgets/"):
        fail("matching budget resource name does not belong to the linked billing account")

    services = load_json(root / "services.json", list)
    enabled_apis = {
        row.get("config", {}).get("name")
        for row in services
        if isinstance(row, dict)
        and isinstance(row.get("config"), dict)
        and row.get("state") == "ENABLED"
    }
    missing_apis = sorted(REQUIRED_APIS - enabled_apis)
    if missing_apis:
        fail(f"required APIs are not enabled: {', '.join(missing_apis)}")

    networks = load_json(root / "networks.json", list)
    routes = load_json(root / "routes.json", list)
    routers = load_json(root / "routers.json", list)
    policy_based_routes = load_json(root / "policy-based-routes.json", list)
    ncc_spokes = load_json(root / "ncc-spokes.json", list)
    subnets = load_json(root / "subnets.json", list)
    firewalls = load_json(root / "firewalls.json", list)
    effective_firewalls = load_json(root / "effective-firewalls.json", (list, dict))
    project_metadata = load_json(root / "project-metadata.json", dict)
    image = load_json(root / "image.json", dict)
    resource_policies = load_json(root / "resource-policies.json", list)
    disks = load_json(root / "disks.json", list)
    instances = load_json(root / "instances.json", list)

    validate_project_metadata(project_metadata)
    validate_image(image)
    validate_no_alternate_routing(routers, policy_based_routes, ncc_spokes)
    validate_project_firewalls(firewalls)

    network = one_named(networks, NETWORK_NAME, "network")
    subnet = one_named(subnets, SUBNET_NAME, "subnet")
    firewall = one_named(firewalls, FIREWALL_NAME, "firewall")
    schedule = one_named(resource_policies, SCHEDULE_NAME, "resource policy")
    boot_disk = one_named(disks, BOOT_DISK_NAME, "disk")
    data_disk = one_named(disks, DATA_DISK_NAME, "disk")
    instance = one_named(instances, VM_NAME, "instance")
    validate_effective_firewalls(
        effective_firewalls,
        project=args.project,
        network_exists=network is not None,
        firewall_exists=firewall is not None,
    )

    route_state = validate_routes(
        routes,
        project=args.project,
        network_exists=network is not None,
        subnet_exists=subnet is not None,
    )
    allow_terminated = scheduled_termination_expected(datetime.now(timezone.utc))

    states = {
        "image": "exact",
        "network": resource_state(network, validate_network),
        "routes": route_state,
        "subnet": resource_state(subnet, lambda row: validate_subnet(row, full_zone)),
        "firewall": resource_state(firewall, validate_firewall),
        "schedule": resource_state(schedule, validate_schedule),
        "boot_disk": resource_state(
            boot_disk, lambda row: validate_disk(row, full_zone, boot=True)
        ),
        "data_disk": resource_state(
            data_disk, lambda row: validate_disk(row, full_zone, boot=False)
        ),
        "instance": resource_state(
            instance,
            lambda row: validate_instance(
                row,
                full_zone,
                require_running=args.require_running,
                allow_terminated=allow_terminated,
            ),
        ),
    }

    if instance is None and boot_disk is not None:
        fail("orphaned VM boot disk exists while the instance is absent")
    if instance is not None:
        for dependency in (
            "network",
            "subnet",
            "firewall",
            "schedule",
            "boot_disk",
            "data_disk",
        ):
            if states[dependency] != "exact":
                fail(f"instance exists but dependency {dependency} is absent")
        if data_disk is None:
            fail("instance exists but data disk inventory is missing")
        data_users = data_disk.get("users", [])
        if not isinstance(data_users, list) or [basename(user) for user in data_users] != [VM_NAME]:
            fail("data disk is not attached exclusively to the expected VM")
    if data_disk is not None and instance is None:
        users = data_disk.get("users", [])
        if users:
            fail("data disk is attached to an unexpected instance")

    if args.require_complete:
        incomplete = sorted(name for name, state in states.items() if state != "exact")
        if incomplete:
            fail(f"provisioning postcondition is incomplete: {', '.join(incomplete)}")

    return {
        "status": "ready",
        "mode": "read-only-preflight",
        "active_account": active_accounts[0],
        "project_id": args.project,
        "project_number": project_number,
        "billing_account": billing_account,
        "budget": {
            "name": budget_name,
            "display_name": BUDGET_DISPLAY_NAME,
            "currency_code": BUDGET_CURRENCY,
            "amount": f"{BUDGET_AMOUNT:.0f}",
            "credit_types_treatment": BUDGET_CREDIT_TREATMENT,
            "scope": budget_scope,
            "period": {
                "start": "2026-08-26",
                "api_end_date": "2026-11-24",
            },
            "threshold_percentages": [25, 50, 70, 85, 95],
            "email_recipients": ["billing-iam", "project-owners"],
        },
        "cost": cost,
        "operating_schedule": {
            "name": SCHEDULE_NAME,
            "daily_window": "07:00-01:00",
            "timezone": SCHEDULE_TIMEZONE,
            "initiation": "2026-08-27T00:00:00+09:00",
            "expiration": "2026-11-24T02:00:00+09:00",
        },
        "region": REGION,
        "zone": full_zone,
        "resources": states,
    }


def billing_account(args: argparse.Namespace) -> str:
    value = load_json(Path(args.path), dict)
    require_equal(value.get("projectId"), args.project, "billing project mismatch")
    require_equal(value.get("billingEnabled"), True, "project billing linkage")
    account = str(value.get("billingAccountName", ""))
    if not re.fullmatch(r"billingAccounts/[A-Z0-9-]+", account):
        fail("billing account linkage is missing or malformed")
    return account


def active_account(args: argparse.Namespace) -> str:
    value = load_json(Path(args.path), list)
    accounts = [
        row.get("account")
        for row in value
        if isinstance(row, dict) and row.get("status") == "ACTIVE" and row.get("account")
    ]
    if len(accounts) != 1 or not isinstance(accounts[0], str):
        fail("exactly one active gcloud account is required")
    if any(character in accounts[0] for character in "\r\n\x00"):
        fail("active gcloud account is malformed")
    return accounts[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    cost_parser = subparsers.add_parser("cost")
    cost_parser.add_argument("--expected-monthly-usd", required=True)
    cost_parser.add_argument("--expected-90day-usd", required=True)

    billing_parser = subparsers.add_parser("billing-account")
    billing_parser.add_argument("--path", required=True)
    billing_parser.add_argument("--project", required=True)

    account_parser = subparsers.add_parser("active-account")
    account_parser.add_argument("--path", required=True)

    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--inventory-dir", required=True)
    validate_parser.add_argument("--project", required=True)
    validate_parser.add_argument("--zone", choices=("a", "b", "c"), required=True)
    validate_parser.add_argument("--expected-monthly-usd", required=True)
    validate_parser.add_argument("--expected-90day-usd", required=True)
    validate_parser.add_argument("--require-complete", action="store_true")
    validate_parser.add_argument("--require-running", action="store_true")
    validate_parser.add_argument("--pretty", action="store_true")

    args = parser.parse_args()
    try:
        if args.command == "cost":
            result: Any = validate_cost(args.expected_monthly_usd, args.expected_90day_usd)
        elif args.command == "billing-account":
            print(billing_account(args))
            return 0
        elif args.command == "active-account":
            print(active_account(args))
            return 0
        else:
            result = validate_inventory(args)
    except ValueError as exc:
        print(f"moneyworry-gcp: {exc}", file=sys.stderr)
        return 1

    indent = 2 if getattr(args, "pretty", False) else None
    print(json.dumps(result, indent=indent, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
