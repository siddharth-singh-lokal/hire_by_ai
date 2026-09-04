/** Matches grader quotes to English transcript lines for display. */
export function englishQuote(
  quote: string,
  transcripts: { sender: string; text: string; textEn?: string; timestamp?: number }[],
  opts?: { speaker?: "candidate" | "interviewer"; timeInSeconds?: number }
): string {
  if (!quote?.trim() || !transcripts.length) return quote;
  const start = transcripts[0]?.timestamp ?? 0;

  if (opts?.timeInSeconds != null && opts.speaker) {
    let best: (typeof transcripts)[0] | undefined;
    let bestDist = Infinity;
    for (const t of transcripts) {
      if (t.sender !== opts.speaker) continue;
      const at = t.timestamp ? Math.max(0, Math.round((t.timestamp - start) / 1000)) : 0;
      const d = Math.abs(at - opts.timeInSeconds);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    if (best && bestDist <= 6) {
      if (best.textEn?.trim()) return best.textEn.trim();
      if (quote.trim().length > 10 && best.text.includes(quote.trim().slice(0, 20))) {
        return best.textEn?.trim() || best.text;
      }
    }
  }

  const needle = quote.trim().slice(0, Math.min(quote.trim().length, 40));
  for (const t of transcripts) {
    if (opts?.speaker && t.sender !== opts.speaker) continue;
    if (t.text.includes(needle) || needle.includes(t.text.trim().slice(0, 20))) {
      if (t.textEn?.trim()) return t.textEn.trim();
    }
  }

  return quote;
}
