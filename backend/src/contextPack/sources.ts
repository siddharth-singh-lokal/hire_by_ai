/**
 * Which internal sources the Context Pack is allowed to read.
 *
 * Deliberately a hardcoded allowlist rather than a search across everything.
 * Two reasons:
 *
 *  1. Blast radius. A wildcard over all of Confluence would eventually pull an
 *     HR space, a finance page, or someone's personal notes. An allowlist can
 *     only ever read what is on it.
 *  2. Signal. Engineering spaces carry design docs and incident writeups;
 *     product and growth spaces carry business logic, which is both confidential
 *     and useless as interview material.
 *
 * Adding a source is a deliberate, reviewable edit to this file.
 */

/** Confluence space keys. Engineering only. */
export const CONFLUENCE_SPACES = [
  "TECH", // design docs, HLD/LLD, RCAs — richest source
  "BD", // backend documentation
  "PKT", // process and knowledge transfer
  "RM", // release management
];

/**
 * Page titles matching these are skipped before fetch. Business-logic documents
 * are rejected later by the sanitizer too, but not spending a model call on them
 * is cheaper and keeps the raw/ directory clean of things we never wanted.
 */
export const TITLE_DENYLIST = [
  /pricing/i,
  /payout/i,
  /\bTDS\b/i,
  /tax/i,
  /billing/i,
  /subscription/i,
  /coin|wallet|recharge/i,
  /revenue|monetis|monetiz/i,
  /experiment|A\/B/i,
  /playbook/i,
  /KYC|PAN|UPI/i,
  /^untitled/i,
];

/** Prefer documents that actually contain engineering reasoning. */
export const TITLE_PRIORITY = [
  /\bRCA\b|post.?mortem|incident/i,
  /\bHLD\b|\bLLD\b|design/i,
  /deep dive/i,
  /pooling|caching|scaling|performance|latency/i,
  /logging|exception|observability/i,
];

/** Slack channels. Hardcoded per team decision — no unofficial channels. */
export const SLACK_CHANNELS = ["backend", "astro-agri-backend"];

/** Error channels follow this shape; matched dynamically against the channel list. */
export const SLACK_CHANNEL_PATTERNS = [/^errors-.+-prod$/];

export function isDenied(title: string): boolean {
  return TITLE_DENYLIST.some((re) => re.test(title));
}

export function priorityScore(title: string): number {
  return TITLE_PRIORITY.reduce((score, re) => (re.test(title) ? score + 1 : score), 0);
}
