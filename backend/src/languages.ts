/**
 * Interview languages.
 *
 * REALITY CHECK (AWS AI Service Card, verified 2026-09-04): Amazon Nova 2 Sonic
 * officially supports speech in English, Spanish, German, French, Italian,
 * Portuguese and Hindi ONLY. Among India's languages that means Hindi and
 * Indian English work; Telugu, Tamil, Kannada, Malayalam, Marathi, Gujarati and
 * Bengali are NOT supported and degrade badly, so they are listed here as
 * roadmap ("coming soon") rather than shipped. The honest path to full Bharat
 * coverage is Sarvam AI (native realtime speech-to-speech for all 22 Indian
 * languages) or a Transcribe -> LLM -> Amazon Polly cascade — a deliberate
 * next step, not something to fake with an unsupported Sonic locale.
 *
 * Voices: `kiara` (female) and `arjun` (male) are the native hi-IN / en-IN
 * voices; `tiffany` / `matthew` are polyglot and code-switch Hinglish within a
 * sentence, which is why Hinglish uses tiffany.
 */

export type LanguageCode =
  | "en"
  | "en-IN"
  | "hi"
  | "hinglish"
  | "te"
  | "ta"
  | "kn"
  | "ml"
  | "mr"
  | "gu"
  | "bn";

export interface LanguageConfig {
  code: LanguageCode;
  /** English label for the admin picker. */
  label: string;
  /** Endonym, shown under the label so the picker reads to a native speaker. */
  nativeLabel: string;
  /** Whether Nova Sonic can actually conduct the interview in this language today. */
  sonicSupported: boolean;
  /** Sonic voiceId to use. Ignored when unsupported. */
  voiceId: string;
  /** Interviewer persona name — an Indian name for the Indian-context languages. */
  interviewerName: string;
  /**
   * Directive appended to the live prompt. Empty for the English default, which
   * already accepts Hinglish. Written to be spoken naturally by the model.
   */
  directive: string;
}

export const DEFAULT_LANGUAGE: LanguageCode = "en";

export const LANGUAGES: Record<LanguageCode, LanguageConfig> = {
  en: {
    code: "en",
    label: "English",
    nativeLabel: "English",
    sonicSupported: true,
    // `arjun` is Nova 2 Sonic's Indian English (en-IN) MASCULINE voice — an
    // Indian-accented male. (`kiara` is its Indian female counterpart; `matthew`
    // is US male.) Overridable at runtime with BEDROCK_SONIC_VOICE.
    voiceId: "arjun",
    interviewerName: "Arjun Sharma",
    directive: "",
  },
  hinglish: {
    code: "hinglish",
    label: "Hinglish",
    nativeLabel: "हिंग्लिश",
    sonicSupported: true,
    voiceId: "tiffany",
    interviewerName: "Priya",
    directive:
      "Speak in natural Hinglish — the everyday Hindi-English mix Indian engineers actually use, switching between the two mid-sentence as feels natural. Keep technical terms (Redis, API, SQL, deploy) in English. The candidate will do the same; follow their lead on the balance.",
  },
  hi: {
    code: "hi",
    label: "Hindi",
    nativeLabel: "हिन्दी",
    sonicSupported: true,
    voiceId: "kiara",
    interviewerName: "Priya",
    directive:
      "Conduct the entire interview in Hindi. The questions below are written in English; ask them in natural spoken Hindi, keeping technical terms (Redis, API, SQL, deploy) in English the way engineers do. The candidate may answer in Hindi, English, or a mix — understand them either way and never ask them to switch.",
  },
  "en-IN": {
    code: "en-IN",
    label: "Indian English",
    nativeLabel: "Indian English",
    sonicSupported: true,
    voiceId: "kiara",
    interviewerName: "Priya",
    directive:
      "Speak in clear Indian English. The candidate may slip into Hindi or a Hindi-English mix; that is completely fine, follow their lead and never comment on their language.",
  },
  // --- Roadmap: not yet supported by Nova Sonic. Shown in the picker as
  // "coming soon" so the product's full-Bharat ambition is visible without
  // shipping a broken experience. Sarvam AI is the planned engine for these.
  te: { code: "te", label: "Telugu", nativeLabel: "తెలుగు", sonicSupported: false, voiceId: "kiara", interviewerName: "Priya", directive: "" },
  ta: { code: "ta", label: "Tamil", nativeLabel: "தமிழ்", sonicSupported: false, voiceId: "kiara", interviewerName: "Priya", directive: "" },
  kn: { code: "kn", label: "Kannada", nativeLabel: "ಕನ್ನಡ", sonicSupported: false, voiceId: "kiara", interviewerName: "Priya", directive: "" },
  ml: { code: "ml", label: "Malayalam", nativeLabel: "മലയാളം", sonicSupported: false, voiceId: "kiara", interviewerName: "Priya", directive: "" },
  mr: { code: "mr", label: "Marathi", nativeLabel: "मराठी", sonicSupported: false, voiceId: "kiara", interviewerName: "Priya", directive: "" },
  gu: { code: "gu", label: "Gujarati", nativeLabel: "ગુજરાતી", sonicSupported: false, voiceId: "kiara", interviewerName: "Priya", directive: "" },
  bn: { code: "bn", label: "Bengali", nativeLabel: "বাংলা", sonicSupported: false, voiceId: "kiara", interviewerName: "Priya", directive: "" },
};

/** Coerces arbitrary input to a supported language, falling back to the default. */
export function resolveLanguage(code: unknown): LanguageConfig {
  const key = String(code || "") as LanguageCode;
  const cfg = LANGUAGES[key];
  return cfg && cfg.sonicSupported ? cfg : LANGUAGES[DEFAULT_LANGUAGE];
}
