import type { EvalTurn } from './memory-comparison-core';
export const COMPANY_A = 'COMPANY_DEMO_008';
export const COMPANY_B = 'UNKNOWN_SAFETY_001';
/** Recombines existing development themes; never an independent evaluation set. */
const input: Array<[string | null, string]> = [
  [COMPANY_A, '한빛테크에서 일합니다. 급여일은 매월 10일이고 이번 달 월급을 받지 못했습니다. 근로계약서 종이 원본과 통장 사본을 갖고 있습니다.'],
  [COMPANY_A, '한빛테크는 문자로 다음 주에 지급하겠다고 했습니다. 정확한 날짜는 아직 받지 못했습니다.'],
  [COMPANY_A, '정정합니다. 한빛테크 급여일은 10일이 아니라 15일입니다. 아직 미지급입니다.'],
  [COMPANY_A, '회사의 문자 원문과 발신자 번호를 보관하고 있습니다.'],
  [COMPANY_A, '미지급 금액은 아직 말하지 않았고 퇴직한 것도 아닙니다.'],
  [COMPANY_A, '근무기록은 개인 수첩에 적어 두었습니다. 자료를 정리하고 있습니다.'],
  [COMPANY_A, '문자를 지우지 않고 보관하고 있습니다. 새 지급 소식은 없습니다.'],
  [COMPANY_B, '다른 회사 푸른건설 상담으로 바꿉니다. 푸른건설의 급여일은 25일입니다. 한빛테크와 별개입니다.'],
  [COMPANY_B, '푸른건설은 아직 지급 약속을 하지 않았습니다.'],
  [COMPANY_B, '정정합니다. 푸른건설 급여일은 25일이 아니라 27일입니다.'],
  [COMPANY_B, '푸른건설의 근로계약 조건은 별도로 확인하고 있습니다.'],
  [COMPANY_B, '푸른건설 상담 기록은 한빛테크 기록과 섞지 않고 있습니다.'],
  [null, '회사 선택을 해제했습니다. 잠깐 다른 주제로 아파트 시세가 궁금합니다.'],
  [null, '투자 추천은 그만하고 노동 상담으로 돌아가겠습니다.'],
  [null, '기존 상담 기록은 그대로 두고 추가 자료를 정리하고 있습니다.'],
  [COMPANY_B, '푸른건설 상담을 다시 선택했습니다. 새 지급 약속은 받지 못했습니다.'],
  [COMPANY_B, '현재 가지고 있는 자료를 확인 중입니다. 새 금액을 확정한 것은 없습니다.'],
  [COMPANY_B, '회사 문의 내역을 날짜 순서로 정리하고 있습니다.'],
  [COMPANY_B, '오늘 새로 받은 지급 답변은 없습니다. 기존 기록만 있습니다.'],
  [COMPANY_B, '지금은 푸른건설 상담입니다. 다른 회사의 사실과 구분하려고 합니다.'],
  [COMPANY_A, '한빛테크 상담으로 돌아왔습니다. 이전 정정 내용을 유지합니다.'],
  [COMPANY_A, '한빛테크에 관해 새로 확정한 금액이나 지급 날짜는 없습니다.'],
  [COMPANY_A, '기존 자료를 보관하며 상담을 이어가고 있습니다.'],
  [COMPANY_A, '근무 관련 기록을 날짜 순서대로 정리하고 있습니다.'],
  [COMPANY_A, '앞선 다른 회사 상담은 별개로 남겨 주세요.'],
  [COMPANY_A, '다시 한빛테크 노동 상담을 이어가겠습니다. 새 사실은 추가하지 않았습니다.'],
];
export const HISTORY: EvalTurn[] = input.map(([company_id, user], index) => ({ index: index + 1, company_id, user,
  assistant: index === 12 ? '이 서비스는 노동 상담 범위의 질문을 안내합니다.' : '말씀하신 내용은 사용자 진술로 기록하며 확인되지 않은 금액이나 날짜를 단정하지 않겠습니다.' }));
const paydayA = { fact: 'A corrected payday', pattern: '15일' };
const promiseA = { fact: 'A relative promise', pattern: /다음\s*주/.source };
const unknownAmount = { fact: 'amount unknown', pattern: '(금액.{0,60}(?:모르|알려|말씀|말하지|미확인|확인되지|없|확정)|(?:모르|없|미확인).{0,30}금액)' };
export const FIXED_PROBES = [
  { id: 'F05-boundary-before', turns: 5, company_id: COMPANY_A,
    question: '한빛테크 상담에서 제가 정정한 급여일과 회사의 지급 약속을 정리하고, 지금 할 일을 알려주세요.', expected: [paydayA, promiseA] },
  { id: 'F06-boundary-after', turns: 6, company_id: COMPANY_A,
    question: '한빛테크 상담에서 제가 정정한 급여일과 회사의 지급 약속을 정리하고, 지금 할 일을 알려주세요.', expected: [paydayA, promiseA] },
  { id: 'F20-company-topic-return', turns: 20, company_id: COMPANY_B,
    question: '다른 주제에서 돌아왔습니다. 푸른건설에 대해 제가 마지막으로 정정한 급여일은 언제이고, 지급 약속을 받은 상태인가요? 지금 할 일도 알려주세요.',
    expected: [{ fact: 'B corrected payday', pattern: '27일' }, { fact: 'B no promise', pattern: '(약속.{0,40}(?:없|받지|미확인|아직)|(?:없|받지|아직).{0,40}약속)' }] },
  { id: 'F26-old-facts', turns: 26, company_id: COMPANY_A,
    question: '한빛테크에 대해 처음 가지고 있다고 말한 자료 두 종류, 정정한 급여일, 회사 지급 약속과 미지급 금액을 말씀드렸는지 정리하고 다음 행동을 알려주세요.',
    expected: [paydayA, promiseA, { fact: 'original contract', pattern: '근로계약서' }, { fact: 'bank copy', pattern: '통장' }, unknownAmount] },
];
export const CONTINUOUS_PROBES = [
  { id: 'L23-recall', company_id: COMPANY_A, question: '한빛테크로 돌아왔습니다. 제가 정정한 급여일과 회사 지급 약속을 정리하고 지금 할 일을 알려주세요.', expected: [paydayA, promiseA] },
  { id: 'L24-new-correction', company_id: COMPANY_A, question: '한빛테크 급여일을 다시 정정합니다. 15일이 아니라 18일입니다. 새 날짜로 내용을 정리해 주세요.', expected: [{ fact: 'A new correction', pattern: '18일' }] },
  { id: 'L25-switch-B', company_id: COMPANY_B, question: '이번에는 푸른건설입니다. 이 회사에 관해 제가 정정한 급여일과 지급 약속 유무를 알려주세요. 한빛테크와 구분해 주세요.',
    expected: [{ fact: 'B corrected payday', pattern: '27일' }, { fact: 'B no promise', pattern: '(약속.{0,40}(?:없|받지|미확인|아직)|(?:없|받지|아직).{0,40}약속)' }] },
  { id: 'L26-clear-both', company_id: null, question: '회사 선택을 해제했습니다. 두 회사의 마지막 정정 급여일을 회사명과 함께 구분해 주세요. 제가 미지급 금액도 말했나요?',
    expected: [{ fact: 'A named', pattern: '한빛테크' }, { fact: 'A new correction', pattern: '18일' }, { fact: 'B named', pattern: '푸른건설' }, { fact: 'B corrected payday', pattern: '27일' }, unknownAmount] },
];
