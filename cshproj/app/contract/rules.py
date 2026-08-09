"""근로계약서 규칙 엔진.

**판정은 전부 여기서 내립니다. LLM은 판정하지 않습니다.**

demo.py에서 지역·업종 필터를 코드로 건 것과 같은 이유입니다.
최저임금 미달 여부는 나눗셈이고, 나눗셈을 모델에 맡기면 틀립니다.
실제로 프롬프트만으로 시켰을 때 두 모델 다 209시간 환산을 건너뛰고
월급을 최저임금 월 환산액과 직접 비교했습니다.

레벨 4단계
    violation  🔴 법정 기준 미달 — 조문이 명확하고 계약서 문면으로 확인되는 것
    check      🟡 확인 필요 — 그 자체로는 위법이 아니거나, 실태를 봐야 결론이 나는 것
    ok         🟢 기준 충족 — 확인된 것도 알려줍니다. 문제만 나열하면 계약서 전체를 불신합니다
    excluded   ⚪ 적용 제외 — 상시 근로자 5인 미만이라 해당 조문이 적용되지 않는 것

**정보가 없으면 violation을 만들지 않습니다.** 없는 것(None)과 없다고 적힌 것(False)은 다릅니다.
"""

from dataclasses import dataclass, asdict, field

from . import schema, standards

VIOLATION, CHECK, OK, EXCLUDED = "violation", "check", "ok", "excluded"

LEVEL_LABEL = {
    VIOLATION: "법정 기준 미달",
    CHECK: "확인 필요",
    OK: "기준 충족",
    EXCLUDED: "적용 제외",
}


@dataclass
class Finding:
    code: str
    level: str
    title: str
    message: str                       # 판정 한 줄
    law: str | None = None             # standards.LAWS 의 키
    detail: str | None = None          # 계산 근거 — 숫자가 어떻게 나왔는가
    evidence: str | None = None        # 계약서 원문 인용
    fix: str | None = None             # 사용자가 할 수 있는 일

    def to_dict(self) -> dict:
        out = asdict(self)
        out["level_label"] = LEVEL_LABEL.get(self.level, self.level)
        if self.law:
            spec = standards.law(self.law)          # 없는 조문이면 여기서 터집니다
            out["law_title"] = spec["title"]
            out["law_text"] = spec["text"]
            out["law_penalty"] = spec["penalty"]
        return out


@dataclass
class Context:
    """규칙이 공유하는 파생값. 규칙마다 다시 계산하지 않습니다."""
    year: int
    min_hourly: int
    min_monthly_209: int
    headcount: int | None = None
    weekly_hours: float | None = None
    monthly_hours: float | None = None
    term_months: float | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def small(self) -> bool | None:
        """상시 5인 미만인가. 모르면 None — 5인 이상이라고 가정하지 않습니다."""
        if self.headcount is None:
            return None
        return self.headcount < standards.SMALL_WORKPLACE_THRESHOLD


def _won(amount: float | int | None) -> str:
    return "—" if amount is None else f"{round(amount):,}원"


def _scale(ctx: Context, finding: Finding) -> Finding:
    """5인 미만 사업장에 적용되지 않는 조문을 걸러냅니다.

    이 처리를 빼면 4인 사업장의 **적법한** 계약서를 위반이라고 말하게 됩니다.
    진단이 가장 자주 틀리는 지점이라 규칙마다가 아니라 여기 한 곳에 모읍니다.
    """
    if finding.law not in standards.EXCLUDED_UNDER_5 or finding.level != VIOLATION:
        return finding

    if ctx.small is True:
        finding.level = EXCLUDED
        finding.message = (f"상시 근로자 {ctx.headcount}명 사업장이라 "
                           f"{finding.law}가 적용되지 않습니다. — {finding.message}")
        finding.fix = "5인 이상이 되면 이 조항은 다시 적용됩니다."
        return finding

    if ctx.small is None:
        finding.level = CHECK
        finding.detail = ((finding.detail + "\n") if finding.detail else "") + \
            f"{finding.law}는 상시 근로자 5인 이상 사업장에 적용됩니다. " \
            "계약서에 상시 근로자 수가 없어 위반으로 단정하지 않았습니다."
        finding.fix = (finding.fix or "") + " 사업장의 상시 근로자 수를 먼저 확인하세요."
    return finding


# ── ① 최저임금 ────────────────────────────────────────────────────────
def _included_monthly_wage(contract: dict, ctx: Context) -> tuple[int | None, str]:
    """최저임금 산입 대상 월 임금과 그 계산 근거.

    가산수당(고정연장수당)은 산입되지 않습니다. 매월 지급되는 상여금·복리후생비는
    2024년부터 전액 산입됩니다. 이 구분을 빼면 포괄임금 계약서가 전부 통과합니다.
    """
    wage = contract["wage"]
    amount, kind = wage["amount"], wage["type"]
    if amount is None:
        return None, ""

    if kind == "annual":
        monthly, base_note = amount / 12, f"연봉 {_won(amount)} ÷ 12개월"
    elif kind == "monthly":
        monthly, base_note = float(amount), f"월급 {_won(amount)}"
    else:
        return None, ""      # 시급·일급은 아래에서 따로 봅니다

    steps = [base_note]
    ot = wage["fixed_ot_amount"]
    if ot:
        monthly -= ot
        steps.append(f"고정연장수당 {_won(ot)} 제외 (가산수당은 최저임금에 산입되지 않습니다)")
    return int(round(monthly)), " · ".join(steps)


