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

export function SafeMarkdown({ children }: { children: string }) {
  const lines = children.trim().split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(lines[index])) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(lines[index])) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      blocks.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ol>);
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length
      && lines[index].trim()
      && !/^\s*[-*]\s+/.test(lines[index])
      && !/^\s*\d+[.)]\s+/.test(lines[index])
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
