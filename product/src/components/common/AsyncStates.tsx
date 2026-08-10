import type { ReactNode } from "react";

export function LoadingSkeleton({ label = "정보를 불러오는 중입니다." }: { label?: string }) {
  return (
    <div className="loading-card" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
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
  return (
    <div className="state-card state-error" role="alert">
      <span className="state-icon" aria-hidden="true">
        !
      </span>
      <h2>정보를 불러오지 못했습니다</h2>
      <p>{message}</p>
      {onRetry ? (
        <button className="button button-outline" type="button" onClick={onRetry}>
          다시 시도
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
