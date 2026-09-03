import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";


/**
 * Region and model IDs for the workshop sandbox.
 *
 * Two gotchas worth remembering:
 *  - Claude requires the `us.` inference-profile prefix. Bare `anthropic.claude-*`
 *    IDs are rejected with "on-demand throughput isn't supported".
 *  - Nova Sonic is the opposite: ON_DEMAND only, so it takes the bare model ID
 *    and has no inference profile.
 */
export const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";

/**
 * Model per task. Chosen by what this sandbox actually grants — opus-5,
 * sonnet-5, gpt-5.6 and grok all return AccessDenied — and then benchmarked.
 *
 * Sonnet 4.6 everywhere, deliberately:
 *
 *  - EVALUATION: measured against Opus 4.6 on the same transcript, Sonnet gave
 *    the same overall score with the same structured output (evidence moments,
 *    gap matrix, R1 briefing all intact) at a fraction of the cost. Opus is
 *    still a one-line override when a decision warrants it.
 *  - GENERATION: Haiku 4.5 finished only ~25% faster (51s vs 68s) because the
 *    bottleneck is output size, not model speed — and it surfaced 3 JD gaps
 *    where Sonnet found 5. Not a trade worth making, especially since this runs
 *    on the admin side before the candidate exists.
 *  - SANITIZATION: bulk workload, and kept on a different model from whatever
 *    generates the interview, so a blind spot in one is less likely to be
 *    shared by the other.
 *
 * Nothing here sits inside the voice loop: Nova Sonic handles the live call and
 * these all run before or after it.
 */
export const EVALUATION_MODEL_ID =
  process.env.BEDROCK_EVALUATION_MODEL_ID || "us.anthropic.claude-sonnet-4-6";

export const GENERATION_MODEL_ID =
  process.env.BEDROCK_GENERATION_MODEL_ID || "us.anthropic.claude-sonnet-4-6";

export const SANITIZER_MODEL_ID =
  process.env.BEDROCK_SANITIZER_MODEL_ID || "us.anthropic.claude-sonnet-4-6";

export const SONIC_MODEL_ID = process.env.BEDROCK_SONIC_MODEL_ID || "amazon.nova-2-sonic-v1:0";

/**
 * Credentials resolve through the default provider chain, which picks up
 * AWS_PROFILE / AWS_ACCESS_KEY_ID+SECRET+SESSION_TOKEN from the environment.
 * Workshop credentials are temporary, so a 403 here usually means the event
 * session expired rather than anything being misconfigured.
 */
export const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });

/** Strips markdown fences the model sometimes wraps JSON in. */
export function extractJson(raw: string): any {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Models occasionally emit JS-flavoured JSON — line comments, trailing
    // commas — especially when the prompt's schema example contains either.
    // Repair before giving up, since a whole evaluation is otherwise lost.
    try {
      const repaired = candidate
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1");
      return JSON.parse(repaired);
    } catch {
      /* fall through to brace extraction */
    }
    // Fall back to the outermost brace pair in case of leading prose.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const sliced = candidate
        .slice(start, end + 1)
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1");
      return JSON.parse(sliced);
    }
    throw new Error("Model response contained no parseable JSON object.");
  }
}
