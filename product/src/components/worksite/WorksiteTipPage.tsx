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
import { format } from "@/i18n/defineMessages";
import { useLocale, useMessages } from "@/i18n/LocaleProvider";
import { htmlLang, isImplementedForeignLocale, type Locale } from "@/i18n/locales";
import { worksiteMessages } from "@/i18n/messages/worksite";
import { detectWorksiteTipSubmissionLanguage } from "@/domain/worksiteTipLanguage";

const EVIDENCE_KEYS = ["contract", "payslip", "attendance", "messages", "photos"] as const;

const MAX_PHOTOS = 3;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** 날짜·숫자 표기 언어. 한국어(쉬운 한국어 포함)는 기존 표기를 그대로 쓴다. */
function intlLocale(locale: Locale): string {
  return locale === "ko" || locale === "ko-easy" ? "ko-KR" : htmlLang(locale);
}

function formatDate(value: string, locale: Locale): string {
  return new Date(value).toLocaleString(intlLocale(locale), { dateStyle: "medium", timeStyle: "short" });
}

/*
 * 역할별로 한 화면만 보인다. 서버 경계(server/auth/inspectorAccess.ts 의
 * WORKSITE_TIP_REVIEW_ROLES)와 같은 규칙이다 — 그 파일은 "server-only" 라
 * 여기서 가져올 수 없어 값을 그대로 적는다.
 *
 *   비로그인   로그인 안내
 *   user       접수 폼
 *   inspector  제보 목록·상세·사진
 *   admin      대상 아님 안내 (제보 열람은 근로감독관의 일이다)
 */
export function SessionGate({ session }: { session: SessionResponse }) {
  const m = useMessages(worksiteMessages).gate;
  if (!session.authenticated) {
    return (
      <div className="worksite-state-card">
        <strong>{m.guestTitle}</strong>
        <p>{m.guestBody}</p>
      </div>
    );
  }

  if (session.user.role === "inspector") return <InspectorTipList />;
  if (session.user.role === "user") return <WorksiteTipForm />;
  return (
    <div className="worksite-state-card">
      <strong>{m.notEligibleTitle}</strong>
      <p>{m.notEligibleBody}</p>
    </div>
  );
}

export function WorksiteTipForm() {
  const locale = useLocale();
  const m = useMessages(worksiteMessages).form;
  const [category, setCategory] = useState<WorksiteTipCategory | "">("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<WorksiteTipReceiptDto | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function selectPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    setError(null);
    const additions = files.filter((file) => !photos.some((photo) =>
      photo.name === file.name && photo.size === file.size && photo.lastModified === file.lastModified));
    if (photos.length + additions.length > MAX_PHOTOS) {
      setError(m.photoLimit);
      return;
    }
    const invalid = additions.find((file) => !PHOTO_TYPES.has(file.type) || file.size > MAX_PHOTO_BYTES);
    if (invalid) {
      setError(m.photoInvalid);
      return;
    }
    setPhotos((current) => [...current, ...additions]);
  }

  function removePhoto(index: number) {
    setPhotos((current) => current.filter((_, photoIndex) => photoIndex !== index));
    if (photoInputRef.current) photoInputRef.current.value = "";
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!category) {
      setError(m.categoryRequired);
      return;
    }
    if (!title.trim() || (!body.trim() && photos.length === 0)) {
      setError(m.contentRequired);
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
      setError(caught instanceof Error ? caught.message : m.submitFailed);
    } finally {
      setSubmitting(false);
    }
  }

  // 번역 안내는 서버가 모델에 보낼 제보에 앞서 반드시 보여야 한다. 서버와 같은 판별 규칙을 쓰고,
  // 외국어 화면에서는 아직 아무것도 쓰지 않았어도 미리 보여 준다.
  const showTranslationNotice = isImplementedForeignLocale(locale)
    || detectWorksiteTipSubmissionLanguage(title, body, locale).kind === "translate";

  if (receipt) {
    return (
      <div className="worksite-receipt" role="status">
        <span className="worksite-receipt-mark" aria-hidden="true">✓</span>
        <div>
          <strong>{m.receiptTitle}</strong>
          <p>{format(m.receiptMeta, { id: receipt.tip_id, count: receipt.attachment_count, date: formatDate(receipt.submitted_at, locale) })}</p>
          <small>{m.receiptNote}</small>
        </div>
        <button type="button" className="button button-outline" onClick={() => setReceipt(null)}>{m.newTip}</button>
      </div>
    );
  }

  return (
    <form className="worksite-tip-form" onSubmit={submit}>
      <div className="worksite-form-intro">
        <div><span className="eyebrow">{m.eyebrow}</span><h2>{m.heading}</h2></div>
        <p>{m.intro}</p>
      </div>
      <div className="worksite-guidance">
        <strong>{m.guidanceTitle}</strong>
        <ul>
          <li>{m.guidanceNoStatus}</li>
          <li>{m.guidanceNotPublic}</li>
        </ul>
        <strong>{m.evidenceTitle}</strong>
        <ul className="worksite-evidence-list">
          {EVIDENCE_KEYS.map((key) => <li key={key}>{m.evidence[key]}</li>)}
        </ul>
        <small>{m.evidenceNote}</small>
      </div>
      <label>{m.categoryLabel}<select value={category} onChange={(event) => setCategory(event.target.value as WorksiteTipCategory | "")} required>
        <option value="">{m.categoryPlaceholder}</option>
        <option value="wage">{m.categoryWage}</option>
        <option value="safety">{m.categorySafety}</option>
      </select></label>
      <label>{m.titleLabel}<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={2} maxLength={120} placeholder={m.titlePlaceholder} required /></label>
      <label>{m.bodyLabel} <span className="field-optional">{m.optional}</span><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={5000} rows={8} placeholder={m.bodyPlaceholder} /></label>
      <div className="worksite-upload-field">
        <label htmlFor="worksite-photos">{m.photoLabel} <span className="field-optional">{m.photoOptional}</span></label>
        <input ref={photoInputRef} id="worksite-photos" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={selectPhotos} disabled={submitting} />
        {photos.length > 0 ? <ul className="worksite-photo-list">{photos.map((photo, index) => <li key={`${photo.name}-${photo.size}-${photo.lastModified}`}><span className="worksite-photo-name">{photo.name}</span><span className="worksite-photo-actions"><span>{Math.ceil(photo.size / 1024)}KB</span><button type="button" disabled={submitting} onClick={() => removePhoto(index)} aria-label={format(m.removePhotoAria, { name: photo.name })}>{m.removePhoto}</button></span></li>)}</ul> : <p className="field-help">{m.photoHelp}</p>}
      </div>
      {showTranslationNotice ? <p className="worksite-translation-notice" role="note">{m.translationNotice}</p> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="worksite-form-actions"><small>{m.requirement}</small><button className="button button-dark" type="submit" disabled={submitting}>{submitting ? m.submitting : m.submit}</button></div>
    </form>
  );
}

