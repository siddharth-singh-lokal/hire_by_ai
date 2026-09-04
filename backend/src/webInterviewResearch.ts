import { GENERATION_MODEL_ID } from "./bedrock";
import { callJson } from "./llm";

/**
 * Pulls commonly asked interview questions for a role from the public web
 * (LeetCode Discuss, Blind, Glassdoor, etc.) and turns them into screening
 * questions for the live voice interview.
 *
 * Runs during admin prepare — before the candidate exists — so the call never
 * blocks on a network fetch.
 */

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  site: string;
}

export interface SuggestedMarketQuestion {
  question: string;
  intent: string;
  source: string;
  sourceUrl?: string;
  strongAnswer: string[];
  weakAnswer: string[];
  fallback?: string;
}

export interface WebResearchResult {
  roleHint: string;
  queries: string[];
  hits: WebSearchHit[];
  suggested: SuggestedMarketQuestion[];
  /** False when search failed and we fell back to model-only suggestions. */
  fromWeb: boolean;
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; HireByAI/1.0; +https://github.com/lokal/hire-by-ai)";

/**
 * Reduces a JD's title line to a searchable ROLE, not a marketing headline.
 *
 * This was returning the raw first matching line, so a JD headed
 * "🌍 Backend Intern @ Lokal — Build Tech for Bharat" became the search query
 * verbatim. Emoji and taglines in a query return search-engine landing pages
 * instead of interview pages, which then produced hallucinated "market"
 * questions — and the one it invented was another résumé walk-through, which is
 * exactly what the market kind exists to avoid.
 */
function cleanRoleLine(raw: string): string {
  return (
    raw
      // markdown/bullet decoration
      .replace(/^#+\s*/, "")
      .replace(/^[*\-•\s]+/, "")
      // emoji and pictographs
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE00}-\u{FE0F}\u{2B00}-\u{2BFF}]/gu, "")
      // "Role - X", "Title – X", "Job Title: X", "Position: X"
      .replace(/^\s*(?:role|title|job\s*title|position|designation)\s*[-–—:]\s*/i, "")
      // drop everything from the first company/tagline separator onward:
      // "Backend Intern @ Lokal — Build Tech for Bharat" -> "Backend Intern"
      .split(/\s+[@|·]\s+|\s+[—–]\s+|\s*\|\s*/)[0]
      // trailing location/parenthetical noise
      .replace(/\s*[\(\[].*$/, "")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

function extractRoleHint(jdText: string): string {
  const lines = jdText
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (
      /(?:engineer|developer|analyst|manager|designer|architect|intern|lead|devops|sre|qa|tester|product|data|mobile|frontend|backend|full.?stack|listener|sales|executive|support)/i.test(
        line
      ) &&
      line.length < 160
    ) {
      const cleaned = cleanRoleLine(line);
      // A cleaned hint of one or two characters means we stripped everything
      // meaningful; fall through rather than search for junk.
      if (cleaned.length >= 3) return cleaned.slice(0, 60);
    }
  }
  return cleanRoleLine(lines[0] || "").slice(0, 60) || "Software Engineer";
}

/**
 * Does this hit look like an actual interview-questions PAGE, rather than a
 * site's homepage or an index that happened to rank?
 *
 * Without this check, `glassdoor.com/Interview/index.htm` and
 * `teamblind.com/` counted as successful research and the extractor invented
 * questions from their marketing copy.
 */
function isUsefulHit(h: WebSearchHit): boolean {
  let path = "";
  try {
    path = new URL(h.url).pathname;
  } catch {
    return false;
  }
  if (/^\/?$/.test(path)) return false; // homepage
  if (/\/index\.(html?|htm)$/i.test(path)) return false;
  if (path.replace(/\//g, "").length < 12) return false; // too shallow to be content
  // Real pages carry a role or company slug, a post id, or a question path.
  return /interview|question|discuss|post|experience|hiring|prepare/i.test(path);
}

function siteLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("leetcode")) return "LeetCode";
    if (host.includes("teamblind") || host.includes("blind")) return "Blind";
    if (host.includes("glassdoor")) return "Glassdoor";
    if (host.includes("reddit")) return "Reddit";
    if (host.includes("geeksforgeeks")) return "GeeksforGeeks";
    if (host.includes("indeed")) return "Indeed";
    return host;
  } catch {
    return "Web";
  }
}

/** DuckDuckGo HTML wraps outbound links in //duckduckgo.com/l/?uddg=... redirects. */
function resolveDuckDuckGoHref(raw: string): string | null {
  const href = raw.replace(/&amp;/g, "&").trim();
  if (!href) return null;

  if (href.startsWith("http://") || href.startsWith("https://")) return href;

  const absolute = href.startsWith("//") ? `https:${href}` : href;
  try {
    const u = new URL(absolute, "https://duckduckgo.com");
    if (u.hostname.includes("duckduckgo.com") && u.pathname.startsWith("/l/")) {
      const target = u.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    }
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    /* fall through */
  }
  return null;
}

/** Parse DuckDuckGo HTML results — no API key required. */
async function searchDuckDuckGo(query: string, limit = 6): Promise<WebSearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.status}`);
  const html = await res.text();

  const hits: WebSearchHit[] = [];
  const linkRe =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < limit) {
    const url = resolveDuckDuckGoHref(m[1]);
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    if (title && url) links.push({ url, title });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < limit) {
    snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
  }

  for (let i = 0; i < links.length; i++) {
    hits.push({
      ...links[i],
      snippet: snippets[i] || "",
      site: siteLabel(links[i].url),
    });
  }
  return hits;
}

/** Optional Serper (Google) search when SERPER_API_KEY is set. */
async function searchSerper(query: string, limit = 6): Promise<WebSearchHit[]> {
  const key = process.env.SERPER_API_KEY?.trim();
  if (!key) return [];

  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: limit }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Serper search failed: ${res.status}`);
  const data = (await res.json()) as { organic?: { title: string; link: string; snippet: string }[] };
  return (data.organic || []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet || "",
    site: siteLabel(r.link),
  }));
}

