import type { SourceReference } from "@/domain/risk";

export function DataSourceList({ sources }: { sources: SourceReference[] }) {
  if (sources.length === 0) {
    return <p className="muted-text">확인 가능한 출처가 없습니다.</p>;
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
              source.as_of && `기준 ${source.as_of}`,
              source.document_id && `문서 ${source.document_id}`,
            ].filter(Boolean).join(" · ")}
          </small>
        </li>
      ))}
    </ul>
  );
}
