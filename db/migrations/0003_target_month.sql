-- 예측 대상월(target_month) 추가 + 기저율 경고 수치 정정.
--
-- 모델의 시간 구조:
--   [t-18 ── 관측창 13개월 ── t-6] ·· 공백 6개월 ·· t(명단공개)
--   as_of_date   = t-6 = 마지막으로 본 국민연금 데이터의 달
--   target_month = t   = as_of_date + 6개월
--
-- 둘 다 기록해야 화면에 "○년 ○월 데이터 기준 · ○년 ○월 위험도" 로 정직하게 쓸 수 있다.
-- 하나만 있으면 사용자가 "지금 상태" 로 읽는다.
ALTER TABLE "batches" ADD COLUMN IF NOT EXISTS "target_month" date;
--> statement-breakpoint

COMMENT ON COLUMN batches.as_of_date IS
  '데이터 기준월 = 관측창의 끝(t-6). 마지막으로 본 국민연금 데이터의 달. NULL 이면 미확정이므로 "언제 기준" 이라고 말하면 안 된다.';
--> statement-breakpoint
COMMENT ON COLUMN batches.target_month IS
  '예측 대상월(t) = as_of_date + 6개월. risk_full 은 "이 달에 명단공개될 위험" 을 뜻한다. 현재 상태가 아니다.';
--> statement-breakpoint

-- 기저율 정정: 옛 제안서의 0.013% 는 폐기됐다.
-- 배포 데이터 실측 = 이미 명단공개된 곳 146 / 552,500 = 0.026% (약 1/3,784).
-- 학습은 양성:음성 1:1(50%) 이므로 실제와 약 1,900배 차이.
COMMENT ON COLUMN scored_active.risk_full IS
  '위험점수 0~1. ⚠️ 확률이 아니다 — 양성:음성 1:1 다운샘플링으로 학습해서 "절반이 위험한 세상" 기준이다. 실제 기저율은 약 0.026%(146/552,500, 약 1/3,784)라 약 1,900배 차이가 난다. "체불 확률 N%" 로 말하지 말고 순위·분위·등급으로만 해석한다. NULL(약 9.2%)은 관측창 커버리지 부족으로 채점 불가이며 0과 다르다. 예측 대상은 batches.target_month 시점의 명단공개다.';
--> statement-breakpoint
COMMENT ON COLUMN scored_active.risk_calibrated IS
  '캘리브레이션된 확률을 넣을 자리. 현재 전부 NULL — 모델 문서상 캘리브레이션은 미완이며, 양성이 희소해 신뢰구간이 넓다. 준비되기 전까지 확률 표현을 쓰지 말 것.';
