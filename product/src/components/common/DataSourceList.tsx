"use client";

import type { SourceReference } from "@/domain/risk";
import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { commonMessages } from "@/i18n/messages/common";

export function DataSourceList({ sources }: { sources: SourceReference[] }) {
  const m = useMessages(commonMessages).sources;
  if (sources.length === 0) {
    return <p className="muted-text">{m.empty}</p>;
  }
  return (
    <ul className="source-list">
      {sources.map((source, index) => (
        <li key={`${source.name}-${source.as_of ?? index}`}>
          <span className="source-primary">
            {source.url ? (
              <a className="source-name" href={source.url} target="_blank" rel="noreferrer" title={source.name}>{source.name}</a>
            ) : <span className="source-name" title={source.name}>{source.name}</span>}
            {source.citation && source.citation !== source.name ? <em>{source.citation}</em> : null}
          </span>
          <small>
            {[
              source.organization,
              source.as_of && format(m.asOf, { date: source.as_of }),
              source.document_id && format(m.document, { id: source.document_id }),
            ].filter(Boolean).join(" · ")}
          </small>
        </li>
      ))}
    </ul>
  );
}
