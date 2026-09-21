import type { ReactNode } from "react";

function inlineMarkdown(value: string): ReactNode[] {
  const parts = value.split(/(\*\*[^*\n]+\*\*)/g);
  return parts.filter(Boolean).map((part, index) => (
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : <span key={index}>{part}</span>
  ));
}

function plainLine(value: string): string {
  return value.replace(/^#{1,6}\s+/, "");
}

type ListKind = "ordered" | "unordered";
type ListMarker = { kind: ListKind; indent: number; content: string };

function listMarker(line: string): ListMarker | null {
  const match = line.match(/^(\s*)(?:(\d+)[.)]|[-*])\s+(.*)$/);
  if (!match) return null;
  return {
    kind: match[2] ? "ordered" : "unordered",
    indent: match[1].replace(/\t/g, "  ").length,
    content: match[3],
  };
}

function listItemContent(lines: string[]): ReactNode {
  return lines.map((line, index) => (
    <span key={index}>
      {inlineMarkdown(line.trim())}
      {index < lines.length - 1 ? <br /> : null}
    </span>
  ));
}

function parseList(lines: string[], start: number, marker: ListMarker): { node: ReactNode; next: number } {
  const items: Array<{ lines: string[]; nested: ReactNode[] }> = [];
  let index = start;
  let current: { lines: string[]; nested: ReactNode[] } | null = null;

  while (index < lines.length) {
    const next = listMarker(lines[index]);
    if (next && next.indent === marker.indent && next.kind === marker.kind) {
      current = { lines: [next.content], nested: [] };
      items.push(current);
      index += 1;
      continue;
    }
    if (next && next.indent > marker.indent && current) {
      const nested = parseList(lines, index, next);
      current.nested.push(nested.node);
      index = nested.next;
      continue;
    }
    if (!lines[index].trim()) {
      let following = index + 1;
      while (following < lines.length && !lines[following].trim()) following += 1;
      const afterBlank = following < lines.length ? listMarker(lines[following]) : null;
      if (afterBlank && afterBlank.indent === marker.indent && afterBlank.kind === marker.kind) {
        index = following;
        continue;
      }
      if (afterBlank && afterBlank.indent > marker.indent && current) {
        index = following;
        continue;
      }
      break;
    }
    if (current && /^\s+/.test(lines[index])) {
      current.lines.push(lines[index]);
      index += 1;
      continue;
    }
    break;
  }

  const Tag = marker.kind === "ordered" ? "ol" : "ul";
  return {
    next: index,
    node: <Tag key={`${marker.kind}-${start}`}>{items.map((item, itemIndex) => (
      <li key={itemIndex}>{listItemContent(item.lines)}{item.nested}</li>
    ))}</Tag>,
  };
}

export function SafeMarkdown({ children }: { children: string }) {
  const lines = children.trim().split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const marker = listMarker(lines[index]);
    if (marker) {
      const list = parseList(lines, index, marker);
      blocks.push(list.node);
      index = list.next;
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length
      && lines[index].trim()
      && !listMarker(lines[index])
    ) {
      paragraph.push(plainLine(lines[index]));
      index += 1;
    }
    blocks.push(
      <p key={`p-${index}`}>
        {paragraph.map((line, lineIndex) => (
          <span key={lineIndex}>
            {inlineMarkdown(line)}
            {lineIndex < paragraph.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>,
    );
  }

  return (
    <div className="safe-markdown">{blocks}</div>
  );
}
