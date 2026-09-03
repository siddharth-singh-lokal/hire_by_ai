/**
 * Minimal OpenRouter chat-completions client.
 *
 * Powers the TEXT interview mode — a stable, typed alternative to the Nova Sonic
 * voice loop (which drops its Bedrock stream). OpenRouter only does text chat
 * completions; it has no real-time audio, so this is text-only by nature.
 *
 * Needs `OPENROUTER_API_KEY` in the backend env. Model is overridable via
 * `OPENROUTER_MODEL` (default: a fast, cheap instruction-follower).
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatComplete(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error("OPENROUTER_API_KEY is not set in the backend environment.");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // Optional but recommended by OpenRouter for attribution.
      "X-Title": "Round-0 Interview",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 300,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }

  const data: any = await res.json();
  const content = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!content) throw new Error("OpenRouter returned an empty message.");
  return content;
}

export { OPENROUTER_MODEL };
