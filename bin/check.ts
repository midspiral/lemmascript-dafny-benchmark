#!/usr/bin/env -S npx tsx
/**
 * check — validate a candidate solution against a benchmark task.
 *
 * This is the contract a runner codes against:
 *
 *   (task_id, candidate_path) → passed | failed | not-run per constraint
 *
 * The task's verify options come from `metadata.json`, so a candidate is held
 * to exactly the budget its reference solution was. Nothing else is stored per
 * task: the candidate is checked against `tasks/NNNN.dfy` and against Dafny.
 *
 * Usage:
 *   check <task-id> <candidate.dfy> [--json] [--diff]
 *
 * Exit status is 0 when both constraints passed, 1 otherwise — including when
 * a constraint could not be run, since "we don't know" is not a pass.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boolFlag } from "../src/cli.js";
import { validate } from "../src/validator.js";
import type { TaskMetadata } from "../src/benchmark.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const positional = process.argv.slice(2).filter(a => !a.startsWith("--"));
const [taskArg, candidateArg] = positional;

if (!taskArg || !candidateArg) {
  console.error("Usage: check <task-id> <candidate.dfy> [--json] [--diff]");
  process.exit(2);
}

const metadataPath = path.join(repoRoot, "metadata.json");
if (!existsSync(metadataPath)) {
  console.error("No metadata.json — run `npm run generate` first.");
  process.exit(2);
}
const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as { tasks: TaskMetadata[] };

// Accept 7, 0007, or tasks/0007.dfy — a runner shouldn't have to care.
const wanted = parseInt(path.basename(taskArg).replace(/\.dfy$/, ""), 10);
const task = metadata.tasks.find(t => t.id === wanted);
if (!task) {
  console.error(`No task ${taskArg}. metadata.json has ${metadata.tasks.length} tasks.`);
  process.exit(2);
}

const genPath = path.join(repoRoot, task.file);
const candidatePath = path.resolve(candidateArg);
if (!existsSync(candidatePath)) {
  console.error(`Candidate not found: ${candidatePath}`);
  process.exit(2);
}

const result = await validate(genPath, candidatePath, {
  timeLimit: task.verify.timeLimit,
  extraFlags: task.verify.flags,
});

if (boolFlag("json")) {
  console.log(JSON.stringify({ task: task.id, key: task.key, ...result, diff: undefined }, null, 2));
} else {
  const a = result.additions;
  const v = result.verify;
  console.log(`task ${task.id}  ${task.key}`);
  console.log(`  additions-only  ${a.status}`);
  if (a.deletedLines) console.log(`    ${a.deletedLines} deleted line(s): ${a.deletedSamples[0]?.trim()}`);
  for (const m of a.bannedMatches) console.log(`    banned ${m.pattern}: ${m.text.trim()}`);
  for (const w of a.weakenedContracts) console.log(`    ${w.clause} added to a generated declaration: ${w.text.trim()}`);
  for (const v of a.signatureViolations) {
    console.log(`    in the signature of \`${v.declaration}\` (line ${v.declarationLine}): ${v.why}`);
    console.log(`      ${v.text.trim()}`);
  }
  if (a.status === "not-run") console.log(`    ${a.notRunReason}`);
  if (a.status === "passed") console.log(`    +${a.addedLines} lines (${a.addedCodeLines} code)`);

  console.log(`  verifies        ${v.status}  (${v.seconds}s)`);
  if (v.timedOut) console.log(`    killed at the wall clock`);
  if (v.timeouts) console.log(`    ${v.timeouts} procedure(s) hit the ${task.verify.timeLimit ?? 30}s limit`);
  for (const e of v.errorSamples) console.log(`    error at line ${e}`);
  for (const w of v.disqualifyingWarnings) console.log(`    ${w.category} at line ${w.line}`);
  if (v.status === "not-run") console.log(`    ${v.notRunReason}`);

  console.log(result.passed ? "\nPASS" : "\nFAIL");
}

if (boolFlag("diff")) console.log(`\n${result.diff}`);

process.exit(result.passed ? 0 : 1);
