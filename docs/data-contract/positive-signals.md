# 긍정 신호 공개 계약 — C2 변경 제안

2026-09-13. 기존 개수 비공개 정책을 개수·확인 항목 공개로 변경하는 PR 검토안. 팀 검토 후 병합 시 적용한다.

## 공개 응답

`wage_risk.positive_signals`는 이전 응답과 호환되는 선택 필드다.

```json
{
  "availability": "ready",
  "confirmed_count": 2,
  "items": [
    {"label": "고용 안정", "status": "confirmed"},
    {"label": "성실 납부", "status": "unconfirmed"},
    {"label": "인건비 안정", "status": "unconfirmed"},
    {"label": "인력 유지", "status": "unconfirmed"},
    {"label": "업력 약 3년 이상", "status": "confirmed"},
    {"label": "낮은 변동성", "status": "unconfirmed"}
  ]
}
```

원시 g1~g6 코드·boolean 배열·점수·가중치·임계값은 공개하지 않는다. 위 예시는 합성 데이터다. ‘성실 납부’를 모든 세금·보험 완납으로 확대 해석하지 않는다. G5는 원시 판정을 사용하며 36개월 기준으로 재계산하지 않는다.

## 자료와 일관성

현재 사업장과 같은 최신 기준 배치의 scored_active에서 여섯 boolean을 가져온다. 모두 확인 가능할 때 true 수를 계산하며 기존 n_green이 있으면 일치 여부도 확인한다. 불일치·일부 누락·unknown·배치 불일치에서는 availability=unavailable, confirmed_count=null로 반환하고 체크를 표시하지 않는다. API 전체 장애에서는 필드가 없을 수 있다.

0은 여섯 값이 모두 확인되고 true가 없다는 뜻이다. null은 개수를 확정하지 못했다는 뜻이다. unconfirmed는 기업의 위법·위험·체불을 뜻하지 않는다. 완전한 데이터가 없는 경우 기존 n_green만으로 개수를 표시하지 않으므로 이전 화면과 표시가 달라질 수 있다.

## 화면과 상담

화면은 ready일 때 이름 6개와 confirmed 체크 및 개수를 표시한다. 미확인 기업이 부정적인 기업이라는 뜻은 아니라고 설명한다. 기존 배제 배지와 공식 명단 사실은 유지한다. 긍정 개수로 배지를 재산정하지 않는다.

비교 상담의 publicSignalForPrompt는 availability·confirmed_count·confirmed_items(확인된 이름 목록)만 전달한다. Responses 도구는 공개 응답을 전달한다. 개수에서 점수·순위·확률을 만들지 않으며 안전 인증·입사 권고·부정 기업 판정을 하지 않는다. 제공되지 않은 개수·누락 이유는 추측하지 않는다.

## 검증과 남은 확인

자동 테스트는 동일 배치 변환, null/0, 개수 불일치, 원시 코드 비노출, 두 모델 입력, 화면의 확인 표시와 중립 설명을 검사한다. 실제 DB 연결 및 실제 모델의 의미적 준수율은 별도 실환경 확인이 필요하다. 감독관 전용 필드와 데이터는 이번 변경 대상이 아니다.
