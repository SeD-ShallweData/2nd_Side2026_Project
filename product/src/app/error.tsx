"use client";

import { AppErrorView } from "@/components/common/AppErrorView";
import { useMessages } from "@/i18n/LocaleProvider";
import { commonMessages } from "@/i18n/messages/common";
import { errorReferenceCodeOf } from "@/utils/errorReference";

/*
 * 루트 레이아웃 아래 화면에서 난 렌더링 예외의 대체 화면. 머리글·바닥글은 그대로 두고
 * 본문만 바꾼다. 오류 문구와 스택은 보여 주지 않고 digest 만 문의 코드로 보여 준다.
 * retry 는 서버에서 화면을 다시 받아 그린다(Next 16.3 부터 안정 기능).
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const m = useMessages(commonMessages).appError;
  return <AppErrorView text={m} referenceCode={errorReferenceCodeOf(error)} onRetry={() => retry()} />;
}