function sourceLanguageName(code: string | null, names: Record<string, string>): string {
  if (!code) return names.und;
  return names[code] ?? code;
}

/**
 * 제보 본문. 한국어 제보는 그대로 보인다.
 * 외국어 제보는 한국어 기계 번역과 원문을 나란히 두고, 번역이 없으면 원문만 있다고 밝힌다.
 */
export function WorksiteTipDetailBody({ tip }: { tip: WorksiteTipDto }) {
  const m = useMessages(worksiteMessages).inspector;
  if (tip.translation_status === "not_needed") {
    return <p className="worksite-detail-body">{tip.body ?? m.photoOnlyBody}</p>;
  }
  const language = format(m.sourceLanguage, { language: sourceLanguageName(tip.source_language, m.languageNames) });
  if (tip.translation_status === "failed" || !tip.title_ko) {
    return (
      <div className="worksite-translation-pair">
        <p className="worksite-translation-status" role="status">{m.translationFailed} · {language}</p>
        <section lang={tip.source_language ?? undefined}>
          <span className="worksite-translation-label">{m.original}</span>
          <h3>{tip.title}</h3>
          <p className="worksite-detail-body">{tip.body ?? m.photoOnlyBody}</p>
        </section>
      </div>
    );
  }
  return (
    <div className="worksite-translation-pair worksite-translation-columns">
      <section lang="ko">
        <span className="worksite-translation-label worksite-translation-machine">{m.machineTranslation}</span>
        <h3>{tip.title_ko}</h3>
        <p className="worksite-detail-body">{tip.body_ko ?? tip.body ?? m.photoOnlyBody}</p>
      </section>
      <section lang={tip.source_language ?? undefined}>
        <span className="worksite-translation-label">{m.original} · {language}</span>
        <h3>{tip.title}</h3>
        <p className="worksite-detail-body">{tip.body ?? m.photoOnlyBody}</p>
      </section>
    </div>
  );
}