def rule_min_wage(contract: dict, ctx: Context) -> list[Finding]:
    wage = contract["wage"]
    law_key = "최저임금법 제6조"
    floor = ctx.min_hourly

    if wage["amount"] is None:
        return [Finding("min_wage", CHECK, "최저임금",
                        "임금 액수를 읽지 못해 최저임금 미달 여부를 계산하지 못했습니다.",
                        law=law_key,
                        fix="계약서의 임금란이 비어 있거나 인식되지 않았습니다. 원본을 확인하세요.")]

    # 시급·일급은 환산 없이 바로 비교합니다.
    if wage["type"] == "hourly":
        hourly = float(wage["amount"])
        detail = f"계약서에 시급 {_won(hourly)}로 적혀 있습니다."
    elif wage["type"] == "daily":
        if not contract["hours"]["daily_hours"]:
            return [Finding("min_wage", CHECK, "최저임금",
                            "일급은 적혀 있는데 1일 소정근로시간이 없어 시급을 환산하지 못했습니다.",
                            law=law_key, fix="1일 몇 시간 근무인지 확인하세요.")]
        daily_hours = contract["hours"]["daily_hours"]
        hourly = wage["amount"] / daily_hours
        detail = f"일급 {_won(wage['amount'])} ÷ 1일 {daily_hours}시간 = 시급 {_won(hourly)}"
    else:
        monthly, base_note = _included_monthly_wage(contract, ctx)
        if monthly is None:
            return [Finding("min_wage", CHECK, "최저임금",
                            "임금 지급 단위(월급·시급·연봉)를 읽지 못해 환산하지 못했습니다.",
                            law=law_key, fix="계약서의 임금 지급 형태를 확인하세요.")]
        if not ctx.monthly_hours:
            return [Finding("min_wage", CHECK, "최저임금",
                            f"{base_note}은 확인했지만 소정근로시간이 없어 시급을 환산하지 못했습니다.",
                            law=law_key,
                            detail=f"참고 — {ctx.year}년 최저임금 월 환산액(209시간 기준)은 "
                                   f"{_won(ctx.min_monthly_209)}입니다.",
                            fix="1주 소정근로시간이 계약서에 적혀 있는지 확인하세요.")]
        hourly = monthly / ctx.monthly_hours
        detail = (f"{base_note} = {_won(monthly)}\n"
                  f"월 소정근로시간 {ctx.monthly_hours}시간 "
                  f"(주 {ctx.weekly_hours}시간 + 유급주휴, ×{standards.WEEKS_PER_MONTH})\n"
                  f"→ 환산 시급 {_won(hourly)}")

    detail += f"\n{ctx.year}년 최저임금 시급 {_won(floor)}"

    if hourly + 1 < floor:                     # 1원은 반올림 오차 여유
        gap = floor - hourly
        return [Finding(
            "min_wage_below", VIOLATION, "최저임금 미달",
            f"환산 시급이 {ctx.year}년 최저임금보다 시간당 약 {_won(gap)} 낮습니다.",
            law=law_key, detail=detail,
            fix="최저임금법 제6조 제3항에 따라 미달분은 무효이고 최저임금액이 적용됩니다. "
                "차액은 3년 이내에 청구할 수 있습니다 (☎1350).")]

    return [Finding("min_wage", OK, "최저임금",
                    f"환산 시급 {_won(hourly)}로 {ctx.year}년 최저임금 이상입니다.",
                    law=law_key, detail=detail)]


