#!/usr/bin/env python3
"""Attest an exact Python 3.12.13 environment against a fully hashed lock file."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path


PYTHON_VERSION = "3.12.13"
REQUIREMENT = re.compile(
    r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*)\s+\\$"
)
HASH = re.compile(r"^\s+--hash=sha256:([0-9a-f]{64})(\s+\\)?$")
CANONICAL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def fail(message: str) -> None:
    raise SystemExit(message)


def canonical_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _fail_unfinished_hashes(
    path: Path,
    location: str,
    active: str,
    hashes: dict[str, set[str]],
) -> None:
    if not hashes[active]:
        fail(f"locked distributions have no SHA-256 hashes: {active}")
    fail(f"unterminated hash continuation at {path}:{location}: {active}")


def parse_lock(path: Path) -> dict[str, str]:
    requirements: dict[str, str] = {}
    active: str | None = None
    hashes: dict[str, set[str]] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        fail(f"could not read lock file as UTF-8: {path} ({error.__class__.__name__})")
    for number, line in enumerate(lines, 1):
        if not line or line.lstrip().startswith("#"):
            if active is not None:
                _fail_unfinished_hashes(path, str(number), active, hashes)
            continue
        requirement = REQUIREMENT.fullmatch(line)
        if requirement:
            if active is not None:
                _fail_unfinished_hashes(path, str(number), active, hashes)
            name = canonical_name(requirement.group(1))
            if not CANONICAL_NAME.fullmatch(name):
                fail(f"invalid locked distribution name at {path}:{number}")
            if name in requirements:
                fail(f"duplicate locked distribution at {path}:{number}: {name}")
            if name == "pip":
                fail("pip must not be locked because only its installed version is exempt")
            requirements[name] = requirement.group(2)
            hashes[name] = set()
            active = name
            continue
        digest = HASH.fullmatch(line)
        if digest:
            if active is None:
                fail(f"orphaned SHA-256 hash at {path}:{number}")
            value = digest.group(1)
            if value in hashes[active]:
                fail(f"duplicate SHA-256 hash at {path}:{number}: {active}")
            hashes[active].add(value)
            if digest.group(2) is None:
                active = None
            continue
        fail(f"unsupported or unhashed lock syntax at {path}:{number}")
    if active is not None:
        _fail_unfinished_hashes(path, "end of lock file", active, hashes)
    if not requirements:
        fail(f"lock file contains no distributions: {path}")
    missing_hash = sorted(name for name, values in hashes.items() if not values)
    if missing_hash:
        fail(f"locked distributions have no SHA-256 hashes: {', '.join(missing_hash)}")
    return requirements


def validate_venv_layout(venv: Path, python: Path) -> Path:
    """Validate a conventional, isolated CPython 3.12 venv without importing it."""

    if not venv.is_absolute() or venv.is_symlink() or not venv.is_dir():
        fail("--venv must be an absolute, real directory")
    expected_python = venv / "bin" / "python"
    if python.absolute() != expected_python.absolute():
        fail("--python must be the exact --venv/bin/python path")
    if not python.is_file():
        fail("--python must identify the venv Python executable")
    bin_directory = venv / "bin"
    if bin_directory.is_symlink() or not bin_directory.is_dir():
        fail("virtual environment must contain a direct bin directory")

    configuration = venv / "pyvenv.cfg"
    if not configuration.is_file() or configuration.is_symlink():
        fail("virtual environment must contain a direct pyvenv.cfg file")
    values: dict[str, str] = {}
    try:
        lines = configuration.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        fail(f"could not read pyvenv.cfg as UTF-8 ({error.__class__.__name__})")
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        key, separator, value = line.partition("=")
        key = key.strip().lower()
        value = value.strip()
        if not separator or not key or not value or key in values:
            fail(f"invalid pyvenv.cfg entry at line {number}")
        values[key] = value
    if values.get("version") != PYTHON_VERSION:
        fail(f"virtual environment pyvenv.cfg must pin Python {PYTHON_VERSION}")
    if values.get("include-system-site-packages", "").lower() != "false":
        fail("virtual environment must disable system site packages")

    lib_directory = venv / "lib"
    version_directory = lib_directory / "python3.12"
    site_packages = version_directory / "site-packages"
    for directory in (lib_directory, version_directory, site_packages):
        if directory.is_symlink() or not directory.is_dir():
            fail("virtual environment has no direct Python 3.12 site-packages directory")

    def walk_error(error: OSError) -> None:
        fail(f"could not inspect virtual environment site-packages ({error.__class__.__name__})")

    for current, directory_names, file_names in os.walk(
        site_packages,
        followlinks=False,
        onerror=walk_error,
    ):
        for entry_name in directory_names + file_names:
            entry = Path(current) / entry_name
            if entry.is_symlink():
                fail("virtual environment site-packages must not contain symlinks")
            if not entry.is_dir() and not entry.is_file():
                fail("virtual environment site-packages contains a special filesystem entry")

        for file_name in file_names:
            lowered = file_name.lower()
            if lowered.endswith((".pth", ".egg-link")) or lowered == "direct_url.json":
                fail(f"virtual environment contains a forbidden import/install hook: {file_name}")

    # Normal site initialization imports these names after processing .pth
    # files. Cover source, bytecode, native extension, and package forms.
    try:
        top_level_entries = list(site_packages.iterdir())
    except OSError as error:
        fail(f"could not inspect virtual environment startup modules ({error.__class__.__name__})")
    for entry in top_level_entries:
        lowered = entry.name.lower()
        if any(
            lowered == module_name or lowered.startswith(f"{module_name}.")
            for module_name in ("sitecustomize", "usercustomize")
        ):
            fail(f"virtual environment contains a forbidden startup module: {entry.name}")
    return site_packages


def runtime_snapshot(python: Path, site_packages: Path) -> dict[str, object]:
    program = """
