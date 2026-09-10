#!/usr/bin/env python3
"""ML 제출물 CSV 자가 검증기.

계약: docs/mlops/ml-db-data-contract.md
규격: docs/mlops/self-check-spec.md   ← 항목 번호(F1·C3·V7·R4 …)는 이 문서 기준

사용법
    python3 self_check.py --outputs /path/to/outputs [--manifest manifest.json]

종료 코드
    0  오류 없음 (경고는 있을 수 있음)
    1  오류 1건 이상
    2  파일을 열지 못함 · 인자 오류
"""
import argparse
import csv
import json
import os
import sys
from collections import Counter, defaultdict

# ── 상수 ───────────────────────────────────────────────
# 큐 risk_full 은 소수 4자리로 반올림돼 있다. 등호 비교하면 98.9% 가 실패한다.
# 운영 DB 실측 최대 차이 0.0000500083, 6e-5 초과 0건.
RISK_FULL_TOLERANCE = 1e-4

# 전 배치 7회 예외 없이 동일했다.
QUEUE_QUOTA = {"긴급": 100, "우선": 400, "주의": 1000, "관찰": 1500}

# scored 의 risk_full 빈 칸 비율이 이보다 낮으면 fillna(0) 정황으로 본다.
# 과거 7배치 실측 8.6~9.2%.
NULL_RATIO_FLOOR = 0.01

# 구분자: 공백 + 가운뎃점(U+00B7) + 공백
SEPARATOR = " · "
REASONS_COUNT = 3

FILE_SCORED = "scored_active_full.csv"
FILE_QUEUE = "감독관_위험큐_full.csv"
FILE_SAFE = "safe_recommendation_full.csv"

KEY = ("사업장명", "사업자번호")

VERDICTS = {
    "안정신호", "유보", "유보_정보부족",
    "배제_임금체불공개", "배제_공개체납", "배제_4대보험체납(door1)",
}
PRIORITIES = set(QUEUE_QUOTA)

BOOL_TRUE_FALSE = {"0", "1", "0.0", "1.0", ""}
NULL_LITERALS = {"NaN", "nan", "NULL", "null", "None", "none", "#N/A", "NA"}

SCORED_COLUMNS = [
    "사업장명", "사업자번호", "시도",
    "업종", "n_months", "G1_고용안정",
    "G2_성실납부", "G3_인건비안정", "G4_인력유지",
    "G5_업력3년", "G6_낮은변동성", "n_green",
    "체불배제", "체납배제", "risk_full",
    "turnover_avg_12m", "turnover_avg_3m", "turnover_max_12m",
    "turnover_std_12m", "emp_change_3m", "emp_change_6m",
    "emp_change_12m", "salary_avg_12m", "salary_last",
    "salary_change_6m", "salary_change_12m", "replacement_avg_12m",
    "replacement_avg_3m", "replacement_min_12m", "salary_drop_consecutive",
    "turnover_momentum", "zero_emp_months", "emp_volatility",
    "log_emp_count", "firm_age_months", "sido_code",
    "industry_category", "imputed_months_count", "imputed_ratio",
    "has_missing_recent_3m", "nf_bill_last_ratio", "nf_bill_maxdrop",
    "nf_pc_slope", "nf_pay_divergence", "nf_bill_cv",
    "nf_emp_slope", "nf_drawdown", "door1_ever",
    "door1_n_insu", "door1_maxamt", "door1_maxmonths",
    "door1_health", "door1_pension", "door1_labor",
]

QUEUE_COLUMNS = [
    "순위", "위험등급", "사업장명",
    "사업자번호", "시도", "업종",
    "risk_full", "door1_체납이력", "이미_임금체불공개",
    "핵심_위험사유",
]

SAFE_COLUMNS = [
    "사업장명", "사업자번호", "시도",
    "업종", "n_months", "n_green",
    "risk_full", "체불배제", "체납배제",
    "door1_ever", "판정",
]


# 불리언으로 적재되는 컬럼 (계약 §3 규칙 2)
BOOL_COLUMNS = {
    FILE_SCORED: ["G1_고용안정", "G2_성실납부", "G3_인건비안정",
                  "G4_인력유지", "G5_업력3년", "G6_낮은변동성",
                  "체불배제", "체납배제"],
    FILE_QUEUE: ["door1_체납이력", "이미_임금체불공개"],
    FILE_SAFE: ["체불배제", "체납배제"],
}
# door1_ever 는 불리언처럼 보이나 ::real 캐스팅이다. 위 목록에 넣지 않는다.

SPEC = {
    FILE_SCORED: SCORED_COLUMNS,
    FILE_QUEUE: QUEUE_COLUMNS,
    FILE_SAFE: SAFE_COLUMNS,
}


