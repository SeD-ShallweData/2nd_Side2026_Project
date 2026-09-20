"use client";

import { useEffect, useState } from "react";

import { readApiResponse } from "@/utils/clientApi";

interface PromptItem {
  name: string;
  title: string;
  usage: string;
  text: string;
  line_count: number;
  char_count: number;
}

interface PromptResponse {
  editable: boolean;
  items: PromptItem[];
}

/*
 * 프롬프트 열람·편집 화면.
 *
 * 읽기는 서버에서 실제로 적용 중인 파일을 그대로 가져온다. 쓰기는 아직
 * 없다 — 프롬프트 파일은 자산 무결성 해시로 고정돼 있어 파일이 바뀌면
 * 배포가 멈춘다(#81). 그래서 편집란과 저장 버튼은 두되, 저장은 이 화면
 * 안에서만 유지된다는 것을 화면에 적어 둔다.
 */
export function PromptStudioPage() {
  const [data, setData] = useState<PromptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/inspector/prompts", { signal: controller.signal })
      .then((response) => readApiResponse<PromptResponse>(response))
      .then(setData)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "프롬프트를 불러오지 못했습니다.");
      });
    return () => controller.abort();
  }, []);

  const item = data?.items[selected];
  const draft = item ? drafts[item.name] ?? item.text : "";
  const dirty = Boolean(item && draft !== item.text);

  return (
    <main className="shell inspector-content prompt-studio-page">
      <div className="inspector-page-heading">
        <div>
          <span className="eyebrow">프롬프트 운영</span>
          <h1>LLM 프롬프트</h1>
          <p>지금 서비스에 적용 중인 시스템 프롬프트입니다. 문구를 고치면 답변의 태도와 금지 표현이 함께 바뀝니다.</p>
        </div>
        <span className="inspector-private-badge">운영 관리자 전용</span>
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
                onClick={() => setSelected(index)}
              >
                <strong>{entry.title}</strong>
                <small>{entry.usage}</small>
                <span>{entry.line_count}줄 · {entry.char_count.toLocaleString("ko-KR")}자</span>
              </button>
            ))}
          </nav>

          {item ? (
            <section className="prompt-studio-editor" aria-label={`${item.title} 내용`}>
              <header>
                <div>
                  <strong>{item.title}</strong>
                  <small>prompts/{item.name}.md</small>
                </div>
                {savedAt[item.name] ? <span className="prompt-saved-mark">{savedAt[item.name]} 저장됨</span> : null}
              </header>

              <textarea
                value={draft}
                spellCheck={false}
                onChange={(event) => setDrafts((prev) => ({ ...prev, [item.name]: event.target.value }))}
                aria-label={`${item.title} 편집`}
              />

              <div className="prompt-studio-actions">
                <button
                  type="button"
                  className="button button-dark"
                  disabled={!dirty}
                  onClick={() => {
                    setSavedAt((prev) => ({
                      ...prev,
                      [item.name]: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
                    }));
                  }}
                >
                  변경 내용 저장
                </button>
                <button
                  type="button"
                  className="button button-outline"
                  disabled={!dirty}
                  onClick={() => setDrafts((prev) => ({ ...prev, [item.name]: item.text }))}
                >
                  되돌리기
                </button>
                <p className="prompt-studio-note">
                  저장한 내용은 이 화면에서만 유지됩니다. 파일에 반영하는 경로는 자산 무결성 해시를 함께
                  갱신해야 해서 아직 열지 않았습니다.
                </p>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
