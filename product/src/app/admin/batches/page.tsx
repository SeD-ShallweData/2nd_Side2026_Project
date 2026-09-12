"use client";

import { useEffect, useState } from "react";

// --- 타입 정의 ---
type DriftStatus = "정상" | "불일치";

interface DriftSummary {
  status: DriftStatus;
  errorCount: number;
  warningCount: number;
  notCheckableCount: number;
}

interface WageGradeDistribution {
  normal: number;
  watch: number;
  review: number;
  unknown: number;
}

interface SafetyBandDistribution {
  top1: number;
  top5: number;
  top10: number;
  general: number;
}

interface BatchStatusBase {
  asOf: string;
  targetPeriod: string;
  isTargetStale: boolean;
  rowCount: number;
  validUntil: string | null;
  drift: DriftSummary;
}

interface WageBatch extends BatchStatusBase {
  distribution: WageGradeDistribution;
}

interface SafetyBatch extends BatchStatusBase {
  distribution: SafetyBandDistribution;
}

// --- 공통 컴포넌트 (순수 인라인 스타일) ---
function DriftBadge({ drift }: { drift: DriftSummary }) {
  const isOk = drift.status === "정상";
  return (
    <span style={{
      padding: '4px 8px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 'bold',
      backgroundColor: isOk ? '#dcfce7' : '#fee2e2',
      color: isOk ? '#15803d' : '#b91c1c'
    }}>
      {isOk ? "정상" : `불일치 ${drift.errorCount}건`}
    </span>
  );
}

function DriftDetail({ drift }: { drift: DriftSummary }) {
  return (
    <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: '12px', marginTop: '12px', fontSize: '0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#6b7280', marginBottom: '8px' }}>
        <span>드리프트 검사 (25항목)</span>
        <DriftBadge drift={drift} />
      </div>
      <div style={{ backgroundColor: '#f9fafb', padding: '12px', borderRadius: '4px', border: '1px solid #f3f4f6', display: 'flex', gap: '16px', color: '#6b7280' }}>
        <span>🟡 경고 {drift.warningCount}건</span>
        <span>⚪ 검사 불가 {drift.notCheckableCount}건 (통과로 세지 않음)</span>
      </div>
    </div>
  );
}

function ValidUntilValue({ validUntil }: { validUntil: string | null }) {
  if (!validUntil) return <span style={{ fontWeight: '500', color: '#d97706' }}>갱신 확인 필요</span>;
  return <span style={{ fontWeight: '500', color: '#2563eb' }}>{validUntil} (다음 배치 예정)</span>;
}

function GradeBar({ label, pct, barColor, textColor, note }: { label: string; pct: number; barColor: string; textColor: string; note?: string; }) {
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem', marginBottom: '4px' }}>
        <span style={{ fontWeight: '500', color: textColor }}>
          {label} {note && <span style={{ fontSize: '0.75rem', color: '#9ca3af', marginLeft: '4px' }}>({note})</span>}
        </span>
        <span style={{ color: '#4b5563' }}>{pct.toFixed(2)}%</span>
      </div>
      <div style={{ width: '100%', backgroundColor: '#e5e7eb', borderRadius: '9999px', height: '8px' }}>
        <div style={{ width: `${pct}%`, backgroundColor: barColor, borderRadius: '9999px', height: '8px' }} />
      </div>
    </div>
  );
}

// --- 임금체불 카드 ---
function WageBatchCard({ batch }: { batch: WageBatch }) {
  const total = batch.distribution.normal + batch.distribution.watch + batch.distribution.review + batch.distribution.unknown;
  const pct = (n: number) => (total ? (n / total) * 100 : 0);

  return (
    <div style={{ backgroundColor: '#ffffff', padding: '24px', borderRadius: '8px', border: '1px solid #e5e7eb', boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '1.125rem', fontWeight: '600', margin: 0, color: '#374151' }}>임금체불 배치</h2>
        <DriftBadge drift={batch.drift} />
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px 0', display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.875rem' }}>
        <li style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>기준일 (as_of)</span><span style={{ fontWeight: '500' }}>{batch.asOf}</span></li>
        <li style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>예측 대상 (target_month)</span><span style={{ fontWeight: '500' }}>{batch.targetPeriod}</span></li>
        <li style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>적재 행수</span><span style={{ fontWeight: '500' }}>{batch.rowCount.toLocaleString()}곳</span></li>
        <li style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>유효기간 (valid_until)</span><ValidUntilValue validUntil={batch.validUntil} /></li>
      </ul>
      <div>
        <GradeBar label="Normal" note="뚜렷한 이상 신호 없음" pct={pct(batch.distribution.normal)} barColor="#22c55e" textColor="#16a34a" />
        <GradeBar label="Watch" note="안전 신호 미확인 — 회색 고정" pct={pct(batch.distribution.watch)} barColor="#9ca3af" textColor="#6b7280" />
        <GradeBar label="Review" note="우선 확인 필요, 누락 금지" pct={pct(batch.distribution.review)} barColor="#ef4444" textColor="#dc2626" />
        <GradeBar label="Unknown" note="분석 자료 부족" pct={pct(batch.distribution.unknown)} barColor="#facc15" textColor="#ca8a04" />
      </div>
      <DriftDetail drift={batch.drift} />
    </div>
  );
}

