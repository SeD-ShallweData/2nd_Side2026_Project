"""
1-3. NO_MATCH_DISTANCE_THRESHOLD 재튜닝.

run_eval.py가 남긴 eval/results/eval_raw.json의 거리 분포를 보고,
positive(답해야 할 질문)와 negative(DB 범위 밖 질문)를 가장 잘 가르는 값을 찾는다.

게이트는 '틀린 답을 하느니 모른다고 하는 게 낫다'는 쪽이 안전하므로,
단순 정확도 말고 negative 차단을 더 무겁게 본 지표도 같이 낸다.

실행: cd webapp && python3 eval/tune_threshold.py
"""
import json
import sys
from pathlib import Path

RESULTS = Path(__file__).resolve().parent / "results" / "eval_raw.json"

# negative를 통과시키는 실수(= 근거 없는 답변)를 positive를 막는 실수보다
# 몇 배 무겁게 볼 것인지. 법률 상담 서비스라 오답이 더 위험하다고 보고 2배로 둔다.
FP_WEIGHT = 2.0


def sweep(pos_d, neg_d):
    """가능한 모든 임계값 후보를 훑어 지표를 계산한다."""
    cands = sorted({round(d, 4) for d in pos_d + neg_d})
    # 후보 사이 중간값도 넣어 경계에 딱 붙지 않게 한다.
    mids = [round((a + b) / 2, 4) for a, b in zip(cands, cands[1:])]
    rows = []
    for th in sorted(set(cands + mids)):
        tp = sum(1 for d in pos_d if d <= th)      # 답해야 할 질문을 통과시킴
        fn = len(pos_d) - tp                       # 답할 수 있는데 막음
        tn = sum(1 for d in neg_d if d > th)       # 범위 밖 질문을 막음
        fp = len(neg_d) - tn                       # 범위 밖인데 답하게 둠
        rows.append({
            "th": th, "tp": tp, "fn": fn, "tn": tn, "fp": fp,
            "recall": tp / len(pos_d),
            "specificity": tn / len(neg_d),
            "youden": tp / len(pos_d) + tn / len(neg_d) - 1,
            "weighted_err": fn + FP_WEIGHT * fp,
        })
    return rows


def histogram(label, values, lo=0.20, hi=0.60, step=0.025):
    print(f"  {label} (n={len(values)})")
    edge = lo
    while edge < hi:
        n = sum(1 for v in values if edge <= v < edge + step)
        if n:
            print(f"    {edge:.3f}~{edge + step:.3f} {'█' * n} {n}")
        edge += step
    out = [v for v in values if v >= hi]
    if out:
        print(f"    {hi:.3f} 이상   {'█' * len(out)} {len(out)}")


def main():
    if not RESULTS.is_file():
        print(f"[!] {RESULTS} 가 없습니다. 먼저 eval/run_eval.py 를 실행하세요.")
        return 1
    data = json.loads(RESULTS.read_text())
    cur_th = data["threshold_at_run"]

    pos = [r for r in data["positives"] if r["gate_distance"] is not None]
    neg = [r for r in data["negatives"] if r["gate_distance"] is not None]
    pos_d = [r["gate_distance"] for r in pos]
    neg_d = [r["gate_distance"] for r in neg]

    print("=" * 78)
    print("1-3. threshold 재튜닝")
    print("=" * 78)
    print(f"현재 값: {cur_th}\n")
    print(f"  positive 거리  min {min(pos_d):.3f} / 중앙 {sorted(pos_d)[len(pos_d) // 2]:.3f} "
          f"/ max {max(pos_d):.3f}")
    print(f"  negative 거리  min {min(neg_d):.3f} / 중앙 {sorted(neg_d)[len(neg_d) // 2]:.3f} "
          f"/ max {max(neg_d):.3f}")
    overlap_lo, overlap_hi = min(neg_d), max(pos_d)
    n_pos_ov = sum(1 for d in pos_d if d >= overlap_lo)
    n_neg_ov = sum(1 for d in neg_d if d <= overlap_hi)
    print(f"  겹치는 구간   {overlap_lo:.3f} ~ {overlap_hi:.3f} "
          f"(positive {n_pos_ov}개 / negative {n_neg_ov}개가 이 안에 있음)")
    print("     → 이 구간에 있는 문항은 거리 하나만으로는 절대 못 가른다.\n")

    print("■ 거리 분포")
    histogram("positive", pos_d)
    histogram("negative", neg_d)

    rows = sweep(pos_d, neg_d)
    best_youden = max(rows, key=lambda r: (r["youden"], -r["th"]))
    best_weighted = min(rows, key=lambda r: (r["weighted_err"], -r["th"]))

    print("\n■ 임계값별 성능 (주요 후보)")
    print(f"    {'th':>6} {'통과된 positive':>16} {'차단된 negative':>16} {'Youden J':>10} "
          f"{'가중오류':>8}")
    watch = sorted({cur_th, best_youden["th"], best_weighted["th"],
                    0.35, 0.38, 0.40, 0.42, 0.44, 0.47})
    for th in watch:
        r = min(rows, key=lambda x: abs(x["th"] - th))
        tag = ""
        if abs(r["th"] - cur_th) < 1e-9:
            tag = " ← 현재"
        if abs(r["th"] - best_youden["th"]) < 1e-9:
            tag += " ← Youden 최적"
        if abs(r["th"] - best_weighted["th"]) < 1e-9:
            tag += f" ← 가중오류 최소(FP×{FP_WEIGHT:g})"
        print(f"    {r['th']:>6.3f} {r['tp']:>7}/{len(pos_d):<8} {r['tn']:>7}/{len(neg_d):<8} "
              f"{r['youden']:>10.3f} {r['weighted_err']:>8.1f}{tag}")

    rec = best_weighted
    print("\n■ 권장값")
    print(f"    NO_MATCH_DISTANCE_THRESHOLD = {rec['th']:.2f}")
    print(f"    - 답해야 할 질문 {rec['tp']}/{len(pos_d)} 통과 "
          f"(놓침 {rec['fn']}개)")
    print(f"    - 범위 밖 질문 {rec['tn']}/{len(neg_d)} 차단 "
          f"(그냥 통과 {rec['fp']}개)")
    cur = min(rows, key=lambda x: abs(x["th"] - cur_th))
    print(f"    - 현재({cur_th}) 대비: 놓침 {cur['fn']}→{rec['fn']}, "
          f"오통과 {cur['fp']}→{rec['fp']}")

    print("\n■ 권장값에서 새로 막히는 positive (확인 필요)")
    for r in sorted(pos, key=lambda r: -r["gate_distance"]):
        if cur_th >= r["gate_distance"] > rec["th"]:
            print(f"    {r['gate_distance']:.3f}  {r['q']}")
            print(f"           → 검색 1순위: {r['got'][0] if r['got'] else '-'}")

    print("\n■ 권장값에서도 여전히 통과하는 negative (거리로는 못 거름)")
    for r in sorted(neg, key=lambda r: r["gate_distance"]):
        if r["gate_distance"] <= rec["th"]:
            print(f"    {r['gate_distance']:.3f}  {r['q']}  → {r['raw_top1']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
