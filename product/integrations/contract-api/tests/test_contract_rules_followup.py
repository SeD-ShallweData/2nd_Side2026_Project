from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.contract import rules, schema  # noqa: E402


def findings(raw: dict) -> dict[str, dict]:
    contract = schema.normalize(raw)
    if raw.get("clauses"):
        source = "\n".join(item["quote"] for item in raw["clauses"])
        contract, _ = schema.verify_quotes(contract, source)
    return {item["code"]: item for item in rules.evaluate(contract, year=2026)["findings"]}


class ContractRuleFollowupTest(unittest.TestCase):
    def test_eleven_month_waiver_requires_actual_service_check(self):
        raw = {
            "contract_type": "fixed_term", "term_start": "2026-01-01", "term_end": "2026-11-30",
            "hours": {"weekly_hours": 40}, "severance": {"provided": False},
            "clauses": [{"code": "severance_waived", "quote": "퇴직금은 지급하지 않는다."}],
        }
        result = findings(raw)["severance_waived"]
        self.assertEqual(result["level"], rules.CHECK)
        self.assertIn("계속근로", result["detail"])
        self.assertEqual(result["evidence"], "퇴직금은 지급하지 않는다.")

    def test_twelve_month_waiver_is_violation_when_hours_known(self):
        raw = {
            "contract_type": "fixed_term", "term_start": "2026-01-01", "term_end": "2026-12-31",
            "hours": {"weekly_hours": 40}, "severance": {"provided": False},
        }
        self.assertEqual(findings(raw)["severance_waived"]["level"], rules.VIOLATION)

    def test_twelve_month_waiver_without_hours_is_not_violation(self):
        raw = {
            "contract_type": "fixed_term", "term_start": "2026-01-01", "term_end": "2026-12-31",
            "severance": {"provided": False},
        }
        self.assertEqual(findings(raw)["severance_waived"]["level"], rules.CHECK)

    def test_short_weekly_hours_and_prepaid_severance_are_check(self):
        raw = {
            "contract_type": "fixed_term", "term_start": "2026-01-01", "term_end": "2026-12-31",
            "hours": {"weekly_hours": 14}, "severance": {"included_in_wage": True},
        }
        self.assertEqual(findings(raw)["severance_in_wage"]["level"], rules.CHECK)

    def test_permanent_contract_with_known_hours_keeps_waiver_violation(self):
        raw = {
            "contract_type": "permanent", "hours": {"weekly_hours": 40},
            "severance": {"provided": False},
        }
        self.assertEqual(findings(raw)["severance_waived"]["level"], rules.VIOLATION)

    def test_explicit_premium_waiver_is_scaled_by_headcount(self):
        quote = "연장근로 가산수당은 지급하지 않는다."
        for count, level in ((5, rules.VIOLATION), (4, rules.EXCLUDED), (None, rules.CHECK)):
            with self.subTest(headcount=count):
                raw = {"headcount": count, "clauses": [
                    {"code": "overtime_premium_waived", "quote": quote}
                ]}
                result = findings(raw)["overtime_premium_waived"]
                self.assertEqual(result["level"], level)
                self.assertEqual(result["law"], "근기법 제56조")

    def test_other_is_upgraded_only_with_verified_explicit_waiver(self):
        quote = "야간근로 수당은 지급하지 않는다."
        raw = {"headcount": 5, "clauses": [{"code": "other", "quote": quote}]}
        self.assertEqual(findings(raw)["overtime_premium_waived"]["level"], rules.VIOLATION)

    def test_paid_premium_is_not_flagged(self):
        quote = "연장근로 가산수당은 별도로 지급한다."
        raw = {"headcount": 5, "clauses": [
            {"code": "overtime_premium_waived", "quote": quote}
        ]}
        contract = schema.normalize(raw)
        verified, dropped = schema.verify_quotes(contract, quote)
        self.assertEqual(verified["clauses"], [])
        self.assertEqual(len(dropped), 1)

    def test_all_seven_written_does_not_mean_content_is_legal(self):
        raw = {"required_items": {key: True for key in schema.REQUIRED_ITEMS}}
        result = findings(raw)["required_items"]
        self.assertEqual(result["level"], rules.CHECK)
        self.assertIn("내용", result["message"])
        self.assertNotIn("missing_required", findings(raw))

    def test_missing_place_and_duty_depends_on_contract_type(self):
        raw = {"required_items": {"work_place_and_duty": False}}
        self.assertEqual(findings({**raw, "contract_type": "permanent"})["required_scope"]["level"], rules.CHECK)
        self.assertEqual(findings({**raw, "contract_type": "fixed_term"})["fixed_term_location_missing"]["level"], rules.VIOLATION)
        self.assertEqual(findings({**raw, "contract_type": "fixed_term"})["fixed_term_location_missing"]["law"], "기간제법 제17조")

    def test_unknown_is_not_treated_as_missing(self):
        result = findings({})
        self.assertEqual(result["required_unknown"]["level"], rules.CHECK)
        self.assertNotIn("missing_required", result)

    def test_annual_leave_missing_with_unknown_headcount_is_check(self):
        raw = {"required_items": {"annual_leave": False}}
        self.assertEqual(findings(raw)["required_scope"]["level"], rules.CHECK)
        self.assertNotIn("missing_required", findings(raw))
