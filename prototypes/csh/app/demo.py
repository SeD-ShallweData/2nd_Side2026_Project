"""프로토타입 더미 데이터.

knowledge/_source 의 예시집에 정의된 스키마를 그대로 따릅니다.
모델과 실데이터가 붙기 전까지 화면과 챗봇이 완성된 형태로 돌아가게 하는 것이 목적입니다.

규칙
- 사업장명은 전부 가명이고 모든 레코드에 is_dummy=true 가 붙습니다.
  실존 기업을 연상시키는 이름을 쓰지 않습니다.
- 응답에 risk_probability 필드가 **존재하지 않습니다.** null이 아니라 필드 자체가 없습니다.
- 산재 경보는 사업장 안이 아니라 context.safety_alert 로 분리됩니다.

필드는 **공공데이터에서 실제로 얻을 수 있는 것만** 둡니다. 출처는 아래와 같습니다.

| 필드 | 출처 |
|---|---|
| 사업장명 · 소재지 · 업종 · 설립연도 | 국민연금 가입 사업장내역 (월) |
| 가입자 수 · 신규취득 · 상실 · 고지금액 | 국민연금 가입 사업장내역 (월) |
| 결측 개월 · 데이터 충실도 | 위 데이터의 월별 스냅샷 존재 여부 |
| 매칭 신뢰도 | 이름+주소 5단계 매칭 결과 (사업자번호가 6자리 마스킹이라 필요) |
| 체불사업주 명단 등재 · 체불액 · 공개일 | 고용노동부 체불사업주 명단공개 (반기) |
| 건강보험 체납 등재 · 체납액 · 공개일 | 건강보험공단 고액·상습 체납 공개명단 |
| 업종 폐업률 | KOSIS 산업별 기업수(활동·신생·소멸) |
| 지역·업종 산재 경보 | 국민권익위 민원분석정보 + 산업재해현황 |

파생 지표(순고용변화율, 이직률, 1인당 고지금액, 하락 streak)는 위 원자료에서 계산됩니다.
"""

# ── 확인 체크리스트 사전 (신호 → 질문) ────────────────────────────────
CHECKLIST = {
    "missing_recent_3m": {
        "severity": "attention",
        "title": "4대보험 가입 여부를 확인하세요",
        "body": "최근 공개 데이터에 납부 이력이 일부 나타나지 않습니다. 근로계약 시 가입 여부와 가입일을 확인해 보세요.",
    },
    "employment_drop": {
        "severity": "attention",
        "title": "면접에서 팀 근속 기간을 물어보세요",
        "body": "최근 1년간 가입자 수가 줄어드는 흐름이 관찰됩니다. 함께 일할 팀의 평균 근속과 최근 충원 사유를 확인해 보세요.",
    },
    "workplace_age": {
        "severity": "info",
        "title": "급여 지급일 규정을 계약서에서 확인하세요",
        "body": "설립 4년 이내 사업장입니다. 근로계약서에 임금 지급일과 지급 방법이 명시되어 있는지 확인하세요.",
    },
    "notice_amount_falling": {
        "severity": "attention",
        "title": "급여 구성 항목을 확인하세요",
        "body": "1인당 고지금액이 여러 달 연속 낮아지는 흐름이 있습니다. 기본급과 수당의 구성, 최근 급여 조정 여부를 확인해 보세요.",
    },
    "turnover_high": {
        "severity": "attention",
        "title": "채용 사유를 물어보세요",
        "body": "최근 1년간 입·퇴사 변동이 동종업계보다 큽니다. 결원 충원인지 증원인지 확인해 보세요.",
    },
    "health_arrears": {
        "severity": "attention",
        "title": "4대보험료 납부 상태를 확인하세요",
        "body": "건강보험공단이 공개한 체납 명단에 포함되어 있습니다. 급여에서 공제된 보험료가 실제로 납부되고 있는지 국민건강보험공단에서 본인 가입 이력을 확인해 보세요.",
    },
    "low_match_confidence": {
        "severity": "info",
        "title": "같은 이름의 다른 사업장일 수 있습니다",
        "body": "사업장명·주소 기반 매칭이라 동명 사업장일 가능성이 있습니다. 사업자등록증의 상호와 소재지를 확인해 보세요.",
    },
    "ambiguous_name": {
        "severity": "info",
        "title": "같은 이름의 사업장이 여러 곳 조회됩니다",
        "body": "소재지가 다른 동명 사업장이 있습니다. 어느 곳인지 확인한 뒤 다시 조회해 보세요.",
    },
    "defaulter_listed": {
        "severity": "attention",
        "title": "고용노동부 체불사업주 명단에 등재된 이력이 있습니다",
        "body": "공개분 기준입니다. 원문은 고용노동부 명단공개 페이지에서 확인하실 수 있습니다.",
    },
    "defaulter_past": {
        "severity": "info",
        "title": "과거 명단 등재 이력이 있습니다",
        "body": "공개 시점 기준의 확정 사실이며 현재 상태를 뜻하지 않습니다. 이후 고용·납부 지표는 안정적입니다. 근로계약 전 임금 지급일을 서면으로 확인해 두세요.",
    },
    "insufficient_data": {
        "severity": "info",
        "title": "판단할 데이터가 아직 부족합니다",
        "body": "설립 기간이 짧아 공개 데이터가 충분히 쌓이지 않았습니다. 근로계약서의 임금 지급일과 4대보험 가입 예정 시점을 직접 확인해 보세요.",
    },
    "high_closure_industry": {
        "severity": "info",
        "title": "업종 특성을 함께 보세요",
        "body": "이 업종은 신생·소멸 기업 비율이 높은 편입니다. 사업장 개별 상황과는 별개이나, 계약 조건을 서면으로 남겨 두시길 권합니다.",
    },
}

