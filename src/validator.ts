/**
 * The validator: two checks against a candidate `.dfy`, and nothing else.
 *
 *   1. additions-only  — diff against the immutable task scaffold, no
 *                        deletions, no banned pattern on an added line
 *   2. verifies        — `dafny verify` with zero errors and no disqualifying
 *                        warning
 *
 * Each check is `passed` / `failed` / `not-run`. No per-task derived state: a
 * candidate is checked against the task and against Dafny. The generator's
 * admission gate calls exactly this, with the composed scaffold as the task
 * and the reference solution as the candidate.
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import {
  declarationKeyword,
  scanAddedLines,
  scannedText,
  weakeningClause,
  type BannedMatch,
  type WeakenedContract,
} from "./banned.js";
import {
  isInert,
  judgeSignatureLine,
  scrub,
  topLevelDeclarations,
  type LexState,
} from "./signature.js";

export type CheckStatus = "passed" | "failed" | "not-run";

export interface SignatureViolation {
  /** 1-based line of the original task declaration. */
  declarationLine: number;
  /** The declaration, for the message. */
  declaration: string;
  why: string;
  text: string;
}

export interface AdditionsCheck {
  status: CheckStatus;
  /** Why the check could not run, when status is "not-run". */
  notRunReason?: string;
  deletedLines: number;
  /** Up to five deleted lines, for the report. */
  deletedSamples: string[];
  bannedMatches: BannedMatch[];
  /** Added `requires` / `reads` / `modifies` clauses attached to a task
   *  declaration outside its signature interval. */
  weakenedContracts: WeakenedContract[];
  /** Disallowed signature additions or original text outside its declaration. */
  signatureViolations: SignatureViolation[];
  addedLines: number;
  /** Added lines that are neither blank nor a whole-line `//` comment. */
  addedCodeLines: number;
}

export type WarningCategory =
  | "bodyless-declaration"
  | "bodyless-forall"
  | "bodyless-loop"
  | "verify-false"
  | "vacuous-theorem";

/**
 * Disqualifying warnings, matched on Dafny's message text.
 *
 * Text matching is fragile across Dafny releases — `errorId` is null for all
 * three — so `fixtures/` holds one cheating `.dfy` per category and the test
 * suite asserts each is still caught. A release that rewords a message fails
 * the suite rather than silently widening the benchmark.
 */
const warningCategories: { category: WarningCategory; match: RegExp }[] = [
  { category: "bodyless-declaration", match: /part of a bodyless/ },
  { category: "bodyless-forall", match: /forall statement has no body/ },
  { category: "bodyless-loop", match: /loop has no body/ },
  // Dafny announces this one itself, which is worth more than any token scan:
  // the attribute can be split across lines (`{:verify` / `false}`) and no
  // line-wise denylist sees it, but the warning fires regardless of spelling.
  { category: "verify-false", match: /\{:verify false\} attribute/ },
];

/**
 * A theorem proved from contradictory assumptions.
 *
 * Dafny emits this in two shapes, and only the first says the *theorem* was
 * vacuous:
 *
 *   ensures clause proved using contradictory assumptions
 *   proved using contradictory assumptions: <inner goal>
 *
 * The second reports an obligation discharged on an infeasible path — an
 * assertion, an index bound, a loop invariant — which is what proof by
 * contradiction looks like from the verifier's side. Nine files in this corpus
 * contain one, so matching it would reject a standard technique.
 *
 * The first shape disqualifies, with one exception: a clause that is literally
 * `ensures false`. Such a lemma asserts that its own hypotheses are
 * unsatisfiable, so proving `false` from them *is* the theorem — the
 * contrapositive idiom. The exception is safe because a candidate cannot write
 * `ensures false` onto a task declaration; the signature rule rejects an
 * added `ensures` there unless the declaration is concretely verified, and a
 * candidate's own lemma proving `false` from contradictory hypotheses is honest
 * work.
 */
const vacuousTheorem = /^ensures clause proved using contradictory assumptions/;
const contradictionWarning = /proved using contradictory assumptions/;
const literalEnsuresFalse = /^\s*ensures\s+false\s*(\/\/.*)?$/;

