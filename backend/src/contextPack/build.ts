import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
import { sanitizeDocuments } from "./sanitize";
import { validatePack } from "./validate";
import { ContextPack, RawDocument } from "./types";

dotenv.config();

/**
 * Context Pack builder.
 *
 *   raw/*.json  ->  redact  ->  abstract  ->  validate  ->  context-pack.json
 *
 * Raw documents are fetched separately (Confluence/Slack MCP) and dropped into
 * raw/, which is gitignored and must never be committed. This script owns
 * everything after that point.
 *
 *   npm run pack:build            build and validate
 *   npm run pack:build -- --approve   also mark approved for use in interviews
 *
 * A pack that fails validation is still written to disk, with approved=false, so
 * you can inspect exactly what tripped the gate. Nothing downstream will load an
 * unapproved pack.
 */

const RAW_DIR = path.join(__dirname, "raw");
const PROFILE_PATH = path.join(__dirname, "company-profile.md");
const OUTPUT = path.join(__dirname, "context-pack.json");

/**
 * Parses a markdown source doc with a small YAML-ish header:
 *
 *   ---
 *   source: confluence
 *   origin: TECH
 *   title: RCA for afternoon 5xx errors
 *   ---
 *   <body>
 *
 * Markdown is supported alongside JSON because dropping a doc into raw/ by hand
 * is the common case, and hand-escaping a page of prose into JSON is miserable.
 */
function parseMarkdownDoc(file: string, content: string): RawDocument {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return {
      id: file,
      source: "confluence",
      origin: "unknown",
      title: file.replace(/\.md$/, ""),
      body: content,
      fetchedAt: new Date().toISOString(),
    };
  }

  const [, header, body] = match;
  const meta: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  return {
    id: meta.id || file,
    source: (meta.source as RawDocument["source"]) || "confluence",
    origin: meta.origin || "unknown",
    title: meta.title || file.replace(/\.md$/, ""),
    body,
    fetchedAt: new Date().toISOString(),
  };
}

function loadRawDocuments(): RawDocument[] {
  if (!fs.existsSync(RAW_DIR)) {
    throw new Error(
      `No raw/ directory at ${RAW_DIR}. Fetch source documents into it before building.`
    );
  }

  const files = fs
    .readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".json") || f.endsWith(".md"));
  if (!files.length) {
    throw new Error("raw/ is empty. Nothing to build a Context Pack from.");
  }

  const docs: RawDocument[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(RAW_DIR, file), "utf8");
    if (file.endsWith(".md")) {
      docs.push(parseMarkdownDoc(file, content));
    } else {
      const parsed = JSON.parse(content);
      docs.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
  }
  return docs;
}

async function main() {
  const approveRequested = process.argv.includes("--approve");

  console.log("\n=== Context Pack Build ===\n");

  const docs = loadRawDocuments();
  console.log(`Loaded ${docs.length} raw document(s) from raw/`);

  console.log("Redacting and abstracting…");
  const { scenarios, stackProfile, redactionFindings } = await sanitizeDocuments(docs);

  // Aggregate the audit log so it reads as a summary rather than a wall.
  const byRule = redactionFindings.reduce<Record<string, number>>((acc, f) => {
    acc[f.rule] = (acc[f.rule] || 0) + f.count;
    return acc;
  }, {});

  console.log("\nRedaction summary (removed before the model saw anything):");
  const ruleEntries = Object.entries(byRule).sort((a, b) => b[1] - a[1]);
  if (!ruleEntries.length) {
    console.log("  (nothing matched — verify the source documents are real)");
  }
  for (const [rule, count] of ruleEntries) {
    console.log(`  ${rule.padEnd(24)} ${count}`);
  }

  console.log(`\nExtracted ${scenarios.length} scenario(s)`);
  for (const s of scenarios) {
    console.log(`  [d${s.difficulty}] ${s.id} — ${s.title}`);
  }

  const sourceSummary = Object.entries(
    docs.reduce<Record<string, number>>((acc, d) => {
      acc[d.source] = (acc[d.source] || 0) + 1;
      return acc;
    }, {})
  ).map(([source, documentCount]) => ({ source, documentCount }));

  // Hand-maintained and public-safe, so it bypasses sanitization by design.
  const companyProfile = fs.existsSync(PROFILE_PATH)
    ? fs.readFileSync(PROFILE_PATH, "utf8")
    : "";
  if (!companyProfile) {
    console.log("\nNote: no company-profile.md — interviews will have no culture context.");
  }

  const pack: ContextPack = {
    version: "1",
    generatedAt: new Date().toISOString(),
    companyProfile,
    stackProfile,
    scenarios,
    sourceSummary,
    approved: false,
  };

  console.log("\nValidating (regex gate + adversarial review)…");
  const validation = await validatePack(pack);

  if (validation.passed) {
    console.log("  PASS — no leaks detected");
    if (validation.llmVerdict) console.log(`  Reviewer: ${validation.llmVerdict}`);
    pack.approved = approveRequested;
  } else {
    console.log("  FAIL — pack will NOT be approved:");
    for (const f of validation.findings) {
      console.log(`    [${f.rule}] x${f.count}  ${f.sample}`);
    }
    if (validation.llmVerdict) console.log(`  Reviewer: ${validation.llmVerdict}`);
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(pack, null, 2));
  console.log(`\nWritten to ${OUTPUT}`);
  console.log(`Approved: ${pack.approved}`);

  if (validation.passed && !approveRequested) {
    console.log("\nValidation passed. Review the pack, then re-run with --approve to enable it.");
  }

  // Non-zero exit on failure so this can gate a build step later.
  if (!validation.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n[Context Pack] Build failed:", err?.message || err);
  process.exitCode = 1;
});
