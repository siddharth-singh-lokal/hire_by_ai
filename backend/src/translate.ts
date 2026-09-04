import { EVALUATION_MODEL_ID } from "./bedrock";
import { callJson } from "./llm";
import { StoredTranscript } from "./sessionStore";

/** True when the line contains Indic or other non-Latin script (e.g. Devanagari). */
export function hasNonLatinScript(text: string): boolean {
  return /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/.test(
    text
  );
}

/** Whether a transcript line should be shown in English for the recruiter/candidate UI. */
export function shouldTranslateToEnglish(text: string, languageCode?: string): boolean {
  if (hasNonLatinScript(text)) return true;
  const code = languageCode || "en";
  return code !== "en";
}

export function sessionNeedsEnglishTranslation(
  transcripts: StoredTranscript[],
  languageCode?: string
): boolean {
  if (languageCode && languageCode !== "en") return true;
  return transcripts.some((t) => hasNonLatinScript(t.text));
}

/**
 * Translates a single live transcript line to English. Best-effort; returns the
 * original on failure. Off the audio hot path — called async after each line.
 */
export async function translateLineToEnglish(
  text: string,
  languageLabel: string
): Promise<string> {
  if (!text.trim()) return text;
  try {
    const { parsed } = await callJson({
      modelId: EVALUATION_MODEL_ID,
      system:
        `Translate this spoken interview line from ${languageLabel} (may mix English — Hinglish) into natural plain English. ` +
        `Keep technical terms (Redis, API, SQL, deploy, etc.) as-is. Preserve meaning; do not summarise. ` +
        `If already in English, return it unchanged. Return ONLY: { "en": "<english line>" }`,
      user: text,
      maxTokens: 400,
      temperature: 0.1,
      label: "translate-line",
    });
    const en = String(parsed?.en || "").trim();
    return en || text;
  } catch (err: any) {
    console.error("[translate] Line translation failed:", err?.message);
    return text;
  }
}

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
