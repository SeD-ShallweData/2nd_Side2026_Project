from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra" / "scripts" / "verify-python-runtime.py"
SPEC = importlib.util.spec_from_file_location("verify_python_runtime", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load Python runtime verifier")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
EXPECTED_VENV = Path("/srv/moneyworry/repo/project/.venv")


def snapshot(packages: dict[str, str], **overrides):
    value = {
        "python": "3.12.13",
        "implementation": "cpython",
        "cache_tag": "cpython-312",
        "executable": str(EXPECTED_VENV / "bin" / "python"),
        "isolated": 1,
        "no_user_site": 1,
        "no_site": 1,
        "packages": packages,
        "duplicates": [],
        "invalid_distributions": 0,
    }
    value.update(overrides)
    return value


class PythonRuntimeVerifierTest(unittest.TestCase):
    def make_venv(self, directory: str) -> tuple[Path, Path, Path]:
        venv = Path(directory) / "service-venv"
        python = venv / "bin" / "python"
        site_packages = venv / "lib" / "python3.12" / "site-packages"
        python.parent.mkdir(parents=True)
        python.touch()
        site_packages.mkdir(parents=True)
        (venv / "pyvenv.cfg").write_text(
            "home = /opt/cpython-3.12.13/bin\n"
            "include-system-site-packages = false\n"
            "version = 3.12.13\n",
            encoding="utf-8",
        )
        return venv, python, site_packages

    def test_parses_only_fully_hashed_exact_requirements(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "requirements.lock"
            lock.write_text(
                "demo-package==1.2.3 \\\n"
                "    --hash=sha256:" + "a" * 64 + "\n",
                encoding="utf-8",
            )
            self.assertEqual({"demo-package": "1.2.3"}, MODULE.parse_lock(lock))

    def test_parses_multiple_hashes_and_distributions(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "requirements.lock"
            lock.write_text(
                "# generated lock\n"
                "alpha==1.0 \\\n"
                "    --hash=sha256:" + "a" * 64 + " \\\n"
                "    --hash=sha256:" + "b" * 64 + "\n"
                "    # via direct\n"
                "Beta_Pkg==2.0.post1 \\\n"
                "    --hash=sha256:" + "c" * 64 + "\n",
                encoding="utf-8",
            )
            self.assertEqual(
                {"alpha": "1.0", "beta-pkg": "2.0.post1"},
                MODULE.parse_lock(lock),
            )

    def test_rejects_a_requirement_without_a_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "requirements.lock"
            lock.write_text("demo==1.0 \\\n", encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "no SHA-256 hashes"):
                MODULE.parse_lock(lock)

    def test_rejects_orphan_duplicate_and_unterminated_hashes(self):
        cases = {
            "orphaned": "    --hash=sha256:" + "a" * 64 + "\n",
            "duplicate SHA-256": (
                "demo==1.0 \\\n"
                "    --hash=sha256:" + "a" * 64 + " \\\n"
                "    --hash=sha256:" + "a" * 64 + "\n"
            ),
            "unterminated": (
                "demo==1.0 \\\n"
                "    --hash=sha256:" + "a" * 64 + " \\\n"
            ),
        }
        for message, content in cases.items():
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                lock = Path(directory) / "requirements.lock"
                lock.write_text(content, encoding="utf-8")
                with self.assertRaisesRegex(SystemExit, message):
                    MODULE.parse_lock(lock)

    def test_rejects_pip_in_the_locked_application_set(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "requirements.lock"
            lock.write_text(
                "pip==26.0 \\\n"
                "    --hash=sha256:" + "a" * 64 + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(SystemExit, "pip must not be locked"):
                MODULE.parse_lock(lock)

    def test_rejects_canonical_collisions_and_non_lock_syntax(self):
        collision = (
            "Demo_Pkg==1.0 \\\n"
            "    --hash=sha256:" + "a" * 64 + "\n"
            "demo-pkg==1.0 \\\n"
            "    --hash=sha256:" + "b" * 64 + "\n"
        )
        unsupported = (
            "demo>=1.0\n",
            "demo==1.0; python_version >= '3.12'\n",
            "demo @ https://example.invalid/demo.whl\n",
            "--index-url https://example.invalid/simple\n",
        )
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "requirements.lock"
            lock.write_text(collision, encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "duplicate locked distribution"):
                MODULE.parse_lock(lock)
            for content in unsupported:
                with self.subTest(content=content):
                    lock.write_text(content, encoding="utf-8")
                    with self.assertRaisesRegex(SystemExit, "unsupported or unhashed"):
                        MODULE.parse_lock(lock)

    def test_current_contract_lock_uses_supported_fully_hashed_syntax(self):
        lock = (
            ROOT
            / "product"
            / "integrations"
            / "contract-api"
            / "requirements.lock"
        )
        parsed = MODULE.parse_lock(lock)
        self.assertEqual(parsed["gunicorn"], "23.0.0")
        self.assertNotIn("pip", parsed)

    def test_snapshot_requires_exact_python_and_installed_set(self):
        expected = {"flask": "3.1.3"}
        MODULE.validate_snapshot(
            expected,
            snapshot({"flask": "3.1.3", "pip": "25.0.1"}),
            expected_venv=EXPECTED_VENV,
        )
        with self.assertRaisesRegex(SystemExit, "exactly 3.12.13"):
            MODULE.validate_snapshot(
                expected,
                snapshot({"flask": "3.1.3"}, python="3.12.12"),
                expected_venv=EXPECTED_VENV,
            )
        with self.assertRaisesRegex(SystemExit, "unlocked distributions: requests"):
            MODULE.validate_snapshot(
                expected,
                snapshot({"flask": "3.1.3", "requests": "2.34.2"}),
                expected_venv=EXPECTED_VENV,
            )

    def test_snapshot_rejects_missing_wrong_and_duplicate_distributions(self):
        expected = {"flask": "3.1.3", "requests": "2.34.2"}
        with self.assertRaisesRegex(SystemExit, "missing locked distributions: requests"):
            MODULE.validate_snapshot(
                expected,
                snapshot({"flask": "3.1.3"}),
                expected_venv=EXPECTED_VENV,
            )
        with self.assertRaisesRegex(SystemExit, "versions differ from the lock: flask"):
            MODULE.validate_snapshot(
                expected,
                snapshot({"flask": "3.1.2", "requests": "2.34.2"}),
                expected_venv=EXPECTED_VENV,
            )
        with self.assertRaisesRegex(SystemExit, "duplicate canonical distribution"):
            MODULE.validate_snapshot(
                expected,
                snapshot(
                    {"flask": "3.1.3", "requests": "2.34.2"},
                    duplicates=["flask"],
                ),
                expected_venv=EXPECTED_VENV,
            )

    def test_snapshot_requires_the_expected_isolated_venv(self):
        expected = {"flask": "3.1.3"}
        with self.assertRaisesRegex(SystemExit, "expected virtual environment"):
            MODULE.validate_snapshot(
                expected,
                snapshot(
                    {"flask": "3.1.3"},
                    executable="/tmp/other-venv/bin/python",
                ),
                expected_venv=EXPECTED_VENV,
            )
        with self.assertRaisesRegex(SystemExit, "isolated -I -S mode"):
            MODULE.validate_snapshot(
                expected,
                snapshot({"flask": "3.1.3"}, isolated=0),
                expected_venv=EXPECTED_VENV,
            )

    def test_snapshot_requires_cpython_and_valid_distribution_metadata(self):
        expected = {"flask": "3.1.3"}
        with self.assertRaisesRegex(SystemExit, "exact CPython 3.12 runtime"):
            MODULE.validate_snapshot(
                expected,
                snapshot({"flask": "3.1.3"}, implementation="pypy"),
                expected_venv=EXPECTED_VENV,
            )
        with self.assertRaisesRegex(SystemExit, "without canonical name/version"):
            MODULE.validate_snapshot(
                expected,
                snapshot({"flask": "3.1.3"}, invalid_distributions=1),
                expected_venv=EXPECTED_VENV,
            )

    def test_validates_direct_isolated_venv_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            venv, python, site_packages = self.make_venv(directory)
            self.assertEqual(
                MODULE.validate_venv_layout(venv, python),
                site_packages,
            )

            (venv / "pyvenv.cfg").write_text(
                "include-system-site-packages = true\nversion = 3.12.13\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(SystemExit, "disable system site packages"):
                MODULE.validate_venv_layout(venv, python)

    def test_runtime_snapshot_never_initializes_target_site_hooks(self):
        completed = mock.Mock(returncode=0, stdout="{}")
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run:
            self.assertEqual(
                MODULE.runtime_snapshot(
                    Path("/srv/service/.venv/bin/python"),
                    Path("/srv/service/.venv/lib/python3.12/site-packages"),
                ),
                {},
            )
        command = run.call_args.args[0]
        self.assertEqual(command[:3], ["/srv/service/.venv/bin/python", "-I", "-S"])
        self.assertEqual(
            command[-1],
            "/srv/service/.venv/lib/python3.12/site-packages",
        )
        self.assertEqual(run.call_args.kwargs["timeout"], 30)

    def test_rejects_symlinks_and_import_hooks_in_site_packages(self):
        hook_names = (
            "arbitrary.pth",
            "editable.egg-link",
            "direct_url.json",
            "sitecustomize.pyc",
            "usercustomize.cpython-312-x86_64-linux-gnu.so",
        )
        for hook_name in hook_names:
            with self.subTest(hook=hook_name), tempfile.TemporaryDirectory() as directory:
                venv, python, site_packages = self.make_venv(directory)
                (site_packages / hook_name).touch()
                with self.assertRaisesRegex(SystemExit, "forbidden (import/install hook|startup module)"):
                    MODULE.validate_venv_layout(venv, python)

        with tempfile.TemporaryDirectory() as directory:
            venv, python, site_packages = self.make_venv(directory)
            (site_packages / "sitecustomize").mkdir()
            with self.assertRaisesRegex(SystemExit, "forbidden startup module"):
                MODULE.validate_venv_layout(venv, python)

        with tempfile.TemporaryDirectory() as directory:
            venv, python, site_packages = self.make_venv(directory)
            outside = Path(directory) / "outside.py"
            outside.touch()
            os.symlink(outside, site_packages / "injected.py")
            with self.assertRaisesRegex(SystemExit, "must not contain symlinks"):
                MODULE.validate_venv_layout(venv, python)


if __name__ == "__main__":
    unittest.main()
