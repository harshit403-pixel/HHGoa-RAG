// ─────────────────────────────────────────────
// index.ts
// ─────────────────────────────────────────────
//
// Entrypoint. Run with:
//   npx tsx index.ts
//
// Same command resumes after a crash — checkpoint.ts
// tracks progress per language and skips rows already
// durably indexed.
// ─────────────────────────────────────────────

import "dotenv/config";
import { runPipeline } from "./pipeline/pipeline.js";

const selectedLangs = process.argv.slice(2);
await runPipeline(selectedLangs);
