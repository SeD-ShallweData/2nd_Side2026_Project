"use client";

import { useState } from "react";

/*
 * 운영 관리자용 모델 운영 패널.
 *
 * 세 가지를 다룬다 — 등급 임계값, 재학습, 배치 승인.
 *
 * 지금은 화면 안에서만 상태가 바뀐다. 실제로 임계값을 저장하거나 학습을
 * 돌리려면 ML 파이프라인 쪽에 받는 자리가 있어야 하고, 그 계약은
 * docs/mlops/ml-db-data-contract.md 를 고쳐야 정해진다. 화면을 먼저 만들어
 * 무엇을 주고받을지 눈으로 합의하려는 것이다.
 *
 * 그래서 누르면 결과가 보이되, 서버에 가지 않는다는 사실을 화면에 적는다.
 */

type RunState =
  | { status: "idle" }
  | { status: "queued"; queuedAt: string }
  | { status: "running"; queuedAt: string };

const GRADE_LABELS = ["우선 확인", "확인 권장", "관찰", "해당 없음"] as const;

export function MlOperationsPanel({ batchLabel }: { batchLabel: string }) {
  const [cuts, setCuts] = useState([3000, 12000, 40000]);
  const [appliedCuts, setAppliedCuts] = useState([3000, 12000, 40000]);
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const [approved, setApproved] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const cutsDirty = cuts.some((value, index) => value !== appliedCuts[index]);

  function note(message: string) {
    const at = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setLog((prev) => [`${at}  ${message}`, ...prev].slice(0, 6));
  }

  return (
    <section className="ml-ops-panel" aria-label="모델 운영">
      <header className="ml-ops-head">
        <div>
          <span className="eyebrow">운영 관리자</span>
          <h2>모델 운영</h2>
        </div>
      </header>

      <div className="ml-ops-grid">
        <article className="ml-ops-card">
          <h3>등급 임계값</h3>
          <p>모델 원점수 내림차순으로 몇 번째까지를 각 등급으로 볼지 정합니다.</p>
          <dl className="ml-ops-cuts">
            {GRADE_LABELS.slice(0, 3).map((label, index) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <span aria-hidden="true">상위</span>
                  <input
                    type="number"
                    min={100}
                    step={100}
                    value={cuts[index]}
                    aria-label={`${label} 등급 상한 순위`}
                    onChange={(event) => {
                      const next = [...cuts];
                      next[index] = Number(event.target.value);
                      setCuts(next);
                    }}
                  />
                  <span aria-hidden="true">위</span>
                </dd>
              </div>
            ))}
          </dl>
          <div className="ml-ops-actions">
            <button
              type="button"
              className="button button-dark button-small"
              disabled={!cutsDirty}
              onClick={() => {
                setAppliedCuts(cuts);
                note(`임계값 적용 — 상위 ${cuts.join(" / ")}위`);
              }}
            >
              적용
            </button>
            <button
              type="button"
              className="button button-outline button-small"
              disabled={!cutsDirty}
              onClick={() => setCuts(appliedCuts)}
            >
              되돌리기
            </button>
          </div>
        </article>

        <article className="ml-ops-card">
          <h3>재학습</h3>
          <p>새 월 데이터로 모델을 다시 학습시킵니다. 학습이 끝나면 새 배치가 만들어집니다.</p>
          <p className="ml-ops-state">
            {run.status === "idle" ? "대기 중인 학습이 없습니다." : null}
            {run.status === "queued" ? `${run.queuedAt} 대기열 등록됨` : null}
            {run.status === "running" ? `${run.queuedAt} 시작 — 진행 중` : null}
          </p>
          <div className="ml-ops-actions">
            <button
              type="button"
              className="button button-dark button-small"
              disabled={run.status !== "idle"}
              onClick={() => {
                const at = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
                setRun({ status: "queued", queuedAt: at });
                note("재학습 대기열 등록");
                window.setTimeout(() => setRun({ status: "running", queuedAt: at }), 1_200);
              }}
            >
              재학습 실행
            </button>
            <button
              type="button"
              className="button button-outline button-small"
              disabled={run.status === "idle"}
              onClick={() => {
                setRun({ status: "idle" });
                note("재학습 취소");
              }}
            >
              취소
            </button>
          </div>
        </article>

        <article className="ml-ops-card">
          <h3>배치 승인</h3>
          <p>학습 결과를 화면에 내보낼지 결정합니다. 승인 전에는 이전 배치가 그대로 쓰입니다.</p>
          <p className="ml-ops-state">
            대상 배치 <strong>{batchLabel}</strong>
            <br />
            {approved ? "승인됨 — 서비스 화면에 반영" : "승인 대기"}
          </p>
          <div className="ml-ops-actions">
            <button
              type="button"
              className="button button-dark button-small"
              disabled={approved}
              onClick={() => {
                setApproved(true);
                note(`배치 승인 — ${batchLabel}`);
              }}
            >
              승인
            </button>
            <button
              type="button"
              className="button button-outline button-small"
              disabled={!approved}
              onClick={() => {
                setApproved(false);
                note(`배치 승인 취소 — ${batchLabel}`);
              }}
            >
              승인 취소
            </button>
          </div>
        </article>
      </div>

      {log.length > 0 ? (
        <ol className="ml-ops-log" aria-label="최근 조작 기록">
          {log.map((line) => <li key={line}>{line}</li>)}
        </ol>
      ) : null}
    </section>
  );
}
