/**
 * Walking the case studies and running every pair through the validator.
 *
 * Shared by `bin/reference-report.ts` and `bin/generate.ts`, which is the point:
 * the admission gate and the report are the same pass, so a task cannot be
 * emitted that the report did not vouch for.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildTaskScaffold,
  loadContextConfig,
  scaffoldFromReport,
  textFacts,
  type ContextReport,
} from "./context.js";
import { checkVerifies, validate, type ValidationResult } from "./validator.js";
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
  /** The immutable task scaffold: `.dfy.gen` plus demanded semantic context. */
  task?: FileFacts;
  solution?: FileFacts;
  context?: ContextReport;
  additions?: ValidationResult["additions"];
  verify?: ValidationResult["verify"];
  /** Whether the composed task verifies with no additions at all. Only measured
   *  for pairs that would otherwise be admitted. */
  taskVerifies?: boolean;
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
  // Not a failure — the solution is byte-identical to the composed scaffold,
  // so there is no proof to complete and the empty submission would pass.
  // Reported, not shipped.
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


/**
 * Apply the `exclude` markers in `config/repos.json`.
 *
 * These bar a pair from becoming a task for a reason that has nothing to do
 * with its proof — an upstream licence incompatible with this repo's, most
 * likely. The pair is still validated and still reported, so the record says
 * whether it *would* have qualified, and still gets an ID, so it keeps its
 * number if the bar is ever lifted.
 *
 * Applied wherever a corpus is assembled, not only where one is validated:
 * `--from-report` reuses stored verdicts, and an exclusion added to the config
 * afterwards has to take effect there too. Idempotent for that reason.
 */
function applyExclusions(reports: PairReport[], repos: RepoEntry[]) {
  const excluded = new Map(repos.filter(r => r.exclude).map(r => [r.repo, r.exclude!]));
  for (const r of reports) {
    const reason = excluded.get(r.repo);
    if (!reason) continue;
    const cause = `excluded:${reason}`;
    if (!r.causes.includes(cause)) r.causes.push(cause);
    r.admitted = false;
  }
}

