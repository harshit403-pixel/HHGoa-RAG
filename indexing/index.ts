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

import { runPipeline } from "./pipeline/pipeline.js";

await runPipeline();
