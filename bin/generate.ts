#!/usr/bin/env -S npx tsx
/**
 * generate — walk the case studies, run every pair through the validator, and
 * emit the benchmark.
 *
 * Four artifacts, all from one pass:
 *
 *   tasks/NNNN.dfy         each admitted `.dfy.gen`, byte for byte
 *   metadata.json          one entry per task
 *   index.json             key → benchmark ID, the only stateful file
 *   reference-report.json  every pair, admitted or not, with its cause
 *
 * The admission gate and the report are the same pass, so no task can be
 * emitted that the report did not vouch for.
 *
 * Usage:
 *   generate [--no-clone] [--jobs=N] [--update] [--prune] [--dry-run]
 *
 *   --update   refresh tasks whose upstream `.dfy.gen` has changed
 *   --prune    delete task files that are no longer admitted
 *   --dry-run  report what would be written, write nothing
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boolFlag, flag } from "../src/cli.js";
import { buildReport, printSummary, walkCorpus } from "../src/corpus.js";
import { buildMetadata, emitTasks, loadIndex, reconcileIndex, writeIndex } from "../src/benchmark.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const update = boolFlag("update");
const prune = boolFlag("prune");
const dryRun = boolFlag("dry-run");

// A partial walk cannot produce a coherent benchmark: every unseen pair would
// look deleted, and metadata.json would silently lose tasks.
if (flag("only") !== undefined) {
  console.error("--only restricts the walk, so it cannot be used to generate. Use bin/reference-report.ts.");
  process.exit(1);
}

const corpus = await walkCorpus({
  repoRoot,
  clone: !boolFlag("no-clone"),
  jobs: Math.max(1, parseInt(flag("jobs", "4")!)),
  log: console.log,
});

printSummary(corpus, console.log);

const indexPath = path.join(repoRoot, "index.json");
const index = loadIndex(indexPath);
const before = index.nextId;
const today = new Date().toISOString().slice(0, 10);
const ids = reconcileIndex(index, corpus.reports, today);
const { tasks, doc } = buildMetadata(corpus, ids);

const emit = dryRun
  ? { written: 0, refreshed: 0, drifted: [], stale: [] }
  : emitTasks(path.join(repoRoot, "tasks"), tasks, corpus, { update, prune });

if (!dryRun) {
  writeIndex(indexPath, index);
  writeFileSync(path.join(repoRoot, "metadata.json"), JSON.stringify(doc, null, 2) + "\n");
  writeFileSync(path.join(repoRoot, "reference-report.json"), JSON.stringify(buildReport(corpus), null, 2) + "\n");
}

const tombstoned = index.entries.filter(e => e.tombstoned).length;
console.log(`\n${"=".repeat(70)}`);
console.log(`tasks        ${tasks.length}`);
console.log(`ids issued   ${index.nextId - before} new, ${index.nextId - 1} total, ${tombstoned} tombstoned`);
if (!dryRun) console.log(`tasks/       ${emit.written} written, ${emit.refreshed} refreshed`);

if (emit.drifted.length) {
  console.log(`\n${emit.drifted.length} task(s) drifted from upstream — pass --update to refresh:`);
  for (const d of emit.drifted) console.log(`  ${d.file}  ${d.key}`);
}
if (emit.stale.length) {
  const what = prune ? "removed" : "no longer admitted — pass --prune to remove";
  console.log(`\n${emit.stale.length} task file(s) ${what}:`);
  for (const s of emit.stale) console.log(`  ${s}`);
}
console.log(dryRun ? "\ndry run — nothing written" : `\nwrote tasks/, metadata.json, index.json, reference-report.json`);