# ── 지역·업종 산재 경보 (시도 × 업종 × 주차 집계) ─────────────────────
SAFETY_ALERT_DISCLAIMER = "지역·업종 단위 집계 예측이며 개별 사업장의 사고 위험을 나타내지 않습니다."

SAFETY_ALERTS = {
    ("28", "F"): {
        "level": "warning", "region_label": "인천광역시", "industry_label": "건설업",
        "predicted_count": 128.0, "baseline_count": 90.0, "risk_ratio": 1.42,
        "top_drivers": ["2주 전 산업안전 관련 민원이 늘었습니다",
                        "지난주 건설 관련 민원이 평소보다 많이 접수됐습니다"],
    },
    ("41", "F"): {
        "level": "danger", "region_label": "경기도", "industry_label": "건설업",
        "predicted_count": 141.2, "baseline_count": 93.8, "risk_ratio": 1.51,
        "top_drivers": ["지난주 건설 관련 민원이 평소보다 많이 접수됐습니다",
                        "2주 전 산업안전 관련 민원이 늘었습니다"],
    },
    ("28", "C"): {
        "level": "normal", "region_label": "인천광역시", "industry_label": "제조업",
        "predicted_count": 61.3, "baseline_count": 58.0, "risk_ratio": 1.06,
        "top_drivers": ["최근 몇 주간 이 지역·업종의 재해 건수는 평시 수준입니다"],
    },
    ("41", "C"): {
        "level": "warning", "region_label": "경기도", "industry_label": "제조업",
        "predicted_count": 98.4, "baseline_count": 76.0, "risk_ratio": 1.29,
        "top_drivers": ["지난주 산업안전 관련 민원이 늘었습니다",
                        "여름철은 온열질환 사고가 늘어나는 시기입니다"],
    },
    ("31", "C"): {
        "level": "danger", "region_label": "울산광역시", "industry_label": "제조업",
        "predicted_count": 44.7, "baseline_count": 28.9, "risk_ratio": 1.55,
        "top_drivers": ["2주 전 산업안전 관련 민원이 크게 늘었습니다",
                        "지난주 환경 관련 민원이 늘었습니다"],
    },
    ("26", "C"): {
        "level": "normal", "region_label": "부산광역시", "industry_label": "제조업",
        "predicted_count": 33.1, "baseline_count": 31.4, "risk_ratio": 1.05,
        "top_drivers": ["최근 몇 주간 재해 건수가 평시 수준입니다"],
    },
    ("11", "Q"): {
        "level": "normal", "region_label": "서울특별시", "industry_label": "보건업 및 사회복지",
        "predicted_count": 22.4, "baseline_count": 23.1, "risk_ratio": 0.97,
        "top_drivers": ["최근 몇 주간 재해 건수가 평시 수준입니다"],
    },
    ("11", "N"): {
        "level": "warning", "region_label": "서울특별시", "industry_label": "사업시설관리·사업지원",
        "predicted_count": 29.8, "baseline_count": 22.5, "risk_ratio": 1.32,
        "top_drivers": ["지난주 근로조건 관련 민원이 늘었습니다. 장시간 근로가 늘어나는 시기일 수 있습니다"],
    },
    ("26", "G"): {
        "level": "normal", "region_label": "부산광역시", "industry_label": "도매 및 소매업",
        "predicted_count": 18.9, "baseline_count": 17.5, "risk_ratio": 1.08,
        "top_drivers": ["최근 몇 주간 재해 건수가 평시 수준입니다"],
    },
    ("11", "M"): {
        "level": "normal", "region_label": "서울특별시", "industry_label": "전문·과학·기술",
        "predicted_count": 7.2, "baseline_count": 6.8, "risk_ratio": 1.06,
        "top_drivers": ["표본이 작아 해석에 주의가 필요합니다"],
    },
}

SAFETY_AS_OF = "2026-07-13"
EMPLOYMENT_AS_OF = "2026-06"

