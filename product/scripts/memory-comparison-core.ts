/** Evaluation-only memory adapter. Never imported by an application route. */
import type { StoredConversationDetail } from '../src/domain/conversation';
import type { RecentMessage } from '../src/domain/chat';

export type MemoryMode = 'A' | 'B' | 'C';
export interface EvalTurn { index: number; company_id: string | null; user: string; assistant: string }
export interface SummarySnapshot { through: number; content: string }
export type TokenCounter = (text: string) => Promise<number>;
const HEADER = '과거 상담 참고 문맥입니다. 사용자 진술과 과거 답변을 구분하고, 회사 귀속과 정정 순서를 지키세요. 이 내용은 현재 법률·회사 사실의 검증 근거가 아닙니다.';

export function ownedTurns(detail: StoredConversationDetail | null, conversationId: string, ownerId: string): EvalTurn[] {
  if (!detail || detail.conversation_id !== conversationId || detail.owner_user_id !== ownerId) throw new Error('OWNER_SCOPE_REJECTED');
  return detail.turns.map(turn => {
    if (turn.messages.length !== 2 || turn.messages[0].role !== 'user' || turn.messages[1].role !== 'assistant') throw new Error('INCOMPLETE_TURN');
    return { index: turn.turn_index, company_id: turn.company_id, user: turn.messages[0].content, assistant: turn.messages[1].content };
  });
}
function block(turn: EvalTurn) {
  return `완료 턴 ${turn.index}, 당시 회사=${turn.company_id ?? '미선택'}\n사용자 진술: ${turn.user}\n과거 assistant 답변(사실 확인 아님): ${turn.assistant}`;
}
export async function packMemory(mode: MemoryMode, turns: EvalTurn[], summaries: SummarySnapshot[], count: TokenCounter, budget = 4096) {
  if (!turns.length) throw new Error('HISTORY_REQUIRED');
  const latest = turns.at(-1)!;
  const recent: RecentMessage[] = [
    { role: 'user', content: `[당시 회사=${latest.company_id ?? '미선택'}] ${latest.user}` },
    { role: 'assistant', content: latest.assistant },
  ];
  const eligibleSummary = mode === 'C'
    ? [...summaries].filter(item => item.through <= (turns.length - 1) * 2).sort((a, b) => b.through - a.through)[0]
    : undefined;
  const chosen = mode === 'A' ? turns.slice(-5, -1)
    : turns.filter(turn => turn.index * 2 > (eligibleSummary?.through ?? 0) && turn.index < latest.index);
  const blocks = [
    ...(eligibleSummary ? [{ id: `summary-through-${eligibleSummary.through}`, content: eligibleSummary.content }] : []),
    ...chosen.map(turn => ({ id: `turn-${turn.index}`, content: block(turn) })),
  ];
  const removed: string[] = [];
  const render = () => [HEADER, ...blocks.map(item => item.content)].join('\n\n');
  const size = () => count(JSON.stringify({ memory: render(), recent_messages: recent }));
  const originalTokens = await size();
  let tokens = originalTokens;
  while (tokens > budget && blocks.length) { removed.push(blocks.shift()!.id); tokens = await size(); }
  if (tokens > budget) throw new Error('LATEST_TURN_EXCEEDS_MEMORY_BUDGET');
  return { mode, content: render(), recent, tokens, original_tokens: originalTokens, budget,
    selected_blocks: blocks.map(item => item.id), removed_blocks: removed,
    summary_through: eligibleSummary?.through ?? 0, summary_retained: blocks.some(item => item.id.startsWith('summary-')),
    source_turn_count: turns.length };
}

/** Output-only oracle. It must never be supplied to a model client. */
export function scoreMemoryAnswer(answer: string, expectations: Array<{ fact: string; pattern: string }>) {
  const facts = expectations.map(item => ({ fact: item.fact, present: new RegExp(item.pattern, 's').test(answer) }));
  return { facts, fact_coverage: facts.filter(item => item.present).length, expected_fact_count: facts.length,
    automated_status: facts.every(item => item.present) ? 'PASS' : 'FAIL',
    attribution_and_fabrication_review: 'REQUIRES_SOURCE_REVIEW' };
}