function InspectorTipList() {
  const locale = useLocale();
  const m = useMessages(worksiteMessages).inspector;
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<WorksiteTipListItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [selectedTipId, setSelectedTipId] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorksiteTipDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
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
      setError(caught instanceof Error ? caught.message : m.listFailed);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
    // m 은 언어가 바뀔 때만 달라진다. 오류 문구 때문에 목록을 다시 부르지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  async function openTip(tipId: string) {
    const request = ++detailRequest.current;
    if (selectedTipId === tipId) {
      setSelectedTipId(null);
      setSelected(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    setSelectedTipId(tipId);
    setSelected(null);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const detail = await getWorksiteTip(tipId);
      if (detailRequest.current === request) setSelected(detail);
    } catch (caught) {
      if (detailRequest.current === request) setDetailError(caught instanceof Error ? caught.message : m.detailFailed);
    } finally {
      if (detailRequest.current === request) setDetailLoading(false);
    }
  }

  useEffect(() => {
    return () => { detailRequest.current += 1; };
  }, []);

  function changePage(nextPage: number) {
    detailRequest.current += 1;
    setSelectedTipId(null);
    setSelected(null);
    setDetailLoading(false);
    setDetailError(null);
    setLoading(true);
    setPage(nextPage);
  }

  return (
    <div className="worksite-inspector-view">
      <div className="worksite-list-toolbar"><div><span className="eyebrow">{m.eyebrow}</span><h2>{m.heading}</h2><p>{m.intro}</p></div><strong>{format(m.total, { count: total.toLocaleString(intlLocale(locale)) })}</strong></div>
      {loading ? <div className="worksite-state-card">{m.loading}</div> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {!loading && items.length === 0 ? <div className="worksite-state-card"><strong>{m.emptyTitle}</strong><p>{m.emptyBody}</p></div> : null}
      <div className="worksite-tip-list">{items.map((item) => (
        <article className="worksite-tip-list-item" key={item.tip_id}>
          <div className="worksite-tip-list-meta"><span>{m.tipLabel}</span><time>{formatDate(item.submitted_at, locale)}</time></div>
          <h3>{item.translation_status === "translated" && item.title_ko ? item.title_ko : item.title}{item.translation_status !== "not_needed" ? <span className={`worksite-translation-badge worksite-translation-${item.translation_status}`}>{item.translation_status === "translated" ? m.machineTranslation : m.translationFailed}</span> : null}</h3>
          <p>{(item.translation_status === "translated" ? item.body_preview_ko : null) ?? item.body_preview ?? m.photoTip}</p>
          <div className="worksite-tip-list-foot"><span>{item.company_context ? `${item.company_context.region ?? m.noRegion} · ${item.company_context.industry ?? m.noIndustry}` : m.noCompany}</span><span>{format(m.photoCount, { count: item.attachment_count })}</span><button type="button" className="button button-outline" aria-expanded={selectedTipId === item.tip_id} aria-controls={selectedTipId === item.tip_id ? `worksite-tip-detail-${item.tip_id}` : undefined} onClick={() => void openTip(item.tip_id)}>{selectedTipId === item.tip_id ? m.close : m.viewDetail}</button></div>
          {selectedTipId === item.tip_id ? (
            <div id={`worksite-tip-detail-${item.tip_id}`} className="worksite-detail-panel">
              {detailLoading ? <p role="status">{m.loading}</p> : selected && selected.tip_id === item.tip_id ? (
                <><div className="worksite-detail-head"><div><span className="eyebrow">{m.detailEyebrow}</span><h2>{selected.translation_status === "translated" && selected.title_ko ? selected.title_ko : selected.title}</h2><time>{formatDate(selected.submitted_at, locale)}</time></div></div><WorksiteTipDetailBody tip={selected} />{selected.attachments.length > 0 ? <div className="worksite-attachment-grid">{selected.attachments.map((attachment, index) => <a key={attachment.attachment_id} href={attachment.content_url} target="_blank" rel="noreferrer" className="worksite-attachment-thumb" aria-label={format(m.photoAria, { n: index + 1 })}>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={attachment.content_url} alt="" loading="lazy" /><span>{format(m.photoCaption, { n: index + 1, size: Math.ceil(attachment.size_bytes / 1024) })}</span></a>)}</div> : <p className="worksite-attachment-empty">{m.noPhotos}</p>}</>
              ) : detailError ? <p className="field-error" role="alert">{detailError}</p> : null}
            </div>
          ) : null}
        </article>
      ))}</div>
      {totalPages > 1 ? <nav className="search-pagination" aria-label={m.paginationAria}><button type="button" className="button button-outline" disabled={page <= 1} onClick={() => changePage(page - 1)}>{m.prev}</button><span className="pagination-page">{format(m.pageOf, { page, total: totalPages })}</span><button type="button" className="button button-outline" disabled={page >= totalPages} onClick={() => changePage(page + 1)}>{m.next}</button></nav> : null}
    </div>
  );
}

export function WorksiteTipPage() {
  const m = useMessages(worksiteMessages).page;
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal).then(setSession).catch((caught) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : m.sessionFailed);
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry]);

  const role = session?.authenticated ? session.user.role : null;
  const isAdmin = role === "admin";
  // 제보를 열람하는 쪽. "근로감독관 확인용으로 전달됩니다" 안내는 이 계정에게 필요 없다.
  const isInspector = role === "inspector";

  return (
    <div className="page-section worksite-page"><div className="shell narrow-shell"><div className="page-heading"><span className="eyebrow">{m.eyebrow}</span><h1>{m.heading}</h1>{!isInspector ? <p>{m.intro}</p> : null}</div>{!isAdmin && !isInspector ? <div className="worksite-privacy-strip"><strong>{m.privacyTitle}</strong><span>{m.privacyBody}</span></div> : null}{error ? <div className="worksite-state-card"><strong>{m.sessionFailed}</strong><p>{error}</p><button type="button" className="button button-outline" onClick={() => { setError(null); setRetry((value) => value + 1); }}>{m.retry}</button></div> : session ? <SessionGate session={session} /> : <div className="worksite-state-card">{m.sessionLoading}</div>}</div></div>
  );
}
