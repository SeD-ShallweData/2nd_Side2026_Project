from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "infra" / "scripts" / "validate-service-envs.py"


class SplitServiceEnvironmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.values = {
            "db": """\
COMPOSE_PROJECT_NAME=moneyworry-production
DB_PORT=5433
DB_NAME=wageguard
DB_USER=pathb_admin
DB_PASSWORD=AdminValue_8eQ2pR7xT4mN9kLs
BOT_USER=wg_bot
POSTGRES_DATA_DIR=/srv/moneyworry/postgres
""",
            "web": """\
BOT_DATABASE_URL=postgresql://wg_bot:BotValue_3qW8nM5vR2zK7pTx@127.0.0.1:5433/wageguard?sslmode=disable
RAG_API_URL=http://127.0.0.1:5051
CONTRACT_ANALYSIS_URL=http://127.0.0.1:8000
RAG_INTERNAL_TOKEN=RagInternal_7pQ2mV9xR4tK8nC3sL6wF
CONTRACT_INTERNAL_TOKEN=ContractInternal_5vN8qT2xM7kP4zC9rL6sW
APP_DATA_MODE=real
CHAT_EXECUTION_MODE=dual_api
UPSTAGE_API_KEY=WebUpstage_7pQ2mV9xR4tK
SKT_API_KEY=WebSktValue_5nL8wC3zT6qP
DEMO_BASIC_AUTH_USER=demo
DEMO_BASIC_AUTH_PASSWORD=BasicValue_6vT2pN9xQ4mK
SAVE_COMPARISON_FEEDBACK=false
""",
            "rag": "RAG_DEVICE=cpu\nRAG_GUNICORN_THREADS=2\nRAG_INTERNAL_TOKEN=RagInternal_7pQ2mV9xR4tK8nC3sL6wF\n",
            "contract": """\
UPSTAGE_API_KEY=ContractUpstage_4xM8qT2vP7nR
SKT_API_KEY=ContractSktValue_9zK3wL6mQ2tN
DEFAULT_PROVIDER=upstage
CONTRACT_INTERNAL_TOKEN=ContractInternal_5vN8qT2xM7kP4zC9rL6sW
""",
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_validator(self, updates: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        values = dict(self.values)
        values.update(updates or {})
        paths = {}
        for name, content in values.items():
            path = self.root / f"{name}.env"
            path.write_text(content, encoding="utf-8")
            paths[name] = path
        return subprocess.run(
            [
                "python3",
                str(VALIDATOR),
                "--db-env",
                str(paths["db"]),
                "--web-env",
                str(paths["web"]),
                "--rag-env",
                str(paths["rag"]),
                "--contract-env",
                str(paths["contract"]),
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def assert_failed_without_secret(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertNotEqual(result.returncode, 0)
        combined = result.stdout + result.stderr
        for marker in (
            "AdminValue_8eQ2pR7xT4mN9kLs",
            "BotValue_3qW8nM5vR2zK7pTx",
            "BasicValue_6vT2pN9xQ4mK",
        ):
            self.assertNotIn(marker, combined)

    def test_valid_split_contract(self) -> None:
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("validated split service environment contracts", result.stdout)

    def test_web_rejects_admin_password(self) -> None:
        result = self.run_validator({"web": self.values["web"] + "DB_PASSWORD=AdminLeak_4vT8pN2xQ6mK9rLs\n"})
        self.assert_failed_without_secret(result)
        self.assertIn("DB/bootstrap credentials", result.stderr)

    def test_web_rejects_database_url_even_when_bot_url_exists(self) -> None:
        result = self.run_validator({
            "web": self.values["web"]
            + "DATABASE_URL=postgresql://pathb_admin:AdminLeak_4vT8pN2xQ6mK9rLs@127.0.0.1:5433/wageguard\n"
        })
        self.assert_failed_without_secret(result)
        self.assertIn("ambiguous fallback: DATABASE_URL", result.stderr)

    def test_web_rejects_tls_for_the_loopback_non_tls_postgres(self) -> None:
        result = self.run_validator({"web": self.values["web"] + "DB_SSL=true\n"})
        self.assert_failed_without_secret(result)
        self.assertIn("DB_SSL must be absent or false", result.stderr)

    def test_web_rejects_unapproved_provider_endpoint(self) -> None:
        result = self.run_validator({
            "web": self.values["web"]
            + "UPSTAGE_API_URL=http://attacker.invalid/collect\n"
        })
        self.assert_failed_without_secret(result)
        self.assertIn("approved HTTPS provider endpoint", result.stderr)

    def test_web_rejects_unknown_api_url_key(self) -> None:
        result = self.run_validator({
            "web": self.values["web"] + "EXTRA_API_URL=https://attacker.invalid/collect\n"
        })
        self.assert_failed_without_secret(result)
        self.assertIn("unsupported keys: EXTRA_API_URL", result.stderr)

    def test_web_rejects_admin_identity_in_bot_url(self) -> None:
        result = self.run_validator({
            "web": self.values["web"].replace(
                "wg_bot:BotValue_3qW8nM5vR2zK7pTx",
                "pathb_admin:AdminLeak_4vT8pN2xQ6mK9rLs",
            )
        })
        self.assert_failed_without_secret(result)
        self.assertIn("read-only bot URL", result.stderr)

    def test_rag_rejects_api_key(self) -> None:
        result = self.run_validator({"rag": self.values["rag"] + "UPSTAGE_API_KEY=RagLeak_4vT8pN2xQ6mK9rLs\n"})
        self.assert_failed_without_secret(result)
        self.assertIn("forbidden secret-bearing key", result.stderr)

    def test_rag_rejects_database_path_override(self) -> None:
        result = self.run_validator({"rag": self.values["rag"] + "RAG_DB_PATH=/tmp/untrusted\n"})
        self.assert_failed_without_secret(result)
        self.assertIn("forbidden secret-bearing key", result.stderr)

    def test_database_rejects_unneeded_bot_secret(self) -> None:
        result = self.run_validator({
            "db": self.values["db"] + "BOT_PASSWORD=BotLeak_4vT8pN2xQ6mK9rLs\n"
        })
        self.assert_failed_without_secret(result)
        self.assertIn("unsupported keys: BOT_PASSWORD", result.stderr)

    def test_contract_rejects_endpoint_override(self) -> None:
        result = self.run_validator({
            "contract": self.values["contract"]
            + "UPSTAGE_API_URL=https://attacker.invalid/collect\n"
        })
        self.assert_failed_without_secret(result)
        self.assertIn("unsupported keys: UPSTAGE_API_URL", result.stderr)

    def test_contract_rejects_database_access(self) -> None:
        result = self.run_validator({
            "contract": self.values["contract"]
            + "BOT_DATABASE_URL=postgresql://wg_bot:BotLeak_4vT8pN2xQ6mK9rLs@127.0.0.1:5433/wageguard\n"
        })
        self.assert_failed_without_secret(result)
        self.assertIn("forbidden DB/file fallback", result.stderr)

    def test_web_requires_public_demo_auth(self) -> None:
        result = self.run_validator({
            "web": self.values["web"].replace("DEMO_BASIC_AUTH_PASSWORD=BasicValue_6vT2pN9xQ4mK\n", "")
        })
        self.assert_failed_without_secret(result)
        self.assertIn("DEMO_BASIC_AUTH_PASSWORD", result.stderr)

    def test_literal_documentation_placeholders_are_rejected(self) -> None:
        result = self.run_validator({
            "db": self.values["db"].replace(
                "AdminValue_8eQ2pR7xT4mN9kLs", "<DB_ADMIN_SECRET>"
            )
        })
        self.assert_failed_without_secret(result)
        self.assertIn("non-placeholder secret", result.stderr)

    def test_trivially_short_basic_password_is_rejected(self) -> None:
        result = self.run_validator({
            "web": self.values["web"].replace("BasicValue_6vT2pN9xQ4mK", "x")
        })
        self.assert_failed_without_secret(result)
        self.assertIn("at least 20 characters", result.stderr)

    def test_basic_auth_username_rejects_colon_separator(self) -> None:
        result = self.run_validator({
            "web": self.values["web"].replace(
                "DEMO_BASIC_AUTH_USER=demo", "DEMO_BASIC_AUTH_USER=demo:admin"
            )
        })
        self.assert_failed_without_secret(result)
        self.assertIn("must not contain ':'", result.stderr)

    def test_basic_auth_credentials_reject_unicode(self) -> None:
        result = self.run_validator({
            "web": self.values["web"].replace(
                "DEMO_BASIC_AUTH_USER=demo", "DEMO_BASIC_AUTH_USER=관리자"
            )
        })
        self.assert_failed_without_secret(result)
        self.assertIn("printable ASCII", result.stderr)

    def test_openai_mode_requires_its_own_key_and_model(self) -> None:
        web = self.values["web"].replace("CHAT_EXECUTION_MODE=dual_api", "CHAT_EXECUTION_MODE=openai_responses")
        result = self.run_validator({"web": web})
        self.assert_failed_without_secret(result)
        self.assertIn("OPENAI_API_KEY", result.stderr)

    def test_internal_tokens_must_match_their_service(self) -> None:
        result = self.run_validator({
            "rag": self.values["rag"].replace(
                "RagInternal_7pQ2mV9xR4tK8nC3sL6wF",
                "DifferentRagInternal_9mQ4xT7vK2pN8cL5sW3z",
            )
        })
        self.assert_failed_without_secret(result)
        self.assertIn("RAG_INTERNAL_TOKEN values must match", result.stderr)

    def test_internal_tokens_must_be_distinct(self) -> None:
        shared = "SharedInternalToken_8mQ4xT7vK2pN9cL5sW3z"
        web = self.values["web"].replace(
            "RagInternal_7pQ2mV9xR4tK8nC3sL6wF", shared
        ).replace("ContractInternal_5vN8qT2xM7kP4zC9rL6sW", shared)
        rag = self.values["rag"].replace(
            "RagInternal_7pQ2mV9xR4tK8nC3sL6wF", shared
        )
        contract = self.values["contract"].replace(
            "ContractInternal_5vN8qT2xM7kP4zC9rL6sW", shared
        )
        result = self.run_validator({"web": web, "rag": rag, "contract": contract})
        self.assert_failed_without_secret(result)
        self.assertIn("must be distinct", result.stderr)

    def test_web_rejects_negative_rag_timeout(self) -> None:
        result = self.run_validator({"web": self.values["web"] + "RAG_TIMEOUT_MS=-1\n"})
        self.assert_failed_without_secret(result)
        self.assertIn("RAG_TIMEOUT_MS must be an integer from 1000 through 60000", result.stderr)

    def test_rag_rejects_policy_disabling_distance(self) -> None:
        result = self.run_validator({
            "rag": self.values["rag"] + "RAG_DISTANCE_THRESHOLD=1000000\n"
        })
        self.assert_failed_without_secret(result)
        self.assertIn("must remain pinned to 0.42", result.stderr)


if __name__ == "__main__":
    unittest.main()