# ── 사업장 마스터 ─────────────────────────────────────────────────────
# 케이스가 겹치지 않게 골랐습니다. 특히 "판단 불가" 행(005·007·010·011)이
# 프로토타입에서 가장 자주 빠지고 시연 중 가장 자주 터지는 지점입니다.
#
# 사업장명은 전부 가공입니다. 실존 기업을 연상시키는 이름을 쓰지 않습니다.
WORKPLACES = [
    {
        "id": "wp_demo_001", "name": "샘플A건설", "case": "완만한 감소 + 결측 1",
        "region_code": "28", "region_label": "인천광역시", "district": "서구",
        "industry_code": "F", "industry_label": "건설업", "industry_closure_rate": 0.118,
        "founded_year": 2022, "subscriber_count": 38, "subscriber_before": 51,
        "net_change_rate_12m": -0.255, "trend": "decreasing", "turnover_rate_12m": 0.29,
        "notice_per_head": 4_184_000, "notice_falling_streak": 4,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 1, "completeness": "medium", "match_confidence": 0.82,
        "signals": ["missing_recent_3m", "employment_drop", "notice_amount_falling", "workplace_age"],
        "green_flags": ["인력유지"],
    },
    {
        "id": "wp_demo_002", "name": "데모B제조", "case": "안정 + 결측 없음",
        "region_code": "28", "region_label": "인천광역시", "district": "남동구",
        "industry_code": "C", "industry_label": "제조업", "industry_closure_rate": 0.071,
        "founded_year": 2011, "subscriber_count": 124, "subscriber_before": 121,
        "net_change_rate_12m": 0.025, "trend": "stable", "turnover_rate_12m": 0.11,
        "notice_per_head": 4_920_000, "notice_falling_streak": 0,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 0, "completeness": "high", "match_confidence": 0.97,
        "signals": [],
        "green_flags": ["고용안정", "성실납부", "인건비안정", "인력유지", "업력3년", "낮은변동성"],
    },
    {
        "id": "wp_demo_003", "name": "예시C물류", "case": "명단 등재 + 급감 + 결측 2",
        "region_code": "41", "region_label": "경기도", "district": "김포시",
        "industry_code": "F", "industry_label": "건설업", "industry_closure_rate": 0.118,
        "founded_year": 2019, "subscriber_count": 17, "subscriber_before": 25,
        "net_change_rate_12m": -0.320, "trend": "decreasing", "turnover_rate_12m": 0.44,
        "notice_per_head": 3_210_000, "notice_falling_streak": 6,
        "defaulter_matched": True, "defaulter_published_at": "2025-08-01", "defaulter_amount": 187_000_000,
        "health_arrears_matched": True, "health_arrears_published_at": "2025-12-01", "health_arrears_amount": 41_000_000,
        "missing_months_recent_3": 2, "completeness": "low", "match_confidence": 0.74,
        "signals": ["defaulter_listed", "health_arrears", "missing_recent_3m",
                    "employment_drop", "notice_amount_falling", "low_match_confidence"],
        "green_flags": [],
    },
    {
        "id": "wp_demo_004", "name": "테스트D요양", "case": "증가 + 데이터 충실",
        "region_code": "11", "region_label": "서울특별시", "district": "노원구",
        "industry_code": "Q", "industry_label": "보건업 및 사회복지", "industry_closure_rate": 0.064,
        "founded_year": 2015, "subscriber_count": 63, "subscriber_before": 55,
        "net_change_rate_12m": 0.145, "trend": "increasing", "turnover_rate_12m": 0.18,
        "notice_per_head": 3_780_000, "notice_falling_streak": 0,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 0, "completeness": "high", "match_confidence": 0.99,
        "signals": [],
        "green_flags": ["고용안정", "성실납부", "인건비안정", "인력유지", "업력3년", "낮은변동성"],
    },
    {
        "id": "wp_demo_005", "name": "샘플E식자재", "case": "신설 + 데이터 거의 없음",
        "region_code": "26", "region_label": "부산광역시", "district": "사상구",
        "industry_code": "G", "industry_label": "도매 및 소매업", "industry_closure_rate": 0.143,
        "founded_year": 2025, "subscriber_count": 6, "subscriber_before": None,
        "net_change_rate_12m": None, "trend": "unknown", "turnover_rate_12m": None,
        "notice_per_head": None, "notice_falling_streak": 0,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 3, "completeness": "low", "match_confidence": 0.61,
        "signals": ["insufficient_data", "workplace_age", "high_closure_industry"],
        "green_flags": [],
    },
    {
        "id": "wp_demo_006", "name": "데모F전기공사", "case": "업력 18년 + 보합",
        "region_code": "28", "region_label": "인천광역시", "district": "부평구",
        "industry_code": "F", "industry_label": "건설업", "industry_closure_rate": 0.118,
        "founded_year": 2008, "subscriber_count": 45, "subscriber_before": 45,
        "net_change_rate_12m": -0.004, "trend": "stable", "turnover_rate_12m": 0.14,
        "notice_per_head": 4_510_000, "notice_falling_streak": 0,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 0, "completeness": "high", "match_confidence": 0.93,
        "signals": [],
        "green_flags": ["고용안정", "성실납부", "인건비안정", "업력3년", "낮은변동성"],
    },
    {
        "id": "wp_demo_007", "name": "예시G디자인", "case": "초소규모 4인 — 지표 비표시",
        "region_code": "11", "region_label": "서울특별시", "district": "마포구",
        "industry_code": "M", "industry_label": "전문·과학·기술", "industry_closure_rate": 0.102,
        "founded_year": 2021, "subscriber_count": 4, "subscriber_before": 8,
        "net_change_rate_12m": None, "trend": "too_small", "small_sample": True,
        "turnover_rate_12m": None, "notice_per_head": None, "notice_falling_streak": 0,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 1, "completeness": "low", "match_confidence": 0.55,
        "signals": ["missing_recent_3m", "low_match_confidence"],
        "green_flags": [],
    },
    {
        "id": "wp_demo_008", "name": "가상H금속", "case": "건강보험 체납만 등재 — 조기 신호",
        "region_code": "41", "region_label": "경기도", "district": "안산시",
        "industry_code": "C", "industry_label": "제조업", "industry_closure_rate": 0.071,
        "founded_year": 2013, "subscriber_count": 78, "subscriber_before": 84,
        "net_change_rate_12m": -0.071, "trend": "decreasing", "turnover_rate_12m": 0.22,
        "notice_per_head": 4_050_000, "notice_falling_streak": 2,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": True, "health_arrears_published_at": "2026-03-02", "health_arrears_amount": 63_000_000,
        "missing_months_recent_3": 1, "completeness": "medium", "match_confidence": 0.91,
        "signals": ["health_arrears", "missing_recent_3m", "employment_drop"],
        "green_flags": ["업력3년"],
    },
    {
        "id": "wp_demo_009", "name": "모의I화학", "case": "가입자 유지 + 인건비만 하락",
        "region_code": "31", "region_label": "울산광역시", "district": "남구",
        "industry_code": "C", "industry_label": "제조업", "industry_closure_rate": 0.071,
        "founded_year": 2009, "subscriber_count": 156, "subscriber_before": 158,
        "net_change_rate_12m": -0.013, "trend": "stable", "turnover_rate_12m": 0.09,
        "notice_per_head": 3_620_000, "notice_falling_streak": 7,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 0, "completeness": "high", "match_confidence": 0.96,
        "signals": ["notice_amount_falling"],
        "green_flags": ["고용안정", "성실납부", "인력유지", "업력3년", "낮은변동성"],
    },
    {
        "id": "wp_demo_010", "name": "샘플J건설", "case": "동명 사업장 ① (인천)",
        "region_code": "28", "region_label": "인천광역시", "district": "서구",
        "industry_code": "F", "industry_label": "건설업", "industry_closure_rate": 0.118,
        "founded_year": 2016, "subscriber_count": 29, "subscriber_before": 31,
        "net_change_rate_12m": -0.065, "trend": "stable", "turnover_rate_12m": 0.26,
        "notice_per_head": 4_330_000, "notice_falling_streak": 0,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 0, "completeness": "high", "match_confidence": 0.68,
        "signals": ["ambiguous_name", "low_match_confidence"],
        "green_flags": ["성실납부", "인건비안정", "업력3년"],
    },
    {
        "id": "wp_demo_011", "name": "샘플J건설", "case": "동명 사업장 ② (경기)",
        "region_code": "41", "region_label": "경기도", "district": "화성시",
        "industry_code": "F", "industry_label": "건설업", "industry_closure_rate": 0.118,
        "founded_year": 2023, "subscriber_count": 12, "subscriber_before": 19,
        "net_change_rate_12m": -0.368, "trend": "decreasing", "turnover_rate_12m": 0.51,
        "notice_per_head": 3_450_000, "notice_falling_streak": 3,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 2, "completeness": "low", "match_confidence": 0.66,
        "signals": ["ambiguous_name", "missing_recent_3m", "employment_drop",
                    "turnover_high", "notice_amount_falling", "workplace_age"],
        "green_flags": [],
    },
    {
        "id": "wp_demo_012", "name": "데모K전자", "case": "대규모 320인 안정",
        "region_code": "41", "region_label": "경기도", "district": "수원시",
        "industry_code": "C", "industry_label": "제조업", "industry_closure_rate": 0.071,
        "founded_year": 2004, "subscriber_count": 324, "subscriber_before": 318,
        "net_change_rate_12m": 0.019, "trend": "stable", "turnover_rate_12m": 0.08,
        "notice_per_head": 5_640_000, "notice_falling_streak": 0,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 0, "completeness": "high", "match_confidence": 0.98,
        "signals": [],
        "green_flags": ["고용안정", "성실납부", "인건비안정", "인력유지", "업력3년", "낮은변동성"],
    },
    {
        "id": "wp_demo_013", "name": "예시L식품", "case": "과거 명단 등재 + 현재 지표 안정",
        "region_code": "26", "region_label": "부산광역시", "district": "강서구",
        "industry_code": "C", "industry_label": "제조업", "industry_closure_rate": 0.071,
        "founded_year": 2012, "subscriber_count": 91, "subscriber_before": 86,
        "net_change_rate_12m": 0.058, "trend": "increasing", "turnover_rate_12m": 0.15,
        "notice_per_head": 4_270_000, "notice_falling_streak": 0,
        "defaulter_matched": True, "defaulter_published_at": "2023-02-01", "defaulter_amount": 96_000_000,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 0, "completeness": "high", "match_confidence": 0.94,
        "signals": ["defaulter_past"],
        "green_flags": ["고용안정", "성실납부", "인건비안정", "인력유지", "업력3년"],
    },
    {
        "id": "wp_demo_014", "name": "테스트M시설관리", "case": "위탁 관리 + 이직률 급증",
        "region_code": "11", "region_label": "서울특별시", "district": "강서구",
        "industry_code": "N", "industry_label": "사업시설관리·사업지원", "industry_closure_rate": 0.126,
        "founded_year": 2017, "subscriber_count": 212, "subscriber_before": 205,
        "net_change_rate_12m": 0.034, "trend": "stable", "turnover_rate_12m": 0.63,
        "notice_per_head": 2_980_000, "notice_falling_streak": 1,
        "defaulter_matched": False, "defaulter_published_at": None, "defaulter_amount": None,
        "health_arrears_matched": False, "health_arrears_published_at": None, "health_arrears_amount": None,
        "missing_months_recent_3": 0, "completeness": "high", "match_confidence": 0.88,
        "signals": ["turnover_high", "high_closure_industry"],
        "green_flags": ["성실납부", "인력유지", "업력3년"],
        "note": "위탁 관리 사업장입니다. 한 회사가 여러 현장을 운영하는 형태라 인력 이동이 잦을 수 있습니다.",
    },
]

