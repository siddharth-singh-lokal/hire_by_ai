import fs from "fs";
import path from "path";

/**
 * Workshop / sandbox credentials expire. They live in backend/.env as a
 * key+secret+session-token triple. Previously the server read them once at boot
 * and cached Bedrock clients forever — updating .env mid-demo did nothing until
 * a full restart, and a mid-call expiry killed the voice stream with no recovery.
 */

const ENV_PATH = path.resolve(__dirname, "..", ".env");

const AWS_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
] as const;

let lastEnvMtimeMs = 0;
let lastCredentialFingerprint = "";

export function isCredentialError(err: unknown): boolean {
  const name = String((err as any)?.name || "");
  const message = String((err as any)?.message || err || "");
  const blob = `${name} ${message}`;
  return /UnrecognizedClient|InvalidClientToken|ExpiredToken|security token|credentials have expired|SignatureDoesNotMatch|AuthFailure|InvalidAccessKeyId/i.test(
    blob
  );
}

/** Parse backend/.env without executing shell or requiring a restart. */
function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function credentialFingerprint(vars: Record<string, string>): string {
  return [
    vars.AWS_ACCESS_KEY_ID || "",
    vars.AWS_SECRET_ACCESS_KEY || "",
    vars.AWS_SESSION_TOKEN || "",
    vars.AWS_PROFILE || "",
  ].join("|");
}

/** Apply AWS_* keys from a parsed .env into process.env. */
function applyAwsEnv(vars: Record<string, string>): void {
  for (const key of AWS_ENV_KEYS) {
    if (!(key in vars)) continue;
    const val = vars[key];
    if (!val) delete process.env[key];
    else process.env[key] = val;
  }

  // Workshop hands an explicit triple — profile names conflict with stale keys.
  if (vars.AWS_ACCESS_KEY_ID && vars.AWS_SECRET_ACCESS_KEY) {
    delete process.env.AWS_PROFILE;
  }
}

/**
 * Re-read backend/.env when the file changed (or when forced).
 * Returns true when credential-relevant values changed.
 */
export function reloadCredentialsFromEnv(force = false): boolean {
  try {
    if (!fs.existsSync(ENV_PATH)) return false;
    const mtimeMs = fs.statSync(ENV_PATH).mtimeMs;
    if (!force && mtimeMs <= lastEnvMtimeMs) return false;

    const vars = parseEnvFile(ENV_PATH);
    const fingerprint = credentialFingerprint(vars);
    if (!force && fingerprint === lastCredentialFingerprint) {
      lastEnvMtimeMs = mtimeMs;
      return false;
    }

    applyAwsEnv(vars);
    lastEnvMtimeMs = mtimeMs;
    lastCredentialFingerprint = fingerprint;
    console.log("[AWS] Reloaded credentials from backend/.env");
    return true;
  } catch (err: any) {
    console.warn("[AWS] Failed to reload backend/.env:", err?.message);
    return false;
  }
}

/** Called on each interview WebSocket connect — picks up a freshly pasted triple. */
export function maybeReloadCredentials(): boolean {
  return reloadCredentialsFromEnv(false);
}

export function getExplicitCredentials():
  | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | undefined {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim();
  if (!accessKeyId || !secretAccessKey) return undefined;
  return sessionToken
    ? { accessKeyId, secretAccessKey, sessionToken }
    : { accessKeyId, secretAccessKey };
}

export function awsCredentialStatus(): {
  configured: boolean;
  source: "env" | "profile" | "none";
  envFile: string;
  envFileExists: boolean;
  hint?: string;
} {
  reloadCredentialsFromEnv(true);
  const explicit = getExplicitCredentials();
  if (explicit) {
    return {
      configured: true,
      source: "env",
      envFile: ENV_PATH,
      envFileExists: fs.existsSync(ENV_PATH),
    };
  }
  if (process.env.AWS_PROFILE) {
    return {
      configured: true,
      source: "profile",
      envFile: ENV_PATH,
      envFileExists: fs.existsSync(ENV_PATH),
      hint: `Using AWS_PROFILE=${process.env.AWS_PROFILE}`,
    };
  }
  return {
    configured: false,
    source: "none",
    envFile: ENV_PATH,
    envFileExists: fs.existsSync(ENV_PATH),
    hint:
      "Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN in backend/.env",
  };
}
