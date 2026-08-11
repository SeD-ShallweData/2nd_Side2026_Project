"""근로계약서 진단.

    parse.py       Upstage Document Parse — PDF·사진·HWP → 마크다운
    schema.py      추출 스키마 · 모델 출력 정규화
    standards.py   법정 기준 상수와 조문 표 (단일 출처)
    rules.py       규칙 엔진 — 조항별 판정을 **코드로** 내립니다
    review.py      파싱 → 추출 → 판정 → 해설 오케스트레이션
    guard.py       계약서 전용 출력 가드레일

설계 원칙은 하나입니다. **판정은 코드가, 읽기와 쓰기는 모델이.**
자세한 근거는 docs/80-근로계약서-진단.md 와 docs/ADR/0003 을 보세요.
"""

from . import guard, parse, review, rules, schema, standards

__all__ = ["guard", "parse", "review", "rules", "schema", "standards"]
