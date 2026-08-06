/**
 * The validator: two checks against a candidate `.dfy`, and nothing else.
 *
 *   1. additions-only  — diff against the `.dfy.gen`, no deletions, no banned
 *                        pattern on an added line
 *   2. verifies        — `dafny verify` with zero errors and no disqualifying
 *                        warning
 *
 * Each check is `passed` / `failed` / `not-run`. No per-task derived state: a
 * candidate is checked against the `.gen` and against Dafny. The generator's
 * admission gate calls exactly this, with the reference solution as the
 * candidate.
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  beginsDeclaration,
  isInert,
  judgeSignatureLine,
  scrub,
  signatureIntervals,
  type LexState,
} from "./signature.js";

export type CheckStatus = "passed" | "failed" | "not-run";

export interface SignatureViolation {
  /** 1-based line of the generated declaration the addition lands in. */
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
  /** Added `requires` / `reads` / `modifies` clauses attached to a generated
   *  declaration outside its signature interval. */
  weakenedContracts: WeakenedContract[];
  /** Added lines inside a generated declaration's signature that are not an
   *  allowed clause. This is what stops `|| true` from continuing a generated
   *  postcondition into something trivial. */
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
 * `ensures false` onto a generated declaration; the signature rule rejects an
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

/** `git diff --no-index`, whose exit status is 1 when the files differ.
 *  `context` is Infinity for the analysis pass: the classification needs every
 *  generated line present, since an added line is located by the generated line
 *  it follows. The compact diff is kept separately, for reporting. */
function gitDiff(genPath: string, candidatePath: string, fullContext = false): string {
  const ctx = fullContext ? ["-U1000000"] : [];
  try {
    return execFileSync("git", ["diff", "--no-index", "--no-color", ...ctx, "--", genPath, candidatePath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e: any) {
    if (e?.stdout != null) return typeof e.stdout === "string" ? e.stdout : e.stdout.toString("utf-8");
    throw e;
  }
}

export function checkAdditionsOnly(genPath: string, candidatePath: string): { check: AdditionsCheck; diff: string } {
  let diff: string;
  try {
    diff = gitDiff(genPath, candidatePath);
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

  const bannedMatches = scanAddedLines(added);
  const weakenedContracts = findWeakenedContracts(lines);
  const signatureViolations = findSignatureViolations(genPath, candidatePath);
  const addedCodeLines = added.filter(l => {
    const t = l.trim();
    return t !== "" && !t.startsWith("//");
  }).length;

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

/**
 * Added lines that land inside a generated declaration's signature and are not
 * one of the two clauses a candidate may add there.
 *
 * An added line is located by the generated line it follows, which is why the
 * analysis pass uses a full-context diff. The intervals themselves come from
 * the `.dfy.gen`, so no addition can move the boundary it is being judged
 * against.
 */
function findSignatureViolations(genPath: string, candidatePath: string): SignatureViolation[] {
  const intervals = signatureIntervals(readFileSync(genPath, "utf-8"));
  if (intervals.length === 0) return [];

  const found: SignatureViolation[] = [];
  const state: LexState = { block: false, str: false };
  let genLine = 0;

  for (const raw of gitDiff(genPath, candidatePath, true).split("\n")) {
    if (raw.startsWith("@@") || raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("\\")) continue;
    if (raw.startsWith(" ")) {
      genLine++;
      continue;
    }
    if (!raw.startsWith("+")) continue;

    const text = raw.slice(1);
    const interval = intervals.find(iv => genLine >= iv.start && genLine <= iv.end);
    if (!interval) continue;
    if (isInert(text)) continue;

    // A declaration may not *begin* inside a generated signature. Allowing it
    // let an added `lemma Injected(…)` capture the generated declaration's
    // clauses and body, leaving the generated one bodyless with no
    // specification at all — it would then claim nothing, and say so silently,
    // because a bodyless declaration without an `ensures` produces no warning.
    // Helpers remain legal at real declaration boundaries, which is where every
    // reference solution puts them.
    const code = scrub(text, state).trim();
    const verdict = judgeSignatureLine(code, interval.trusted);
    if (!verdict.ok) {
      found.push({
        declarationLine: interval.start,
        declaration: interval.text.slice(0, 72),
        why: verdict.why,
        text,
      });
    }
  }
  return found;
}

/**
 * Added `requires` / `reads` / `modifies` clauses that belong to a *generated*
 * declaration.
 *
 * A clause is attributed to the nearest declaration keyword *preceding* it in
 * the candidate, and is allowed only when that keyword is itself on an added
 * line — i.e. the clause is part of a helper the candidate wrote. Order
 * matters: "somewhere in the same run of added lines" would let a clause
 * borrow the keyword of a helper declared after it.
 *
 * Why this and not the vacuous-proof warning it replaces: adding `requires
 * false` to a generated lemma discharges its postcondition outright, and a
 * generated lemma nothing calls has no caller to break. On a *new* helper the
 * same clause is inert — Dafny makes every call site discharge it from
 * generated context the candidate cannot weaken, so an uncallable helper
 * proves nothing. The syntactic rule therefore covers the case the semantic
 * one existed for, and covers ordinary weakening too, which the warning never
 * saw.
 */
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
    if (found !== opts.expectedVersion) {
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
  // library is opt-in, and a candidate may reach for it even when the .gen does
  // not, so this is read off the candidate rather than stored per task.
  if (content.includes("Std.")) args.push("--standard-libraries");
  if (opts.timeLimit) args.push("--verification-time-limit", String(opts.timeLimit));
  for (const f of opts.extraFlags ?? []) args.push(f);

  // A directory containing only the candidate: nothing else for Dafny to pick up.
  // The staged name must end in `.dfy`: Dafny rejects any other extension
  // outright, and the admission gate verifies `.dfy.gen` files directly.
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
