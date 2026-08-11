import unittest

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


if __name__ == "__main__":
    unittest.main()
