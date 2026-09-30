"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMessages } from "@/i18n/LocaleProvider";
import { communityMessages } from "@/i18n/messages/community";
import { CommunityApiError, deleteCommunityPost } from "@/services/communityClient";

export function CommunityPostDeleteButton({ postId }: { postId: string }) {
  const m = useMessages(communityMessages);
  const errorMessages: Record<string, string> = m.deletion.errors;
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteCommunityPost(postId);
      // 삭제된 글은 상세 조회가 404가 되므로 목록으로 돌아간다.
      router.push("/community");
    } catch (caught) {
      setDeleting(false);
      if (caught instanceof CommunityApiError) {
        setError(errorMessages[caught.code] ?? caught.message);
        return;
      }
      setError(m.deletion.networkError);
    }
  }

  if (!confirming) {
    // 부모(.community-post-actions)가 가로 flex 라 버튼을 문단으로 감싸면
    // flex 자식이 <p> 가 되어 field-help 의 margin-top 8px 만큼 혼자 내려앉는다.
    // 버튼 자신이 flex 자식이 되도록 껍데기를 두지 않는다.
    return (
      <>
        <button type="button" className="button button-outline button-small" onClick={() => setConfirming(true)}>
          {m.deletion.button}
        </button>
        {error ? <span className="field-error" role="alert" style={{ margin: 0 }}>{error}</span> : null}
      </>
    );
  }

  return (
    // 확인 패널은 버튼 한 칸이 아니라 한 줄을 통째로 쓴다.
    // 부모가 flex-wrap 이므로 flexBasis 100% 면 제자리에서 줄을 바꾼다.
    // order 로 밀지 않는다 — 보이는 순서와 탭 순서가 어긋나면 안 된다.
    <div className="contract-actions" role="group" aria-label={m.deletion.confirmAria} style={{ flexBasis: "100%" }}>
      <span className="field-help">{m.deletion.confirmText}</span>
      <button type="button" className="button button-dark" disabled={deleting} onClick={() => void handleDelete()}>
        {deleting ? m.deletion.deleting : m.deletion.confirm}
      </button>
      <button type="button" className="button button-ghost" disabled={deleting} onClick={() => setConfirming(false)}>
        {m.deletion.cancel}
      </button>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </div>
  );
}
