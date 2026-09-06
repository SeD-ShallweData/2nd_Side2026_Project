import os
import unittest
from unittest.mock import patch

import app


class HealthTest(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def test_health_is_503_until_the_full_readiness_contract_passes(self):
        token = "RagInternal_7pQ2mV9xR4tK8nC3sL6wF"
        with patch.dict(os.environ, {"RAG_INTERNAL_TOKEN": token}, clear=True), patch.object(app.retriever, "status", return_value={
            "ready": False,
            "document_count": 583,
            "expected_document_count": 583,
            "embedding_dimension": 1024,
            "query_compatible": False,
        }):
            response = self.client.get(
                "/api/health", headers={"Authorization": f"Bearer {token}"}
            )

        self.assertEqual(503, response.status_code)
        self.assertFalse(response.get_json()["ok"])

    def test_health_is_200_only_after_real_query_compatibility(self):
        token = "RagInternal_7pQ2mV9xR4tK8nC3sL6wF"
        with patch.dict(os.environ, {"RAG_INTERNAL_TOKEN": token}, clear=True), patch.object(app.retriever, "status", return_value={
            "ready": True,
            "document_count": 583,
            "expected_document_count": 583,
            "embedding_dimension": 1024,
            "query_compatible": True,
        }):
            response = self.client.get(
                "/api/health", headers={"Authorization": f"Bearer {token}"}
            )

        self.assertEqual(200, response.status_code)
        self.assertTrue(response.get_json()["ok"])

    def test_retrieve_rejects_missing_internal_bearer_without_querying(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(
            app.retriever, "retrieve"
        ) as retrieve:
            response = self.client.post("/api/retrieve", json={"query": "임금 지급일"})

        self.assertEqual(401, response.status_code)
        self.assertEqual("Bearer", response.headers["WWW-Authenticate"])
        retrieve.assert_not_called()

    def test_health_also_requires_the_internal_bearer(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(
            app.retriever, "status"
        ) as status:
            response = self.client.get("/api/health")

        self.assertEqual(401, response.status_code)
        status.assert_not_called()

    def test_retrieve_accepts_only_the_configured_internal_bearer(self):
        token = "RagInternal_7pQ2mV9xR4tK8nC3sL6wF"
        result = {"status": "no_match", "query": "질문", "items": []}
        with patch.dict(os.environ, {"RAG_INTERNAL_TOKEN": token}, clear=True), patch.object(
            app.retriever, "retrieve", return_value=result
        ) as retrieve:
            wrong = self.client.post(
                "/api/retrieve",
                json={"query": "질문"},
                headers={"Authorization": "Bearer wrong"},
            )
            accepted = self.client.post(
                "/api/retrieve",
                json={"query": "질문"},
                headers={"Authorization": f"Bearer {token}"},
            )

        self.assertEqual(401, wrong.status_code)
        self.assertEqual(200, accepted.status_code)
        retrieve.assert_called_once_with("질문", 5)


if __name__ == "__main__":
    unittest.main()
