"use client";

import { useCallback, useEffect, useState } from "react";

import { OpsReasonForm } from "@/components/admin/OpsReasonForm";
import { postJson, readApiResponse } from "@/utils/clientApi";

interface PromptItem {
  name: string;
  title: string;
  usage: string;
  text: string;
  line_count: number;
  char_count: number;
  source: "file" | "db";
  active_version: { version: number; sha256: string; activated_at: string | null } | null;
  file_text: string;
}

interface PromptResponse {
  editable: boolean;
  items: PromptItem[];
}

interface PromptValidation {
  ok: boolean;
  missing_phrases: string[];
  forbidden_strings: string[];
  problems: string[];
  char_count: number;
}

interface PromptVersion {
  id: string;
  version: number;
  status: "draft" | "active" | "retired";
  body: string;
  validation: PromptValidation;
  reason: string;
  created_by_name: string;
  created_at: string;
  activated_at: string | null;
}

interface SavedDraft {
  id: string;
  version: number;
  validation: PromptValidation;
}

type PendingChange =
  | { kind: "save"; name: string; body: string }
  | { kind: "activate"; name: string; versionId: string; version: number }
  | { kind: "reset"; name: string };

const STATUS_LABEL: Record<PromptVersion["status"], string> = {
  draft: "초안",
  active: "적용 중",
  retired: "이전 적용",
};

function timeLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }) : "";
}

function ValidationResult({ validation }: { validation: PromptValidation }) {
  if (validation.ok) {
    return <p className="prompt-validation is-ok">검증 통과 · 필수 정책 문장이 모두 들어 있습니다.</p>;
  }
  return (
    <div className="prompt-validation is-failed" role="alert">
      <strong>검증 실패 · 이 버전은 적용할 수 없습니다.</strong>
      <ul>
        {validation.missing_phrases.map((phrase) => <li key={`m-${phrase}`}>빠진 정책 문장: “{phrase}”</li>)}
        {validation.forbidden_strings.map((text) => <li key={`f-${text}`}>들어가면 안 되는 문자열: {text}</li>)}
        {validation.problems.map((problem) => <li key={`p-${problem}`}>{problem}</li>)}
      </ul>
    </div>
  );
}

/*
 * 프롬프트 열람·편집 화면.
 *
 * 파일(prompts/*.md)은 자산 무결성 해시로 고정돼 있어(#81) 고치지 않는다. 편집은
 * 운영 DB에 버전으로 저장하고, 검증을 통과한 버전만 적용할 수 있다. 적용된 DB 버전은
 * 파일보다 우선하며, "파일 기본값으로 복귀"로 언제든 되돌린다. 운영 DB가 연결되지
 * 않은 환경(Mock 등)에서는 이 화면 안에서만 초안을 유지한다.
 */