DISCLAIMER = (
    "본 정보는 공공데이터를 가공한 참고 자료이며, 특정 사업장의 임금체불 발생을 단정하거나 "
    "예측한 결과가 아닙니다. 채용·이직 판단은 여러 정보를 함께 확인하신 뒤 본인의 책임으로 결정해 주세요."
)


def _checklist(signals: list[str]) -> list[dict]:
    """attention을 먼저, info를 뒤에 둡니다."""
    items = [{"id": key, **CHECKLIST[key]} for key in signals if key in CHECKLIST]
    return sorted(items, key=lambda i: 0 if i["severity"] == "attention" else 1)


def _observed(wp: dict) -> dict:
    employment = {
        "subscriber_count": wp["subscriber_count"],
        "trend": wp["trend"],
        "small_sample": wp.get("small_sample", False),
    }
    # 5인 미만이거나 신설이면 변화율 자체를 내보내지 않습니다.
    if not wp.get("small_sample") and wp.get("net_change_rate_12m") is not None:
        employment["net_change_rate_12m"] = wp["net_change_rate_12m"]
        employment["subscriber_before"] = wp["subscriber_before"]
        employment["turnover_rate_12m"] = wp["turnover_rate_12m"]
        employment["notice_per_head"] = wp["notice_per_head"]
        employment["notice_falling_streak"] = wp["notice_falling_streak"]

    notes = []
    if wp["missing_months_recent_3"]:
        notes.append(f"최근 3개월 중 {wp['missing_months_recent_3']}개월치 데이터가 공개 자료에 나타나지 않습니다.")
    if wp.get("small_sample"):
        notes.append("가입자 수가 5인 미만이라 변화율 지표는 표시하지 않습니다.")
    if wp["match_confidence"] < 0.8:
        notes.append("사업장명 기반 매칭이라 동명 사업장일 가능성이 있습니다.")
    if wp.get("note"):
        notes.append(wp["note"])

    return {
        "defaulter_list": {
            "matched": wp["defaulter_matched"],
            "source": "고용노동부 체불사업주 명단공개",
            "published_at": wp["defaulter_published_at"],
            "amount": wp["defaulter_amount"],
        },
        "health_arrears": {
            "matched": wp["health_arrears_matched"],
            "source": "건강보험공단 고액·상습 체납 공개명단",
            "published_at": wp["health_arrears_published_at"],
            "amount": wp["health_arrears_amount"],
        },
        "employment": employment,
        "industry": {
            "label": wp["industry_label"],
            "closure_rate": wp["industry_closure_rate"],
            "source": "KOSIS 산업별 기업수(활동·신생·소멸)",
        },
        "green_flags": wp["green_flags"],
        "data_quality": {
            "completeness": wp["completeness"],
            "missing_months_recent_3": wp["missing_months_recent_3"],
            "match_confidence": wp["match_confidence"],
            "notes": notes,
        },
    }


