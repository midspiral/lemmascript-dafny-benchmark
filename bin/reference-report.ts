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
 * Usage:
 *   reference-report [--no-clone] [--jobs=N] [--only=<substring>] [--out=<path>]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate, type ValidationResult } from "../src/validator.js";
import {
  dedupeRepos,
  fileFacts,
  loadConfig,
  pairsFor,
  readFileList,
  resolveCheckout,
  type Checkout,
  type Pair,
} from "../src/pairs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(name: string, fallback?: string): string | undefined {
  const hit = process.argv.slice(2).find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return fallback;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

const clone = flag("no-clone") === undefined;
const jobs = Math.max(1, parseInt(flag("jobs", "4")!));
const only = flag("only");
const outPath = path.resolve(repoRoot, flag("out", "reference-report.json")!);

interface PairReport {
  key: string;
  repo: string;
  branch: string;
  relpath: string;
  admitted: boolean;
  causes: string[];
  verifyOptions: { timeLimit?: number; flags: string[] };
  gen?: { bytes: number; lines: number; sha256: string };
  solution?: { bytes: number; lines: number; sha256: string };
  additions?: ValidationResult["additions"];
  verify?: ValidationResult["verify"];
}

const config = loadConfig(path.join(repoRoot, "config", "repos.json"));
const { kept, dropped } = dedupeRepos(config.repos);
const parentDir = path.resolve(repoRoot, config.parentDir);

console.log(`reference-report — ${kept.length} repos (${dropped.length} extra branches deferred), parent ${parentDir}`);

// --- checkouts -------------------------------------------------------------

const checkouts: Checkout[] = [];
for (const entry of kept) {
  const c = resolveCheckout(entry, parentDir, { clone });
  checkouts.push(c);
  if (!c.present) console.log(`  ! ${entry.repo}: ${c.error}`);
}

// --- pairs -----------------------------------------------------------------

const work: { pair: Pair; report: PairReport }[] = [];
const reports: PairReport[] = [];

function blank(pair: Pair): PairReport {
  return {
    key: pair.key,
    repo: pair.repo,
    branch: pair.branch,
    relpath: pair.relpath,
    admitted: false,
    causes: [],
    verifyOptions: { timeLimit: pair.timeout, flags: pair.flags },
  };
}

for (const c of checkouts) {
  if (!c.present) {
    reports.push({
      key: `${c.entry.repo}:-`,
      repo: c.entry.repo,
      branch: c.entry.branch,
      relpath: "-",
      admitted: false,
      causes: ["missing-repo"],
      verifyOptions: { flags: [] },
    });
    continue;
  }
  const entries = readFileList(c.dir);
  if (!entries) {
    reports.push({
      key: `${c.entry.repo}:-`,
      repo: c.entry.repo,
      branch: c.entry.branch,
      relpath: "-",
      admitted: false,
      causes: ["missing-file-list"],
      verifyOptions: { flags: [] },
    });
    continue;
  }
  for (const pair of pairsFor(c, entries)) {
    if (only && !pair.key.includes(only)) continue;
    const report = blank(pair);
    if (pair.missing) {
      report.causes.push(`missing-${pair.missing}`);
      reports.push(report);
      continue;
    }
    report.gen = fileFacts(pair.genPath);
    report.solution = fileFacts(pair.solutionPath);
    // Layout enforcement: the flat tasks/ folder assumes self-contained files,
    // so an `include` anywhere in the .gen makes the task unsolvable as emitted.
    if (/^\s*include\b/m.test(readFileSync(pair.genPath, "utf-8"))) {
      report.causes.push("gen-has-include");
      reports.push(report);
      continue;
    }
    work.push({ pair, report });
    reports.push(report);
  }
}

console.log(`  ${work.length} pairs to validate, ${jobs} at a time\n`);

// --- validate --------------------------------------------------------------

