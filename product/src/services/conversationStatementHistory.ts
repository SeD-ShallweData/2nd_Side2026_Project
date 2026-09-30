import type { StoredConversationDetail } from "@/domain/conversation";
import { mentionedCompanies, statementCompany, type RecallCompany } from "@/services/conversationCompanyScope";

/** Walk only owner-checked user originals. An actual UI selection change resets
 * conversational focus; a plain follow-up keeps the last explicit subject. */
export function scopedConversationUsers(detail: StoredConversationDetail, companies: RecallCompany[]) {
  let active: string | null = null;
  let lastSelection: string | null = null;
  const messages = detail.turns.flatMap(turn => {
    const selection = turn.company_id ?? null;
    if (selection !== lastSelection) active = selection;
    lastSelection = selection;
    return turn.messages.flatMap((message, index) => {
      if (message.role !== "user") return [];
      const initial = active;
      for (const sentence of message.content.match(/[^.!?。？\n]+[.!?。？]?/g) ?? []) {
        const scope = statementCompany(sentence, active, companies);
        const named = mentionedCompanies(sentence, companies);
        if (!scope.ambiguous) active = scope.company_id;
        else if (named.length > 1 || /(?:회사|사업장|업체)(?:의|은|는|에서는|에서)\s/.test(sentence)) active = null;
        // A question such as "1350과 노동포털의 차이" is not a company switch.
      }
      return [{ message, sequence: (turn.turn_index - 1) * 2 + index + 1, company_id: initial }];
    });
  });
  return { messages, active_subject: active, last_selection: lastSelection };
}