# ── 보고 ───────────────────────────────────────────────
class Report:
    """오류·경고·미검사·통과를 모은다. 미검사를 통과로 세지 않는다."""

    MAX_SAMPLES = 5

    def __init__(self):
        self.errors = []
        self.warnings = []
        self.skipped = []
        self.passed = []
        self._seen = set()

    def error(self, code, msg):
        self.errors.append(f"[{code}] {msg}")
        self._seen.add(code)

    def warn(self, code, msg):
        self.warnings.append(f"[{code}] {msg}")
        self._seen.add(code)

    def skip(self, code, msg):
        self.skipped.append(f"[{code}] {msg}")
        self._seen.add(code)

    def ok(self, code):
        if code not in self._seen:
            self.passed.append(code)
            self._seen.add(code)

    @staticmethod
    def sample(items):
        """위반을 전부 나열하지 않는다. 앞 5건 + 총 건수."""
        head = ", ".join(str(x) for x in items[:Report.MAX_SAMPLES])
        more = f" 외 {len(items) - Report.MAX_SAMPLES}건" if len(items) > Report.MAX_SAMPLES else ""
        return head + more

    def render(self):
        out = []
        if self.errors:
            out.append(f"🔴 오류 {len(self.errors)}건")
            out += [f"  {e}" for e in self.errors]
            out.append("")
        if self.warnings:
            out.append(f"🟡 경고 {len(self.warnings)}건")
            out += [f"  {w}" for w in self.warnings]
            out.append("")
        if self.skipped:
            out.append(f"⚪ 검사하지 않음 {len(self.skipped)}건")
            out += [f"  {s}" for s in self.skipped]
            out.append("")
        out.append(f"✅ 통과 {len(self.passed)}건")
        return "\n".join(out)


