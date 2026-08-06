/**
 * Walking the case studies and running every pair through the validator.
 *
 * Shared by `bin/reference-report.ts` and `bin/generate.ts`, which is the point:
 * the admission gate and the report are the same pass, so a task cannot be
 * emitted that the report did not vouch for.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { validate, type ValidationResult } from "./validator.js";
import {
  dedupeRepos,
  fileFacts,
  loadConfig,
  pairsFor,
  readFileList,
  repoName,
  resolveCheckout,
  type Checkout,
  type Config,
  type Pair,
  type RepoEntry,
} from "./pairs.js";

export interface FileFacts {
  bytes: number;
  lines: number;
  sha256: string;
}

export interface PairReport {
  /** `repo:relpath` — the stable key `index.json` numbers. */
  key: string;
  repo: string;
  branch: string;
  relpath: string;
  admitted: boolean;
  causes: string[];
  verifyOptions: { timeLimit?: number; flags: string[] };
  gen?: FileFacts;
  solution?: FileFacts;
  additions?: ValidationResult["additions"];
  verify?: ValidationResult["verify"];
}

export interface CorpusOptions {
  repoRoot: string;
  /** Clone a case study that isn't checked out. */
  clone: boolean;
  /** Concurrent `dafny verify` runs. Keep low: the per-task time limits are
   *  wall-clock, so a loaded machine turns passing proofs into timeouts. */
  jobs: number;
  /** Restrict to pairs whose key contains this substring. */
  only?: string;
  log?: (line: string) => void;
}

export interface Corpus {
  config: Config;
  reposUsed: RepoEntry[];
  branchesDeferred: RepoEntry[];
  checkouts: Checkout[];
  /** Every pair seen, sorted by key. */
  reports: PairReport[];
  /** Pairs keyed for lookup, including the resolved paths. */
  pairs: Map<string, Pair>;
  elapsedSeconds: number;
}

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

function repoLevelFailure(entry: RepoEntry, cause: string): PairReport {
  return {
    key: `${entry.repo}:-`,
    repo: entry.repo,
    branch: entry.branch,
    admitted: false,
    relpath: "-",
    causes: [cause],
    verifyOptions: { flags: [] },
  };
}

