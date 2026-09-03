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

export const EVALUATION_MODEL_ID =
  process.env.BEDROCK_EVALUATION_MODEL_ID || "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

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
    // Fall back to the outermost brace pair in case of leading prose.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Model response contained no parseable JSON object.");
  }
}
