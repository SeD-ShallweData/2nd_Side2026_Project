import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import retriever


def candidate(law, article_id, title, chapter="", distance=0.2):
    return (
        f"{article_id}({title}) 본문",
        {
            "law": law,
            "article_id": article_id,
            "title": title,
            "chapter": chapter,
        },
        distance,
    )


class RetrievalPolicyTest(unittest.TestCase):
    def test_expands_only_known_user_phrases(self):
        self.assertIn("구직급여 수급 요건", retriever._expand_query("실업급여 조건이 뭐예요?"))
        self.assertIn("해고의 예고", retriever._expand_query("사장이 다음 주까지만 나오래"))
        self.assertEqual(
            "사장이 내일부터 일찍 나오라고 했어요",
            retriever._expand_query("사장이 내일부터 일찍 나오라고 했어요"),
        )
        self.assertIn("서면 명시 교부", retriever._expand_query("근로계약서를 아직 못 받았어요"))
        self.assertIn("가산임금 지급", retriever._expand_query("포괄임금제면 야근수당을 못 받나요?"))
        self.assertIn("임금체불 진정 입증자료", retriever._expand_query("월급이 밀렸는데 어떤 자료를 준비할까요?"))

    def test_filters_special_worker_rules_until_the_query_mentions_them(self):
        candidates = [
            candidate("고용보험법", "제77조", "예술인인 피보험자", "제3장 예술인 특례"),
            candidate("고용보험법", "제40조", "구직급여의 수급 요건", "제4장 실업급여"),
        ]
        picked = retriever._pick(candidates, "실업급여 조건", 1)
        self.assertEqual("제40조", picked[0][1]["article_id"])

        picked_for_artist = retriever._pick(candidates, "예술인 실업급여 조건", 1)
        self.assertEqual("제77조", picked_for_artist[0][1]["article_id"])

    def test_trigger_for_one_special_group_does_not_open_all_special_rules(self):
        candidates = [
            candidate("고용보험법", "제77조", "예술인인 피보험자", "제3장 예술인 특례"),
            candidate("근로기준법", "제44조", "도급 사업에 대한 임금 지급", "제3장 임금"),
        ]
        picked = retriever._pick(candidates, "건설 하도급 임금", 1)
        self.assertEqual(("근로기준법", "제44조"), (picked[0][1]["law"], picked[0][1]["article_id"]))

    def test_deduplicates_article_numbers_per_law_not_globally(self):
        candidates = [
            candidate("근로기준법", "제8조", "차별적 처우의 금지"),
            candidate("남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률", "제8조", "임금"),
        ]
        picked = retriever._pick(candidates, "성별에 따른 임금 차별", 2)
        self.assertEqual(2, len(picked))

    def test_blocks_known_out_of_scope_topics_without_a_strong_match(self):
        self.assertEqual(
            "노동조합",
            retriever._out_of_scope_topic("노동조합을 만들고 싶어요", 0.41),
        )
        self.assertIsNone(retriever._out_of_scope_topic("노동조합과 관련된 임금 질문", 0.20))

    def test_filters_every_vector_candidate_by_the_distance_threshold(self):
        candidates = [
            candidate("근로기준법", "제17조", "근로조건의 명시", distance=0.20),
            candidate("근로기준법", "제56조", "연장ㆍ야간 및 휴일 근로", distance=0.43),
        ]
        eligible = retriever._within_distance_threshold(candidates)
        picked = retriever._pick(eligible, "근로계약서", 5)
        self.assertEqual(["제17조"], [item[1]["article_id"] for item in picked])

    def test_matches_curated_official_guides_only_on_reviewed_phrases(self):
        matches = retriever._guide_candidates("임금이 밀렸을 때 어떤 자료부터 준비해야 하나요?")
        self.assertIn("MOEL-WAGE-EVIDENCE", [item[1]["document_id"] for item in matches])
        evidence = next(item for item in matches if item[1]["document_id"] == "MOEL-WAGE-EVIDENCE")
        self.assertTrue(evidence[1]["suppress_vector_when_matched"])
        self.assertEqual([], retriever._guide_candidates("회사 자료를 어디에 저장할까요?"))
        self.assertEqual([], retriever._guide_candidates("해고에 관해 어떤 자료를 준비해야 하나요?"))