def _context(wp: dict) -> dict:
    alert = SAFETY_ALERTS.get((wp["region_code"], wp["industry_code"]))
    if not alert:
        return {}
    return {"safety_alert": {**alert, "week": SAFETY_AS_OF, "disclaimer": SAFETY_ALERT_DISCLAIMER}}


def card(wp: dict) -> dict:
    """사업장 카드 한 장. risk_probability 필드는 존재하지 않습니다."""
    return {
        "workplace": {
            "id": wp["id"], "name": wp["name"], "case": wp["case"],
            "region_code": wp["region_code"], "region_label": wp["region_label"],
            "district": wp["district"],
            "industry_code": wp["industry_code"], "industry_label": wp["industry_label"],
            "founded_year": wp["founded_year"], "is_dummy": True,
        },
        "observed": _observed(wp),
        "checklist": _checklist(wp["signals"]),
        "context": _context(wp),
        "disclaimer": DISCLAIMER,
        "as_of": {"employment": EMPLOYMENT_AS_OF, "safety": SAFETY_AS_OF},
    }


def list_cards() -> list[dict]:
    return [card(wp) for wp in WORKPLACES]


def _won(value) -> str:
    if not value:
        return "-"
    return f"{value / 100_000_000:.1f}억원" if value >= 100_000_000 else f"{value / 10_000:,.0f}만원"