async function runSearch(query: string, limit = 6): Promise<WebSearchHit[]> {
  const serper = await searchSerper(query, limit).catch(() => []);
  if (serper.length) return serper;
  return searchDuckDuckGo(query, limit);
}

function buildQueries(roleHint: string, discipline: string): string[] {
  const role = roleHint.slice(0, 80);
  const sites =
    discipline === "product" || discipline === "design"
      ? "glassdoor OR indeed interview questions"
      : "leetcode OR teamblind OR blind OR glassdoor interview questions";
  return [
    `${role} ${sites}`,
    `${role} technical interview experience site:leetcode.com OR site:teamblind.com`,
    `${role} phone screen questions ${discipline !== "any" ? discipline : ""}`.trim(),
  ];
}

function dedupeHits(hits: WebSearchHit[]): WebSearchHit[] {
  const seen = new Set<string>();
  const out: WebSearchHit[] = [];
  for (const h of hits) {
    const key = h.url.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

async function extractQuestions(input: {
  roleHint: string;
  discipline: string;
  jdExcerpt: string;
  hits: WebSearchHit[];
  count: number;
}): Promise<SuggestedMarketQuestion[]> {
  const snippets = input.hits
    .map(
      (h, i) =>
        `[${i + 1}] ${h.site}: ${h.title}\nURL: ${h.url}\n${h.snippet}`
    )
    .join("\n\n");

  const { parsed } = await callJson({
    modelId: GENERATION_MODEL_ID,
    system: `You extract Round-0 SCREENING interview questions from web search snippets about what companies ask for a role.

Rules:
- Output exactly ${input.count} question(s), each grounded in something from the SNIPPETS. If the snippets do not support a question, return fewer — an empty list is a valid and correct answer. Do NOT invent a question to fill the count.
- NEVER output a résumé walk-through ("walk me through a project you built", "tell me about your most challenging project", "what was your tech stack"). Those already exist elsewhere in this interview, they are what the market kind is meant to ADD to, and duplicating them wastes the slot. A market question must stand on its own without the candidate's résumé.
- Questions must be answerable in a VOICE conversation in 3-5 minutes — NOT "write code on a whiteboard" or "implement leetcode #42".
- Prefer questions candidates report on Blind, LeetCode Discuss, Glassdoor — system design at screening depth, debugging stories, tradeoffs, "tell me about a time", domain concepts.
- Match the discipline: ${input.discipline}. Do NOT ask backend infra questions for a PM or designer.
- Attribute source as the site name (LeetCode, Blind, Glassdoor, etc.) and include sourceUrl when you can tie it to a snippet URL.
- strongAnswer/weakAnswer: illustrative only — grade reasoning not recall.

Return ONLY JSON:
{
  "questions": [{
    "question": "...",
    "intent": "...",
    "source": "LeetCode|Blind|Glassdoor|...",
    "sourceUrl": "optional url from snippets",
    "strongAnswer": ["..."],
    "weakAnswer": ["..."],
    "fallback": "optional simpler angle"
  }]
}`,
    user: `Role: ${input.roleHint}\n\nJD excerpt:\n${input.jdExcerpt.slice(0, 3000)}\n\n=== WEB SNIPPETS ===\n${snippets || "(no snippets — use well-known screening themes for this role)"}`,
    maxTokens: 3000,
    temperature: 0.35,
    label: "web-interview-extract",
  });

  const rows = Array.isArray(parsed?.questions) ? parsed.questions : [];
  return rows.slice(0, input.count).map((q: any) => ({
    question: String(q?.question || "").trim(),
    intent: String(q?.intent || "Commonly asked for this role on interview forums.").trim(),
    source: String(q?.source || "Web").trim(),
    sourceUrl: q?.sourceUrl ? String(q.sourceUrl) : undefined,
    strongAnswer: Array.isArray(q?.strongAnswer) ? q.strongAnswer.map(String) : [],
    weakAnswer: Array.isArray(q?.weakAnswer) ? q.weakAnswer.map(String) : [],
    fallback: q?.fallback ? String(q.fallback) : undefined,
  }));
}

export function webResearchEnabled(): boolean {
  return process.env.WEB_RESEARCH_ENABLED !== "false";
}

/**
 * Search the web and extract market-grounded interview questions for a role.
 */
export async function researchMarketInterviewQuestions(opts: {
  jdText: string;
  discipline: string;
  count: number;
}): Promise<WebResearchResult> {
  const roleHint = extractRoleHint(opts.jdText);
  const queries = buildQueries(roleHint, opts.discipline);

  if (!webResearchEnabled() || opts.count <= 0) {
    return { roleHint, queries: [], hits: [], suggested: [], fromWeb: false };
  }

  let hits: WebSearchHit[] = [];
  let fromWeb = false;

  try {
    for (const q of queries) {
      const batch = await runSearch(q, 5);
      hits.push(...batch);
      if (hits.length >= 10) break;
    }
    hits = dedupeHits(hits).slice(0, 12);
    // Keep only pages that could actually contain reported questions.
    const useful = hits.filter(isUsefulHit);
    fromWeb = useful.length > 0;
    console.log(
      `[webResearch] ${hits.length} hit(s), ${useful.length} usable for "${roleHint}"` +
        (useful.length ? ` — ${useful.map((h) => h.site).slice(0, 4).join(", ")}` : " — no usable pages")
    );
    hits = useful;
  } catch (err: any) {
    console.warn("[webResearch] Search failed:", err?.message);
  }

  // No real source material: return nothing rather than inventing "market"
  // questions. An empty result makes the generator reallocate those slots to
  // JD-grounded technical questions, which is honest and produces better
  // interviews than a hallucinated forum question.
  if (!hits.length) {
    console.warn(
      `[webResearch] no usable sources for "${roleHint}" — market questions will be replaced by technical ones`
    );
    return { roleHint, queries, hits: [], suggested: [], fromWeb: false };
  }

  const suggested = await extractQuestions({
    roleHint,
    discipline: opts.discipline,
    jdExcerpt: opts.jdText,
    hits,
    count: opts.count,
  });

  return { roleHint, queries, hits, suggested, fromWeb };
}

/** Text block injected into the question-bank generator prompt. */
export function formatWebResearchForPrompt(research: WebResearchResult): string {
  if (!research.suggested.length) return "";

  const hitLines = research.hits
    .slice(0, 8)
    .map((h) => `- [${h.site}] ${h.title}: ${h.snippet.slice(0, 200)}`)
    .join("\n");

  const qLines = research.suggested
    .map(
      (q, i) =>
        `${i + 1}. "${q.question}" (source: ${q.source}${q.sourceUrl ? ` — ${q.sourceUrl}` : ""})\n   intent: ${q.intent}`
    )
    .join("\n");

  return `
WEB-GROUNDED QUESTIONS (from LeetCode / Blind / Glassdoor research for "${research.roleHint}")
These reflect what candidates report being asked for this role on public interview forums. Include them as "market" kind questions — adapt wording to your voice but keep the substance. Do NOT read URLs aloud.

Suggested market questions (use or closely adapt):
${qLines}

Raw search snippets for context:
${hitLines}
`;
}
