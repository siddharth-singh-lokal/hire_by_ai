import * as path from "path";
import dotenv from "dotenv";

/**
 * Loads backend/.env before anything else reads process.env.
 *
 * Import this FIRST in every entry point. Module bodies run at import time, so
 * a `dotenv.config()` call sitting below the import list executes too late: any
 * module-level `process.env.X` in an imported file has already been evaluated.
 * That silently disabled the OpenRouter fallback — the key was in .env, but
 * llm.ts had already read an empty value by the time dotenv ran.
 *
 * The path is resolved from this file rather than process.cwd(), so it works
 * whether the server is started from backend/ or from the repo root.
 */
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
