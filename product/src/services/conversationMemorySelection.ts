import type { ConversationRecallFact } from "@/domain/conversationRecall";

/** Reserve the latest value of each subject/kind before filling historical slots.
 * Repetitions must not evict another company's current correction. */
export function selectRecallFacts(facts: ConversationRecallFact[]): ConversationRecallFact[] {
  const latest = new Map<string, ConversationRecallFact>();
  for (const fact of facts) latest.set(`${fact.company_id ?? ""}:${fact.kind}`, fact);
  const current = [...latest.values()].slice(-64);
  const selected = new Set(current);
  const history = facts.filter((fact) => !selected.has(fact)).slice(-(64 - current.length));
  return [...(current.length < 64 ? history : []), ...current].sort((a, b) => a.sequence - b.sequence);
}
