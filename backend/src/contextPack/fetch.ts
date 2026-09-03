import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
import {
  CONFLUENCE_SPACES,
  SLACK_CHANNELS,
  SLACK_CHANNEL_PATTERNS,
  isDenied,
  priorityScore,
} from "./sources";
import { RawDocument } from "./types";

dotenv.config();

/**
 * Stage 0: pull source documents into raw/.
 *
 * Read-only against both APIs. Everything it writes is gitignored — raw/ holds
 * unsanitized internal documentation and must never be committed.
 *
 *   npm run pack:fetch
 *
 * Credentials (all optional; whichever are present get used):
 *   CONFLUENCE_BASE_URL   https://<site>.atlassian.net
 *   CONFLUENCE_EMAIL      your Atlassian account email
 *   CONFLUENCE_API_TOKEN  id.atlassian.com/manage-profile/security/api-tokens
 *   SLACK_BOT_TOKEN       xoxb-… with channels:history + channels:read
 *
 * With no credentials this is a no-op and the build runs against whatever is
 * already in raw/, so the pipeline stays demonstrable offline.
 */

const RAW_DIR = path.join(__dirname, "raw");
const MAX_PAGES_PER_SPACE = 25;
const MAX_SLACK_MESSAGES = 200;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function writeDoc(doc: RawDocument): void {
  const file = path.join(RAW_DIR, `${slugify(doc.id || doc.title)}.md`);
  const header = [
    "---",
    `id: ${doc.id}`,
    `source: ${doc.source}`,
    `origin: ${doc.origin}`,
    `title: ${doc.title.replace(/\n/g, " ")}`,
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(file, header + doc.body);
}

// --- Confluence -----------------------------------------------------------

async function fetchConfluence(): Promise<number> {
  const baseUrl = process.env.CONFLUENCE_BASE_URL?.replace(/\/$/, "");
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;

  if (!baseUrl || !email || !token) {
    console.log("  Confluence: no credentials set, skipping");
    return 0;
  }

  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };

  const cql = `space in (${CONFLUENCE_SPACES.join(",")}) AND type = page ORDER BY lastmodified DESC`;
  const searchUrl =
    `${baseUrl}/wiki/rest/api/content/search` +
    `?cql=${encodeURIComponent(cql)}&limit=${MAX_PAGES_PER_SPACE * CONFLUENCE_SPACES.length}` +
    `&expand=body.storage,space`;

  const res = await fetch(searchUrl, { headers });
  if (!res.ok) {
    throw new Error(`Confluence search failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as any;
  const candidates = (data.results || [])
    .filter((page: any) => !isDenied(page.title || ""))
    // Engineering-reasoning docs first; the cap then keeps the best of them.
    .sort((a: any, b: any) => priorityScore(b.title) - priorityScore(a.title));

  let written = 0;
  const skipped: string[] = [];

  for (const page of candidates) {
    const html = page.body?.storage?.value || "";
    // Storage format is XHTML; strip tags rather than pulling in a parser.
    const body = html
      .replace(/<ac:structured-macro[\s\S]*?<\/ac:structured-macro>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (body.length < 400) {
      skipped.push(page.title);
      continue;
    }
    if (written >= MAX_PAGES_PER_SPACE * CONFLUENCE_SPACES.length) break;

    writeDoc({
      id: `confluence-${page.id}`,
      source: "confluence",
      origin: page.space?.key || "unknown",
      title: page.title,
      body,
      fetchedAt: new Date().toISOString(),
    });
    written++;
  }

  console.log(
    `  Confluence: ${written} page(s) from ${CONFLUENCE_SPACES.join(", ")}` +
      `  (${candidates.length - written} skipped as stubs or denylisted)`
  );
  return written;
}

// --- Slack ----------------------------------------------------------------

async function slackApi(method: string, params: Record<string, string>): Promise<any> {
  const token = process.env.SLACK_BOT_TOKEN!;
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = (await res.json()) as any;
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`);
  return data;
}

async function fetchSlack(): Promise<number> {
  if (!process.env.SLACK_BOT_TOKEN) {
    console.log("  Slack: no bot token set, skipping");
    return 0;
  }

  const list = await slackApi("conversations.list", {
    types: "public_channel",
    limit: "1000",
    exclude_archived: "true",
  });

  const wanted = (list.channels || []).filter(
    (c: any) =>
      SLACK_CHANNELS.includes(c.name) ||
      SLACK_CHANNEL_PATTERNS.some((re) => re.test(c.name))
  );

  let written = 0;
  for (const channel of wanted) {
    try {
      const history = await slackApi("conversations.history", {
        channel: channel.id,
        limit: String(MAX_SLACK_MESSAGES),
      });

      // Channel history is one document per channel: individual messages are too
      // short to yield a scenario, but a run of them shows how problems get
      // discussed and debugged.
      const body = (history.messages || [])
        .filter((m: any) => m.text && !m.subtype)
        .map((m: any) => m.text)
        .join("\n\n---\n\n");

      if (body.length < 400) continue;

      writeDoc({
        id: `slack-${channel.name}`,
        source: "slack",
        origin: `#${channel.name}`,
        title: `Engineering discussion in #${channel.name}`,
        body,
        fetchedAt: new Date().toISOString(),
      });
      written++;
    } catch (err: any) {
      console.error(`    #${channel.name}: ${err.message}`);
    }
  }

  console.log(`  Slack: ${written} channel(s) — ${wanted.map((c: any) => "#" + c.name).join(", ")}`);
  return written;
}

// --- main -----------------------------------------------------------------

async function main() {
  console.log("\n=== Context Pack Fetch ===\n");
  fs.mkdirSync(RAW_DIR, { recursive: true });

  let total = 0;
  try {
    total += await fetchConfluence();
  } catch (err: any) {
    console.error(`  Confluence failed: ${err.message}`);
  }
  try {
    total += await fetchSlack();
  } catch (err: any) {
    console.error(`  Slack failed: ${err.message}`);
  }

  const onDisk = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith(".md")).length;
  console.log(`\nFetched ${total} document(s). raw/ now holds ${onDisk}.`);
  console.log("raw/ is gitignored — it contains unsanitized internal docs.\n");

  if (total === 0 && onDisk === 0) {
    console.log("Nothing to build from. Set credentials, or drop markdown into raw/ by hand.");
    process.exitCode = 1;
  } else {
    console.log("Next: npm run pack:build");
  }
}

main().catch((err) => {
  console.error("\n[Context Pack] Fetch failed:", err?.message || err);
  process.exitCode = 1;
});