/** Every cause a pair can be excluded for. Assigned in `classify`. */
function classify(report: PairReport, result: ValidationResult) {
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
  // A per-procedure timeout is wall-clock, so it is a property of the machine as
  // much as of the proof; kept apart from a proof that genuinely failed.
  if (v.timeouts > 0) report.causes.push("verification-timeout");
  if (v.errors - v.timeouts > 0) report.causes.push("verification-errors");
  for (const c of new Set(v.disqualifyingWarnings.map(w => w.category))) report.causes.push(`warning:${c}`);

  report.admitted = report.causes.length === 0;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export async function walkCorpus(opts: CorpusOptions): Promise<Corpus> {
  const log = opts.log ?? (() => {});
  const config = loadConfig(path.join(opts.repoRoot, "config", "repos.json"));
  const { kept, dropped } = dedupeRepos(config.repos);
  const parentDir = path.resolve(opts.repoRoot, config.parentDir);

  log(`${kept.length} repos (${dropped.length} extra branches deferred), parent ${parentDir}`);

  const checkouts: Checkout[] = [];
  for (const entry of kept) {
    const c = resolveCheckout(entry, parentDir, { clone: opts.clone });
    checkouts.push(c);
    if (!c.present) log(`  ! ${entry.repo}: ${c.error}`);
  }

  const reports: PairReport[] = [];
  const pairs = new Map<string, Pair>();
  const work: { pair: Pair; report: PairReport }[] = [];

  for (const c of checkouts) {
    if (!c.present) {
      reports.push(repoLevelFailure(c.entry, "missing-repo"));
      continue;
    }
    const entries = readFileList(c.dir);
    if (!entries) {
      reports.push(repoLevelFailure(c.entry, "missing-file-list"));
      continue;
    }
    for (const pair of pairsFor(c, entries)) {
      if (opts.only && !pair.key.includes(opts.only)) continue;
      pairs.set(pair.key, pair);
      const report = blank(pair);
      reports.push(report);
      if (pair.missing) {
        report.causes.push(`missing-${pair.missing}`);
        continue;
      }
      report.gen = fileFacts(pair.genPath);
      report.solution = fileFacts(pair.solutionPath);
      // Layout enforcement: the flat tasks/ folder assumes self-contained files,
      // so an `include` anywhere in the .gen makes the task unsolvable as emitted.
      if (/^\s*include\b/m.test(readFileSync(pair.genPath, "utf-8"))) {
        report.causes.push("gen-has-include");
        continue;
      }
      work.push({ pair, report });
    }
  }

  log(`  ${work.length} pairs to validate, ${opts.jobs} at a time\n`);

  const started = Date.now();
  let done = 0;
  await pool(work, opts.jobs, async ({ pair, report }) => {
    const result = await validate(pair.genPath, pair.solutionPath, {
      timeLimit: pair.timeout,
      extraFlags: pair.flags,
    });
    report.additions = result.additions;
    report.verify = result.verify;
    classify(report, result);

    done++;
    const mark = report.admitted ? "ok  " : "EXCL";
    const detail = report.admitted ? `${result.additions.addedLines} added` : report.causes.join(",");
    log(`  [${String(done).padStart(3)}/${work.length}] ${mark} ${pair.key} (${result.verify.seconds}s) ${detail}`);
  });

  reports.sort((a, b) => a.key.localeCompare(b.key));
  return {
    config,
    reposUsed: kept,
    branchesDeferred: dropped,
    checkouts,
    reports,
    pairs,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
  };
}

/** The `reference-report.json` document. */
export function buildReport(corpus: Corpus) {
  const byCause = new Map<string, number>();
  for (const r of corpus.reports) for (const c of r.causes) byCause.set(c, (byCause.get(c) ?? 0) + 1);
  const admitted = corpus.reports.filter(r => r.admitted);

  return {
    dafnyVersion: corpus.config.dafnyVersion,
    configSource: corpus.config.source,
    configSeededAt: corpus.config.seededAt,
    aggregate: {
      reposConfigured: corpus.config.repos.length,
      reposUsed: corpus.reposUsed.length,
      branchesDeferred: corpus.branchesDeferred,
      pairsSeen: corpus.reports.length,
      admitted: admitted.length,
      excluded: corpus.reports.length - admitted.length,
      // A pair can trip more than one cause, so these sum to at least the
      // excluded count, not exactly to it.
      excludedByCause: Object.fromEntries([...byCause.entries()].sort((a, b) => b[1] - a[1])),
    },
    repos: corpus.checkouts.map(c => ({
      repo: c.entry.repo,
      branch: c.entry.branch,
      present: c.present,
      head: c.head,
      currentBranch: c.currentBranch,
      dirty: c.dirty,
      error: c.error,
    })),
    pairs: corpus.reports,
  };
}

/** The printed summary that accompanies the report. */
export function printSummary(corpus: Corpus, log: (line: string) => void) {
  const byCause = new Map<string, number>();
  for (const r of corpus.reports) for (const c of r.causes) byCause.set(c, (byCause.get(c) ?? 0) + 1);
  const admitted = corpus.reports.filter(r => r.admitted);

  log(`\n${"=".repeat(70)}`);
  log(`pairs seen  ${corpus.reports.length}`);
  log(`admitted    ${admitted.length}`);
  log(`excluded    ${corpus.reports.length - admitted.length}`);
  log(`\nby cause (a pair can trip more than one):`);
  for (const [cause, n] of [...byCause.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  ${String(n).padStart(3)}  ${cause}`);
  }
  const slow = admitted
    .filter(r => (r.verify?.seconds ?? 0) >= 30)
    .sort((a, b) => (b.verify?.seconds ?? 0) - (a.verify?.seconds ?? 0));
  if (slow.length) {
    log(`\nslowest admitted:`);
    for (const r of slow.slice(0, 8)) log(`  ${String(r.verify!.seconds).padStart(4)}s  ${r.key}`);
  }
}

/**
 * Rebuild a `Corpus` from a previously written `reference-report.json`, without
 * running Dafny.
 *
 * Emitting the benchmark needs nothing the report does not already hold — file
 * facts, added-line counts, verify options, reference timings, repo heads — plus
 * each `.dfy.gen`'s path, which is derivable from the repo and relpath. So the
 * emission step has no business re-verifying 65 proofs to change the shape of a
 * JSON file.
 *
 * The `sha256` recorded per pair is what keeps this honest: if a checkout has
 * moved since the report was written, the report describes a corpus that no
 * longer exists, and emitting from it would produce tasks nothing vouched for.
 */
export function corpusFromReport(repoRoot: string, reportPath: string): Corpus {
  const doc = JSON.parse(readFileSync(reportPath, "utf-8"));
  const config = loadConfig(path.join(repoRoot, "config", "repos.json"));
  const { kept, dropped } = dedupeRepos(config.repos);
  const parentDir = path.resolve(repoRoot, config.parentDir);

  const checkouts: Checkout[] = doc.repos.map((r: any) => ({
    entry: { repo: r.repo, branch: r.branch },
    dir: path.join(parentDir, repoName(r.repo)),
    present: r.present,
    head: r.head,
    currentBranch: r.currentBranch,
    dirty: r.dirty,
    error: r.error,
  }));

  const reports: PairReport[] = doc.pairs;
  const pairs = new Map<string, Pair>();
  const stale: string[] = [];

  for (const r of reports) {
    if (!r.gen || r.relpath === "-") continue;
    const base = path.join(parentDir, repoName(r.repo), r.relpath.replace(/\.ts$/, ""));
    const genPath = `${base}.dfy.gen`;
    const solutionPath = `${base}.dfy`;
    if (!existsSync(genPath) || fileFacts(genPath).sha256 !== r.gen.sha256) {
      stale.push(r.key);
      continue;
    }
    pairs.set(r.key, {
      key: r.key,
      repo: r.repo,
      branch: r.branch,
      relpath: r.relpath,
      genPath,
      solutionPath,
      timeout: r.verifyOptions.timeLimit,
      flags: r.verifyOptions.flags,
    });
  }

  if (stale.length) {
    throw new Error(
      `${stale.length} pair(s) have moved since ${path.basename(reportPath)} was written, ` +
        `so it no longer describes the corpus. Re-run the full pass.\n  ` +
        stale.slice(0, 5).join("\n  "),
    );
  }

  return { config, reposUsed: kept, branchesDeferred: dropped, checkouts, reports, pairs, elapsedSeconds: 0 };
}