// --- 산업재해 카드 ---
function SafetyBatchCard({ batch }: { batch: SafetyBatch }) {
  const total = batch.distribution.top1 + batch.distribution.top5 + batch.distribution.top10 + batch.distribution.general;
  const pct = (n: number) => (total ? (n / total) * 100 : 0);

  return (
    <div style={{ backgroundColor: '#ffffff', padding: '24px', borderRadius: '8px', border: '1px solid #e5e7eb', boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '1.125rem', fontWeight: '600', margin: 0, color: '#374151' }}>산업재해 배치</h2>
        <DriftBadge drift={batch.drift} />
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px 0', display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.875rem' }}>
        <li style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>기준일 (as_of)</span><span style={{ fontWeight: '500' }}>{batch.asOf}</span></li>
        <li style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#6b7280' }}>예측 대상 (target_week)</span>
          <span style={{ fontWeight: '500' }}>{batch.targetPeriod}{batch.isTargetStale && <span style={{ color: '#d97706', fontSize: '0.75rem', marginLeft: '4px' }}>(기간 지남)</span>}</span>
        </li>
        <li style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>적재 행수</span><span style={{ fontWeight: '500' }}>{batch.rowCount.toLocaleString()}곳</span></li>
        <li style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>유효기간 (valid_until)</span><ValidUntilValue validUntil={batch.validUntil} /></li>
      </ul>
      <p style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: '12px', marginTop: 0 }}>밴드 기준은 전국 전체입니다. 지역·업종으로 필터링해도 재계산되지 않습니다.</p>
      <div>
        <GradeBar label="상위 1%" pct={pct(batch.distribution.top1)} barColor="#b91c1c" textColor="#b91c1c" />
        <GradeBar label="상위 5%" note="1~5% 구간" pct={pct(batch.distribution.top5)} barColor="#ef4444" textColor="#dc2626" />
        <GradeBar label="상위 10%" note="5~10% 구간" pct={pct(batch.distribution.top10)} barColor="#fca5a5" textColor="#ef4444" />
        <GradeBar label="일반" pct={pct(batch.distribution.general)} barColor="#9ca3af" textColor="#6b7280" />
      </div>
      <DriftDetail drift={batch.drift} />
    </div>
  );
}

// --- 메인 페이지 ---
export default function MLBatchDashboard() {
  const [wageBatch, setWageBatch] = useState<WageBatch | null>(null);
  const [safetyBatch, setSafetyBatch] = useState<SafetyBatch | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 우리가 방금 만든 로컬 가짜 데이터 API 호출
    fetch("/api/admin/batches")
      .then((r) => r.json())
      .then((data) => {
        setWageBatch(data.wage);
        setSafetyBatch(data.safety);
      })
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: '24px', maxWidth: '1024px', margin: '0 auto', backgroundColor: '#f9fafb', minHeight: '100vh', fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '24px', color: '#1f2937' }}>📊 ML 배치 현황</h1>
      {loading ? (
        <p style={{ color: '#6b7280' }}>데이터를 불러오는 중…</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '24px' }}>
            {wageBatch && <WageBatchCard batch={wageBatch} />}
            {safetyBatch && <SafetyBatchCard batch={safetyBatch} />}
          </div>
          <p style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '16px', textAlign: 'center' }}>
            두 배치는 분모·시간 단위·등급 체계가 달라 항상 별도 카드로 표시하고 합산하지 않습니다.
          </p>
        </>
      )}
    </div>
  );
}