export function PromptStudioPage() {
  const [data, setData] = useState<PromptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, SavedDraft>>({});
  const [history, setHistory] = useState<Record<string, PromptVersion[]>>({});
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) =>
    fetch("/api/inspector/prompts", { signal, cache: "no-store" })
      .then((response) => readApiResponse<PromptResponse>(response))
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "프롬프트를 불러오지 못했습니다.");
      }), []);

  const loadHistory = useCallback(async (name: string) => {
    try {
      const response = await fetch(`/api/admin/prompts/history?name=${encodeURIComponent(name)}`, { cache: "no-store" });
      const result = await readApiResponse<{ items: PromptVersion[] }>(response);
      setHistory((prev) => ({ ...prev, [name]: result.items }));
    } catch {
      setHistory((prev) => ({ ...prev, [name]: [] }));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // 이력은 목록을 받은 뒤, 그리고 다른 프롬프트를 고를 때 한 번씩 읽는다.
  const firstName = data?.editable ? data.items[0]?.name : undefined;
  useEffect(() => {
    if (!firstName) return;
    const timer = window.setTimeout(() => void loadHistory(firstName), 0);
    return () => window.clearTimeout(timer);
  }, [firstName, loadHistory]);

  const item = data?.items[selected];
  const editable = data?.editable === true;
  const draft = item ? drafts[item.name] ?? item.text : "";
  const dirty = Boolean(item && draft !== item.text);
  const savedDraft = item ? saved[item.name] : undefined;
  const versions = item ? history[item.name] : undefined;

  function begin(change: PendingChange) {
    setPending(change);
    setChangeError(null);
    setNotice(null);
  }

  async function applyChange(reason: string) {
    if (!pending) return;
    setBusy(true);
    setChangeError(null);
    try {
      if (pending.kind === "save") {
        const result = await postJson<SavedDraft>("/api/admin/prompts/drafts", { name: pending.name, body: pending.body, reason });
        setSaved((prev) => ({ ...prev, [pending.name]: result }));
        setNotice(`새 버전(v${result.version})을 저장했습니다. ${result.validation.ok ? "검증을 통과해 적용할 수 있습니다." : "검증을 통과하지 못해 적용할 수 없습니다."}`);
      } else if (pending.kind === "activate") {
        await postJson(`/api/admin/prompts/versions/${pending.versionId}/activate`, { reason });
        setSaved((prev) => { const next = { ...prev }; delete next[pending.name]; return next; });
        setDrafts((prev) => { const next = { ...prev }; delete next[pending.name]; return next; });
        setNotice(`버전(v${pending.version})을 적용했습니다. 새 대화부터 이 프롬프트가 쓰입니다.`);
        await load();
      } else {
        await postJson("/api/admin/prompts/reset", { name: pending.name, reason });
        setDrafts((prev) => { const next = { ...prev }; delete next[pending.name]; return next; });
        setNotice("파일 기본값으로 돌아갔습니다. 버전 이력은 그대로 남습니다.");
        await load();
      }
      setPending(null);
      await loadHistory(pending.name);
    } catch (caught) {
      setChangeError(caught instanceof Error ? caught.message : "변경하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  function pendingSummary(change: PendingChange): string {
    if (change.kind === "save") return "편집한 내용을 새 버전(초안)으로 저장합니다. 저장만으로는 서비스에 반영되지 않습니다.";
    if (change.kind === "activate") return `버전(v${change.version})을 적용합니다. 새로 시작하는 대화부터 이 프롬프트가 쓰입니다.`;
    return "DB 버전 적용을 해제하고 저장소 파일(prompts/*.md) 기본값으로 돌아갑니다.";
  }

  return (
    <main className="shell inspector-content prompt-studio-page">
      <div className="inspector-page-heading">
        <div>
          <span className="eyebrow">프롬프트 운영</span>
          <h1>LLM 프롬프트</h1>
          <p>지금 서비스에 적용 중인 시스템 프롬프트입니다. 문구를 고치면 답변의 태도와 금지 표현이 함께 바뀝니다.</p>
        </div>
      </div>

      {error ? <div className="batch-state-card" role="alert"><strong>프롬프트를 불러오지 못했습니다.</strong><p>{error}</p></div> : null}
      {!data && !error ? <div className="batch-state-card">프롬프트를 불러오는 중입니다.</div> : null}

      {data ? (
        <div className="prompt-studio-layout">
          <nav className="prompt-studio-list" aria-label="프롬프트 목록">
            {data.items.map((entry, index) => (
              <button
                type="button"
                key={entry.name}
                className={index === selected ? "is-active" : ""}
                aria-current={index === selected ? "true" : undefined}
                onClick={() => {
                  setSelected(index);
                  setPending(null);
                  setNotice(null);
                  if (data.editable && history[entry.name] === undefined) void loadHistory(entry.name);
                }}
              >
                <strong>{entry.title}</strong>
                <small>{entry.usage}</small>
                <span>
                  {entry.source === "db" && entry.active_version ? `운영 버전 v${entry.active_version.version}` : "파일 기본값"}
                  {" · "}{entry.line_count}줄 · {entry.char_count.toLocaleString("ko-KR")}자
                </span>
              </button>
            ))}
          </nav>

          {item ? (
            <section className="prompt-studio-editor" aria-label={`${item.title} 내용`}>
              <header>
                <div>
                  <strong>{item.title}</strong>
                  <small>
                    {item.source === "db" && item.active_version
                      ? `운영 버전 v${item.active_version.version} 적용 중 · ${timeLabel(item.active_version.activated_at)}`
                      : `파일 기본값 · prompts/${item.name}.md`}
                  </small>
                </div>
                {dirty ? <span className="prompt-saved-mark">편집 중</span> : null}
              </header>

              <textarea
                value={draft}
                spellCheck={false}
                onChange={(event) => {
                  const value = event.target.value;
                  setDrafts((prev) => ({ ...prev, [item.name]: value }));
                  setSaved((prev) => { const next = { ...prev }; delete next[item.name]; return next; });
                }}
                aria-label={`${item.title} 편집`}
              />

              {notice ? <p className="ops-notice" role="status">{notice}</p> : null}
              {savedDraft ? <ValidationResult validation={savedDraft.validation} /> : null}

              {pending ? (
                <OpsReasonForm
                  summary={pendingSummary(pending)}
                  confirmLabel={pending.kind === "save" ? "초안 저장" : pending.kind === "activate" ? "적용" : "파일로 복귀"}
                  busy={busy}
                  error={changeError}
                  onConfirm={(reason) => void applyChange(reason)}
                  onCancel={() => { setPending(null); setChangeError(null); }}
                />
              ) : (
                <div className="prompt-studio-actions">
                  {editable ? (
                    <>
                      <button type="button" className="button button-dark" disabled={!dirty} onClick={() => begin({ kind: "save", name: item.name, body: draft })}>
                        새 버전으로 저장
                      </button>
                      {savedDraft?.validation.ok ? (
                        <button type="button" className="button button-dark" onClick={() => begin({ kind: "activate", name: item.name, versionId: savedDraft.id, version: savedDraft.version })}>
                          버전 {savedDraft.version} 적용
                        </button>
                      ) : null}
                      {item.source === "db" ? (
                        <button type="button" className="button button-outline" onClick={() => begin({ kind: "reset", name: item.name })}>
                          파일 기본값으로 복귀
                        </button>
                      ) : null}
                    </>
                  ) : null}
                  <button type="button" className="button button-outline" disabled={!dirty} onClick={() => setDrafts((prev) => ({ ...prev, [item.name]: item.text }))}>
                    편집 취소
                  </button>
                  <p className="prompt-studio-note">
                    {editable
                      ? "저장한 버전은 필수 정책 문장·금지 문자열 검증을 거칩니다. 검증을 통과한 버전만 적용할 수 있고, 모든 변경은 사유와 함께 기록됩니다."
                      : "운영 데이터베이스가 연결되지 않은 환경이라 편집 내용은 이 화면에서만 유지됩니다."}
                  </p>
                </div>
              )}

              {editable ? (
                <div className="prompt-history">
                  <strong>버전 이력</strong>
                  {versions === undefined ? <p className="muted-text">이력을 불러오는 중입니다.</p> : null}
                  {versions?.length === 0 ? <p className="muted-text">저장된 버전이 없습니다. 지금은 파일 기본값이 쓰입니다.</p> : null}
                  {versions && versions.length > 0 ? (
                    <ul>
                      {versions.map((entry) => (
                        <li key={entry.id} className={entry.status === "active" ? "is-active" : undefined}>
                          <div>
                            <span className={`prompt-version-pill is-${entry.status}`}>v{entry.version} · {STATUS_LABEL[entry.status]}</span>
                            {!entry.validation.ok ? <span className="prompt-version-pill is-failed">검증 실패</span> : null}
                            <small>{entry.created_by_name} · {timeLabel(entry.created_at)}</small>
                          </div>
                          <p>{entry.reason}</p>
                          <div className="prompt-history-actions">
                            <button type="button" className="text-button" onClick={() => setDrafts((prev) => ({ ...prev, [item.name]: entry.body }))}>
                              편집란에 불러오기
                            </button>
                            {entry.status !== "active" && entry.validation.ok ? (
                              <button type="button" className="text-button" disabled={Boolean(pending)} onClick={() => begin({ kind: "activate", name: item.name, versionId: entry.id, version: entry.version })}>
                                이 버전으로 되돌리기
                              </button>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