# 질문에서 지역·업종을 알아보기 위한 별칭. 실DB로 가면 코드 테이블로 대체됩니다.
REGION_ALIASES = {
    "11": ["서울"], "26": ["부산"], "28": ["인천"], "31": ["울산"],
    "41": ["경기", "수원", "안산", "화성", "김포"],
    "27": ["대구"], "29": ["광주"], "30": ["대전"], "50": ["제주"],
    "42": ["강원"], "43": ["충북"], "44": ["충남"], "45": ["전북"],
    "46": ["전남"], "47": ["경북"], "48": ["경남"],
}
INDUSTRY_ALIASES = {
    "F": ["건설", "건축", "토목", "전기공사"],
    "C": ["제조", "공장", "금속", "화학", "식품", "전자"],
    "H": ["물류", "운수", "창고", "택배"],
    "Q": ["보건", "요양", "복지", "병원", "간호"],
    "G": ["도매", "소매", "유통", "식자재", "판매"],
    "M": ["전문", "과학", "기술", "디자인", "설계"],
    "N": ["시설관리", "사업지원", "청소", "경비", "용역"],
    "I": ["숙박", "음식", "식당", "호텔", "펜션"],
}


def _codes_in(question: str, aliases: dict[str, list[str]]) -> set[str]:
    return {code for code, words in aliases.items() if any(w in question for w in words)}


def filter_records(question: str) -> tuple[list[dict], str]:
    """질문의 지역·업종 조건으로 레코드를 걸러냅니다.

    필터링을 모델에 맡기면 조건에 맞는 곳이 없을 때 **비슷한 것으로 채웁니다.**
    실제로 "제주도 숙박업 추천"에 서울·경기 제조업 사업장을 답했습니다. 2026-08-01.
    학습자료가 지적한 대로 이런 필터는 프롬프트가 아니라 쿼리 계층의 일입니다.

    반환: (레코드 목록, 적용된 조건 설명)
    """
    q = question or ""
    named = [wp for wp in WORKPLACES if wp["name"] in q]

    regions = _codes_in(q, REGION_ALIASES)
    industries = _codes_in(q, INDUSTRY_ALIASES)

    if named:
        # 이름 + 지역이 함께 나오면 지역으로 좁힙니다. 동명 사업장을 가리는 경로입니다.
        if regions:
            narrowed = [w for w in named if w["region_code"] in regions]
            if narrowed:
                named = narrowed
        label = f"사업장명: {', '.join(sorted({w['name'] for w in named}))}"
        if regions:
            label += " · " + ", ".join(sorted({REGION_ALIASES[c][0] for c in regions}))
        return named, label

    if not regions and not industries:
        # 대상이 없는 질문("회사가 위험한지 알고 싶어요")에 전체를 넣으면
        # 모델이 아무 사업장이나 골라 수치를 인용합니다. 조회할 것이 없으면 비웁니다.
        # 2026-08-01 일관성 측정에서 잡힌 문제입니다.
        return [], "조회 대상 없음 — 사업장명 또는 지역·업종이 필요"

    matched = [
        wp for wp in WORKPLACES
        if (not regions or wp["region_code"] in regions)
        and (not industries or wp["industry_code"] in industries)
    ]

    # 질문에 이름이 나온 사업장은 조건과 무관하게 포함합니다.
    result = matched + [wp for wp in named if wp not in matched]

    labels = []
    if regions:
        labels.append("지역: " + ", ".join(sorted({REGION_ALIASES[c][0] for c in regions})))
    if industries:
        labels.append("업종: " + ", ".join(sorted({INDUSTRY_ALIASES[c][0] for c in industries})))
    return result, " · ".join(labels)


LEVEL_LABEL = {"normal": "정상", "warning": "주의", "danger": "위험"}


