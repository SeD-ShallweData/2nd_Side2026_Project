-- 챗봇·LLM 에이전트가 읽을 뷰 + 스키마 주석.
--
-- 왜 뷰를 거치나:
--   커뮤니티 글·리뷰 테이블을 그대로 열어주면 `author_id` 가 보인다.
--   그러면 익명 글을 작성자와 연결할 수 있어 **익명성이 깨진다**.
--   웹은 직렬화 단계에서 실명을 지우는데, DB 를 직접 읽는 경로가 그걸 우회하면 안 된다.
--   그래서 봇에게는 원본 테이블 대신 신원이 제거된 뷰만 준다.
--
-- 뷰가 노출하는 것: 제목·본문·평점·작성시각·역할·(실명 글이면) 이름
-- 뷰가 감추는 것  : author_id, 이메일, 비밀번호 해시, 익명 글의 이름

CREATE OR REPLACE VIEW v_posts AS
SELECT p.id,
       p.firm_id,
       p.title,
       p.body,
       p.anonymous,
       -- 익명이면 이름을 아예 내보내지 않는다
       CASE WHEN p.anonymous THEN NULL ELSE u.name END AS author_name,
       u.role AS author_role,
       p.created_at
FROM posts p
JOIN users u ON u.id = p.author_id;
--> statement-breakpoint

CREATE OR REPLACE VIEW v_comments AS
SELECT c.id,
       c.post_id,
       c.body,
       c.anonymous,
       CASE WHEN c.anonymous THEN NULL ELSE u.name END AS author_name,
       u.role AS author_role,
       c.created_at
FROM comments c
JOIN users u ON u.id = c.author_id;
--> statement-breakpoint

CREATE OR REPLACE VIEW v_reviews AS
SELECT r.id,
       r.firm_id,
       r.status,
       r.rating_pay,
       r.rating_worklife,
       r.rating_culture,
       r.rating_management,
       -- 총평은 네 항목 평균 (웹과 같은 규칙)
       round(((r.rating_pay + r.rating_worklife + r.rating_culture + r.rating_management)::numeric) / 4, 2) AS rating_avg,
       r.pros,
       r.cons,
       r.anonymous,
       CASE WHEN r.anonymous THEN NULL ELSE u.name END AS author_name,
       r.created_at
FROM reviews r
JOIN users u ON u.id = r.author_id;
--> statement-breakpoint

-- ── 스키마 주석 ───────────────────────────────────────────────
-- LLM 에이전트는 접속 시 스키마를 introspect 하는 경우가 많다.
-- 잘못 쓰기 쉬운 컬럼에 경고를 박아 두면 그 단계에서 읽힌다.

COMMENT ON COLUMN scored_active.risk_full IS
  '위험점수 0~1. ⚠️ 확률이 아니다 — 음성 1:1 다운샘플링 학습이라 실제 기저율(약 0.013%)보다 약 2400배 부풀려져 있다. "체불 확률 N%" 로 말하지 말 것. 순위·분위·등급으로만 해석한다. NULL(약 9.2%)은 이력 부족으로 채점 불가이며 0과 다르다.';
--> statement-breakpoint
COMMENT ON COLUMN scored_active.risk_calibrated IS
  '캘리브레이션된 확률을 넣을 자리. 현재 전부 NULL — 준비되기 전까지 확률 표현을 쓰지 말 것.';
--> statement-breakpoint
COMMENT ON COLUMN firms.firm_id IS
  'sha1(사업장명||''|''||사업자번호)[:16]. ⚠️ 불변이 아니다 — 사업장명이 바뀌면 달라진다(월 약 0.24%).';
--> statement-breakpoint
COMMENT ON COLUMN firms.biz_no IS
  '마스킹된 6자리. ⚠️ 비고유 — 한 번호가 최대 788곳에 재사용된다. 단독으로 사업장을 식별할 수 없다.';
--> statement-breakpoint
COMMENT ON COLUMN firms.corp_key IS
  '표기 변형을 흡수한 정규화 키. 같은 법인의 여러 사업장을 묶는 용도이며 식별키가 아니다.';
--> statement-breakpoint
COMMENT ON COLUMN inspector_queue.reasons IS
  'SHAP 상위 3피처 한글명. ⚠️ 위험큐 상위 3000곳에만 존재한다. 나머지 사업장에는 위험사유가 없으며 지어내면 안 된다.';
--> statement-breakpoint
COMMENT ON COLUMN batches.as_of_date IS
  '데이터 기준월 — 어느 국민연금 데이터로 채점했는지. NULL 이면 미확정이므로 "언제 기준" 이라고 말하면 안 된다.';
--> statement-breakpoint
COMMENT ON VIEW v_posts IS
  '커뮤니티 글 (신원 제거). 익명 글은 author_name 이 NULL 이다. 원본 posts 테이블에는 접근 권한이 없다.';
--> statement-breakpoint
COMMENT ON VIEW v_reviews IS
  '사업장 리뷰 (신원 제거). 익명이면 author_name 이 NULL 이다.';
