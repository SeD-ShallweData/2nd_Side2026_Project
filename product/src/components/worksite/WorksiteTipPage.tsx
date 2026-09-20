"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import type { SessionResponse } from "@/app/api/auth/authApiContract";
import type {
  WorksiteTipCategory,
  WorksiteTipDto,
  WorksiteTipListItemDto,
  WorksiteTipReceiptDto,
} from "@/app/api/worksite-tips/worksiteTipApiContract";
import { getSession, getWorksiteTip, listWorksiteTips, submitWorksiteTip } from "@/services/worksiteTipClient";

const MAX_PHOTOS = 3;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

function formatDate(value: string): string {
  return new Date(value).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

function SessionGate({ session, onRetry }: { session: SessionResponse; onRetry: () => void }) {
  if (!session.authenticated) {
    return (
      <div className="worksite-state-card">
        <strong>로그인 후 현장 신고를 접수할 수 있습니다.</strong>
        <p>제보 내용과 사진은 공개 커뮤니티에 게시되지 않고 근로감독관 확인용으로만 전달됩니다.</p>
      </div>
    );
  }

  if (session.user.role === "admin") return <InspectorTipList />;
  if (session.user.role === "user") return <WorksiteTipForm />;
  return (
    <div className="worksite-state-card">
      <strong>현재 계정은 현장 신고 접수 대상이 아닙니다.</strong>
      <p>일반 사용자 계정으로 로그인하거나 근로감독관 모드에서 확인해 주세요.</p>
      <button className="button button-outline" type="button" onClick={onRetry}>다시 확인</button>
    </div>
  );
}

export function WorksiteTipForm() {
  const [category, setCategory] = useState<WorksiteTipCategory | "">("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<WorksiteTipReceiptDto | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function selectPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setError(null);
    if (files.length > MAX_PHOTOS) {
      setError("사진은 최대 3장까지 첨부할 수 있습니다.");
      event.target.value = "";
      return;
    }
    const invalid = files.find((file) => !PHOTO_TYPES.has(file.type) || file.size > MAX_PHOTO_BYTES);
    if (invalid) {
      setError("JPEG, PNG, WebP 사진만 첨부할 수 있으며 사진 한 장은 5MB 이하여야 합니다.");
      event.target.value = "";
      return;
    }
    setPhotos(files);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!category) {
      setError("제보 유형을 임금과 산재 중에서 골라 주세요.");
      return;
    }
    if (!title.trim() || (!body.trim() && photos.length === 0)) {
      setError("제목을 입력하고 본문 또는 사진을 하나 이상 첨부해 주세요.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("category", category);
      form.append("title", title);
      if (body.trim()) form.append("body", body);
      photos.forEach((photo) => form.append("photos", photo, photo.name));
      setReceipt(await submitWorksiteTip(form));
      setCategory("");
      setTitle("");
      setBody("");
      setPhotos([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "현장 제보를 접수하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  if (receipt) {
    return (
      <div className="worksite-receipt" role="status">
        <span className="worksite-receipt-mark" aria-hidden="true">✓</span>
        <div>
          <strong>현장 제보가 접수되었습니다.</strong>
          <p>제보 번호 {receipt.tip_id} · 사진 {receipt.attachment_count}장 · {formatDate(receipt.submitted_at)}</p>
          <small>제보 내용은 공개되지 않으며 근로감독관 확인용으로 전달됩니다.</small>
        </div>
        <button type="button" className="button button-outline" onClick={() => setReceipt(null)}>새 제보 작성</button>
      </div>
    );
  }

  return (
    <form className="worksite-tip-form" onSubmit={submit}>
      <div className="worksite-form-intro">
        <div><span className="eyebrow">비공개 접수</span><h2>현장의 문제를 알려주세요</h2></div>
        <p>임금·안전·근로조건과 관련된 현장 상황을 글이나 사진으로 전달할 수 있습니다.</p>
      </div>
      <label>제보 유형<select value={category} onChange={(event) => setCategory(event.target.value as WorksiteTipCategory | "")} required>
        <option value="">선택해 주세요</option>
        <option value="wage">임금 — 체불·미지급</option>
        <option value="safety">산재 — 안전·사고 위험</option>
      </select></label>
      <label>제보 제목<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={2} maxLength={120} placeholder="예: 안전교육 없이 위험 작업을 지시받았습니다" required /></label>
      <label>상세 내용 <span className="field-optional">선택</span><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={5000} rows={8} placeholder="언제, 어디서, 어떤 일이 있었는지 사실 그대로 적어 주세요." /></label>
      <div className="worksite-upload-field">
        <label htmlFor="worksite-photos">현장 사진 <span className="field-optional">선택 · 최대 3장</span></label>
        <input id="worksite-photos" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={selectPhotos} />
        {photos.length > 0 ? <ul className="worksite-photo-list">{photos.map((photo) => <li key={`${photo.name}-${photo.size}`}>{photo.name}<span>{Math.ceil(photo.size / 1024)}KB</span></li>)}</ul> : <p className="field-help">사진은 사실 확인에 도움이 될 수 있습니다. 원본 파일은 공개 게시되지 않습니다.</p>}
      </div>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="worksite-form-actions"><small>제목, 본문, 사진 중 제목과 본문 또는 사진이 필요합니다.</small><button className="button button-dark" type="submit" disabled={submitting}>{submitting ? "접수 중..." : "비공개 제보 접수"}</button></div>
    </form>
  );
}

function InspectorTipList() {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<WorksiteTipListItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [selected, setSelected] = useState<WorksiteTipDto | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    listWorksiteTips(page, controller.signal).then((result) => {
      setItems(result.items);
      setTotal(result.total);
      setTotalPages(result.total_pages);
      setError(null);
    }).catch((caught) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "현장 제보 목록을 불러오지 못했습니다.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page]);

  async function openTip(tipId: string) {
    try {
      setSelected(await getWorksiteTip(tipId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "제보 상세를 불러오지 못했습니다.");
    }
  }

  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [selected]);

  function changePage(nextPage: number) {
    setLoading(true);
    setPage(nextPage);
  }

  return (
    <div className="worksite-inspector-view">
      <div className="worksite-list-toolbar"><div><span className="eyebrow">근로감독관 확인</span><h2>현장 제보 목록</h2><p>접수된 제보를 최신순으로 확인합니다.</p></div><strong>전체 {total.toLocaleString("ko-KR")}건</strong></div>
      {/* 목록 아래가 아니라 위에 펼친다. 목록이 길면 아래에 붙은 상세는 화면
          밖으로 밀려나 열린 줄도 모른다. 열 때 이 자리로 스크롤도 옮긴다. */}
      {selected ? <div className="worksite-detail-panel" ref={detailRef} tabIndex={-1}><div className="worksite-detail-head"><div><span className="eyebrow">제보 상세</span><h2>{selected.title}</h2><time>{formatDate(selected.submitted_at)}</time></div><button type="button" className="button button-outline" onClick={() => setSelected(null)}>닫기</button></div><p className="worksite-detail-body">{selected.body ?? "본문 없이 사진으로 접수된 제보입니다."}</p>{selected.attachments.length > 0 ? <div className="worksite-attachment-grid">{selected.attachments.map((attachment, index) => <a key={attachment.attachment_id} href={attachment.content_url} target="_blank" rel="noreferrer" className="worksite-attachment-thumb" aria-label={`사진 ${index + 1} 원본 크기로 보기`}>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={attachment.content_url} alt="" loading="lazy" /><span>사진 {index + 1} · {Math.ceil(attachment.size_bytes / 1024)}KB</span></a>)}</div> : <p className="worksite-attachment-empty">첨부된 사진이 없습니다.</p>}</div> : null}
      {loading ? <div className="worksite-state-card">현장 제보를 불러오는 중입니다.</div> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {!loading && items.length === 0 ? <div className="worksite-state-card"><strong>접수된 현장 제보가 없습니다.</strong><p>새 제보가 접수되면 이곳에서 확인할 수 있습니다.</p></div> : null}
      <div className="worksite-tip-list">{items.map((item) => <article className="worksite-tip-list-item" key={item.tip_id}><div className="worksite-tip-list-meta"><span>현장 제보</span><time>{formatDate(item.submitted_at)}</time></div><h3>{item.title}</h3><p>{item.body_preview ?? "사진 첨부 제보"}</p><div className="worksite-tip-list-foot"><span>{item.company_context ? `${item.company_context.region ?? "지역 정보 없음"} · ${item.company_context.industry ?? "업종 정보 없음"}` : "사업장 미지정"}</span><span>사진 {item.attachment_count}장</span><button type="button" className="button button-outline" onClick={() => void openTip(item.tip_id)}>상세 보기</button></div></article>)}</div>
      {totalPages > 1 ? <nav className="search-pagination" aria-label="현장 제보 페이지"><button type="button" className="button button-outline" disabled={page <= 1} onClick={() => changePage(page - 1)}>← 이전</button><span className="pagination-page">{page} / {totalPages} 페이지</span><button type="button" className="button button-outline" disabled={page >= totalPages} onClick={() => changePage(page + 1)}>다음 →</button></nav> : null}
    </div>
  );
}

export function WorksiteTipPage() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal).then(setSession).catch((caught) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "로그인 상태를 확인하지 못했습니다.");
    });
    return () => controller.abort();
  }, [retry]);

  const role = session?.authenticated ? session.user.role : null;
  const isAdmin = role === "admin";
  const isInspector = role === "inspector";

  return (
    <div className="page-section worksite-page"><div className="shell narrow-shell"><div className="page-heading"><span className="eyebrow">현장 위험 요소 제보</span><h1>현장의 목소리를 안전하게 전달하세요</h1>{!isAdmin ? <p>제보는 공개 커뮤니티와 분리되어 근로감독관 확인용으로만 전달됩니다.</p> : null}</div>{!isAdmin && !isInspector ? <div className="worksite-privacy-strip"><strong>안심하세요!</strong><span>제보자의 이메일과 내부 식별정보는 화면에 표시하지 않습니다.</span></div> : null}{error ? <div className="worksite-state-card"><strong>로그인 상태를 확인하지 못했습니다.</strong><p>{error}</p><button type="button" className="button button-outline" onClick={() => { setError(null); setRetry((value) => value + 1); }}>다시 시도</button></div> : session ? <SessionGate session={session} onRetry={() => setRetry((value) => value + 1)} /> : <div className="worksite-state-card">로그인 상태를 확인하는 중입니다.</div>}</div></div>
  );
}