def filter_alerts(question: str) -> tuple[list[dict], str]:
    """질문의 지역·업종으로 산재 경보를 조회합니다.

    사업장과 같은 문제가 경보에서도 났습니다. 데이터에 없는
    "제주 숙박업 주의 단계"를 지어냈습니다. 2026-08-01.
    조회되지 않는 조합은 "경보를 산출하지 않았다"가 정답입니다.
    """
    q = question or ""
    regions = _codes_in(q, REGION_ALIASES)
    industries = _codes_in(q, INDUSTRY_ALIASES)

    if not regions and not industries:
        return [], "조건 없음"

    found = [
        {"region_code": r, "industry_code": i, **alert}
        for (r, i), alert in SAFETY_ALERTS.items()
        if (not regions or r in regions) and (not industries or i in industries)
    ]
    labels = []
    if regions:
        labels.append("지역: " + ", ".join(sorted({REGION_ALIASES[c][0] for c in regions})))
    if industries:
        labels.append("업종: " + ", ".join(sorted({INDUSTRY_ALIASES[c][0] for c in industries})))
    return found, " · ".join(labels)


def alerts_prompt_block(alerts: list[dict]) -> str:
    """산재 경보를 프롬프트에 넣을 형태로 만듭니다."""
    if not alerts:
        return "(조건에 맞는 지역·업종 경보가 산출되지 않았습니다)"
    blocks = []
    for a in alerts:
        blocks.append(
            f'<alert 지역="{a["region_label"]}" 업종="{a["industry_label"]}" 주차="{SAFETY_AS_OF}">\n'
            f'  등급: {LEVEL_LABEL[a["level"]]}\n'
            f'  예측 {a["predicted_count"]}건 / 평시 {a["baseline_count"]}건 ({a["risk_ratio"]}배)\n'
            f'  주요 신호: {" / ".join(a["top_drivers"])}\n'
            f'</alert>')
    return "\n\n".join(blocks)


def as_prompt_block(workplaces: list[dict] | None = None) -> str:
    """조회 가능한 사업장 레코드를 프롬프트에 넣을 형태로 만듭니다.

    이게 없으면 모델이 few-shot 예시의 수치 패턴을 **아무 회사에나 복사합니다.**
    실제로 "삼성전자 기흥사업장"에 대해 존재하지 않는 가입자 수를 지어냈습니다. 2026-08-01.

    RAG·실DB로 넘어가면 이 함수가 "질문에서 추출한 사업장명으로 조회한 결과"를
    돌려주도록 바뀝니다. 프롬프트 쪽 계약(<workplace_db> 블록)은 그대로 유지됩니다.
    """
    rows = WORKPLACES if workplaces is None else workplaces
    dupes = {n for n in known_names() if known_names().count(n) > 1}
    blocks = []
    for wp in rows:
        head = f'<record name="{wp["name"]}" 소재지="{wp["region_label"]} {wp["district"]}">'
        parts = [head,
                 f'  업종: {wp["industry_label"]} (업종 폐업률 {wp["industry_closure_rate"] * 100:.1f}%, KOSIS)'
                 f' · 설립: {wp["founded_year"]}년']

        if wp["name"] in dupes:
            parts.append("  ※ 같은 이름의 다른 소재지 사업장이 또 있음 — 어느 곳인지 먼저 되물을 것")

        # 미등재에는 "공개일 없음"을 명시합니다. 이 표시가 없으면 모델이
        # 다른 사업장의 공개일(2025-08-01)을 끌어다 붙입니다.
        parts.append("  체불사업주 명단: " + (
            f'등재 ({wp["defaulter_published_at"]} 공개분, 체불액 {_won(wp["defaulter_amount"])})'
            if wp["defaulter_matched"] else "미등재 (해당 공개일 없음 — 날짜를 쓰지 말 것)"))
        parts.append("  건강보험 체납 공개명단: " + (
            f'등재 ({wp["health_arrears_published_at"]} 공개분, 체납액 {_won(wp["health_arrears_amount"])})'
            if wp["health_arrears_matched"] else "미등재 (해당 공개일 없음 — 날짜를 쓰지 말 것)"))

        if wp.get("small_sample"):
            parts.append(f'  국민연금 가입자: {wp["subscriber_count"]}명 (5인 미만 — 변화율·이직률 지표를 말하지 않음)')
        elif wp["net_change_rate_12m"] is None:
            parts.append(f'  국민연금 가입자: {wp["subscriber_count"]}명 (신설 — 12개월 추이 산출 불가)')
        else:
            parts.append(
                f'  국민연금 가입자: {wp["subscriber_before"]}명 → {wp["subscriber_count"]}명 '
                f'(12개월, {wp["net_change_rate_12m"] * 100:+.1f}%)')
            parts.append(f'  이직률(12개월): {wp["turnover_rate_12m"] * 100:.0f}%')
            parts.append(
                f'  1인당 고지금액: 월 {wp["notice_per_head"] / 10_000:,.0f}만원'
                + (f' · {wp["notice_falling_streak"]}개월 연속 하락' if wp["notice_falling_streak"] else ' · 하락 구간 없음'))

        parts.append(
            f'  최근 3개월 결측: {wp["missing_months_recent_3"]}개월 · '
            f'데이터 충실도: {wp["completeness"]} · 매칭 신뢰도: {wp["match_confidence"]}')
        if wp["green_flags"]:
            parts.append(f'  안정 지표: {", ".join(wp["green_flags"])}')
        checks = [CHECKLIST[s]["title"] for s in wp["signals"] if s in CHECKLIST]
        if checks:
            parts.append(f'  확인 체크리스트: {" / ".join(checks)}')
        if wp.get("note"):
            parts.append(f'  비고: {wp["note"]}')
        parts.append("</record>")
        blocks.append("\n".join(parts))
    return "\n\n".join(blocks)


