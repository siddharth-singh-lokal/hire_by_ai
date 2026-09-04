import { EVALUATION_MODEL_ID } from "./bedrock";
import { callJson } from "./llm";
import { StoredTranscript } from "./sessionStore";

const HINGLISH_CODES = new Set(["hi", "hinglish", "en-IN"]);

const HINGLISH_LINE_PROMPT =
  `Convert this spoken interview line into natural Roman Hinglish — how Indian professionals actually talk, ` +
  `Hindi and English mixed in Latin script (e.g. "main us team ka part nahi tha, woh doosre colleague ne kiya"). ` +
  `Keep technical terms (API, Redis, deploy) in English. Devanagari must become Roman Hinglish — not Devanagari, ` +
  `not formal English. If already Roman Hinglish or plain English, keep the natural spoken form. ` +
  `Return ONLY: { "hinglish": "<roman hinglish line>" }`;

const HINGLISH_BATCH_PROMPT =
  `Convert each interview line into natural Roman Hinglish in Latin script — the everyday Hindi-English mix ` +
  `Indian engineers use ("main yeh nahi karta", "team ne handle kiya", "let's wrap the interview"). ` +
  `Keep technical terms in English. Devanagari → Roman Hinglish only, never Devanagari, never formal English. ` +
  `Lines already in Roman Hinglish or English: return unchanged. ` +
  `Return ONLY: { "lines": [{ "i": <index>, "hinglish": "<line>" }] } with one entry per input line.`;

/** True when the line contains Indic or other non-Latin script (e.g. Devanagari). */
export function hasNonLatinScript(text: string): boolean {
  return /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/.test(
    text
  );
}

/** Whether a live line needs Roman Hinglish for display. */
export function shouldLocalizeTranscript(text: string, languageCode?: string): boolean {
  if (hasNonLatinScript(text)) return true;
  const code = languageCode || "en";
  return HINGLISH_CODES.has(code);
}

/** @deprecated alias */
export const shouldTranslateToEnglish = shouldLocalizeTranscript;

export function sessionNeedsTranscriptLocalization(
  transcripts: StoredTranscript[],
  languageCode?: string
): boolean {
  if (languageCode && HINGLISH_CODES.has(languageCode)) return true;
  return transcripts.some((t) => hasNonLatinScript(t.text));
}

/** @deprecated alias */
export const sessionNeedsEnglishTranslation = sessionNeedsTranscriptLocalization;

/**
 * Roman Hinglish gloss for one live line. Stored in `textEn` for display; `text`
 * stays the verbatim ASR original.
 */
export async function translateLineToHinglish(text: string): Promise<string> {
  if (!text.trim()) return text;
  try {
    const { parsed } = await callJson({
      modelId: EVALUATION_MODEL_ID,
      system: HINGLISH_LINE_PROMPT,
      user: text,
      maxTokens: 400,
      temperature: 0.1,
      label: "translate-hinglish-line",
    });
    const out = String(parsed?.hinglish || "").trim();
    return out || text;
  } catch (err: any) {
    console.error("[translate] Hinglish line failed:", err?.message);
    return text;
  }
}

/** @deprecated alias */
export const translateLineToEnglish = translateLineToHinglish;

/**
 * Batch Roman Hinglish pass for grading/scorecard. Original `text` kept verbatim.
 */
export async function translateTranscriptToHinglish(
  transcripts: StoredTranscript[]
): Promise<StoredTranscript[]> {
  if (!transcripts.length) return transcripts;

  const numbered = transcripts.map((t, i) => `${i}\t${t.text}`).join("\n");

  try {
    const { parsed } = await callJson({
      modelId: EVALUATION_MODEL_ID,
      system: HINGLISH_BATCH_PROMPT,
      user: numbered,
      maxTokens: 4000,
      temperature: 0.1,
      label: "translate-hinglish-transcript",
    });

    const byIndex = new Map<number, string>();
    for (const row of parsed?.lines || []) {
      if (typeof row?.i === "number" && typeof row?.hinglish === "string") {
        byIndex.set(row.i, row.hinglish);
      }
    }

    return transcripts.map((t, i) => {
      const hinglish = byIndex.get(i);
      return hinglish && hinglish.trim() ? { ...t, textEn: hinglish.trim() } : t;
    });
  } catch (err: any) {
    console.error("[translate] Hinglish transcript failed:", err?.message);
    return transcripts;
  }
}

/** @deprecated alias */
export const translateTranscriptToEnglish = translateTranscriptToHinglish;
