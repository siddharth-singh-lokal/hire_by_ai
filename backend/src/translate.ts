import { EVALUATION_MODEL_ID } from "./bedrock";
import { callJson } from "./llm";
import { StoredTranscript } from "./sessionStore";

/**
 * Translates a non-English interview transcript to English, in one batch call,
 * so the recruiter can read a Hindi/Hinglish screen. The original `text` is kept
 * verbatim (evidence quotes rely on it); the translation lands in `textEn`.
 *
 * Runs off the hot path — called once at grading time, not per line — so a slow
 * translation never touches the live audio loop. Best-effort: on any failure the
 * transcript is returned unchanged rather than blocking the scorecard.
 */
export async function translateTranscriptToEnglish(
  transcripts: StoredTranscript[],
  languageLabel: string
): Promise<StoredTranscript[]> {
  if (!transcripts.length) return transcripts;

  const numbered = transcripts.map((t, i) => `${i}\t${t.text}`).join("\n");

  try {
    const { parsed } = await callJson({
      modelId: EVALUATION_MODEL_ID,
      system:
        `Translate each interview line from ${languageLabel} (which may mix in English — Hinglish) into natural, plain English. ` +
        `Keep technical terms (Redis, API, SQL, deploy, etc.) as-is. Preserve meaning and tone; do not summarise, add, or omit anything. ` +
        `Lines already in English should be returned unchanged. ` +
        `Return ONLY a JSON object: { "lines": [{ "i": <index>, "en": "<english>" }] } with one entry per input line, same indices.`,
      user: numbered,
      maxTokens: 4000,
      temperature: 0.1,
      label: "translate-transcript",
    });

    const byIndex = new Map<number, string>();
    for (const row of parsed?.lines || []) {
      if (typeof row?.i === "number" && typeof row?.en === "string") byIndex.set(row.i, row.en);
    }

    return transcripts.map((t, i) => {
      const en = byIndex.get(i);
      return en && en.trim() ? { ...t, textEn: en.trim() } : t;
    });
  } catch (err: any) {
    console.error("[translate] Transcript translation failed:", err?.message);
    return transcripts;
  }
}