# ── ② 수습 ────────────────────────────────────────────────────────────
def rule_probation(contract: dict, ctx: Context) -> list[Finding]:
    prob = contract["probation"]
    if prob["exists"] is not True and prob["months"] is None and prob["wage_rate"] is None:
        return []

    law_key = "최저임금법 시행령 제3조"
    out: list[Finding] = []
    months, rate = prob["months"], prob["wage_rate"]
    discounted = rate is not None and rate < 1.0

    if months and months > standards.PROBATION_MAX_MONTHS and discounted:
        out.append(Finding(
            "probation_over_3m", VIOLATION, "수습기간 감액",
            f"수습기간이 {months:g}개월인데 임금을 감액합니다. 감액은 3개월까지만 허용됩니다.",
            law=law_key,
            detail=f"수습 {months:g}개월 · 수습기간 임금 {rate:.0%}",
            fix=f"{standards.PROBATION_MAX_MONTHS}개월을 넘는 기간은 100%를 받아야 합니다."))
    elif months and months > standards.PROBATION_MAX_MONTHS:
        out.append(Finding(
            "probation_over_3m", CHECK, "수습기간",
            f"수습기간이 {months:g}개월입니다. 감액 조항이 없다면 그 자체로 위반은 아닙니다.",
            law=law_key,
            detail="다만 수습을 이유로 임금을 깎을 수 있는 기간은 3개월까지입니다.",
            fix="수습기간 중 실제 지급액이 정상 임금과 같은지 확인하세요."))

    if discounted:
        if rate < standards.PROBATION_MIN_RATE - 1e-9:
            out.append(Finding(
                "probation_rate_low", VIOLATION, "수습 감액률",
                f"수습기간 임금이 {rate:.0%}입니다. 감액 하한은 최저임금의 90%입니다.",
                law=law_key,
                detail=f"{ctx.year}년 최저임금 시급 {_won(ctx.min_hourly)} × 90% = "
                       f"{_won(ctx.min_hourly * standards.PROBATION_MIN_RATE)}",
                fix="90%에 미달하는 부분은 청구할 수 있습니다."))

        if ctx.term_months is not None and ctx.term_months < standards.PROBATION_MIN_TERM_MONTHS:
            out.append(Finding(
                "probation_short_term", VIOLATION, "수습 감액 — 계약기간",
                f"계약기간이 {ctx.term_months:g}개월(1년 미만)이라 수습 감액을 할 수 없습니다.",
                law=law_key,
                detail="감액은 1년 이상의 근로계약을 맺은 경우에만 허용됩니다.",
                fix="수습기간에도 최저임금 전액을 받아야 합니다."))

        if standards.is_simple_labor(contract.get("job_title")):
            out.append(Finding(
                "probation_simple_labor", VIOLATION, "수습 감액 — 단순노무업무",
                f"'{contract['job_title']}'는 고용노동부가 고시한 단순노무업무로 보입니다. "
                "이 경우 수습을 이유로 최저임금을 깎을 수 없습니다.",
                law=law_key,
                detail="단순노무업무 종사자는 계약기간·수습 여부와 무관하게 감액 대상이 아닙니다.",
                fix="실제 담당 업무가 고시 목록에 해당하는지 ☎1350에서 확인하세요."))

    if not out and prob["exists"]:
        parts = ["수습"]
        if months:
            parts.append(f"{months:g}개월")
        if rate:
            parts.append(f"· 임금 {rate:.0%}")
        out.append(Finding("probation", OK, "수습",
                           " ".join(parts) + " — 법정 기준 안에 있습니다.", law=law_key))
    return out


# ── ③ 근로시간 ────────────────────────────────────────────────────────
def rule_work_hours(contract: dict, ctx: Context) -> list[Finding]:
    hours = contract["hours"]
    out: list[Finding] = []

    if hours["daily_hours"] and hours["daily_hours"] > standards.LEGAL_DAILY_HOURS:
        out.append(_scale(ctx, Finding(
            "daily_hours_over", VIOLATION, "1일 소정근로시간",
            f"1일 소정근로시간이 {hours['daily_hours']:g}시간으로 법정 8시간을 넘습니다.",
            law="근기법 제50조",
            detail="8시간을 넘는 부분은 소정근로가 아니라 연장근로이고, "
                   "연장근로에는 50% 가산수당이 붙어야 합니다.",
            fix="초과분이 연장근로로 처리되고 가산수당이 지급되는지 확인하세요.")))

    if ctx.weekly_hours and ctx.weekly_hours > standards.LEGAL_WEEKLY_HOURS:
        out.append(_scale(ctx, Finding(
            "weekly_hours_over", VIOLATION, "1주 소정근로시간",
            f"1주 소정근로시간이 {ctx.weekly_hours:g}시간으로 법정 40시간을 넘습니다.",
            law="근기법 제50조",
            detail=f"소정근로 40시간 + 연장 최대 12시간 = 1주 {standards.MAX_WEEKLY_TOTAL}시간이 상한입니다.",
            fix="40시간 초과분이 연장근로로 명시되고 가산수당이 붙는지 확인하세요.")))
    elif ctx.weekly_hours:
        out.append(Finding("weekly_hours", OK, "1주 소정근로시간",
                           f"1주 {ctx.weekly_hours:g}시간으로 법정 40시간 이내입니다.",
                           law="근기법 제50조"))
    else:
        out.append(Finding(
            "scheduled_hours_missing", VIOLATION, "소정근로시간 미기재",
            "소정근로시간이 계약서에서 확인되지 않습니다.",
            law="근기법 제17조",
            detail="소정근로시간은 서면 명시 의무 항목입니다. "
                   "이 값이 없으면 최저임금·연장수당 계산 자체가 불가능합니다.",
            fix="1일·1주 몇 시간 근무인지 계약서에 적어 달라고 요구하세요."))

    overtime = hours["weekly_overtime_hours"]
    if overtime and overtime > standards.MAX_WEEKLY_OVERTIME:
        out.append(_scale(ctx, Finding(
            "overtime_over_12h", VIOLATION, "연장근로 한도",
            f"계약서가 정한 1주 연장근로가 {overtime:g}시간으로 법정 한도 12시간을 넘습니다.",
            law="근기법 제53조",
            detail=f"당사자가 합의해도 1주 연장근로는 12시간까지입니다 "
                   f"(소정 40시간을 더해 총 {standards.MAX_WEEKLY_TOTAL}시간).",
            fix="한도를 넘는 근로에 동의했더라도 그 합의는 효력이 없습니다.")))
    elif (ctx.weekly_hours or 0) + (overtime or 0) > standards.MAX_WEEKLY_TOTAL:
        total = (ctx.weekly_hours or 0) + (overtime or 0)
        breakdown = (f"소정 {ctx.weekly_hours:g}시간 + 연장 {overtime:g}시간 = {total:g}시간"
                     if overtime else f"{total:g}시간")
        out.append(_scale(ctx, Finding(
            "weekly_total_over", VIOLATION, "1주 총 근로시간",
            f"1주 근로시간이 {breakdown}으로 상한 {standards.MAX_WEEKLY_TOTAL}시간을 넘습니다.",
            law="근기법 제53조",
            fix="상한을 넘는 근로는 합의가 있어도 허용되지 않습니다.")))

    return out