class RetrievalReadinessTest(unittest.TestCase):
    def setUp(self):
        retriever._reset_for_tests()

    def tearDown(self):
        retriever._reset_for_tests()

    @staticmethod
    def _ready_dependencies():
        model = Mock()
        model.get_sentence_embedding_dimension.return_value = 1024
        model.encode.return_value = [[0.0] * 1024]
        collection = Mock()
        collection.count.return_value = 583
        collection.query.return_value = {
            "ids": [["kis_a43"]],
            "documents": [["제43조(임금 지급) 임금은 매월 1회 이상 지급하여야 한다."]],
            "metadatas": [[{
                "law": "근로기준법",
                "article_id": "제43조",
            }]],
            "distances": [[0.000001]],
        }
        return model, collection

    def test_warmup_requires_hashes_exact_count_and_a_real_query(self):
        model, collection = self._ready_dependencies()
        with (
            patch.object(
                retriever,
                "verify_runtime_assets",
                return_value={"manifest_sha256": retriever.PINNED_ASSET_MANIFEST_SHA256},
            ) as verify_assets,
            patch.object(retriever, "_create_model", return_value=model),
            patch.object(retriever, "_open_collection", return_value=collection),
        ):
            health = retriever.warmup()

        self.assertTrue(health["ready"])
        self.assertTrue(health["asset_integrity"])
        self.assertTrue(health["query_compatible"])
        self.assertEqual(583, health["document_count"])
        self.assertEqual(1024, health["embedding_dimension"])
        verify_assets.assert_called_once_with(
            retriever.ASSET_MANIFEST,
            hf_home=retriever.HF_HOME,
            hub_cache=retriever.HF_HUB_CACHE,
            rag_db=retriever.DB_PATH,
            require_seal=True,
        )
        model.encode.assert_called_once_with(
            [retriever.ASSET_MANIFEST.collection.probe.query],
            normalize_embeddings=True,
        )
        collection.query.assert_called_once()
        query_call = collection.query.call_args.kwargs
        self.assertEqual(1, query_call["n_results"])
        self.assertEqual(1024, len(query_call["query_embeddings"][0]))

    def test_wrong_document_count_fails_before_query(self):
        model, collection = self._ready_dependencies()
        collection.count.return_value = 582
        with (
            patch.object(
                retriever,
                "verify_runtime_assets",
                return_value={"manifest_sha256": retriever.PINNED_ASSET_MANIFEST_SHA256},
            ),
            patch.object(retriever, "_create_model", return_value=model),
            patch.object(retriever, "_open_collection", return_value=collection),
        ):
            with self.assertRaisesRegex(retriever.RetrievalUnavailable, "expected 583, got 582"):
                retriever.warmup()

        model.encode.assert_not_called()
        self.assertFalse(retriever.status()["ready"])

    def test_embedding_dimension_mismatch_fails_closed(self):
        model, collection = self._ready_dependencies()
        model.get_sentence_embedding_dimension.return_value = 768
        with (
            patch.object(
                retriever,
                "verify_runtime_assets",
                return_value={"manifest_sha256": retriever.PINNED_ASSET_MANIFEST_SHA256},
            ),
            patch.object(retriever, "_create_model", return_value=model),
            patch.object(retriever, "_open_collection", return_value=collection),
        ):
            with self.assertRaisesRegex(retriever.RetrievalUnavailable, "dimension mismatch"):
                retriever.warmup()

        self.assertFalse(retriever.status()["query_compatible"])

    def test_empty_probe_result_never_becomes_ready(self):
        model, collection = self._ready_dependencies()
        collection.query.return_value["documents"] = [[]]
        with (
            patch.object(
                retriever,
                "verify_runtime_assets",
                return_value={"manifest_sha256": retriever.PINNED_ASSET_MANIFEST_SHA256},
            ),
            patch.object(retriever, "_create_model", return_value=model),
            patch.object(retriever, "_open_collection", return_value=collection),
        ):
            with self.assertRaisesRegex(retriever.RetrievalUnavailable, "no documents"):
                retriever.warmup()

        self.assertFalse(retriever.status()["ready"])

    def test_semantically_wrong_top_document_never_becomes_ready(self):
        model, collection = self._ready_dependencies()
        collection.query.return_value["ids"] = [["kis_a44"]]
        collection.query.return_value["metadatas"] = [[{
            "law": "근로기준법",
            "article_id": "제44조",
        }]]
        with (
            patch.object(
                retriever,
                "verify_runtime_assets",
                return_value={"manifest_sha256": retriever.PINNED_ASSET_MANIFEST_SHA256},
            ),
            patch.object(retriever, "_create_model", return_value=model),
            patch.object(retriever, "_open_collection", return_value=collection),
        ):
            with self.assertRaisesRegex(retriever.RetrievalUnavailable, "semantic probe id mismatch"):
                retriever.warmup()

        self.assertFalse(retriever.status()["ready"])

    def test_semantic_probe_distance_is_bounded(self):
        model, collection = self._ready_dependencies()
        collection.query.return_value["distances"] = [[0.01]]
        with (
            patch.object(
                retriever,
                "verify_runtime_assets",
                return_value={"manifest_sha256": retriever.PINNED_ASSET_MANIFEST_SHA256},
            ),
            patch.object(retriever, "_create_model", return_value=model),
            patch.object(retriever, "_open_collection", return_value=collection),
        ):
            with self.assertRaisesRegex(retriever.RetrievalUnavailable, "distance exceeded"):
                retriever.warmup()

        self.assertFalse(retriever.status()["ready"])

    def test_model_loader_is_revision_pinned_and_local_only(self):
        loader = Mock(return_value=object())
        fake_module = SimpleNamespace(SentenceTransformer=loader)
        with patch.dict("sys.modules", {"sentence_transformers": fake_module}):
            retriever._create_model()

        loader.assert_called_once_with(
            "BAAI/bge-m3",
            device=retriever.DEVICE,
            revision="5617a9f61b028005a4858fdac845db406aefb181",
            cache_folder=str(retriever.HF_HUB_CACHE),
            local_files_only=True,
            trust_remote_code=False,
            model_kwargs={"use_safetensors": False},
        )

    def test_distance_policy_cannot_be_disabled_by_environment_drift(self):
        with patch.object(retriever, "NO_MATCH_DISTANCE_THRESHOLD", 1_000_000.0):
            with self.assertRaisesRegex(
                retriever.RetrievalUnavailable,
                "RAG_DISTANCE_THRESHOLD must remain pinned to 0.42",
            ):
                retriever.warmup()

        with patch.object(retriever, "STRONG_MATCH_DISTANCE", float("nan")):
            with self.assertRaisesRegex(
                retriever.RetrievalUnavailable,
                "RAG_STRONG_MATCH_DISTANCE must remain pinned to 0.30",
            ):
                retriever.warmup()


if __name__ == "__main__":
    unittest.main()