def stream_csv(path):
    """헤더를 먼저 돌려주고 행을 하나씩 흘려보낸다.

    따옴표로 감싼 필드가 있으므로 반드시 csv 모듈을 쓴다 —
    industry_category 값에 쉼표가 들어 있어 split(',') 로는 컬럼이 밀린다.
    scored 가 55만 행이라 list() 로 받으면 메모리가 GB 단위로 뛴다."""
    with open(path, encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        yield header
        for row in reader:
            yield row


# ── F. 파일 수준 ───────────────────────────────────────
def check_files(outputs, rep):
    """F1 파일 존재 · F2 BOM · F3 헤더"""
    present = {}
    for name in (FILE_SCORED, FILE_QUEUE, FILE_SAFE):
        path = os.path.join(outputs, name)
        if os.path.isfile(path):
            present[name] = path
        else:
            rep.error("F1", f"파일 없음: {name} — 이름이 정확히 일치해야 합니다")
    if len(present) == 3:
        rep.ok("F1")

    # 비슷한 이름이 함께 있으면 잘못 복사한 정황
    try:
        strays = [f for f in os.listdir(outputs)
                  if f.endswith(".csv") and f not in (FILE_SCORED, FILE_QUEUE, FILE_SAFE)]
    except OSError:
        strays = []
    if strays:
        rep.warn("F1", f"계약에 없는 CSV 가 함께 있습니다: {Report.sample(strays)}")

    for name, path in present.items():
        with open(path, "rb") as fh:
            head = fh.read(3)
        if head == b"\xef\xbb\xbf":
            rep.error("F2", f"BOM 발견: {name} — UTF-8(BOM 없음)으로 저장하세요")
        try:
            with open(path, encoding="utf-8") as fh:
                fh.read(4096)
        except UnicodeDecodeError as exc:
            rep.error("F2", f"UTF-8 디코딩 실패: {name} — {exc}")
    rep.ok("F2")
    return present


# ── C. 컬럼 수준 ───────────────────────────────────────
def check_columns(name, header, rep):
    """C1 개수 · C2 이름 · C3 순서. 하나라도 어긋나면 값 검사를 건너뛴다."""
    spec = SPEC[name]
    if header is None:
        rep.error("F3", f"헤더 없음: {name} — 첫 줄이 컬럼명이어야 합니다")
        return False
    rep.ok("F3")

    if len(header) != len(spec):
        rep.error("C1", f"컬럼 수 불일치: {name} {len(header)}개 ({len(spec)}개여야 함)")
        return False
    rep.ok("C1")

    missing = [c for c in spec if c not in header]
    unknown = [c for c in header if c not in spec]
    if missing or unknown:
        rep.error("C2", f"컬럼 이름 불일치: {name} — 없음: {Report.sample(missing) or '(없음)'}"
                        f" / 모르는 컬럼: {Report.sample(unknown) or '(없음)'}")
        return False
    rep.ok("C2")

    for i, (got, want) in enumerate(zip(header, spec), start=1):
        if got != want:
            rep.error("C3", f"컬럼 순서 불일치: {name} {i}번째가 '{got}'인데 '{want}'이어야 합니다")
            return False
    rep.ok("C3")
    return True


# ── V. 값 수준 ─────────────────────────────────────────
def scan_file(name, header, rows, rep):
    """한 번만 순회하면서 값 검사와 관계 검사용 자료를 함께 모은다.

    반환: (keys, rf_map)
        keys    식별키 리스트 (중복 판정에 쓰므로 set 이 아니다)
        rf_map  식별키 → risk_full (빈 칸은 넣지 않음)
    """
    idx = {c: i for i, c in enumerate(header)}
    bool_idx = [(c, idx[c]) for c in BOOL_COLUMNS.get(name, [])]
    rf_i = idx.get("risk_full")
    ni, bi = idx["사업장명"], idx["사업자번호"]
    verdict_i = idx.get("판정")
    prio_i = idx.get("위험등급")
    reasons_i = idx.get("핵심_위험사유")
    rank_i = idx.get("순위")

    keys, rf_map = [], {}
    n_rows = 0
    blank_rf = 0
    bad_bool = defaultdict(Counter)      # 컬럼 → 값 → 건수
    bad_null = defaultdict(Counter)      # 컬럼 → 값 → 건수
    rf_out_of_range = []
    rf_not_number = None
    bad_verdict = Counter()
    prio_counts = Counter()
    bad_reasons, leftover_reasons = [], []
    ranks = []
    rank_bad = False
    bizno_lens = Counter()

    for lineno, r in enumerate(rows, start=2):
        n_rows += 1
        key = (r[ni], r[bi])
        keys.append(key)
        bizno_lens[len(r[bi])] += 1

        for col, i in bool_idx:
            v = r[i]
            if v not in BOOL_TRUE_FALSE:
                bad_bool[col][v] += 1

        for col, i in idx.items():
            v = r[i]
            if v in NULL_LITERALS:
                bad_null[col][v] += 1

        if rf_i is not None:
            v = r[rf_i]
            if v == "":
                blank_rf += 1
            else:
                try:
                    f = float(v)
                except ValueError:
                    if rf_not_number is None:
                        rf_not_number = (lineno, v)
                else:
                    rf_map[key] = f
                    if not (0.0 <= f <= 1.0):
                        rf_out_of_range.append(f"{v}({lineno}행)")

        if verdict_i is not None and r[verdict_i] not in VERDICTS:
            bad_verdict[r[verdict_i]] += 1

        if prio_i is not None:
            prio_counts[r[prio_i]] += 1

        if reasons_i is not None:
            parts = r[reasons_i].split(SEPARATOR)
            if len(parts) != REASONS_COUNT:
                bad_reasons.append(f"{lineno}행({len(parts)}개)")
            if any("·" in x for x in parts):
                leftover_reasons.append(f"{lineno}행")

        if rank_i is not None:
            try:
                ranks.append(int(r[rank_i]))
            except ValueError:
                rank_bad = True

    # ── 집계 결과를 판정으로 옮긴다 ──
    for col, counts in bad_bool.items():
        kinds = ", ".join(f"'{v}'({n}건)" for v, n in counts.most_common(3))
        rep.error("V1", f"불리언 표기 오류: {name} {col} 에 {kinds}"
                        f" — 0/1 로 저장하세요 (pandas: astype(int))")
    rep.ok("V1")

    for col, counts in bad_null.items():
        kinds = ", ".join(f"'{v}'({n}건)" for v, n in counts.most_common(3))
        rep.error("V2", f"결측 표기 오류: {name} {col} 에 {kinds}"
                        f" — 빈 칸으로 저장하세요 (fillna 금지)")
    rep.ok("V2")

    if name == FILE_SCORED and n_rows:
        ratio = blank_rf / n_rows
        if ratio < NULL_RATIO_FLOOR:
            rep.warn("V3", f"risk_full 빈 칸이 {ratio*100:.2f}% 입니다"
                           f" — 과거 7배치는 8.6~9.2% 였습니다. fillna(0) 여부를 확인하세요")
        else:
            rep.ok("V3")

    if rf_i is not None:
        if rf_not_number:
            rep.error("V6", f"risk_full 이 숫자가 아닙니다: {name} {rf_not_number[0]}행 '{rf_not_number[1]}'")
        elif rf_out_of_range:
            rep.warn("V6", f"risk_full 범위 밖: {name} {Report.sample(rf_out_of_range)} — 0~1 이어야 합니다")
        else:
            rep.ok("V6")

    if verdict_i is not None:
        if bad_verdict:
            kinds = ", ".join(f"'{v}'({n}건)" for v, n in bad_verdict.most_common(3))
            rep.error("V4", f"알 수 없는 판정값: {kinds} — 허용 6종과 한 글자도 달라선 안 됩니다")
        else:
            rep.ok("V4")

    if prio_i is not None:
        unknown = {v: n for v, n in prio_counts.items() if v not in PRIORITIES}
        if unknown:
            kinds = ", ".join(f"'{v}'({n}건)" for v, n in unknown.items())
            rep.error("V5", f"알 수 없는 위험등급: {kinds}")
        else:
            rep.ok("V5")
        actual = {k: prio_counts.get(k, 0) for k in QUEUE_QUOTA}
        if actual != QUEUE_QUOTA:
            diff = ", ".join(f"{k} {actual[k]}(기대 {QUEUE_QUOTA[k]})"
                             for k in QUEUE_QUOTA if actual[k] != QUEUE_QUOTA[k])
            rep.warn("V5-1", f"위험등급 개수가 다릅니다: {diff} — 과거 7배치는 모두 동일했습니다")
        else:
            rep.ok("V5-1")

    if reasons_i is not None:
        if bad_reasons:
            rep.error("V7", f"위험사유 구분자 오류: {Report.sample(bad_reasons)}"
                            f" — 구분자는 ' · '(공백+U+00B7+공백)이고 원소는 {REASONS_COUNT}개입니다")
        if leftover_reasons:
            rep.error("V7", f"위험사유 원소에 가운뎃점이 남아 있습니다: {Report.sample(leftover_reasons)}")
        if not bad_reasons and not leftover_reasons:
            rep.ok("V7")

    if rank_i is not None:
        if rank_bad:
            rep.error("V8", "순위에 정수가 아닌 값이 있습니다")
        else:
            ranks.sort()
            want = list(range(1, len(ranks) + 1))
            if ranks != want:
                dup = [v for v, n in Counter(ranks).items() if n > 1]
                miss = sorted(set(want) - set(ranks))
                msgs = []
                if dup:
                    msgs.append(f"중복 {Report.sample(dup)}")
                if miss:
                    msgs.append(f"결번 {Report.sample(miss)}")
                rep.error("V8", "순위가 1..N 연속이 아닙니다: " + " / ".join(msgs))
            else:
                rep.ok("V8")

    # V9 사업자번호 — 앞자리 0 보존은 원리상 검사 불가. 길이 일관성만 본다.
    if len(bizno_lens) > 1:
        detail = " · ".join(f"{k}자리 {v}건" for k, v in sorted(bizno_lens.items()))
        rep.warn("V9", f"{name} 사업자번호 길이가 섞여 있습니다: {detail} — 앞자리 0 유실 가능성")

    return keys, rf_map


# ── R. 관계 수준 ───────────────────────────────────────
def check_relations(collected, rep):
    """R1 safe ⊆ scored · R2 queue ⊆ safe ⊆ scored · R3 중복 · R4 risk_full 일치

    collected: 파일명 → (keys, rf_map). 원본 행은 이미 버렸다.
    """
    if not all(f in collected for f in (FILE_SCORED, FILE_QUEUE, FILE_SAFE)):
        rep.skip("R1", "세 파일이 모두 유효하지 않아 관계 검사를 건너뜁니다")
        return

    sk, s_rf = collected[FILE_SCORED]
    qk, q_rf = collected[FILE_QUEUE]
    ak, a_rf = collected[FILE_SAFE]
    sset, qset, aset = set(sk), set(qk), set(ak)

    # R3 scored 내 식별키 중복
    if len(sk) != len(sset):
        dup = [k for k, n in Counter(sk).items() if n > 1]
        rep.error("R3", f"scored 에 중복 사업장 {len(dup)}건 — {Report.sample(dup)}")
    else:
        rep.ok("R3")

    # R1 safe ⊆ scored
    orphan = aset - sset
    if orphan:
        rep.error("R1", f"safe 에 있으나 scored 에 없는 사업장 {len(orphan)}건"
                        f" — {Report.sample(sorted(orphan))}")
    else:
        rep.ok("R1")

    # R2 queue ⊆ safe ⊆ scored
    q_not_s = qset - sset
    q_not_a = qset - aset
    if q_not_s:
        rep.error("R2", f"queue 에 있으나 scored 에 없는 사업장 {len(q_not_s)}건"
                        f" — {Report.sample(sorted(q_not_s))}")
    if q_not_a:
        rep.error("R2", f"queue 에 있으나 safe 에 없는 사업장 {len(q_not_a)}건"
                        f" — {Report.sample(sorted(q_not_a))}")
    if not q_not_s and not q_not_a:
        rep.ok("R2")

    # R4 risk_full 일치 — 등호가 아니라 허용오차로 본다.
    # 큐 값은 소수 4자리로 반올림돼 있어 등호로 재면 98.9% 가 실패한다.
    bad = []
    for label, other in (("safe", a_rf), ("queue", q_rf)):
        for k, v in other.items():
            base = s_rf.get(k)
            if base is not None and abs(v - base) > RISK_FULL_TOLERANCE:
                bad.append(f"{k[0]}/{k[1]} {label} {v} vs scored {base}")
    if bad:
        rep.error("R4", f"risk_full 불일치 {len(bad)}건 (허용오차 {RISK_FULL_TOLERANCE})"
                        f" — {Report.sample(bad)}")
    else:
        rep.ok("R4")


# ── M. 메타데이터 ──────────────────────────────────────
def check_manifest(path, row_counts, rep):
    if not path or not os.path.isfile(path):
        rep.warn("M0", "manifest.json 없음 — M1~M3 을 검사하지 않았습니다")
        rep.skip("M2", "as_of 가 관측창 종료월인지 — 파일 밖 정보라 판정 불가")
        return
    rep.ok("M0")
    try:
        man = json.load(open(path, encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        rep.error("M0", f"manifest.json 을 읽지 못했습니다: {exc}")
        return

    if not str(man.get("model_version", "")).strip():
        rep.warn("M1", "manifest 에 model_version 이 없습니다")
    else:
        rep.ok("M1")

    as_of = str(man.get("as_of", ""))
    if len(as_of) != 7 or as_of[4] != "-" or not (as_of[:4] + as_of[5:]).isdigit():
        rep.warn("M2", f"as_of 형식이 YYYY-MM 이 아닙니다: '{as_of}'")
    else:
        rep.ok("M2")
    rep.skip("M2", "as_of 가 실제로 관측창 종료월인지 — 파일 밖 정보라 판정 불가")

    expect = man.get("expect_rows") or {}
    if not expect:
        rep.warn("M3", "manifest 에 expect_rows 가 없습니다")
        return
    mismatch = []
    for name, key in ((FILE_SCORED, "scored"), (FILE_QUEUE, "queue"), (FILE_SAFE, "safe")):
        if key in expect and name in row_counts:
            actual = row_counts[name]
            if int(expect[key]) != actual:
                mismatch.append(f"{key} manifest {expect[key]} vs 실제 {actual}")
    if mismatch:
        rep.error("M3", "행수 불일치: " + " / ".join(mismatch))
    else:
        rep.ok("M3")


# ── main ───────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="ML 제출물 CSV 자가 검증기")
    ap.add_argument("--outputs", required=True, help="CSV 3개가 있는 디렉터리")
    ap.add_argument("--manifest", default=None, help="manifest.json 경로 (없으면 --outputs 안에서 찾음)")
    args = ap.parse_args()

    if not os.path.isdir(args.outputs):
        print(f"디렉터리가 없습니다: {args.outputs}", file=sys.stderr)
        return 2

    rep = Report()
    present = check_files(args.outputs, rep)

    collected = {}
    row_counts = {}
    for name, path in present.items():
        try:
            stream = stream_csv(path)
            header = next(stream)
            if check_columns(name, header, rep):
                keys, rf_map = scan_file(name, header, stream, rep)
                collected[name] = (keys, rf_map)
                row_counts[name] = len(keys)
        except (OSError, UnicodeDecodeError, csv.Error) as exc:
            rep.error("F2", f"{name} 을 읽지 못했습니다: {exc}")

    check_relations(collected, rep)

    manifest = args.manifest or os.path.join(args.outputs, "manifest.json")
    check_manifest(manifest if os.path.isfile(manifest) else None, row_counts, rep)

    # 원리상 검사할 수 없는 항목 — 통과로 세지 않는다
    rep.skip("V9", "사업자번호 앞자리 0 보존 — CSV만으로 판정 불가 (길이 일관성만 확인)")
    rep.skip("V10", "sido_code·industry_category 문자열 여부 — CSV에 타입 정보 없음")

    print("자가 검증 결과")
    print(f"대상: {args.outputs}")
    print()
    print(rep.render())
    print()
    code = 1 if rep.errors else 0
    print(f"종료 코드 {code}")
    return code


if __name__ == "__main__":
    sys.exit(main())