import importlib.metadata
import json
import platform
import sys

packages = {}
duplicates = []
invalid_distributions = 0
for distribution in importlib.metadata.distributions(path=[sys.argv[1]]):
    name = distribution.metadata.get("Name")
    version = distribution.version
    if not name or not version:
        invalid_distributions += 1
        continue
    canonical = __import__("re").sub(r"[-_.]+", "-", name).lower()
    if canonical in packages:
        duplicates.append(canonical)
    packages[canonical] = version
print(json.dumps({
    "python": platform.python_version(),
    "implementation": sys.implementation.name,
    "cache_tag": sys.implementation.cache_tag,
    "executable": __import__("os").path.abspath(sys.executable),
    "isolated": sys.flags.isolated,
    "no_user_site": sys.flags.no_user_site,
    "no_site": sys.flags.no_site,
    "packages": packages,
    "duplicates": sorted(set(duplicates)),
    "invalid_distributions": invalid_distributions,
}, sort_keys=True))
"""
    try:
        completed = subprocess.run(
            [str(python), "-I", "-S", "-c", program, str(site_packages)],
            check=False,
            text=True,
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail("could not inventory the service Python environment")
    if completed.returncode != 0:
        fail("could not inventory the service Python environment")
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError:
        fail("service Python returned an invalid environment inventory")
    if not isinstance(result, dict):
        fail("service Python returned an invalid environment inventory")
    return result


def validate_snapshot(
    expected: dict[str, str],
    snapshot: dict[str, object],
    *,
    expected_venv: Path,
) -> None:
    expected_keys = {
        "python",
        "implementation",
        "cache_tag",
        "executable",
        "isolated",
        "no_user_site",
        "no_site",
        "packages",
        "duplicates",
        "invalid_distributions",
    }
    if set(snapshot) != expected_keys:
        fail("service Python returned an incomplete runtime inventory")
    if snapshot.get("python") != PYTHON_VERSION:
        fail(f"service Python must be exactly {PYTHON_VERSION}")
    if snapshot.get("implementation") != "cpython" or snapshot.get("cache_tag") != "cpython-312":
        fail("service Python must be the exact CPython 3.12 runtime")
    expected_venv = expected_venv.resolve()
    executable = snapshot.get("executable")
    if not isinstance(executable, str) or not executable:
        fail("service Python venv identity is invalid")
    if Path(executable).parent.parent.resolve() != expected_venv:
        fail("service Python executable does not belong to the expected virtual environment")
    if (
        snapshot.get("isolated") != 1
        or snapshot.get("no_user_site") != 1
        or snapshot.get("no_site") != 1
    ):
        fail("service Python inventory must run in isolated -I -S mode with no user site packages")
    packages = snapshot.get("packages")
    duplicates = snapshot.get("duplicates")
    if not isinstance(packages, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in packages.items()
    ):
        fail("service Python package inventory is invalid")
    if not isinstance(duplicates, list) or not all(isinstance(value, str) for value in duplicates):
        fail("service Python duplicate inventory is invalid")
    if duplicates:
        fail("service Python has duplicate canonical distribution names")
    invalid_distributions = snapshot.get("invalid_distributions")
    if isinstance(invalid_distributions, bool) or not isinstance(invalid_distributions, int):
        fail("service Python invalid distribution inventory is malformed")
    if invalid_distributions != 0:
        fail("service Python has distributions without canonical name/version metadata")
    if any(
        key != canonical_name(key)
        or not CANONICAL_NAME.fullmatch(key)
        or not value
        for key, value in packages.items()
    ):
        fail("service Python package inventory is not canonical")
    actual = {key: value for key, value in packages.items() if key != "pip"}
    missing = sorted(set(expected) - set(actual))
    unexpected = sorted(set(actual) - set(expected))
    wrong = sorted(
        name for name in set(expected).intersection(actual) if expected[name] != actual[name]
    )
    if missing:
        fail(f"service Python is missing locked distributions: {', '.join(missing)}")
    if unexpected:
        fail(f"service Python has unlocked distributions: {', '.join(unexpected)}")
    if wrong:
        fail(f"service Python distribution versions differ from the lock: {', '.join(wrong)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venv", required=True, type=Path)
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--lock", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        python = args.python.resolve(strict=True)
    except OSError:
        fail("--python must resolve to an existing regular file")
    if not python.is_file():
        fail("--python must resolve to an existing regular file")
    if not args.lock.is_file() or args.lock.is_symlink():
        fail("--lock must be a direct regular file")
    site_packages = validate_venv_layout(args.venv, args.python)
    expected = parse_lock(args.lock)
    validate_snapshot(
        expected,
        runtime_snapshot(args.python, site_packages),
        expected_venv=args.venv,
    )
    print(f"verified Python {PYTHON_VERSION} and {len(expected)} locked distributions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
