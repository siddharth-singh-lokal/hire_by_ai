import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockClient, SANITIZER_MODEL_ID, extractJson } from "../bedrock";
import { redact } from "./redact";
import { Finding, RawDocument, Scenario, StackProfile } from "./types";

/**
 * Stage 2 of the pipeline: turn redacted internal docs into abstracted interview
 * scenarios.
 *
 * Redaction (stage 1) removes identifiers but leaves text that still reads like
 * an internal document — "the service now reuses database connections, see
 * <ticket>". This stage rewrites it into a standalone engineering problem that
 * makes sense to someone who has never worked here, while keeping the reasoning
 * that made it worth asking about.
 *
 * The model never sees an unredacted document. Redaction is not something we ask
 * it to do; it has already happened.
 */

const SCENARIO_PROMPT = `You are building interview material from sanitized engineering documentation.

The text has ALREADY had identifiers removed — you will see placeholders like <internal-host>, <ticket>, <commit>, <email>. Never try to guess or reconstruct what they contained, and never carry a placeholder into your output.

Your job: extract engineering situations that reveal how someone THINKS, and rewrite each as a self-contained problem a candidate could reason about with no knowledge of this company.

WHAT IS IN SCOPE — infrastructure and engineering craft:
  Connection pooling, caching strategy, query performance, failure modes, retries
  and idempotency, race conditions, deployment and rollback, observability,
  schema design, API design, concurrency, scaling patterns.
  These are industry-standard problems. Reasoning about them reveals ability and
  reveals nothing proprietary.

WHAT IS OUT OF SCOPE — business and product logic. REJECT these outright:
  Pricing rules, subscription or billing mechanics, payout or commission logic,
  tax handling, coin/credit/wallet economics, tier or discount schemes,
  recommendation ranking formulas, experiment results, monetisation strategy,
  moderation policy, anything describing HOW THE BUSINESS MAKES MONEY.
  A document explaining how subscriptions are priced is confidential and also
  makes a terrible interview question — a candidate cannot reason about rules
  they have never seen. If a document is mostly business logic, return NO
  scenarios for it. That is the correct outcome, not a failure.

The test: "we run PostgreSQL and Redis behind Django" is fine — that is a stack,
and every job ad says as much. "Users are charged an escalating rate after N
minutes with the same expert" is not fine — that is the business.

RULES
- Preserve the engineering substance: the constraint, the tradeoff, the failure mode, the non-obvious gotcha. That is the whole value.
- Remove all traceability: no product names, service names, team names, ticket references, or "we"/"our company" phrasing. Write in neutral third person ("a service", "a team").
- Keep generic technology names (PostgreSQL, Django, Redis, Kubernetes). Those are industry knowledge, not secrets.

- DISTINGUISH SHAPE FROM FINGERPRINT. This is the subtle part and it matters most:
    * KEEP the magnitudes and ratios that make the problem real — "a 2-vCPU database", "one connection per worker thread", "a 24-hour TTL", "roughly 5,000 requests per second".
    * DROP the exact configuration that lets someone recognise a specific event — precise wall-clock times, dates, deployment timestamps, version numbers on cache keys, cloud instance SKUs, exact pod/worker/replica counts.
    * Say "the cache expired at the same time each afternoon", never "expired at 4:00 PM". Say "the cache key was versioned on deploy", never "v6 became v7".
  A reader who works at the source company must not be able to identify which incident this was.

- Drop numbers that reveal scale of business (user counts, revenue, downloads).
- Prefer situations with a genuine gotcha over descriptive documentation. A doc explaining what a service does is worthless; a doc explaining why something broke is gold.
- If a document contains no real engineering judgment, return no scenario for it. Empty output is correct and expected.

TAG EACH SCENARIO WITH THE ROLES IT SUITS ("disciplines").
  backend, frontend, mobile, data, devops, product, design, or "any".
This matters more than it looks. Without it a connection-pooling scenario reaches
a product analyst, which measures nothing and makes the interview look broken.
Be strict: an infrastructure problem is ["backend"] or ["backend","devops"], not
["any"]. Reserve "any" for situations that genuinely transcend discipline —
ambiguous requirements, conflicting priorities, communicating during an incident,
deciding what to cut under time pressure.

For each scenario set difficulty on this scale:
  0 = intern / fresh grad     1 = 1-2 yrs      2 = 3-5 yrs
  3 = senior / 5-8 yrs        4 = staff / 8+ yrs

Return ONLY a JSON object:
{
  "scenarios": [
    {
      "id": "kebab-case-slug",
      "title": "short description of the situation",
      "stack": ["PostgreSQL", "Django"],
      "constraints": ["cost-constrained instance sizing"],
      "prompt": "the question as posed to a candidate",
      "probes": ["follow-up when the answer is strong"],
      "weakAnswer": ["what a shallow answer looks like"],
      "strongAnswer": ["what a strong answer identifies"],
      "competencies": ["databases", "reliability"],
      "disciplines": ["backend"],
      "difficulty": 3
    }
  ]
}`;