export interface DisqualifyingWarning {
  category: WarningCategory;
  message: string;
  line: number;
}

export interface VerifyCheck {
  status: CheckStatus;
  notRunReason?: string;
  errors: number;
  /** Of those errors, the ones that are `--verification-time-limit` expiries.
   *  Dafny reports a per-procedure timeout as an error, but it means "ran out
   *  of clock", not "could not be proved" — and since the limit is wall-clock,
   *  it is sensitive to machine load. Counted separately so the report can tell
   *  a flaky run from a broken proof. */
  timeouts: number;
  /** Up to five error messages, for the report. */
  errorSamples: string[];
  disqualifyingWarnings: DisqualifyingWarning[];
  /** Contradictory-assumption warnings of any shape. Reported, not
   *  disqualifying — see `contradictionWarning`. */
  contradictions: number;
  otherWarnings: number;
  /** The argv actually run, minus the absolute path of the candidate. */
  command: string[];
  seconds: number;
  timedOut: boolean;
  exitCode: number | null;
}

/**
 * The Dafny version this checker was written against, checked once per process.
 *
 * Warning categories are matched on message text, so a different release can
 * silently change what the validator accepts — a `PASS` under an unpinned
 * toolchain means something other than what the benchmark claims. Cheap enough
 * to enforce rather than document.
 */
let cachedVersion: string | null | undefined;

/**
 * Whether a reported Dafny version is the one we pinned.
 *
 * Release builds report bare `4.11.0`, but `setup-dafny-action` installs a build
 * that reports `4.11.0+fcb2042d6d043a2634f0854338c08feeaaaf4ae2`. Semver says
 * build metadata — everything after `+` — is ignored when comparing versions, so
 * an exact string match rejects the very toolchain it is trying to require.
 * Found by CI, because the check had only ever run against one local install.
 */
export function versionMatches(expected: string, found: string): boolean {
  const core = (v: string) => v.trim().split("+")[0];
  return core(expected) === core(found);
}