# ── ④ 휴게 ────────────────────────────────────────────────────────────
def rule_break(contract: dict, ctx: Context) -> list[Finding]:
    hours = contract["hours"]
    daily, given = hours["daily_hours"], hours["break_minutes"]
    if not daily:
        return []

    need = standards.required_break_minutes(daily)
    if not need:
        return []
    if given is None:
        return [Finding("break_missing", CHECK, "휴게시간",
                        f"1일 {daily:g}시간 근무인데 휴게시간이 계약서에서 확인되지 않습니다.",
                        law="근기법 제54조",
                        detail=f"{daily:g}시간 근무에는 최소 {need}분의 휴게가 근로시간 도중에 필요합니다.",
                        fix="휴게시간이 몇 시부터 몇 시까지인지 계약서에 적어 달라고 요구하세요.")]
    if given + 1e-9 < need:
        return [Finding("break_short", VIOLATION, "휴게시간 부족",
                        f"1일 {daily:g}시간 근무에 휴게시간이 {given:g}분입니다. "
                        f"법정 최소는 {need}분입니다.",
                        law="근기법 제54조",
                        detail="4시간이면 30분, 8시간이면 60분 이상이며 근로시간 도중에 주어야 합니다.",
                        fix="부족한 휴게시간만큼은 근로시간으로 보아 임금을 청구할 수 있습니다.")]
    return [Finding("break", OK, "휴게시간",
                    f"1일 {daily:g}시간 근무에 휴게 {given:g}분으로 법정 기준({need}분) 이상입니다.",
                    law="근기법 제54조")]


# ── ⑤ 휴일·연차 ───────────────────────────────────────────────────────
def rule_holiday(contract: dict, ctx: Context) -> list[Finding]:
    holiday = contract["holiday"]
    out: list[Finding] = []

    if holiday["weekly_holiday_paid"] is False:
        out.append(Finding(
            "no_weekly_holiday", VIOLATION, "주휴일",
            "주휴일을 무급으로 하거나 주휴수당을 주지 않는다고 적혀 있습니다.",
            law="근기법 제55조①",
            detail="주휴일은 상시 근로자 5인 미만 사업장에도 적용됩니다. "
                   "1주 15시간 이상 근무하고 소정근로일을 개근하면 발생합니다.",
            fix="주휴수당 미지급은 임금체불입니다. 3년 이내에 청구할 수 있습니다."))
    elif holiday["weekly_holiday_paid"] is True:
        out.append(Finding("weekly_holiday", OK, "주휴일",
                           "주휴일이 유급으로 명시되어 있습니다.", law="근기법 제55조①"))
    else:
        out.append(Finding(
            "weekly_holiday_missing", CHECK, "주휴일",
            "주휴일에 관한 조항이 계약서에서 확인되지 않습니다.",
            law="근기법 제17조",
            detail="주휴일은 서면 명시 의무 항목입니다.",
            fix="주휴일이 언제이고 유급인지 계약서에 적어 달라고 요구하세요."))

    if holiday["annual_leave_granted"] is False:
        out.append(_scale(ctx, Finding(
            "no_annual_leave", VIOLATION, "연차유급휴가",
            "연차유급휴가를 부여하지 않는다고 적혀 있습니다.",
            law="근기법 제60조",
            detail="1년간 80% 이상 출근하면 15일, 1년 미만이면 1개월 개근당 1일이 발생합니다.",
            fix="미사용 연차는 수당으로 청구할 수 있습니다. 시효는 3년입니다.")))
    elif holiday["annual_leave_granted"] is True:
        out.append(Finding("annual_leave", OK, "연차유급휴가",
                           "연차유급휴가 조항이 있습니다.", law="근기법 제60조"))
    else:
        out.append(Finding(
            "annual_leave_missing", CHECK, "연차유급휴가",
            "연차유급휴가에 관한 조항이 계약서에서 확인되지 않습니다.",
            law="근기법 제17조",
            detail="연차유급휴가는 서면 명시 의무 항목입니다.",
            fix="연차 조항을 넣어 달라고 요구하세요."))

    if holiday["public_holiday_paid"] is False:
        out.append(_scale(ctx, Finding(
            "public_holiday_unpaid", VIOLATION, "관공서 공휴일",
            "관공서 공휴일을 무급으로 한다고 적혀 있습니다.",
            law="근기법 제55조②",
            detail="상시 근로자 5인 이상 사업장은 관공서 공휴일을 유급휴일로 보장해야 합니다.",
            fix="5인 이상이라면 공휴일 무급 약정은 효력이 없습니다.")))

    return out