def is_ambiguous(rows: list[dict]) -> bool:
    """이름이 같은 사업장이 둘 이상 조회됐는가."""
    return len(rows) >= 2 and len({w["name"] for w in rows}) == 1


def as_choice_block(rows: list[dict]) -> str:
    """동명 사업장일 때 **수치 없이** 소재지·설립연도만 내보냅니다.

    프롬프트로 "되묻고 수치를 말하지 말라"고 해도 두 모델 다 어겼습니다.
    한쪽은 양쪽 데이터를 전부 쏟아냈고, 다른 쪽은 두 곳 수치를 한 문단에 섞었습니다.
    수치를 아예 주지 않으면 인용할 수가 없습니다. 2026-08-01.
    """
    name = rows[0]["name"]
    lines = [f'<disambiguation name="{name}" count="{len(rows)}">']
    for wp in rows:
        lines.append(f'  - {wp["region_label"]} {wp["district"]} (설립 {wp["founded_year"]}년)')
    lines.append("  ※ 어느 곳인지 확인되기 전이라 관측 지표는 조회하지 않았습니다.")
    lines.append("</disambiguation>")
    return "\n".join(lines)


def known_names() -> list[str]:
    return [wp["name"] for wp in WORKPLACES]


def find_all(name_or_id: str) -> list[dict]:
    """이름·id로 조회. 동명 사업장이 있으면 여러 건을 돌려줍니다."""
    key = (name_or_id or "").strip().lower()
    if not key:
        return []
    exact = [wp for wp in WORKPLACES if key in (wp["id"].lower(), wp["name"].lower())]
    if exact:
        return [card(wp) for wp in exact]
    return [card(wp) for wp in WORKPLACES if key in wp["name"].lower()]


def find(name_or_id: str) -> dict | None:
    found = find_all(name_or_id)
    return found[0] if found else None


# ── 커뮤니티 더미 글 ──────────────────────────────────────────────────
COMMUNITY = [
    {"id": "c1", "region": "인천", "industry": "건설업", "tag": "긴급", "icon": "construction",
     "title": "현장에서 2달째 임금 체불 중입니다",
     "body": "소장한테 말해도 계속 미루고 있는데 어떻게 해야 하나요? 주변 동료들도 같은 상황이고...",
     "ago": "3시간 전", "comments": 24, "likes": 47},
    {"id": "c2", "region": "경기", "industry": "제조업", "tag": None, "icon": "gear",
     "title": "안전모 없이 작업 지시 받았을 때 대처법",
     "body": "신입이라 거절하기 어려웠는데 나중에 알고 보니 중대재해처벌법 위반이더라고요.",
     "ago": "1일 전", "comments": 18, "likes": 63},
    {"id": "c3", "region": "울산", "industry": "화학", "tag": None, "icon": "flask",
     "title": "화학물질 취급 중 이상 증상, 신고해야 하나요?",
     "body": "MSDS 확인했는데 우리 현장이랑 맞지 않는 것 같아서요. 비슷한 경험 있으신 분 계신가요?",
     "ago": "2일 전", "comments": 31, "likes": 88},
    {"id": "c4", "region": "부산", "industry": "물류", "tag": None, "icon": "truck",
     "title": "야간 상하차 근무, 휴게시간이 없습니다",
     "body": "8시간 내리 일하는데 쉬는 시간을 안 줍니다. 이거 문제 삼을 수 있나요?",
     "ago": "3일 전", "comments": 12, "likes": 39},
    {"id": "c5", "region": "인천", "industry": "서비스업", "tag": None, "icon": "store",
     "title": "퇴사 후 한 달 넘게 퇴직금이 안 들어와요",
     "body": "사장님은 곧 준다고만 하시는데 언제까지 기다려야 하는지 모르겠습니다.",
     "ago": "4일 전", "comments": 27, "likes": 51},
]

# 랜딩 상단 지표 (전부 더미)
STATS = [
    {"value": "12,480", "unit": "개", "label": "등록된 사업장"},
    {"value": "8,930", "unit": "건", "label": "위험카드 발급"},
    {"value": "34,200", "unit": "개", "label": "커뮤니티 글"},
    {"value": "21,600", "unit": "건", "label": "AI 상담 건수"},
]
