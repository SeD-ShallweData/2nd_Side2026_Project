# 공개 API·AI 상담 개인정보 정책 계약

기준일: 2026-09-21

이 문서는 후속 9의 추천 기본안을 사용자가 채택한 결과다. 실제 원격 `main`
`ce87dacf`에는 이 항목을 달리 정한 구현이나 문서가 없었다. 코드가 강제하는 계약과
운영자가 배포 전에 확인해야 하는 계약을 구분한다.

## 코드가 강제하는 계약

- 공개 회사 검색은 한 요청에 20건, 50페이지, 최대 1,000건 window만 제공한다.
  `total`은 1,000에서 잘리고 `total_is_capped=true`일 때 UI는 `1,000+`로 표시한다.
- 지역·업종 모집단은 exact count 대신 `1–9`, `10–49`, `50–99`, `100–499`,
  `500–999`, `1,000+` 구간으로 공개한다. DTO의 `count`는 지도 음영용 구간 하한이다.
- 공개 위험 결과는 검토된 표시 level·availability·confidence·기준일과 stable public
  card ID만 제공한다. 내부 batch/model/pipeline 식별자는 공개 source에 내보내지 않는다.
- 익명 상담은 IP와 탭 단위 browser marker를 해시한 key로 시간당 10회, 일 30회,
  전체 일 1,000회로 제한한다. 회사 검색은 분당 30회다. raw IP와 marker는 저장하지 않는다.
- 일반 상담은 매 요청마다 외부 AI 전송 동의를 요구한다. 비교 모드는 비교 체크가 두 번째
  공급자 전송 동의다. 지속 동의는 저장하지 않으므로 체크 해제가 미래 전송을 즉시 막는다.
- 전송 범위는 현재 질문, 최근 최대 10개 표시 메시지, 서버의 30일 요약, 선택 회사의
  공개 allowlist, 현재 공식 검색 근거다. 비밀 키, DB 내부 score/rank, client 주입 memory는 제외한다.
- 상담방 원문·표시 답변·sources·summary·request ledger·company events는 마지막 활동부터
  함께 30일 보존하고 thread hard delete로 cascade 삭제한다. 90일 cross-feature memory는 도입하지 않는다.
- `chat_memory_events`와 `chat_memory_consents`는 이번 릴리스에 도입하지 않는다.
  회사 전환은 `conversation_company_events`, 관심 사업장은 favorites가 정본이다.
- 일반 사용자는 `계정 삭제` 확인 뒤 자신의 user row를 물리 삭제할 수 있다. FK cascade로
  session, 상담 데이터, favorites와 현재 schema의 user 연결 데이터를 제거한다. 관리자와 감독관은
  이 공개 경로에서 삭제할 수 없다.
- 상담 request는 2분 lease를 쓴다. 같은 `request_id`의 유효 lease 중복은 409이며,
  만료 후 같은 ID로 재획득할 수 있다. lease token fencing으로 늦은 이전 응답 저장을 막는다.

## 배포 전에 운영 환경에서 강제해야 하는 계약

- 여러 app instance에서는 process-local quota가 합산되지 않는다. edge/gateway 또는 공유 저장소에
  같은 검색·익명 상담 한도를 설정하고, 신뢰 proxy가 외부 client의 forwarding header를 제거한 뒤
  `TRUST_PROXY_HEADERS=true`를 사용한다.
- `ANONYMOUS_CHAT_GLOBAL_PER_DAY`는 공급자 비용 예산에 맞춰 승인된 값으로 설정하고 429·예산 차단
  metrics/alert를 연결한다. 기본 1,000회는 코드 fallback이며 재무 승인값이 아니다.
- live DB 삭제는 즉시 반영한다. backup은 최대 30일 뒤 만료하며, restore한 DB는 서비스 개방 전에
  현재 expiry cutoff와 삭제 journal/tombstone을 재적용한다. 실제 backup catalog/TTL/rehearsal은 별도 증거가 필요하다.
- 외부 LLM은 무학습, 승인된 처리 지역, 계약상 최소 보존 또는 최대 30일 조건을 조달 문서에서 확인한다.
  철회는 미래 전송과 local 식별 데이터 삭제를 즉시 적용하고, 과거 provider 데이터는 해당 계약의
  삭제 API 또는 TTL을 따른다고 고지한다.
- `SAVE_COMPARISON_FEEDBACK=true` 공개 운영은 금지한다. server-issued comparison ledger 확인,
  원문 없는 90일 TTL, rotation/purge, 필요한 경우에만 pseudonymous user/conversation 연결을 구현한 뒤 켠다.

## 외부 공급자 공개 정책 조사 (2026-09-28)

[개인 후속 06 보고서](../qa/2026-09-28-personal-06.md)가 상품별 공개 근거, 계정 적용 확인, 서비스 정책 대조를 분리해 기록한다. 이 조사는 기존 **무학습·승인 처리 지역·계약상 최소 보존 또는 최대 30일** 조건을 변경하지 않는다.

- 기본 Upstage 동기 Solar API의 [현행 약관 제22조](https://www.upstage.ai/terms-of-service)는 일반적인 개선·학습 배제 원칙과 별도 동의, 서비스 운영상 저장 예외, 무상 서비스의 개선·학습 예외를 구분한다. [최신 개인정보처리방침](https://www.upstage.ai/privacy-policy/updated-sep-21-2026-ko)은 API 로깅 opt-in, 무상 API, 비동기 API, File Search를 각각 별도 항목으로 둔다. 동기 API의 운영/오류 로그 보존 상한과 이 계정의 상품·동의·처리 지역은 공개 문서만으로 확정할 수 없다.
- SKT A.X-K1은 비교 요청에만 구성된 공급자다. 이 API 상품에 적용되는 보존·학습·지역·삭제 조건의 공식 약관과 계정 적용을 확인하지 못했다. OpenAI Responses는 선택 모드일 뿐 이번 로컬 활성 경로가 아니므로 조사 범위에서 제외했다. 운영 인스턴스 활성 모드는 별도 확인이 필요하다.
- 사용자 상담 삭제는 로컬 저장소를 지우지만 공급자 과거 데이터까지 즉시 지운다는 의미가 아니다. 공급자 삭제 API/요청 또는 계약상 TTL을 계정별로 확인해야 한다. 미확인 항목을 고지문만 바꿔 충족 처리하지 않는다.

## 현재 미확인으로 남는 외부 사실

- 활성 Upstage/SKT 계정·개별 계약의 상품 구분, 예외 포함 보존 기간, 학습/로깅 동의, 처리 지역, 삭제 요청 지원 여부. OpenAI는 운영에서 활성화될 때 별도 조사한다.
- 운영 backup 실제 TTL과 restore 후 삭제 재적용 자동화
- 운영 gateway의 공유 quota 저장소, trusted proxy header 정규화, budget alert

공개 공급자 정책은 위와 같이 조사했지만 계정 적용과 운영 환경의 세 항목은 아직 확인되지 않았다. 코드 기본값만으로 충족됐다고 판단하지 않는다.
