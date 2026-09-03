import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockClient, SANITIZER_MODEL_ID, extractJson } from "../bedrock";
import { scanForLeaks } from "./redact";
import { ContextPack, ValidationResult } from "./types";

/**
 * Stage 3: the gate. Nothing ships unless this passes.
 *
 * Two independent checks, because they fail differently:
 *
 *  - The regex scan catches known-dangerous shapes (credentials, emails, private
 *    IPs) but only shapes it was told about.
 *  - The adversarial model pass catches what regex cannot: prose that identifies
 *    the organisation without containing a single matchable token. "A hyperlocal
 *    news app serving non-English speakers across seven Indian states" has no
 *    secrets in it and is still a fingerprint.
 *
 * Fails closed. If the validator itself errors, that is a FAIL, not a pass — an
 * unavailable check is not a passed check.
 */

const ADVERSARIAL_PROMPT = `You are a security reviewer auditing interview material before it is shown to external job candidates.

The material was derived from a company's internal engineering documentation. Your job is to find anything that could identify the company, expose internal systems, or leak confidential information.

Look for:
- Descriptions specific enough to fingerprint the organisation (its market, user base, product mix, geography)
- Internal system, service, or team names that survived sanitization
- Architecture detail so specific it would help someone attack the real infrastructure
- Any residual credential, hostname, identifier, or personal name
- Placeholder tokens like <internal-host> or <ticket> that were left in the output
- Exact wall-clock times, dates, version numbers or deployment timestamps that would let an insider recognise a specific incident
- BUSINESS LOGIC of any kind: pricing rules, subscription or billing mechanics, payout
  or commission structures, tax handling, wallet or credit economics, tier and discount
  schemes, ranking or recommendation formulas, experiment results, monetisation strategy.
  Naming a technology the company uses is acceptable; describing how it charges its
  customers is not.

Do NOT flag generic industry technology (PostgreSQL, Django, Redis, Kafka, Kubernetes) or ordinary engineering concepts. Those are public knowledge and the material is useless without them.

Be strict but not paranoid: the test is "could a candidate reading this identify the company or learn something they should not know", not "is this about software".

Return ONLY:
{ "safe": true|false, "concerns": ["..."], "reasoning": "one or two sentences" }`;

export async function validatePack(pack: ContextPack): Promise<ValidationResult> {
  // Serialise everything a candidate could ever be exposed to. The provenance
  // block is excluded deliberately — it holds source titles for auditing and is
  // never sent to the interviewer.
  const exposed = JSON.stringify(
    { stackProfile: pack.stackProfile, scenarios: pack.scenarios },
    null,
    2
  );

  const findings = scanForLeaks(exposed);

  // Placeholder tokens surviving into output means the abstraction pass failed.
  const placeholders = exposed.match(/<(?:internal-host|ticket|commit|email|credential|cloud-host|internal-domain|k8s-ref|gcp-project|path|phone|ip)>/g);
  if (placeholders?.length) {
    findings.push({
      rule: "unresolved-placeholder",
      sample: placeholders[0],
      count: placeholders.length,
    });
  }

  let llmVerdict: string | undefined;
  let llmSafe = false;

  try {
    const response = await bedrockClient.send(
      new ConverseCommand({
        modelId: SANITIZER_MODEL_ID,
        system: [{ text: ADVERSARIAL_PROMPT }],
        messages: [{ role: "user", content: [{ text: exposed.slice(0, 60000) }] }],
        inferenceConfig: { maxTokens: 1500, temperature: 0 },
      })
    );

    const text = response.output?.message?.content?.[0]?.text;
    if (!text) throw new Error("empty response");

    const verdict = extractJson(text);
    llmSafe = verdict?.safe === true;
    llmVerdict = verdict?.reasoning || "";

    if (Array.isArray(verdict?.concerns)) {
      for (const concern of verdict.concerns) {
        findings.push({ rule: "llm-concern", sample: String(concern).slice(0, 120), count: 1 });
      }
    }
  } catch (err: any) {
    // Fail closed. An unavailable check is not a passed check.
    llmSafe = false;
    llmVerdict = `Adversarial check could not complete: ${err?.message}. Failing closed.`;
    findings.push({ rule: "validator-unavailable", sample: err?.name || "error", count: 1 });
  }

  return {
    passed: findings.length === 0 && llmSafe,
    findings,
    llmVerdict,
  };
}
