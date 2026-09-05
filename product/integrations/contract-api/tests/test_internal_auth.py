import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import main  # noqa: E402


class InternalAuthenticationTest(unittest.TestCase):
    def setUp(self):
        self.client = main.app.test_client()

    def test_non_health_routes_fail_closed_without_the_service_token(self):
        with patch.dict(os.environ, {}, clear=True):
            response = self.client.get("/api/personas")

        self.assertEqual(401, response.status_code)
        self.assertEqual("Bearer", response.headers["WWW-Authenticate"])

    def test_wrong_token_is_rejected_and_exact_token_is_accepted(self):
        token = "ContractInternal_5vN8qT2xM7kP4zC9rL6sW"
        with patch.dict(os.environ, {"CONTRACT_INTERNAL_TOKEN": token}, clear=True):
            wrong = self.client.get(
                "/api/personas",
                headers={"Authorization": "Bearer wrong"},
            )
            accepted = self.client.get(
                "/api/personas",
                headers={"Authorization": f"Bearer {token}"},
            )

        self.assertEqual(401, wrong.status_code)
        self.assertEqual(200, accepted.status_code)

    def test_health_requires_the_same_internal_bearer(self):
        token = "ContractInternal_5vN8qT2xM7kP4zC9rL6sW"
        with patch.dict(os.environ, {}, clear=True):
            missing = self.client.get("/api/health")
        with patch.dict(os.environ, {"CONTRACT_INTERNAL_TOKEN": token}, clear=True):
            response = self.client.get(
                "/api/health", headers={"Authorization": f"Bearer {token}"}
            )

        self.assertEqual(401, missing.status_code)
        self.assertEqual(200, response.status_code)
        payload = response.get_json()
        self.assertTrue(payload["asset_integrity"])
        self.assertEqual(
            main.asset_integrity.PINNED_MANIFEST_SHA256,
            payload["asset_manifest_sha256"],
        )

    def test_asset_drift_makes_health_and_authenticated_routes_unavailable(self):
        token = "ContractInternal_5vN8qT2xM7kP4zC9rL6sW"
        with patch.object(
            main.asset_integrity,
            "DEFAULT_MANIFEST",
            Path("/definitely/missing/contract-assets.json"),
        ), patch.dict(os.environ, {"CONTRACT_INTERNAL_TOKEN": token}, clear=True):
            health = self.client.get(
                "/api/health",
                headers={"Authorization": f"Bearer {token}"},
            )
            personas = self.client.get(
                "/api/personas",
                headers={"Authorization": f"Bearer {token}"},
            )

        self.assertEqual(503, health.status_code)
        self.assertFalse(health.get_json()["asset_integrity"])
        self.assertEqual(503, personas.status_code)


if __name__ == "__main__":
    unittest.main()