export function dafnyVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    cachedVersion = execFileSync("dafny", ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split(/\s+/)[0];
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

export interface VerifyOptions {
  /** Refuse to run against any other Dafny. */
  expectedVersion?: string;
  /** `--verification-time-limit`, from the LemmaScript-files.txt entry. */
  timeLimit?: number;
  /** Extra Dafny flags from the LemmaScript-files.txt entry, e.g. `--isolate-assertions`. */
  extraFlags?: string[];
  /** Wall-clock kill, in seconds. Defence against a hang, not a verification budget. */
  wallClockSeconds?: number;
}

export interface ValidationResult {
  additions: AdditionsCheck;
  verify: VerifyCheck;
  /** Both checks passed. */
  passed: boolean;
  /** The unified diff, gen → candidate. */
  diff: string;
}

/** Compare exact text. Full context is required for source-position checks. */
export function gitDiff(genPath: string, candidatePath: string, fullContext = false): string {
  const ctx = fullContext ? ["-U1000000"] : [];
  try {
    const output = execFileSync("git", ["diff", "--no-index", "--minimal", "--no-color",
      "--no-ext-diff", "--no-textconv", "--text", ...ctx, "--", genPath, candidatePath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1" },
      maxBuffer: 256 * 1024 * 1024,
    });
    if (output !== "") throw new Error("git diff reported identical files with unexpected output");
    return output;
  } catch (e: any) {
    // Exit 1 denotes a completed comparison with differences. A process or
    // buffer error must not be accepted merely because it contains stdout.
    if (e?.status === 1 && e?.signal == null && e?.code == null &&
        typeof e.stdout === "string" && e.stdout.startsWith("diff --git ")) return e.stdout;
    const detail = typeof e?.stderr === "string" ? e.stderr.trim() : "";
    throw new Error(`git diff failed (exit ${e?.status ?? "unavailable"}): ${detail || e?.message || e}`);
  }
}

export function checkAdditionsOnly(genPath: string, candidatePath: string): { check: AdditionsCheck; diff: string } {
  let diff: string;
  let fullDiff: string;
  try {
    diff = gitDiff(genPath, candidatePath);
    fullDiff = gitDiff(genPath, candidatePath, true);
  } catch (e: any) {
    return {
      diff: "",
      check: {
        status: "not-run",
        notRunReason: `could not run git diff: ${e?.message ?? e}`,
        deletedLines: 0,
        deletedSamples: [],
        bannedMatches: [],
        weakenedContracts: [],
        signatureViolations: [],
        addedLines: 0,
        addedCodeLines: 0,
      },
    };
  }

  const lines = diff.split("\n");
  const deleted = lines.filter(l => l.startsWith("-") && !l.startsWith("---"));
  const added = lines.filter(l => l.startsWith("+") && !l.startsWith("+++")).map(l => l.slice(1));

  const addedCodeLines = added.filter(l => {
    const t = l.trim();
    return t !== "" && !t.startsWith("//");
  }).length;

  const bannedMatches = scanAddedLines(added);
  const weakenedContracts = findWeakenedContracts(fullDiff.split("\n"));
  let signatureViolations: SignatureViolation[];
  try {
    signatureViolations = findDeclarationViolations(genPath, candidatePath);
  } catch (e: any) {
    return {
      diff,
      check: {
        status: "not-run",
        notRunReason: `could not compare scaffold declarations: ${e?.message ?? e}`,
        deletedLines: deleted.length,
        deletedSamples: deleted.slice(0, 5),
        bannedMatches, weakenedContracts, signatureViolations: [],
        addedLines: added.length, addedCodeLines,
      },
    };
  }

  const clean =
    deleted.length === 0 &&
    bannedMatches.length === 0 &&
    weakenedContracts.length === 0 &&
    signatureViolations.length === 0;
  return {
    diff,
    check: {
      status: clean ? "passed" : "failed",
      deletedLines: deleted.length,
      deletedSamples: deleted.slice(0, 5),
      bannedMatches,
      weakenedContracts,
      signatureViolations,
      addedLines: added.length,
      addedCodeLines,
    },
  };
}

/** Preserve each original signature and body inside its matching declaration. */
function findDeclarationViolations(genPath: string, candidatePath: string): SignatureViolation[] {
  const genText = readFileSync(genPath, "utf-8");
  const candidateText = readFileSync(candidatePath, "utf-8");
  const originalLines = genText.split("\n");
  const candidateLines = candidateText.split("\n");
  const originals = topLevelDeclarations(genText, true);
  const candidates = topLevelDeclarations(candidateText, true);
  const found: SignatureViolation[] = [];
  let previousEnd = 0;
  for (const original of originals) {
    const reject = (why: string, text = originalLines[original.start - 1]) => {
      found.push({
        declarationLine: original.start,
        declaration: originalLines[original.start - 1].trim().slice(0, 72),
        why,
        text,
      });
    };
    const matches = candidates.filter(candidate => candidate.kind === original.kind && candidate.name === original.name);
    if (matches.length !== 1 || matches[0].start <= previousEnd) {
      reject("original declaration has no unique counterpart in its original order");
      continue;
    }
    const candidate = matches[0];
    previousEnd = candidate.end;
    const originalEnd = original.bodyStart === null ? original.end : original.bodyStart - 1;
    const candidateEnd = candidate.bodyStart === null ? candidate.end : candidate.bodyStart - 1;
    const signature = originalLines.slice(original.start - 1, originalEnd);
    let next = 0;
    const state: LexState = { block: false, str: false };
    for (const text of candidateLines.slice(candidate.start - 1, candidateEnd)) {
      const code = scrub(text, state).trim();
      if (next < signature.length && text === signature[next]) {
        next++;
      } else if (!isInert(text)) {
        const verdict = judgeSignatureLine(code, original.trusted);
        if (!verdict.ok) reject(verdict.why, text);
      }
    }
    if (next !== signature.length) {
      reject("original signature is not preserved inside its declaration", signature[next]);
    }
    if (original.bodyStart !== null) {
      if (candidate.bodyStart === null) {
        reject("original body is not preserved inside its declaration");
        continue;
      }
      // Preserve body lines within this declaration, independently of its signature.
      const body = originalLines.slice(original.bodyStart - 1, original.end);
      let bodyNext = 0;
      for (const text of candidateLines.slice(candidate.bodyStart - 1, candidate.end)) {
        if (bodyNext < body.length && text === body[bodyNext]) bodyNext++;
      }
      if (bodyNext !== body.length) reject("original body is not preserved inside its declaration", body[bodyNext]);
    }
  }
  return found;
}

/** Reject added preconditions/frames unless the preceding declaration is a new helper.
 *  Full diff context preserves unchanged declaration headers between additions. */
function findWeakenedContracts(diffLines: string[]): WeakenedContract[] {
  const found: WeakenedContract[] = [];
  let addedIndex = 0;
  // Whether the nearest preceding declaration keyword sat on an added line.
  // `null` until one is seen at all; a clause before any declaration is not
  // something a candidate can have written legitimately.
  let lastDeclarationAdded: boolean | null = null;

  for (const line of diffLines) {
    const isAdded = line.startsWith("+") && !line.startsWith("+++");
    const isContext = line.startsWith(" ");
    if (!isAdded && !isContext) continue; // headers, deletions, "\ No newline"

    const text = line.slice(1);
    if (isAdded) addedIndex++;

    // Comments must not supply a keyword — `// this lemma is hard` is prose.
    const code = scannedText(text);
    if (declarationKeyword.test(code)) lastDeclarationAdded = isAdded;

    if (isAdded && lastDeclarationAdded !== true) {
      const m = weakeningClause.exec(code);
      if (m) found.push({ clause: m[1], addedLineIndex: addedIndex, text });
    }
  }
  return found;
}

export async function checkVerifies(candidatePath: string, opts: VerifyOptions = {}): Promise<VerifyCheck> {
  const empty = { errors: 0, timeouts: 0, errorSamples: [], disqualifyingWarnings: [], contradictions: 0, otherWarnings: 0, seconds: 0, timedOut: false, exitCode: null };

  let content: string;
  try {
    content = readFileSync(candidatePath, "utf-8");
  } catch (e: any) {
    return { status: "not-run", notRunReason: `could not read candidate: ${e?.message ?? e}`, command: [], ...empty };
  }

  if (opts.expectedVersion) {
    const found = dafnyVersion();
    if (found === null) {
      return { status: "not-run", notRunReason: "`dafny` not found on PATH", command: [], ...empty };
    }
    if (!versionMatches(opts.expectedVersion, found)) {
      return {
        status: "not-run",
        notRunReason: `expected Dafny ${opts.expectedVersion}, found ${found}`,
        command: [],
        ...empty,
      };
    }
  }

  const args = ["verify", "--allow-warnings", "--warn-contradictory-assumptions", "--json-output"];
  // Mirrors LemmaScript's own sniff (tools/src/dafny-commands.ts): the standard
  // library is opt-in, and a candidate may reach for it even when the task does
  // not, so this is read off the candidate rather than stored per task.
  if (content.includes("Std.")) args.push("--standard-libraries");
  if (opts.timeLimit) args.push("--verification-time-limit", String(opts.timeLimit));
  for (const f of opts.extraFlags ?? []) args.push(f);

  // A directory containing only the candidate: nothing else for Dafny to pick up.
  // The staged name must end in `.dfy`: Dafny rejects any other extension
  // outright. Raw generated baselines may still have a `.dfy.gen` suffix.
  const dir = mkdtempSync(path.join(tmpdir(), "lsdb-verify-"));
  const raw = path.basename(candidatePath);
  const base = raw.endsWith(".dfy") ? raw : `${raw.replace(/\.gen$/, "")}${raw.endsWith(".dfy.gen") ? "" : ".dfy"}`;
  const command = [...args, base];
  const started = Date.now();
  try {
    copyFileSync(candidatePath, path.join(dir, base));
    const run = await runDafny([...args, base], dir, (opts.wallClockSeconds ?? 2400) * 1000);
    const seconds = Math.round((Date.now() - started) / 1000);

    if (run.spawnError?.code === "ENOENT") {
      return { status: "not-run", notRunReason: "`dafny` not found on PATH", command, ...empty, seconds };
    }
    if (run.timedOut) {
      return { status: "failed", command, ...empty, seconds, timedOut: true, exitCode: null };
    }
    if (run.spawnError) {
      return { status: "not-run", notRunReason: `could not run dafny: ${run.spawnError.message}`, command, ...empty, seconds };
    }

    const candidateLines = content.split("\n");
    const errorSamples: string[] = [];
    const disqualifyingWarnings: DisqualifyingWarning[] = [];
    let errors = 0;
    let timeouts = 0;
    let contradictions = 0;
    let otherWarnings = 0;
    let sawStatus = false;

    for (const raw of run.stdout.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.type === "status") {
        sawStatus = true;
        continue;
      }
      if (parsed.type !== "diagnostic") continue;
      const v = parsed.value;
      const message: string = v.defaultFormatMessage ?? "";
      if (v.severity === 1) {
        errors++;
        if (/timed out after/.test(message)) timeouts++;
        if (errorSamples.length < 5) errorSamples.push(`${v.location?.range?.start?.line ?? "?"}: ${message}`);
      } else if (v.severity === 2) {
        const line = v.location?.range?.start?.line ?? -1;
        const hit = warningCategories.find(w => w.match.test(message));
        if (hit) {
          disqualifyingWarnings.push({ category: hit.category, message, line });
        } else if (vacuousTheorem.test(message) && !isContrapositive(candidateLines, line)) {
          disqualifyingWarnings.push({ category: "vacuous-theorem", message, line });
        } else if (contradictionWarning.test(message)) {
          contradictions++;
        } else {
          otherWarnings++;
        }
      }
    }

    // No diagnostics and no status line means Dafny never got far enough to say
    // anything — a crashed run must not read as a clean one.
    if (!sawStatus && errors === 0) {
      return {
        status: "not-run",
        notRunReason: `dafny produced no verification status (exit ${run.code}): ${run.stderr.trim().slice(0, 300)}`,
        command,
        ...empty,
        seconds,
        exitCode: run.code,
      };
    }

    // The exit code is checked alongside the parsed diagnostics: a run that
    // emitted a status line and then failed for a reason we did not parse must
    // not be reported as clean.
    return {
      status: run.code === 0 && errors === 0 && disqualifyingWarnings.length === 0 ? "passed" : "failed",
      errors,
      timeouts,
      errorSamples,
      disqualifyingWarnings,
      contradictions,
      otherWarnings,
      command,
      seconds,
      timedOut: false,
      exitCode: run.code,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether the warned-about clause is literally `ensures false` — the
 *  contrapositive idiom rather than a vacuous proof. Dafny reports 1-based
 *  line numbers. */
function isContrapositive(lines: string[], line: number): boolean {
  const text = lines[line - 1];
  return text !== undefined && literalEnsuresFalse.test(text);
}

interface DafnyRun {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
}

/** One `dafny` invocation, killed at the wall clock. Async so the reference
 *  report can run several case studies at once. */
function runDafny(args: string[], cwd: string, wallClockMs: number): Promise<DafnyRun> {
  return new Promise(resolve => {
    const child = spawn("dafny", args, { cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, wallClockMs);
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut, spawnError: err });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/**
 * Both checks. Corpus mode runs both regardless of the first result — the
 * reference report wants every cause, not the first one.
 */
export async function validate(genPath: string, candidatePath: string, opts: VerifyOptions = {}): Promise<ValidationResult> {
  const { check: additions, diff } = checkAdditionsOnly(genPath, candidatePath);
  const verify = await checkVerifies(candidatePath, opts);
  return { additions, verify, passed: additions.status === "passed" && verify.status === "passed", diff };
}
