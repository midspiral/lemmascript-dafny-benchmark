#!/usr/bin/env -S npx tsx
/**
 * reference-report — run every (`.dfy.gen`, solution) pair in the case studies
 * through the validator and report what the corpus actually looks like.
 *
 * This is the admission gate's output, and a deliverable in its own right:
 * every ban and every disqualifying warning category is a guess that the
 * reference solutions clear it, and this is what falsifies the guess. Excluded
 * pairs stay listed with their cause, so the report doubles as an upstream
 * to-do list for the case studies.
 *
 * `bin/generate.ts` runs the same pass and additionally emits the benchmark.
 *
 * Usage:
 *   reference-report [--no-clone] [--jobs=N] [--only=<substring>] [--out=<path>]
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boolFlag, flag } from "../src/cli.js";
import { buildReport, printSummary, walkCorpus } from "../src/corpus.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.resolve(repoRoot, flag("out", "reference-report.json")!);

const corpus = await walkCorpus({
  repoRoot,
  clone: !boolFlag("no-clone"),
  jobs: Math.max(1, parseInt(flag("jobs", "4")!)),
  only: flag("only"),
  log: console.log,
});

writeFileSync(outPath, JSON.stringify(buildReport(corpus), null, 2) + "\n");
printSummary(corpus, console.log);
console.log(`\nwrote ${path.relative(process.cwd(), outPath)} in ${corpus.elapsedSeconds}s`);