# ── ⑥ 퇴직금 ──────────────────────────────────────────────────────────
def rule_severance(contract: dict, ctx: Context) -> list[Finding]:
    sev = contract["severance"]
    out: list[Finding] = []

    if sev["included_in_wage"] is True:
        out.append(Finding(
            "severance_in_wage", VIOLATION, "퇴직금 분할약정",
            "퇴직금을 매월 급여에 포함해 지급한다고 적혀 있습니다. 이런 분할약정은 무효입니다.",
            law="퇴직급여법 제8조",
            detail="퇴직금은 퇴직할 때 발생하는 것이라 미리 나누어 지급할 수 없습니다. "
                   "이미 나누어 받았더라도 퇴직금을 지급한 것으로 인정되지 않습니다.",
            fix="퇴직 후 14일 이내에 퇴직금을 청구할 수 있습니다. 시효는 3년입니다."))
    elif sev["provided"] is False:
        out.append(Finding(
            "severance_waived", VIOLATION, "퇴직금 미지급 약정",
            "퇴직금을 지급하지 않는다고 적혀 있습니다.",
            law="퇴직급여법 제4조",
            detail="계속근로 1년 이상, 4주 평균 주 15시간 이상이면 사업장 규모와 무관하게 "
                   "퇴직급여를 설정해야 합니다. 5인 미만 사업장도 마찬가지입니다.",
            fix="근로자가 동의했더라도 이 약정은 무효입니다."))
    elif sev["provided"] is True:
        out.append(Finding("severance", OK, "퇴직금",
                           "퇴직금(퇴직급여) 조항이 있습니다.", law="퇴직급여법 제4조"))

    if ctx.weekly_hours is not None and ctx.weekly_hours < standards.SEVERANCE_MIN_WEEKLY_HOURS:
        out.append(Finding(
            "severance_hours_threshold", CHECK, "퇴직금 — 근로시간 요건",
            f"1주 소정근로시간이 {ctx.weekly_hours:g}시간으로 15시간 미만입니다. "
            "이 상태가 유지되면 퇴직급여 대상이 아닙니다.",
            law="퇴직급여법 제4조",
            detail="4주 평균 1주 15시간 이상이어야 퇴직급여가 발생합니다. "
                   "실제 근무가 이보다 많다면 결론이 달라집니다.",
            fix="실제 근무시간을 출퇴근 기록으로 확인하세요."))

    return out


# ── ⑦ 제17조 서면 명시·교부 ───────────────────────────────────────────
def rule_required_items(contract: dict, ctx: Context) -> list[Finding]:
    missing = [label for key, label in schema.REQUIRED_ITEMS.items()
               if contract["required_items"].get(key) is False]
    unknown = [label for key, label in schema.REQUIRED_ITEMS.items()
               if contract["required_items"].get(key) is None]

    out: list[Finding] = []
    if missing:
        out.append(Finding(
            "missing_required", VIOLATION, "서면 명시 항목 누락",
            f"서면에 반드시 적어야 하는 항목 {len(missing)}개가 빠져 있습니다 — {', '.join(missing)}",
            law="근기법 제17조",
            detail="임금의 구성항목·계산방법·지급방법, 소정근로시간, 주휴일, "
                   "연차유급휴가, 취업장소와 업무는 서면 명시 의무 항목입니다.",
            fix="빠진 항목을 적은 계약서를 다시 요구하세요. 미교부·미명시는 별도 벌칙 대상입니다."))
    elif not unknown:
        out.append(Finding("required_items", OK, "서면 명시 항목",
                           "제17조가 요구하는 항목이 모두 적혀 있습니다.", law="근기법 제17조"))

    if contract["copy_given"] is False:
        out.append(Finding(
            "copy_not_given", VIOLATION, "계약서 교부",
            "계약서를 근로자에게 교부하지 않는다고 되어 있습니다.",
            law="근기법 제17조",
            detail="근로계약서는 작성만으로 부족하고 근로자에게 **교부**해야 합니다.",
            fix="사본을 요구하세요. 주지 않으면 그 자체로 노동청 진정 사유입니다."))
    elif contract["copy_given"] is None:
        out.append(Finding(
            "copy_unknown", CHECK, "계약서 교부",
            "계약서를 근로자에게 교부한다는 문구가 확인되지 않습니다.",
            law="근기법 제17조",
            fix="서명 후 반드시 사본을 받아 두세요. 나중에 다툼이 생기면 가장 중요한 증거입니다."))

    return out


# ── ⑧ 계약기간 ────────────────────────────────────────────────────────
def rule_term(contract: dict, ctx: Context) -> list[Finding]:
    if contract["contract_type"] != "fixed_term" or ctx.term_months is None:
        return []
    if ctx.term_months == float("inf"):
        return []
    if ctx.term_months > standards.FIXED_TERM_MAX_MONTHS:
        return [Finding(
            "fixed_term_over_2y", CHECK, "기간제 계약기간",
            f"계약기간이 {ctx.term_months:g}개월로 2년을 넘습니다.",
            law="기간제법 제4조",
            detail="기간제로 2년을 초과해 사용하면 기간의 정함이 없는 근로자로 봅니다. "
                   "근로자에게 불리한 조항은 아니지만, 갱신·정규직 전환 다툼의 근거가 됩니다.",
            fix="2년을 넘겨 계속 일하면 무기계약 전환을 주장할 수 있습니다.")]
    return []


