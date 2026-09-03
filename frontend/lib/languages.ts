/**
 * Interview languages shown in the admin picker. Mirrors backend/src/languages.ts —
 * the backend is authoritative and coerces anything unsupported to English.
 *
 * Nova 2 Sonic officially supports Hindi and (Indian) English among India's
 * languages; the rest are on the roadmap via Sarvam AI (native realtime
 * speech-to-speech for all 22 Indian languages) and are shown disabled so the
 * product's full-Bharat ambition is visible without shipping a broken call.
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

export interface LanguageOption {
  code: LanguageCode;
  label: string;
  nativeLabel: string;
  available: boolean;
}

export const LANGUAGES: LanguageOption[] = [
  { code: "en", label: "English", nativeLabel: "English", available: true },
  { code: "hinglish", label: "Hinglish", nativeLabel: "हिंग्लिश", available: true },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी", available: true },
  { code: "en-IN", label: "Indian English", nativeLabel: "Indian English", available: true },
  { code: "te", label: "Telugu", nativeLabel: "తెలుగు", available: false },
  { code: "ta", label: "Tamil", nativeLabel: "தமிழ்", available: false },
  { code: "kn", label: "Kannada", nativeLabel: "ಕನ್ನಡ", available: false },
  { code: "ml", label: "Malayalam", nativeLabel: "മലയാളം", available: false },
  { code: "mr", label: "Marathi", nativeLabel: "मराठी", available: false },
  { code: "gu", label: "Gujarati", nativeLabel: "ગુજરાતી", available: false },
  { code: "bn", label: "Bengali", nativeLabel: "বাংলা", available: false },
];

export function languageLabel(code?: string | null): string {
  return LANGUAGES.find((l) => l.code === code)?.label || "English";
}

/** Spoken-language copy for the candidate lobby, e.g. "in Hindi". */
export function languagePhrase(code?: string | null): string | null {
  const l = LANGUAGES.find((x) => x.code === code);
  if (!l || l.code === "en") return null;
  if (l.code === "hinglish") return "in Hinglish (Hindi and English mixed)";
  return `in ${l.label}`;
}
