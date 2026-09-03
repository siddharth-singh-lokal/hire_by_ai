import { Finding } from "./types";

/**
 * Deterministic redaction.
 *
 * Runs BEFORE the LLM abstraction pass, and again as a validation gate after.
 * Order matters twice over:
 *
 *  1. A model asked to "remove sensitive details" will sometimes decide a private
 *     IP is harmless context and keep it. Regex does not negotiate.
 *  2. The rules must run in the right sequence. Redacting the company domain
 *     before emails turns `alice@company.com` into `alice@<domain>` — the domain
 *     is gone and the person's name is still there. Credentials and personal data
 *     therefore run first, structural identifiers last.
 *
 * Every rule was written against something actually present in the source
 * Confluence: private IPs, k8s secret names, commit SHAs, GCP project IDs, Jira
 * keys, EC2 hostnames, Bitbucket URLs.
 */

interface Rule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/** Ordered. Do not sort alphabetically — see the header note. */
const RULES: Rule[] = [
  // === 1. credentials — most dangerous, most specific, must run first ===
  {
    name: "credential",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    replacement: "<credential>",
  },
  {
    // Catches `AWS_SECRET_ACCESS_KEY=...`. The leading/trailing \w* is what makes
    // this work — the keyword is rarely adjacent to the separator.
    name: "assignment-secret",
    pattern:
      /\b\w*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|credential)\w*\s*[:=]\s*["']?[^\s"'\n]{6,}/gi,
    replacement: "<credential-assignment>",
  },
  {
    // Bare 40-char base64 — the AWS secret access key shape. Over-redacting a
    // stray hash is a cheaper mistake than shipping a key.
    name: "high-entropy-blob",
    pattern: /\b(?=[A-Za-z0-9/+=]{40}\b)(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z0-9/+=]{40}\b/g,
    replacement: "<credential>",
  },

  // === 2. personal data — before anything that would eat its surroundings ===
  { name: "email", pattern: /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g, replacement: "<email>" },
  {
    name: "phone",
    pattern: /\b(?:\+?91[-\s]?)?[6-9]\d{9}\b/g,
    replacement: "<phone>",
  },

  // === 3. network identifiers ===
  {
    name: "private-ipv4",
    pattern:
      /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
    replacement: "<internal-host>",
  },
  {
    name: "cloud-hostname",
    pattern:
      /\b[\w.-]*\.(?:compute\.amazonaws\.com|amazonaws\.com|rds\.amazonaws\.com|cloudfront\.net)\b/gi,
    replacement: "<cloud-host>",
  },
  { name: "public-ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: "<ip>" },

  // === 4. org identifiers ===
  {
    name: "internal-url",
    pattern: /\bhttps?:\/\/(?:[\w.-]*\.)?(?:internal|atlassian\.net|bitbucket\.org)[^\s)>\]]*/gi,
    replacement: "<internal-link>",
  },
  {
    name: "company-domain",
    pattern: /\b[\w.-]*getlokalapp\.com\b|\b[\w.-]*astrolokal\.com\b|\b[\w.-]*agrilokal\.com\b/gi,
    replacement: "<internal-domain>",
  },

  // === 5. incident fingerprints ===
  // Individually harmless, collectively identifying. An exact wall-clock time
  // plus a date plus a cache-key version number lets anyone who was there
  // recognise the incident — which is a leak even with every hostname gone.
  {
    name: "clock-time",
    pattern: /\b\d{1,2}:\d{2}\s*(?:[AaPp]\.?[Mm]\.?)?\b/g,
    replacement: "<time>",
  },
  {
    name: "calendar-date",
    pattern:
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:\s*[–—-]\s*\d{1,2})?(?:,?\s*\d{4})?\b|\b\d{4}-\d{2}-\d{2}\b/g,
    replacement: "<date>",
  },
  {
    name: "versioned-key",
    pattern: /\b\w+_v\d+\b/g,
    replacement: "<versioned-key>",
  },
  {
    name: "pull-request",
    pattern: /\bPR\s*#?\d+\b|\B#\d{3,6}\b/g,
    replacement: "<pull-request>",
  },
  {
    name: "repo-url",
    pattern: /\bhttps?:\/\/(?:www\.)?github\.com\/[^\s)>\]]*/gi,
    replacement: "<repo-link>",
  },
  {
    // The vCPU count survives elsewhere and is what actually matters; the SKU
    // name is a fingerprint that adds nothing to the engineering problem.
    name: "instance-class",
    pattern: /\b(?:db\.)?[tmcrxig]\d[a-z]*\.(?:nano|micro|small|medium|large|\d*xlarge)\b/gi,
    replacement: "<instance-class>",
  },

  // === 6. code and infra references ===
  {
    // At least one hex letter required, so a 10-digit phone or an ID number is
    // never mistaken for a commit.
    name: "git-sha",
    pattern: /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
    replacement: "<commit>",
  },
  { name: "jira-ticket", pattern: /\b[A-Z]{2,10}-\d{1,6}\b/g, replacement: "<ticket>" },
  {
    name: "k8s-secret",
    pattern: /\b[\w-]*-secret\b|\bsecretKeyRef\b|\bnamespace\s+`?\w+`?/gi,
    replacement: "<k8s-ref>",
  },
  {
    name: "gcp-project",
    pattern: /\b[a-z][a-z0-9-]{4,28}-\d{4,6}\b/g,
    replacement: "<gcp-project>",
  },
  {
    name: "file-path",
    pattern: /(?:\/(?:home|Users|var\/www|opt)\/[\w./-]+)|(?:[A-Z]:\\\\[\w\\.-]+)/g,
    replacement: "<path>",
  },
];

