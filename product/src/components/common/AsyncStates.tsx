"use client";

import type { ReactNode } from "react";
import { useMessages } from "@/i18n/LocaleProvider";
import { commonMessages } from "@/i18n/messages/common";

export function LoadingSkeleton({ label }: { label?: string }) {
  const m = useMessages(commonMessages).async;
  return (
    <div className="loading-card" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? m.loading}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-card" role="status">
      <span className="state-icon" aria-hidden="true">
        ?
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  const m = useMessages(commonMessages).async;
  return (
    <div className="state-card state-error" role="alert">
      <span className="state-icon" aria-hidden="true">
        !
      </span>
      <h2>{m.errorTitle}</h2>
      <p>{message}</p>
      {onRetry ? (
        <button className="button button-outline" type="button" onClick={onRetry}>
          {m.retry}
        </button>
      ) : null}
    </div>
  );
}

export function LimitationNotice({ children }: { children: ReactNode }) {
  return (
    <div className="limitation-notice">
      <span aria-hidden="true">i</span>
      <div>{children}</div>
    </div>
  );
}