const STACK_PROMPT = `From these sanitized engineering documents, describe the org's technical environment generically — the kind of profile you could write about any company in this space.

Include operating constraints that shape engineering decisions (cost sensitivity, team structure, instance sizing philosophy). Exclude anything identifying: no product names, no scale-of-business figures.

Return ONLY:
{
  "languages": [], "datastores": [], "infrastructure": [],
  "observability": [], "operatingConstraints": []
}`;

async function callModel(system: string, user: string, maxTokens = 4096): Promise<any> {
  const response = await bedrockClient.send(
    new ConverseCommand({
      modelId: SANITIZER_MODEL_ID,
      system: [{ text: system }],
      messages: [{ role: "user", content: [{ text: user }] }],
      // Low temperature: this is an extraction task, not a creative one.
      inferenceConfig: { maxTokens, temperature: 0.2 },
    })
  );

  const text = response.output?.message?.content?.[0]?.text;
  if (!text) throw new Error("Model returned an empty response during sanitization.");
  return extractJson(text);
}

export interface SanitizeResult {
  scenarios: Scenario[];
  stackProfile: StackProfile;
  redactionFindings: Finding[];
}

export async function sanitizeDocuments(docs: RawDocument[]): Promise<SanitizeResult> {
  const redactionFindings: Finding[] = [];
  const cleaned: { title: string; body: string }[] = [];

  // Stage 1 — deterministic redaction. Always before the model sees anything.
  for (const doc of docs) {
    const { clean: cleanBody, findings: bodyFindings } = redact(doc.body);
    const { clean: cleanTitle } = redact(doc.title);
    redactionFindings.push(...bodyFindings);
    cleaned.push({ title: cleanTitle, body: cleanBody });
  }

  // Stage 2 — abstraction, one document at a time so a single noisy doc cannot
  // blow the context window or drag unrelated scenarios together.
  const scenarios: Scenario[] = [];
  for (const doc of cleaned) {
    // Skip stubs and template pages; they produce nothing but cost a call.
    if (doc.body.trim().length < 400) continue;

    try {
      const result = await callModel(
        SCENARIO_PROMPT,
        `Document title: ${doc.title}\n\n${doc.body.slice(0, 24000)}`
      );
      if (Array.isArray(result?.scenarios)) scenarios.push(...result.scenarios);
    } catch (err: any) {
      console.error(`[sanitize] Skipping "${doc.title}": ${err?.message}`);
    }
  }

  const corpus = cleaned
    .map((d) => `## ${d.title}\n${d.body.slice(0, 4000)}`)
    .join("\n\n")
    .slice(0, 40000);

  const stackProfile: StackProfile = await callModel(STACK_PROMPT, corpus, 1500);

  return { scenarios, stackProfile, redactionFindings };
}
