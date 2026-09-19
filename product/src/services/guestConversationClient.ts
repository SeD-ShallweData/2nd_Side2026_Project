import type {
  ImportGuestConversationRequest,
  ImportGuestConversationTurn,
} from "@/app/api/conversations/conversationApiContract";
import type { ChatComparisonResponse } from "@/domain/chatComparison";

const STORAGE_KEY = "donworry.currentGuestConversation.v1";

export function readGuestConversation(): ImportGuestConversationRequest | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ImportGuestConversationRequest> | null;
    if (!value || typeof value.import_id !== "string" || !Array.isArray(value.turns) || value.turns.length < 1) return null;
    return { import_id: value.import_id, turns: value.turns.slice(-10) as ImportGuestConversationTurn[] };
  } catch {
    return null;
  }
}

export function hasGuestConversation(): boolean {
  return readGuestConversation() !== null;
}

export function appendGuestConversationTurn(
  userMessage: string,
  companyId: string | null,
  response: ChatComparisonResponse,
): ImportGuestConversationRequest {
  const current = readGuestConversation() ?? { import_id: crypto.randomUUID(), turns: [] };
  const next = {
    import_id: current.import_id,
    turns: [...current.turns, {
      user_message: userMessage,
      company_id: companyId,
      response: structuredClone(response),
    }].slice(-10),
  };
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function clearGuestConversation(): void {
  if (typeof window !== "undefined") window.sessionStorage.removeItem(STORAGE_KEY);
}