# ── ⑨ 포괄임금 ────────────────────────────────────────────────────────
def rule_inclusive_wage(contract: dict, ctx: Context) -> list[Finding]:
    wage = contract["wage"]
    if not (wage["inclusive"] or wage["fixed_ot_amount"]):
        return []

    hours_note = (f"고정연장수당 {_won(wage['fixed_ot_amount'])}"
                  if wage["fixed_ot_amount"] else "고정연장수당")
    if wage["fixed_ot_hours"]:
        return [Finding(
            "inclusive_wage", CHECK, "포괄임금",
            f"{hours_note}이 월 {wage['fixed_ot_hours']:g}시간분으로 정해져 있습니다.",
            law="근기법 제56조",
            detail="포괄임금 약정은 근로시간 산정이 어려운 경우에만 유효하다는 것이 대법원 입장입니다. "
                   f"실제 연장근로가 월 {wage['fixed_ot_hours']:g}시간을 넘으면 초과분은 별도로 받아야 합니다.",
            fix="출퇴근 기록으로 실제 연장근로 시간을 남겨 두세요. 초과분은 3년 이내 청구할 수 있습니다.")]

    return [Finding(
        "fixed_ot_hours_unclear", CHECK, "포괄임금 — 시간 수 미기재",
        f"{hours_note}은 있는데 **몇 시간분인지** 계약서에 적혀 있지 않습니다.",
        law="근기법 제56조",
        detail="시간 수가 없으면 실제 연장근로가 그 금액을 넘었는지 계산할 수 없습니다. "
               "포괄임금 분쟁에서 가장 자주 문제가 되는 형태입니다.",
        fix="고정연장수당이 월 몇 시간분인지 계약서에 적어 달라고 요구하세요.")]


# ── ⑩ 4대보험 ─────────────────────────────────────────────────────────
_INSURANCE_LABEL = {"employment": "고용보험", "health": "건강보험",
                    "pension": "국민연금", "accident": "산재보험"}


def rule_insurance(contract: dict, ctx: Context) -> list[Finding]:
    ins = contract["insurance"]
    excluded = [label for key, label in _INSURANCE_LABEL.items() if ins.get(key) is False]
    included = [label for key, label in _INSURANCE_LABEL.items() if ins.get(key) is True]

    if "산재보험" in excluded:
        # 근거는 산업재해보상보험법이지만 조문 표에 없습니다.
        # 조문 번호를 지어내는 대신 법 이름만 쓰고 law 는 비워 둡니다.
        return [Finding(
            "no_accident_insurance", VIOLATION, "산재보험",
            "산재보험에 가입하지 않는다고 적혀 있습니다.",
            detail="산재보험은 근로자를 사용하는 모든 사업장의 의무가입 대상이고 "
                   "보험료는 전액 사업주가 부담합니다. 미가입 상태에서 다쳐도 "
                   "근로복지공단에 산재를 신청할 수 있습니다.",
            fix="가입 여부는 근로복지공단(☎1588-0075)에서 확인할 수 있습니다.")]
    if excluded:
        return [Finding(
            "insurance_excluded", CHECK, "4대보험",
            f"{', '.join(excluded)}에 가입하지 않는다고 되어 있습니다.",
            detail="주 15시간 미만 초단시간 근로 등 법정 적용 제외 사유가 있으면 적법할 수 있습니다. "
                   "그 사유가 없는데 빠져 있다면 확인이 필요합니다.",
            fix="실제 근로시간과 가입 요건을 ☎1350에서 확인하세요.")]
    if len(included) == 4:
        return [Finding("insurance", OK, "4대보험", "4대보험 가입이 명시되어 있습니다.")]
    return []


# ── ⑪ 상시 근로자 수 ──────────────────────────────────────────────────
def rule_headcount(contract: dict, ctx: Context) -> list[Finding]:
    if ctx.headcount is not None:
        return []
    return [Finding(
        "headcount_unknown", CHECK, "상시 근로자 수",
        "계약서에 상시 근로자 수가 없어 5인 미만 사업장인지 판단하지 못했습니다.",
        detail="상시 근로자 5인 미만이면 연장·야간·휴일 가산수당(제56조), 연차(제60조), "
               "근로시간 제한(제50조·제53조), 부당해고 구제(제23조)가 적용되지 않습니다. "
               "이 진단은 5인 이상이라고 **가정하지 않았습니다.**",
        fix="함께 일하는 사람이 몇 명인지 확인하면 판정이 확정됩니다.")]