/** Product and service names, generalised so scenarios aren't traceable. */
const PRODUCT_NAMES =
  /\b(agri ?lokal|astro ?lokal|gyan ?tv|dostt|eaze|lokal|kachra-?seth|redash)\b/gi;

export function redact(text: string): { clean: string; findings: Finding[] } {
  const findings: Finding[] = [];
  let clean = text;

  for (const rule of RULES) {
    const matches = clean.match(rule.pattern);
    if (matches?.length) {
      findings.push({
        rule: rule.name,
        // Truncated so the audit log never becomes a second copy of the secret.
        sample: matches[0].slice(0, 12) + (matches[0].length > 12 ? "…" : ""),
        count: matches.length,
      });
      clean = clean.replace(rule.pattern, rule.replacement);
    }
  }

  const productMatches = clean.match(PRODUCT_NAMES);
  if (productMatches?.length) {
    findings.push({
      rule: "product-name",
      sample: productMatches[0],
      count: productMatches.length,
    });
    clean = clean.replace(PRODUCT_NAMES, "the service");
  }

  return { clean, findings };
}

/**
 * Validation gate, run against already-sanitized output. Any hit means the
 * pipeline leaked and the pack must not ship.
 *
 * Excludes the deliberately noisy scrubbing heuristics (bare IPv4, file paths,
 * the broad k8s pattern, gcp-project) which are useful when cleaning but throw
 * false positives on ordinary prose — a version number would fail every pack.
 * Everything genuinely dangerous stays in.
 */
const GATE_RULES = new Set([
  "credential",
  "assignment-secret",
  "high-entropy-blob",
  "email",
  "phone",
  "private-ipv4",
  "cloud-hostname",
  "internal-url",
  "company-domain",
  "jira-ticket",
  "product-name",
]);

export function scanForLeaks(text: string): Finding[] {
  const findings: Finding[] = [];

  for (const rule of RULES) {
    if (!GATE_RULES.has(rule.name)) continue;
    const matches = text.match(rule.pattern);
    if (matches?.length) {
      findings.push({
        rule: rule.name,
        sample: matches[0].slice(0, 12) + (matches[0].length > 12 ? "…" : ""),
        count: matches.length,
      });
    }
  }

  const productMatches = text.match(PRODUCT_NAMES);
  if (productMatches?.length) {
    findings.push({
      rule: "product-name",
      sample: productMatches[0],
      count: productMatches.length,
    });
  }

  return findings;
}
