# 성현 담당 과제 인계 현황 — 2026-09-18

기준: main `b413498` 및 [이번 주 과제](https://app.notion.com/p/3cd8ded8ca0780969e35dfc72bc0f324). 사용자 확인에 따라 이미 수행한 전달 업무를 반복하지 않고, 실제 계약서 재시험과 기억 시스템 구현은 해당 팀 담당 범위로 분리한다.

## 과제별 상태

| 과제 | 현재 상태 | 근거·후속 범위 |
| --- | --- | --- |
| 가드레일 표현 보강 | 구현·병합 완료 | [#79](https://github.com/SeD-ShallweData/2nd_Side2026_Project/pull/79), [#90](https://github.com/SeD-ShallweData/2nd_Side2026_Project/pull/90). 전체 한국어 표현을 포괄한다는 뜻은 아님 |
| 범위 밖 질문 회사 요약 분기 | 구현·병합 완료, 팀 후속 수정 반영 | [#80](https://github.com/SeD-ShallweData/2nd_Side2026_Project/pull/80), [#82](https://github.com/SeD-ShallweData/2nd_Side2026_Project/pull/82), [#96](https://github.com/SeD-ShallweData/2nd_Side2026_Project/pull/96) |
| QA용 PDF 제작·전달 | 제작 완료. 전달 업무는 사용자 확인상 대부분 완료 | 정상·부당·경계 3종 제작을 다시 수행하지 않음. 개별 수신 결과를 새로 확인했다고 주장하지 않음 |
| C4 계약 규칙 3건 | 구현·병합 완료 | [#78](https://github.com/SeD-ShallweData/2nd_Side2026_Project/pull/78). 법적 판단 조건의 별도 합의와 실제 문서 검증은 구현 사실과 구별 |
| PDF 업로드 E2E | 팀 재시험으로 인계 | 다른 팀원이 다양한 계약서를 재시험하고 문제 발생 시 수정. 이번에 실행 완료 처리하지 않음 |
| C3 기본 모델 | 구현·병합 완료 | [#70](https://github.com/SeD-ShallweData/2nd_Side2026_Project/pull/70), 기본 Upstage·선택적 SKT 비교 |
| C5 계약 검토 부분 성공 | 구현·병합 완료 | [#68](https://github.com/SeD-ShallweData/2nd_Side2026_Project/pull/68) |
| C6 문서 상태 정리 | 이번 문서 변경으로 보완 | 과거 C3·C4 기록에 현재 반영 상태 추가, 긍정 신호의 과거 정책과 현재 구현 구분 |
| 39 기억 저장 대상·민감정보 규칙 | 담당 초안 작성 완료, 저장소 인계 | [메모리 초안](../data-contract/conversation-memory.md). 팀 정책 확정·DB·전체 시스템 구현은 별도 담당 |
| 웹 QA·긍정 지표 점검 | 9월 17일 API 점검 기록 있음 | [실측 보고서](2026-09-17-positive-signals-live-check.md). 브라우저 E2E나 #96 배포 후 재검증 완료는 아님 |

## 이번에 정리한 문서

1. [긍정 신호 공개 계약](../data-contract/positive-signals.md)의 ‘병합 시 적용’ 표기를 #67 병합 사실로 갱신했다. 정책의 별도 합의까지 완료됐다고 기록하지 않는다.
2. [임금 데이터 계약](../data-contract/wage-risk.md)에서 원시 n_green 비공개와 검증된 confirmed_count 공개를 구별했다. 개수 삭제 요청은 9월 8~9일 당시 이력으로 표시했다.
3. [기존 C3·C4·C6 검토](2026-09-13-followup-review.md)와 [C4 구현 문서](2026-09-15-contract-rules-implementation.md)에 후속 병합 상태를 추가했다. 과거 측정 수치와 법적 판단안은 재작성하지 않았다.
4. 기존 로컬 메모리 초안을 저장소에 보존하고 기간·삭제·민감정보 제거·승인 정책의 팀 결정 항목을 분리했다. 스키마나 런타임 동작을 구현한 것은 아니다.

## 중복 작업을 피할 것

9월 17일의 반복 확인 질문·답변 작성 지침 출력 문제는 사용자의 중단 요청에 따라 이번에 추가 진단하지 않는다. #96에는 회사 자료 전용 경로, 의도 분류와 RAG 업무 배경 처리, 회사 답변 대체 및 출력 검사 수정이 포함됐다. 그 PR은 mock 회사 + 실제 로컬 RAG/Upstage 검사 결과를 기록하며 운영 PostgreSQL·배포·브라우저 E2E까지 완료했다고 주장하지 않는다. 기존 진단을 현재 코드의 미해결 결과로 재사용하지 않는다.

## 팀이 결정하거나 재시험할 것

- 기억 보존기간·저장 전 민감정보 제거·삭제 방식·동의 범위의 정책 확정과 후속 시스템 구현.
- 계약서 다양한 입력의 재시험 결과와 발견한 실패 사례.
- 필요 시 변경된 상담 경로의 배포 환경 QA. 이전 #82의 80문항 미실행 기록을 #96 평가 결과와 합산하지 않는다.

이 문서 작성으로 위 팀 작업까지 완료 처리하지 않는다. 팀 메시지 전송·서비스 배포·노션 체크 변경은 수행하지 않았다.