# ── ⑫ 조항 기반 규칙 ──────────────────────────────────────────────────
# 모델이 원문을 인용해 코드를 붙인 조항을 판정으로 옮깁니다.
# 판정 수위(level)와 조문은 **여기 표가 정합니다.** 모델이 정하지 않습니다.
CLAUSE_RULES: dict[str, dict] = {
    "penalty_predetermined": {
        "level": VIOLATION, "law": "근기법 제20조", "title": "위약금 예정",
        "message": "근로계약 불이행에 대한 위약금·손해배상액을 미리 정한 조항이 있습니다.",
        "fix": "이런 약정은 효력이 없습니다. 청구를 받아도 응하기 전에 ☎1350에 상담하세요.",
    },
    "damages_actual": {
        "level": CHECK, "law": "근기법 제20조", "title": "손해배상 조항",
        "message": "실제 발생한 손해를 배상한다는 조항입니다. 금액을 미리 정한 것이 아니라 "
                   "위약 예정 금지에 곧바로 걸리지는 않습니다.",
        "fix": "고의·중과실이 없는 통상적 업무상 실수까지 배상하도록 운용된다면 다툴 수 있습니다.",
    },
    "wage_offset": {
        "level": VIOLATION, "law": "근기법 제43조", "title": "임금 공제·상계",
        "message": "손해액이나 대여금을 임금에서 공제·상계한다는 조항이 있습니다.",
        "fix": "법령·단체협약 근거가 없는 공제는 전액 지급 원칙 위반입니다. 공제된 금액을 청구할 수 있습니다.",
    },
    "forced_saving": {
        "level": VIOLATION, "law": "근기법 제22조", "title": "강제 저금",
        "message": "급여의 일부를 회사가 적립·관리한다는 조항이 있습니다.",
        "fix": "근로계약에 저축을 부수시키는 약정은 금지됩니다.",
    },
    "severance_waived": {
        "level": VIOLATION, "law": "퇴직급여법 제4조", "title": "퇴직금 배제",
        "message": "퇴직금을 지급하지 않거나 월급에 포함한다는 조항이 있습니다.",
        "fix": "근로자가 동의했더라도 무효입니다. 퇴직 후 3년 이내에 청구할 수 있습니다.",
    },
    "at_will_dismissal": {
        "level": VIOLATION, "law": "근기법 제23조", "title": "임의 해고",
        "message": "회사가 필요하다고 판단하면 언제든 해고할 수 있다는 조항이 있습니다.",
        "fix": "부당해고 구제신청은 해고일로부터 3개월 이내입니다. 기한이 짧으니 서두르세요.",
    },
    "marriage_retirement": {
        "level": VIOLATION, "law": "남녀고용평등법 제11조②", "title": "혼인·임신 퇴직 예정",
        "message": "혼인·임신·출산을 퇴직 사유로 예정한 조항이 있습니다.",
        "fix": "이 약정은 무효입니다. 이를 이유로 한 퇴직 강요는 별도 위반입니다.",
    },
    "no_annual_leave": {
        "level": VIOLATION, "law": "근기법 제60조", "title": "연차 배제",
        "message": "연차유급휴가를 부여하지 않는다는 조항이 있습니다.",
        "fix": "미사용 연차는 수당으로 청구할 수 있습니다.",
    },
    "no_weekly_holiday": {
        "level": VIOLATION, "law": "근기법 제55조①", "title": "주휴수당 배제",
        "message": "주휴일·주휴수당을 주지 않는다는 조항이 있습니다.",
        "fix": "주휴수당 미지급은 임금체불입니다. 5인 미만 사업장에도 적용됩니다.",
    },
    "unpaid_training": {
        "level": CHECK, "law": None, "title": "교육·대기 시간",
        "message": "교육이나 대기 시간을 근로시간에서 제외한다는 조항이 있습니다.",
        "fix": "사용자의 지휘·감독 아래 있었다면 근로시간입니다. 실제 운용을 확인하세요.",
    },
    "noncompete": {
        "level": CHECK, "law": None, "title": "경업금지",
        "message": "퇴직 후 동종업계 취업을 제한하는 조항이 있습니다.",
        "fix": "기간·지역·직종이 과도하거나 보상이 없으면 무효로 판단될 수 있습니다. "
               "서명 전에 범위를 좁혀 달라고 요구하세요.",
    },
    "confidentiality_penalty": {
        "level": CHECK, "law": "근기법 제20조", "title": "비밀유지 위반 배상",
        "message": "비밀유지 위반 시 배상 조항이 있습니다.",
        "fix": "배상액을 미리 못 박은 형태라면 위약 예정 금지에 걸립니다. 금액 명시 여부를 확인하세요.",
    },
    "duty_change_broad": {
        "level": CHECK, "law": None, "title": "업무·근무지 변경",
        "message": "회사가 업무나 근무지를 변경할 수 있다는 조항이 있습니다.",
        "fix": "통상적 인사권 범위면 유효합니다. 생활상 불이익이 크면 다툴 수 있습니다.",
    },
    "other": {
        "level": CHECK, "law": None, "title": "그 밖에 불리해 보이는 조항",
        "message": "표준 계약서에서는 보기 어려운 조항입니다.",
        "fix": "무슨 뜻인지 서명 전에 확인하세요. ☎1350에서 무료로 물어볼 수 있습니다.",
    },
}