export async function walkCorpus(opts: CorpusOptions): Promise<Corpus> {
  const log = opts.log ?? (() => {});
  const config = loadConfig(path.join(opts.repoRoot, "config", "repos.json"));
  const contextConfig = loadContextConfig(path.join(opts.repoRoot, "config", "context.json"));
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
  const enumeratedRepos = new Set<string>();

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
    enumeratedRepos.add(c.entry.repo);
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

  if (!opts.only) {
    const configuredRepos = new Set(kept.map(entry => entry.repo));
    const unknown = [...contextConfig.keys()].filter(key => {
      const repo = key.slice(0, key.indexOf(":"));
      return !configuredRepos.has(repo) || (enumeratedRepos.has(repo) && !pairs.has(key));
    });
    if (unknown.length > 0) throw new Error(`context config names unknown pair(s): ${unknown.join(", ")}`);
  }

  log(`  ${work.length} pairs to validate, ${opts.jobs} at a time\n`);

  const started = Date.now();
  let done = 0;
  await pool(work, opts.jobs, async ({ pair, report }) => {
    const built = buildTaskScaffold(pair.genPath, pair.solutionPath, {
      expectedVersion: config.dafnyVersion,
      declarations: contextConfig.get(pair.key) ?? [],
    });
    pair.taskText = built.taskText;
    report.task = textFacts(built.taskText);
    report.context = built.context;
    report.causes.push(...built.context.causes);

    const genText = readFileSync(pair.genPath, "utf-8");
    const stagedDir = built.taskText === genText ? undefined : mkdtempSync(path.join(tmpdir(), "lsdb-task-"));
    const taskPath = stagedDir ? path.join(stagedDir, "task.dfy") : pair.genPath;
    if (stagedDir) writeFileSync(taskPath, built.taskText);

    try {
      const result = await validate(taskPath, pair.solutionPath, {
        timeLimit: pair.timeout,
        extraFlags: pair.flags,
        expectedVersion: config.dafnyVersion,
      });
      report.additions = result.additions;
      report.verify = result.verify;
      classify(report, result);

      // A scaffold that already verifies is not a task: the empty submission
      // solves it, however many standalone theorems the reference later adds.
      // Context-only completions have no remaining additions, but are checked
      // too so their exclusion records the real reason.
      const contextOnly =
        built.context.status === "passed" &&
        report.causes.length === 1 &&
        report.causes[0] === "no-additions";
      if (report.admitted || contextOnly) {
        const taskCheck = await checkVerifies(taskPath, {
          timeLimit: pair.timeout,
          extraFlags: pair.flags,
          expectedVersion: config.dafnyVersion,
        });
        report.taskVerifies = taskCheck.status === "passed";
        if (report.taskVerifies) {
          if (built.context.status === "passed") {
            report.causes = report.causes.filter(c => c !== "no-additions");
            report.causes.push("already-verifies-after-context");
          } else {
            report.causes.push("already-verifies");
          }
          report.admitted = false;
        } else if (taskCheck.status === "not-run") {
          // Not knowing whether the scaffold is trivial is not the same as
          // knowing it isn't, so fail closed.
          report.causes.push("task-not-checked");
          report.admitted = false;
        }
      }

      done++;
      const mark = report.admitted ? "ok  " : "EXCL";
      const detail = report.admitted ? `${result.additions.addedLines} added` : report.causes.join(",");
      log(`  [${String(done).padStart(3)}/${work.length}] ${mark} ${pair.key} (${result.verify.seconds}s) ${detail}`);
    } finally {
      if (stagedDir) rmSync(stagedDir, { recursive: true, force: true });
    }
  });

  applyExclusions(reports, kept);
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
 * each pair's source paths, which are derivable from the repo and relpath. So
 * the emission step has no business re-verifying 65 proofs to change the shape
 * of a JSON file.
 *
 * The hashes recorded per pair are what keep this honest: a context-bearing
 * scaffold depends on both `.dfy.gen` and `.dfy`, so both must still be the
 * files the report vouched for.
 */
export function corpusFromReport(repoRoot: string, reportPath: string): Corpus {
  const doc = JSON.parse(readFileSync(reportPath, "utf-8"));
  const config = loadConfig(path.join(repoRoot, "config", "repos.json"));
  const contextConfig = loadContextConfig(path.join(repoRoot, "config", "context.json"));
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
  const reportedKeys = new Set(reports.map(report => report.key));
  for (const key of contextConfig.keys()) {
    if (!reportedKeys.has(key)) stale.push(key);
  }

  for (const r of reports) {
    if (!r.gen || r.relpath === "-") continue;
    const base = path.join(parentDir, repoName(r.repo), r.relpath.replace(/\.ts$/, ""));
    const genPath = `${base}.dfy.gen`;
    const solutionPath = `${base}.dfy`;
    if (
      !existsSync(genPath) ||
      fileFacts(genPath).sha256 !== r.gen.sha256 ||
      !r.solution ||
      !existsSync(solutionPath) ||
      fileFacts(solutionPath).sha256 !== r.solution.sha256
    ) {
      stale.push(r.key);
      continue;
    }
    const configured = contextConfig.get(r.key) ?? [];
    const reportedConfigured = r.context?.configured ?? [];
    if (JSON.stringify(configured) !== JSON.stringify(reportedConfigured)) {
      stale.push(r.key);
      continue;
    }
    // Pairs rejected before the context phase (currently, self-containment
    // failures caused by `include`) have source hashes but no composed task.
    // They cannot be emitted, so there is no scaffold to reconstruct.
    if (!r.task && !r.admitted && r.causes.includes("gen-has-include")) continue;
    let taskText: string;
    try {
      const names = r.context?.status === "passed" ? r.context.declarations.map(d => d.name) : [];
      taskText = names.length > 0 ? scaffoldFromReport(genPath, solutionPath, names) : readFileSync(genPath, "utf-8");
      if (!r.task || textFacts(taskText).sha256 !== r.task.sha256) {
        stale.push(r.key);
        continue;
      }
    } catch {
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
      taskText,
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

  applyExclusions(reports, kept);
  return { config, reposUsed: kept, branchesDeferred: dropped, checkouts, reports, pairs, elapsedSeconds: 0 };
}