let done = 0;
async function runOne(item: { pair: Pair; report: PairReport }) {
  const { pair, report } = item;
  const result = await validate(pair.genPath, pair.solutionPath, {
    timeLimit: pair.timeout,
    extraFlags: pair.flags,
  });
  report.additions = result.additions;
  report.verify = result.verify;

  const a = result.additions;
  if (a.status === "not-run") report.causes.push("additions-not-run");
  if (a.deletedLines > 0) report.causes.push("deleted-lines");
  for (const m of new Set(a.bannedMatches.map(m => m.pattern))) report.causes.push(`banned:${m}`);
  for (const c of new Set(a.weakenedContracts.map(w => w.clause))) report.causes.push(`weakened:${c}`);
  // Not a failure — the solution is byte-identical to the .gen, so there is no
  // proof to complete and the empty submission would pass. Reported, not shipped.
  if (a.status === "passed" && a.addedLines === 0) report.causes.push("no-additions");

  const v = result.verify;
  if (v.status === "not-run") report.causes.push("verify-not-run");
  if (v.timedOut) report.causes.push("verify-killed");
  // A per-procedure timeout is wall-clock, so it is a property of the machine
  // as much as of the proof; kept apart from a proof that genuinely failed.
  if (v.timeouts > 0) report.causes.push("verification-timeout");
  if (v.errors - v.timeouts > 0) report.causes.push("verification-errors");
  for (const c of new Set(v.disqualifyingWarnings.map(w => w.category))) report.causes.push(`warning:${c}`);

  report.admitted = report.causes.length === 0;

  done++;
  const mark = report.admitted ? "ok  " : "EXCL";
  const detail = report.admitted ? `${a.addedLines} added` : report.causes.join(",");
  console.log(`  [${String(done).padStart(3)}/${work.length}] ${mark} ${pair.key} (${v.seconds}s) ${detail}`);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const started = Date.now();
await pool(work, jobs, runOne);

// --- report ----------------------------------------------------------------

const byCause = new Map<string, number>();
for (const r of reports) for (const c of r.causes) byCause.set(c, (byCause.get(c) ?? 0) + 1);

const admitted = reports.filter(r => r.admitted);
const report = {
  dafnyVersion: config.dafnyVersion,
  configSource: config.source,
  configSeededAt: config.seededAt,
  aggregate: {
    reposConfigured: config.repos.length,
    reposUsed: kept.length,
    branchesDeferred: dropped,
    pairsSeen: reports.length,
    admitted: admitted.length,
    excluded: reports.length - admitted.length,
    // A pair can trip more than one cause, so these sum to at least the
    // excluded count, not exactly to it.
    excludedByCause: Object.fromEntries([...byCause.entries()].sort((a, b) => b[1] - a[1])),
  },
  repos: checkouts.map(c => ({
    repo: c.entry.repo,
    branch: c.entry.branch,
    present: c.present,
    head: c.head,
    currentBranch: c.currentBranch,
    dirty: c.dirty,
    error: c.error,
  })),
  pairs: reports.sort((a, b) => a.key.localeCompare(b.key)),
};

writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

console.log(`\n${"=".repeat(70)}`);
console.log(`pairs seen  ${reports.length}`);
console.log(`admitted    ${admitted.length}`);
console.log(`excluded    ${reports.length - admitted.length}`);
console.log(`\nby cause (a pair can trip more than one):`);
for (const [cause, n] of [...byCause.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${cause}`);
}
const slow = admitted
  .filter(r => (r.verify?.seconds ?? 0) >= 30)
  .sort((a, b) => (b.verify?.seconds ?? 0) - (a.verify?.seconds ?? 0));
if (slow.length) {
  console.log(`\nslowest admitted:`);
  for (const r of slow.slice(0, 8)) console.log(`  ${String(r.verify!.seconds).padStart(4)}s  ${r.key}`);
}
console.log(`\nwrote ${path.relative(process.cwd(), outPath)} in ${Math.round((Date.now() - started) / 1000)}s`);