def rule_clauses(contract: dict, ctx: Context) -> list[Finding]:
    out: list[Finding] = []
    seen: set[tuple[str, str]] = set()

    for clause in contract["clauses"]:
        spec = CLAUSE_RULES.get(clause["code"]) or CLAUSE_RULES["other"]
        key = (clause["code"], clause["quote"][:60])
        if key in seen:
            continue
        seen.add(key)

        out.append(_scale(ctx, Finding(
            code=clause["code"],
            level=spec["level"],
            title=spec["title"],
            message=spec["message"],
            law=spec["law"],
            detail=clause.get("note"),
            evidence=clause["quote"],
            fix=spec["fix"],
        )))
    return out


# ── 실행 ──────────────────────────────────────────────────────────────
RULES = (
    rule_min_wage,
    rule_probation,
    rule_work_hours,
    rule_break,
    rule_holiday,
    rule_severance,
    rule_required_items,
    rule_term,
    rule_inclusive_wage,
    rule_insurance,
    rule_headcount,
    rule_clauses,
)

# 정렬 순서 — 화면에서 위험한 것이 위로 옵니다.
_ORDER = {VIOLATION: 0, CHECK: 1, OK: 2, EXCLUDED: 3}


def build_context(contract: dict, year: int | None = None) -> Context:
    wage = standards.min_wage(year)
    weekly = schema.weekly_hours(contract)
    return Context(
        year=standards.min_wage_year(year),
        min_hourly=wage["hourly"],
        min_monthly_209=wage["monthly_209"],
        headcount=contract.get("headcount"),
        weekly_hours=weekly,
        monthly_hours=standards.monthly_scheduled_hours(weekly) if weekly else None,
        term_months=schema.term_months(contract),
    )


def evaluate(contract: dict, year: int | None = None) -> dict:
    """정규화된 계약 정보 → 판정 결과.

    LLM을 호출하지 않습니다. 같은 입력이면 항상 같은 출력입니다.
    이 결정성이 이 기능이 상담 서비스로 쓰일 수 있는 근거입니다.
    """
    ctx = build_context(contract, year)

    findings: list[Finding] = []
    for rule in RULES:
        findings.extend(rule(contract, ctx))

    findings = _dedupe(findings)
    findings.sort(key=lambda f: (_ORDER.get(f.level, 9), f.code))
    rows = [f.to_dict() for f in findings]

    counts = {level: sum(1 for f in findings if f.level == level)
              for level in (VIOLATION, CHECK, OK, EXCLUDED)}

    return {
        "findings": rows,
        "counts": counts,
        "headline": _headline(counts),
        "basis": {
            "year": ctx.year,
            "min_hourly": ctx.min_hourly,
            "min_monthly_209": ctx.min_monthly_209,
            "weekly_hours": ctx.weekly_hours,
            "monthly_hours": ctx.monthly_hours,
            "headcount": ctx.headcount,
            "term_months": None if ctx.term_months in (None, float("inf")) else ctx.term_months,
            "assumed_5plus": False,
        },
    }


# 같은 사실을 두 규칙이 각자 잡는 쌍. 앞쪽이 살아 있으면 뒤쪽은 지웁니다.
# 예 — 퇴직금 월급 포함은 rule_severance(계약 필드)와 rule_clauses(조항 인용) 양쪽에서 납니다.
_SUPERSEDES = {"severance_in_wage": "severance_waived"}


def _dedupe(findings: list[Finding]) -> list[Finding]:
    """같은 판정이 두 번 뜨는 것을 정리합니다.

    조항 기반 규칙과 필드 기반 규칙이 같은 사실을 각자 잡습니다.
    "연차를 부여하지 않는다"는 `holiday.annual_leave_granted=False`(필드)로도,
    `clauses[no_annual_leave]`(원문 인용)로도 들어옵니다.
    화면에 같은 항목이 두 번 뜨면 위반 건수가 부풀려져 보입니다.

    같은 code 가 여럿이면 **원문 인용(evidence)이 있는 쪽을 남깁니다.**
    사용자가 계약서의 어느 줄인지 찾을 수 있어야 하기 때문입니다.
    """
    have_evidence = {f.code for f in findings if f.evidence}
    superseded = {_SUPERSEDES[f.code] for f in findings if f.code in _SUPERSEDES}

    out: list[Finding] = []
    seen: set[tuple[str, str | None]] = set()
    for finding in findings:
        if finding.code in superseded:
            continue
        # 인용이 있는 같은 코드가 따로 있으면, 인용 없는 쪽은 버립니다.
        if finding.evidence is None and finding.code in have_evidence:
            continue
        key = (finding.code, finding.evidence)
        if key in seen:
            continue
        seen.add(key)
        out.append(finding)
    return out


def _headline(counts: dict) -> str:
    """한 줄 요약. **점수·등급을 붙이지 않습니다** (ADR-0001·0003)."""
    if counts[VIOLATION]:
        return (f"법정 기준에 미달하는 조항이 {counts[VIOLATION]}건 확인됐습니다."
                + (f" 함께 확인할 항목이 {counts[CHECK]}건 있습니다." if counts[CHECK] else ""))
    if counts[CHECK]:
        return f"법정 기준에 명백히 미달하는 조항은 없고, 확인이 필요한 항목이 {counts[CHECK]}건 있습니다."
    if counts[OK]:
        return "확인한 항목은 모두 법정 기준을 충족합니다."
    return "계약서에서 판정할 수 있는 항목을 찾지 못했습니다."
