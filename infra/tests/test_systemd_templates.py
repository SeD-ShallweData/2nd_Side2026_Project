from __future__ import annotations

import subprocess
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infra"


class SystemdPrivilegeBoundaryTests(unittest.TestCase):
    def test_installer_is_valid_bash_and_has_no_legacy_shared_variables(self) -> None:
        result = subprocess.run(
            ["bash", "-n", str(INFRA / "scripts" / "install-systemd-units.sh")],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        installer = (INFRA / "scripts" / "install-systemd-units.sh").read_text(encoding="utf-8")
        self.assertNotIn('ENV_FILE="/etc/moneyworry/moneyworry.env"', installer)
        self.assertNotRegex(installer, r"(?m)^SERVICE_USER=")
        self.assertNotRegex(installer, r"(?m)^ENV_FILE=")
        for token in (
            "DB_ENV_FILE",
            "WEB_ENV_FILE",
            "RAG_ENV_FILE",
            "CONTRACT_ENV_FILE",
            "DB_SERVICE_USER",
            "WEB_SERVICE_USER",
            "RAG_SERVICE_USER",
            "CONTRACT_SERVICE_USER",
        ):
            self.assertIn(token, installer)
        self.assertIn("production web requires Node.js 22.23.2 exactly", installer)
        self.assertIn("process.versions.node", installer)
        self.assertIn("http://127.0.0.1:3111/api/health/ready", installer)
        self.assertIn("readiness did not reach HTTP 200", installer)
        self.assertIn("environment directory must be root-owned", installer)
        self.assertIn("environment directory must not be group/world writable", installer)
        self.assertIn("environment files must be direct children of /etc/moneyworry", installer)

    def test_installer_rejects_node_runtimes_hidden_by_protect_home(self) -> None:
        installer = (INFRA / "scripts" / "install-systemd-units.sh").read_text(
            encoding="utf-8"
        )
        match = re.search(
            r'case "\$NODE_BIN" in\n.*?\nesac',
            installer,
            flags=re.DOTALL,
        )
        self.assertIsNotNone(match, "NODE_BIN ProtectHome gate is missing")
        assert match is not None
        gate = match.group(0)
        harness = "\n".join(
            (
                "die() { exit 97; }",
                'NODE_BIN="$1"',
                gate,
            )
        )
        for bad_path in (
            "/home/deploy/.nvm/versions/node/v22.23.2/bin/node",
            "/root/.nvm/versions/node/v22.23.2/bin/node",
            "/run/user/1000/fnm/node",
        ):
            result = subprocess.run(
                ["bash", "-c", harness, "node-gate", bad_path],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 97, bad_path)
        for allowed_path in ("/usr/bin/node", "/usr/local/bin/node", "/opt/node/bin/node"):
            result = subprocess.run(
                ["bash", "-c", harness, "node-gate", allowed_path],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, allowed_path)
        self.assertIn("web service account cannot execute the Node.js runtime", installer)

    def test_installer_requires_exact_persistent_disk_mount_and_fstab(self) -> None:
        installer = (INFRA / "scripts" / "install-systemd-units.sh").read_text(
            encoding="utf-8"
        )
        for token in (
            'DATA_DISK_BY_ID="/dev/disk/by-id/google-moneyworry-data"',
            'DATA_DISK_BYTES="85899345920"',
            "blockdev --getsize64",
            "findmnt --noheadings --raw",
            "findmnt --fstab --evaluate --noheadings --raw",
            '[[ "$live_target" == "$DATA_MOUNT_ROOT" ]]',
            '[[ "$live_fstype" == "ext4" ]]',
            '[[ "$live_source_device" == "$expected_data_device" ]]',
            '[[ "$fstab_target" == "$DATA_MOUNT_ROOT" ]]',
            '[[ "$fstab_fstype" == "ext4" ]]',
            '[[ "$fstab_source_device" == "$expected_data_device" ]]',
            "live data mount inventory must contain exactly one record",
            "/etc/fstab data mount inventory must contain exactly one record",
        ):
            self.assertIn(token, installer)

    def test_installer_rejects_dropins_and_attests_effective_units(self) -> None:
        installer = (INFRA / "scripts" / "install-systemd-units.sh").read_text(
            encoding="utf-8"
        )
        for root in (
            "/etc/systemd/system",
            "/run/systemd/system",
            "/usr/local/lib/systemd/system",
            "/usr/lib/systemd/system",
        ):
            self.assertIn(root, installer)
        for dropin_pattern in (
            '"$dropin_root/service.d"',
            '"$dropin_root/moneyworry-.service.d"',
            '"$dropin_root/$unit_name.service.d"',
        ):
            self.assertIn(dropin_pattern, installer)
        for effective_property in (
            "LoadState",
            "FragmentPath",
            "DropInPaths",
            "User",
            "Group",
            "ProtectHome",
            "NoNewPrivileges",
            "EnvironmentFiles",
            "ReadOnlyPaths",
            "ReadWritePaths",
        ):
            self.assertIn(
                f"systemctl show --property={effective_property} --value",
                installer,
            )
        self.assertIn("effective systemd drop-ins are forbidden", installer)
        self.assertIn('"ExecStartPre"', installer)
        self.assertIn('"ExecStart"', installer)
        self.assertIn('"-H",', installer)
        self.assertIn('"127.0.0.1",', installer)
        self.assertIn('"-p",', installer)
        self.assertIn('"3111",', installer)
        self.assertIn("effective systemd ExecStart/ExecStartPre attestation failed", installer)

    def test_each_unit_has_a_distinct_user_and_environment_token(self) -> None:
        expected = {
            "moneyworry-db.service.in": ("@DB_SERVICE_USER@", "@DB_ENV_FILE@"),
            "moneyworry-web.service.in": ("@WEB_SERVICE_USER@", "@WEB_ENV_FILE@"),
            "moneyworry-rag.service.in": ("@RAG_SERVICE_USER@", "@RAG_ENV_FILE@"),
            "moneyworry-contract.service.in": ("@CONTRACT_SERVICE_USER@", "@CONTRACT_ENV_FILE@"),
        }
        for filename, (user, env_file) in expected.items():
            text = (INFRA / "systemd" / filename).read_text(encoding="utf-8")
            self.assertIn(f"User={user}", text)
            self.assertIn(f"EnvironmentFile={env_file}", text)
            self.assertNotIn("@SERVICE_USER@", text)
            self.assertNotIn("@ENV_FILE@", text)

    def test_only_db_unit_receives_docker_group(self) -> None:
        db = (INFRA / "systemd" / "moneyworry-db.service.in").read_text(encoding="utf-8")
        self.assertIn("SupplementaryGroups=docker", db)
        for name in ("moneyworry-web", "moneyworry-rag", "moneyworry-contract"):
            text = (INFRA / "systemd" / f"{name}.service.in").read_text(encoding="utf-8")
            self.assertNotIn("docker", text.lower())

    def test_request_facing_units_mount_code_read_only(self) -> None:
        for name in ("moneyworry-web", "moneyworry-rag", "moneyworry-contract"):
            text = (INFRA / "systemd" / f"{name}.service.in").read_text(encoding="utf-8")
            self.assertIn("ProtectSystem=strict", text)
            self.assertIn("ReadOnlyPaths=@PROJECT_ROOT@", text)
        rag = (INFRA / "systemd" / "moneyworry-rag.service.in").read_text(encoding="utf-8")
        self.assertIn(
            "ReadOnlyPaths=@PROJECT_ROOT@ /srv/moneyworry/hf /srv/moneyworry/rag-db",
            rag,
        )
        self.assertIn("ReadWritePaths=/run/moneyworry-rag", rag)
        self.assertIn("Environment=RAG_DB_PATH=/run/moneyworry-rag/chroma", rag)
        self.assertIn("RuntimeDirectory=moneyworry-rag", rag)

    def test_rag_unit_pins_offline_assets_and_runs_integrity_preflight(self) -> None:
        rag = (INFRA / "systemd" / "moneyworry-rag.service.in").read_text(encoding="utf-8")
        for setting in (
            "Environment=HF_HUB_OFFLINE=1",
            "Environment=TRANSFORMERS_OFFLINE=1",
            "Environment=RAG_EMBEDDING_MODEL=BAAI/bge-m3",
            "Environment=RAG_MODEL_REVISION=5617a9f61b028005a4858fdac845db406aefb181",
            "Environment=RAG_MODEL_LOCAL_ONLY=1",
            "Environment=RAG_EXPECTED_DOCUMENT_COUNT=583",
            "Environment=RAG_EXPECTED_EMBEDDING_DIMENSION=1024",
            "Environment=RAG_DISTANCE_THRESHOLD=0.42",
            "Environment=RAG_STRONG_MATCH_DISTANCE=0.30",
            "prepare_rag_assets.py stage-runtime",
            "--runtime-rag-db /run/moneyworry-rag/chroma",
            "--require-read-only",
            "TimeoutStartSec=15min",
        ):
            self.assertIn(setting, rag)

        installer = (INFRA / "scripts" / "install-systemd-units.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("pinned RAG model/Chroma asset verification failed", installer)
        self.assertIn("must not be able to modify the sealed HF cache", installer)

    def test_contract_unit_and_installer_verify_sealed_assets(self) -> None:
        contract = (INFRA / "systemd" / "moneyworry-contract.service.in").read_text(
            encoding="utf-8"
        )
        self.assertIn(".venv/bin/python", contract)
        self.assertIn("verify_contract_assets.py", contract)
        installer = (INFRA / "scripts" / "install-systemd-units.sh").read_text(
            encoding="utf-8"
        )
        for token in (
            "verify_contract_assets.py",
            "app/asset_integrity.py",
            "config/contract_assets.v1.json",
            "pinned contract asset verification failed",
        ):
            self.assertIn(token, installer)

    def test_contract_unit_runs_exact_asset_preflight(self) -> None:
        contract = (INFRA / "systemd" / "moneyworry-contract.service.in").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "ExecStartPre=@PROJECT_ROOT@/product/integrations/contract-api/.venv/bin/python "
            "@PROJECT_ROOT@/product/integrations/contract-api/verify_contract_assets.py",
            contract,
        )
        run_script = (
            INFRA.parent / "product" / "integrations" / "contract-api" / "run-gunicorn.sh"
        ).read_text(encoding="utf-8")
        self.assertIn('"$PYTHON" "$SCRIPT_DIR/verify_contract_assets.py"', run_script)

    def test_installer_attests_both_exact_python_runtimes_and_sealed_venvs(self) -> None:
        installer = (INFRA / "scripts" / "install-systemd-units.sh").read_text(
            encoding="utf-8"
        )
        for token in (
            'PYTHON_RUNTIME_VERIFIER="$PROJECT_ROOT/infra/scripts/verify-python-runtime.py"',
            'RAG_REQUIREMENTS_LOCK="$RAG_ROOT/requirements.lock"',
            'CONTRACT_REQUIREMENTS_LOCK="$CONTRACT_ROOT/requirements.lock"',
            '"$PYTHON3_BIN" -I -S "$PYTHON_RUNTIME_VERIFIER"',
            '--venv "$RAG_VENV"',
            '--python "$RAG_VENV/bin/python"',
            '--lock "$RAG_REQUIREMENTS_LOCK"',
            '--venv "$CONTRACT_VENV"',
            '--python "$CONTRACT_VENV/bin/python"',
            '--lock "$CONTRACT_REQUIREMENTS_LOCK"',
            "RAG Python 3.12.13/hashed-lock runtime attestation failed",
            "contract Python 3.12.13/hashed-lock runtime attestation failed",
            "tree must be entirely root-owned",
            "tree must not be group/world writable",
            "can modify the sealed",
            'find -P "$venv" ! -uid 0',
            '-perm /022',
            '-writable -print -quit',
        ):
            self.assertIn(token, installer)

        for relative in (
            "product/integrations/rag-api/run-gunicorn.sh",
            "product/integrations/contract-api/run-gunicorn.sh",
        ):
            run_script = (INFRA.parent / relative).read_text(encoding="utf-8")
            self.assertIn('exec "$PYTHON" -m gunicorn', run_script)
            self.assertIn("requirements.lock", run_script)

    def test_python_readmes_use_exact_hashed_lock_install(self) -> None:
        readmes = (
            INFRA / "README.md",
            INFRA.parent / "product" / "README.md",
            INFRA.parent / "product" / "integrations" / "rag-api" / "README.md",
            INFRA.parent / "product" / "integrations" / "contract-api" / "README.md",
        )
        for readme in readmes:
            text = readme.read_text(encoding="utf-8")
            self.assertNotIn("pip install -r requirements.txt", text, readme)
        for readme in readmes[1:]:
            text = readme.read_text(encoding="utf-8")
            self.assertIn("3.12.13", text, readme)
            self.assertIn("--require-hashes -r requirements.lock", text, readme)

    def test_every_service_disables_core_dumps(self) -> None:
        for name in ("moneyworry-db", "moneyworry-web", "moneyworry-rag", "moneyworry-contract"):
            text = (INFRA / "systemd" / f"{name}.service.in").read_text(encoding="utf-8")
            self.assertEqual(text.count("LimitCORE=0"), 1, name)

    def test_web_and_contract_disable_legacy_secret_file_fallbacks(self) -> None:
        web = (INFRA / "systemd" / "moneyworry-web.service.in").read_text(encoding="utf-8")
        contract = (INFRA / "systemd" / "moneyworry-contract.service.in").read_text(encoding="utf-8")
        self.assertIn("Environment=DATABASE_ENV_FILE=/dev/null", web)
        self.assertIn("Environment=SHARED_API_KEY_FILE=/dev/null", web)
        self.assertIn("Environment=API_KEY_ENV_FILE=/dev/null", contract)
        self.assertIn("Environment=LOCAL_CONFIG_ENV_FILE=/dev/null", contract)


if __name__ == "__main__":
    unittest.main()
