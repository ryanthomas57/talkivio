/**
 * Search snippets arrive as plain text plus [start, end) code-point offsets of the
 * matches (the API strips its own markers, so message text cannot fake a highlight).
 * They are rendered as text nodes plus <mark> — never as HTML.
 */
export function splitSnippet(text: string, highlights: Array<[number, number]> = []): Array<{ text: string; hit: boolean }> {
  const chars = Array.from(text);
  const out: Array<{ text: string; hit: boolean }> = [];
  let pos = 0;
  for (const [start, end] of [...highlights].sort((a, b) => a[0] - b[0])) {
    if (start < pos || end <= start || end > chars.length) continue;
    if (start > pos) out.push({ text: chars.slice(pos, start).join(''), hit: false });
    out.push({ text: chars.slice(start, end).join(''), hit: true });
    pos = end;
  }
  if (pos < chars.length) out.push({ text: chars.slice(pos).join(''), hit: false });
  return out;
}

export function Snippet({ text, highlights, className }: { text: string; highlights?: Array<[number, number]>; className?: string }) {
  // Collapse whitespace per part so offsets stay aligned with the original text.
  const parts = splitSnippet(text, highlights).map((p) => ({ ...p, text: p.text.replace(/\s+/g, ' ') }));
  return (
    <span className={className} dir="auto">
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-warning-tint px-0.5 font-semibold text-fg">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}
