import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockClient, extractJson } from "./bedrock";

/**
 * One call site for every TEXT model call — question bank generation, grading,
 * the generic counterfactual, and the Context Pack sanitizer/validator.
 *
 * WHY THIS EXISTS: the live voice interview runs on Amazon Nova Sonic and can
 * only ever run on Bedrock — nothing else offers a realtime bidirectional
 * speech-to-speech stream (checked: OpenRouter exposes 425 models, four of
 * which emit audio at all, none of them realtime; barge-in and VAD turn-taking
 * are impossible over request/response audio). So the voice path has no
 * fallback and must not get one.
 *
 * The text calls are different. They are ordinary prompt-in, JSON-out requests,
 * and they are what produces the scorecard — the output the whole product
 * exists to deliver. Those we can insure. If Bedrock refuses a text call
 * because sandbox credentials expired or a model's access was pulled (both
 * observed in this account), we retry once on OpenRouter and the interview
 * still gets graded.
 *
 * Bedrock stays primary and is the default: it is measured, it is what the
 * models were chosen against, and the interview already depends on it.
 * OpenRouter is a parachute, not a co-pilot.
 */

export type Provider = "bedrock" | "openrouter";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Read lazily, never captured at module load. A module-level read happens
 * before the entry point's dotenv call and silently produced "no fallback
 * configured" while the key sat in .env the whole time.
 */
const forcedProvider = (): Provider | "" =>
  (process.env.LLM_PROVIDER || "").toLowerCase() as Provider | "";
const openRouterKey = (): string => process.env.OPENROUTER_API_KEY || "";

/**
 * Bedrock model id -> OpenRouter equivalent. Kept explicit rather than derived:
 * a silent mismatch here would grade candidates on a different model than the
 * one the rubric was calibrated against, and that should be a visible decision.
 */
const OPENROUTER_EQUIVALENT: Record<string, string> = {
  "us.anthropic.claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "us.anthropic.claude-sonnet-4-5": "anthropic/claude-sonnet-4.5",
  "us.anthropic.claude-opus-4-6": "anthropic/claude-opus-4.6",
  "us.anthropic.claude-haiku-4-5": "anthropic/claude-haiku-4.5",
};

const fallbackModel = (): string =>
  process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.6";

/**
 * Errors where trying a different provider is the right move: the credentials
 * or the model grant are the problem, not the prompt. A malformed prompt would
 * fail identically everywhere, so those are NOT retried.
 */
const PROVIDER_LEVEL_FAILURE =
  /ExpiredToken|security token|credential|AccessDenied|AccessDeniedException|UnrecognizedClient|Throttl|ServiceUnavailable|ValidationException: .*model|ResourceNotFound|not authorized|on-demand throughput/i;

export interface TextCallInput {
  /** Bedrock model id. Mapped to an OpenRouter id only if a fallback happens. */
  modelId: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  /** Shows up in logs so a fallback is attributable to a specific task. */
  label: string;
}

export interface TextCallResult {
  text: string;
  provider: Provider;
  model: string;
}

async function callBedrock(input: TextCallInput): Promise<string> {
  const response = await bedrockClient.send(
    new ConverseCommand({
      modelId: input.modelId,
      system: [{ text: input.system }],
      messages: [{ role: "user", content: [{ text: input.user }] }],
      inferenceConfig: { maxTokens: input.maxTokens, temperature: input.temperature },
    })
  );
  const text = response.output?.message?.content?.[0]?.text;
  if (!text) throw new Error("Bedrock returned an empty response.");
  return text;
}

async function callOpenRouter(input: TextCallInput): Promise<{ text: string; model: string }> {
  const key = openRouterKey();
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not set, so there is no fallback provider.");
  }
  const model = OPENROUTER_EQUIVALENT[input.modelId] || fallbackModel();

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // OpenRouter attributes usage by these; harmless but polite.
      "HTTP-Referer": "http://localhost:3030",
      "X-Title": "Round-0 Screening",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      max_tokens: input.maxTokens,
      temperature: input.temperature,
    }),
  });

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `OpenRouter ${res.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 200)}`
    );
  }
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenRouter returned an empty response.");
  return { text, model };
}

/**
 * Runs a text call on Bedrock, falling back to OpenRouter once if Bedrock
 * fails for a provider-level reason and a key is configured.
 */
export async function callText(input: TextCallInput): Promise<TextCallResult> {
  if (forcedProvider() === "openrouter") {
    const { text, model } = await callOpenRouter(input);
    console.log(`[llm] ${input.label} — openrouter/${model} (LLM_PROVIDER=openrouter)`);
    return { text, provider: "openrouter", model };
  }

  try {
    const text = await callBedrock(input);
    return { text, provider: "bedrock", model: input.modelId };
  } catch (err: any) {
    const label = `${err?.name || "Error"}: ${err?.message || "unknown"}`;
    const providerFault = PROVIDER_LEVEL_FAILURE.test(label);

    if (!providerFault || !openRouterKey()) {
      // Either the prompt is the problem (a different provider would fail the
      // same way) or there is nothing to fall back to. Fail honestly.
      throw err;
    }

    console.warn(
      `[llm] ${input.label} — Bedrock failed (${label}). Falling back to OpenRouter.`
    );
    const { text, model } = await callOpenRouter(input);
    console.log(`[llm] ${input.label} — served by openrouter/${model}`);
    return { text, provider: "openrouter", model };
  }
}

/** callText plus JSON extraction, which every caller here needs. */
export async function callJson(input: TextCallInput): Promise<{ parsed: any } & TextCallResult> {
  const result = await callText(input);
  return { ...result, parsed: extractJson(result.text) };
}

/** For the health endpoint, so the demo can show what is actually configured. */
export function llmProviderStatus() {
  const key = openRouterKey();
  return {
    primary: forcedProvider() === "openrouter" ? "openrouter" : "bedrock",
    fallbackConfigured: Boolean(key),
    fallbackModel: key ? fallbackModel() : null,
  };
}
