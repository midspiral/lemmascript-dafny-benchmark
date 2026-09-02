/**
 * Build the immutable task scaffold from a generated file plus explicitly
 * marked semantic declarations in its completed Dafny solution.
 *
 * Context is deliberately demand-driven: Dafny resolution starts at the raw
 * `.dfy.gen`, and a marked function or predicate is selected only when its name
 * is unresolved. Resolving again discovers transitive semantic dependencies.
 * Nothing reachable only from reference-proof additions enters the task.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanAddedLines } from "./banned.js";
import { declarationHeader, scrub, type LexState } from "./signature.js";
import { dafnyVersion, gitDiff, versionMatches } from "./validator.js";

const BEGIN = /^\s*\/\/\s*@benchmark-context\s+begin\s+([A-Za-z_]\w*)\s*$/;
const END = /^\s*\/\/\s*@benchmark-context\s+end\s+([A-Za-z_]\w*)\s*$/;
const PROOF_TOKEN = /\b(assert|calc|reveal)\b|^\s*by\s+method\b/m;
const INELIGIBLE_TOP_LEVEL = /^\s*(datatype|type|newtype|const|class|trait|module|import|include)\b/m;

export interface ContextDeclaration {
  name: string;
  kind: "function" | "predicate";
  ghost: boolean;
  abstract: boolean;
  addedLines: number;
  addedCodeLines: number;
  sha256: string;
}

export interface ContextReport {
  status: "none" | "passed" | "failed" | "not-run";
  causes: string[];
  diagnostics: string[];
  declarations: ContextDeclaration[];
  /** Unresolved names observed on each demand-driven resolution round. */
  resolutionRounds: string[][];
  addedLines: number;
  addedCodeLines: number;
}

export interface ContextBuildResult {
  taskText: string;
  context: ContextReport;
}

interface DiffEntry {
  origin: "generated" | "added";
  text: string;
}

interface MarkerBlock {
  name: string;
  start: number;
  end: number;
  declaration: ContextDeclaration;
}

interface Prepared {
  genText: string;
  solutionText: string;
  entries: DiffEntry[];
  trailingNewline: boolean;
  blocks: MarkerBlock[];
  errors: string[];
}

interface ResolveResult {
  status: "passed" | "failed" | "not-run";
  unresolved: string[];
  output: string;
  notRunReason?: string;
}

function physicalLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body === "" ? [] : body.split("\n"), trailingNewline };
}

function renderLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return trailingNewline ? "\n" : "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Parse the full-context git diff into the completed file's line order. */
function diffEntries(genPath: string, solutionPath: string): {
  entries: DiffEntry[];
  deletions: number;
  errors: string[];
} {
  const genText = readFileSync(genPath, "utf-8");
  const solutionText = readFileSync(solutionPath, "utf-8");
  const diff = gitDiff(genPath, solutionPath, true);
  if (diff === "") {
    return {
      entries: physicalLines(genText).lines.map(text => ({ origin: "generated", text })),
      deletions: 0,
      errors: [],
    };
  }

  const entries: DiffEntry[] = [];
  let deletions = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\ No newline")) continue;
    if (raw.startsWith(" ")) entries.push({ origin: "generated", text: raw.slice(1) });
    else if (raw.startsWith("+")) entries.push({ origin: "added", text: raw.slice(1) });
    else if (raw.startsWith("-")) deletions++;
  }

  const errors: string[] = [];
  const genTrailing = genText.endsWith("\n");
  const solutionTrailing = solutionText.endsWith("\n");
  const reconstructedGen = renderLines(
    entries.filter(e => e.origin === "generated").map(e => e.text),
    genTrailing,
  );
  const reconstructedSolution = renderLines(entries.map(e => e.text), solutionTrailing);
  if (reconstructedGen !== genText) errors.push("full-context diff did not reconstruct the generated file");
  if (reconstructedSolution !== solutionText) errors.push("full-context diff did not reconstruct the solution file");
  return { entries, deletions, errors };
}

function scrubbedLines(lines: string[]): string[] {
  const state: LexState = { block: false, str: false };
  return lines.map(line => scrub(line, state));
}

function validateBlock(name: string, lines: string[]): { declaration?: ContextDeclaration; errors: string[] } {
  const errors: string[] = [];
  const inner = lines.slice(1, -1);
  const scrubbed = scrubbedLines(inner);
  const headers = scrubbed.map(line => declarationHeader(line)).filter(h => h !== null);
  if (headers.length !== 1) {
    errors.push(`context ${name}: expected exactly one callable declaration, found ${headers.length}`);
    return { errors };
  }

  const header = headers[0];
  if (header.name !== name) errors.push(`context ${name}: marker wraps declaration ${header.name}`);
  if (header.kind !== "function" && header.kind !== "predicate") {
    errors.push(`context ${name}: ${header.kind} declarations are not eligible context`);
  }

  const code = scrubbed.join("\n");
  if (/\bensures\b/.test(code)) errors.push(`context ${name}: context declarations may not contain ensures clauses`);
  if (PROOF_TOKEN.test(code)) errors.push(`context ${name}: context declarations may not contain proof statements`);
  if (INELIGIBLE_TOP_LEVEL.test(code)) errors.push(`context ${name}: block contains an ineligible top-level declaration`);
  const banned = scanAddedLines(inner);
  if (banned.length > 0) {
    errors.push(`context ${name}: contains banned material (${[...new Set(banned.map(b => b.pattern))].join(", ")})`);
  }
  if (errors.length > 0 || (header.kind !== "function" && header.kind !== "predicate")) return { errors };

  const whole = lines.join("\n") + "\n";
  const addedCodeLines = inner.filter((line, i) => scrubbed[i].trim() !== "").length;
  return {
    errors,
    declaration: {
      name,
      kind: header.kind,
      ghost: header.ghost,
      abstract: !code.includes("{"),
      addedLines: lines.length,
      addedCodeLines,
      sha256: textHash(whole),
    },
  };
}

function prepare(genPath: string, solutionPath: string): Prepared {
  const genText = readFileSync(genPath, "utf-8");
  const solutionText = readFileSync(solutionPath, "utf-8");
  const { entries, deletions, errors: diffErrors } = diffEntries(genPath, solutionPath);
  const errors = [...diffErrors];
  if (deletions > 0) errors.push(`solution deletes ${deletions} generated line(s)`);

  const blocks: MarkerBlock[] = [];
  const names = new Set<string>();
  let open: { name: string; start: number } | null = null;
  for (let i = 0; i < entries.length; i++) {
    const begin = BEGIN.exec(entries[i].text);
    const end = END.exec(entries[i].text);
    if (begin) {
      if (open) {
        errors.push(`context ${begin[1]}: marker is nested inside context ${open.name}`);
        continue;
      }
      if (entries[i].origin !== "added") errors.push(`context ${begin[1]}: begin marker is not an added line`);
      open = { name: begin[1], start: i };
      continue;
    }
    if (!end) {
      if (open && entries[i].origin !== "added") {
        errors.push(`context ${open.name}: block contains a generated line`);
      }
      continue;
    }
    if (!open) {
      errors.push(`context ${end[1]}: end marker has no matching begin`);
      continue;
    }
    if (entries[i].origin !== "added") errors.push(`context ${end[1]}: end marker is not an added line`);
    if (end[1] !== open.name) {
      errors.push(`context ${open.name}: end marker names ${end[1]}`);
      open = null;
      continue;
    }
    if (names.has(open.name)) errors.push(`context ${open.name}: declaration is marked more than once`);
    names.add(open.name);
    const lines = entries.slice(open.start, i + 1).map(e => e.text);
    const checked = validateBlock(open.name, lines);
    errors.push(...checked.errors);
    if (checked.declaration) {
      blocks.push({ name: open.name, start: open.start, end: i, declaration: checked.declaration });
    }
    open = null;
  }
  if (open) errors.push(`context ${open.name}: begin marker has no matching end`);

  return { genText, solutionText, entries, trailingNewline: solutionText.endsWith("\n"), blocks, errors };
}

function project(prepared: Prepared, selected: ReadonlySet<string>): string {
  const selectedLines = new Set<number>();
  for (const block of prepared.blocks) {
    if (!selected.has(block.name)) continue;
    for (let i = block.start; i <= block.end; i++) selectedLines.add(i);
  }
  return renderLines(
    prepared.entries
      .filter((entry, i) => entry.origin === "generated" || selectedLines.has(i))
      .map(entry => entry.text),
    prepared.trailingNewline,
  );
}

function commandOutput(error: any): string {
  const stdout = error?.stdout == null ? "" : Buffer.isBuffer(error.stdout) ? error.stdout.toString("utf-8") : String(error.stdout);
  const stderr = error?.stderr == null ? "" : Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf-8") : String(error.stderr);
  return [stdout, stderr].filter(Boolean).join("\n");
}

function resolveText(text: string, expectedVersion?: string): ResolveResult {
  if (expectedVersion) {
    const found = dafnyVersion();
    if (found === null) {
      return { status: "not-run", unresolved: [], output: "", notRunReason: "`dafny` not found on PATH" };
    }
    if (!versionMatches(expectedVersion, found)) {
      return {
        status: "not-run",
        unresolved: [],
        output: "",
        notRunReason: `expected Dafny ${expectedVersion}, found ${found}`,
      };
    }
  }

  const dir = mkdtempSync(path.join(tmpdir(), "lsdb-context-"));
  const name = "task.dfy";
  try {
    writeFileSync(path.join(dir, name), text);
    const args = ["resolve", "--allow-warnings"];
    if (text.includes("Std.")) args.push("--standard-libraries");
    args.push(name);
    let output = "";
    let passed = true;
    try {
      output = execFileSync("dafny", args, {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return { status: "not-run", unresolved: [], output: "", notRunReason: "`dafny` not found on PATH" };
      }
      if (error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM") {
        return { status: "not-run", unresolved: [], output: commandOutput(error), notRunReason: "dafny resolve timed out" };
      }
      output = commandOutput(error);
      passed = false;
    }
    const unresolved = [...output.matchAll(/unresolved identifier:\s*([^\s]+)/g)]
      .map(m => m[1].replace(/[^A-Za-z0-9_].*$/, ""))
      .filter(Boolean);
    return {
      status: passed ? "passed" : "failed",
      unresolved: [...new Set(unresolved)].sort(),
      output,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function emptyReport(status: ContextReport["status"], causes: string[] = [], diagnostics: string[] = []): ContextReport {
  return {
    status,
    causes,
    diagnostics,
    declarations: [],
    resolutionRounds: [],
    addedLines: 0,
    addedCodeLines: 0,
  };
}

function outputSample(output: string): string {
  return output
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(" | ")
    .slice(0, 800);
}

/** Build and resolution-check the task scaffold for one pair. */
export function buildTaskScaffold(
  genPath: string,
  solutionPath: string,
  opts: { expectedVersion?: string } = {},
): ContextBuildResult {
  let prepared: Prepared;
  try {
    prepared = prepare(genPath, solutionPath);
  } catch (error: any) {
    return {
      taskText: readFileSync(genPath, "utf-8"),
      context: emptyReport("not-run", ["context-not-checked"], [String(error?.message ?? error)]),
    };
  }
  if (prepared.errors.length > 0) {
    return {
      taskText: prepared.genText,
      context: emptyReport("failed", ["invalid-context"], prepared.errors),
    };
  }

  const raw = resolveText(prepared.genText, opts.expectedVersion);
  if (raw.status === "not-run") {
    return {
      taskText: prepared.genText,
      context: emptyReport("not-run", ["context-not-checked"], [raw.notRunReason ?? "dafny resolve did not run"]),
    };
  }

  if (prepared.blocks.length === 0) {
    if (raw.unresolved.length > 0) {
      return {
        taskText: prepared.genText,
        context: emptyReport(
          "failed",
          ["unresolved-context-name"],
          [`unresolved names with no marked context: ${raw.unresolved.join(", ")}`],
        ),
      };
    }
    return { taskText: prepared.genText, context: emptyReport("none") };
  }

  const byName = new Map(prepared.blocks.map(block => [block.name, block]));
  const selected = new Set<string>();
  const rounds: string[][] = [];
  let resolution = raw;

  while (resolution.status !== "passed") {
    if (resolution.unresolved.length === 0) {
      return {
        taskText: prepared.genText,
        context: {
          ...emptyReport("failed", ["context-not-resolved"], [outputSample(resolution.output)]),
          resolutionRounds: rounds,
        },
      };
    }
    rounds.push(resolution.unresolved);
    const requested = resolution.unresolved.filter(name => byName.has(name) && !selected.has(name));
    if (requested.length === 0) {
      return {
        taskText: prepared.genText,
        context: {
          ...emptyReport(
            "failed",
            ["unresolved-context-name"],
            [`no marked context supplies: ${resolution.unresolved.join(", ")}`],
          ),
          resolutionRounds: rounds,
        },
      };
    }
    for (const name of requested) selected.add(name);
    resolution = resolveText(project(prepared, selected), opts.expectedVersion);
    if (resolution.status === "not-run") {
      return {
        taskText: prepared.genText,
        context: {
          ...emptyReport("not-run", ["context-not-checked"], [resolution.notRunReason ?? "dafny resolve did not run"]),
          resolutionRounds: rounds,
        },
      };
    }
  }

  const unused = prepared.blocks.filter(block => !selected.has(block.name)).map(block => block.name);
  if (unused.length > 0) {
    return {
      taskText: prepared.genText,
      context: {
        ...emptyReport("failed", ["unused-context"], [`marked context was not requested: ${unused.join(", ")}`]),
        resolutionRounds: rounds,
      },
    };
  }

  const declarations = prepared.blocks.map(block => block.declaration);
  return {
    taskText: project(prepared, selected),
    context: {
      status: "passed",
      causes: [],
      diagnostics: [],
      declarations,
      resolutionRounds: rounds,
      addedLines: declarations.reduce((n, d) => n + d.addedLines, 0),
      addedCodeLines: declarations.reduce((n, d) => n + d.addedCodeLines, 0),
    },
  };
}

/** Recompose a previously reported scaffold without invoking Dafny. */
export function scaffoldFromReport(genPath: string, solutionPath: string, declarationNames: string[]): string {
  const prepared = prepare(genPath, solutionPath);
  if (prepared.errors.length > 0) throw new Error(prepared.errors.join("; "));
  const available = new Set(prepared.blocks.map(block => block.name));
  const missing = declarationNames.filter(name => !available.has(name));
  if (missing.length > 0) throw new Error(`reported context declarations are no longer marked: ${missing.join(", ")}`);
  const extra = prepared.blocks.filter(block => !declarationNames.includes(block.name)).map(block => block.name);
  if (extra.length > 0) throw new Error(`new unreported context declarations are present: ${extra.join(", ")}`);
  return project(prepared, new Set(declarationNames));
}

export function textFacts(text: string): { bytes: number; lines: number; sha256: string } {
  return {
    bytes: Buffer.byteLength(text),
    lines: text.split("\n").length,
    sha256: textHash(text),
  };
}
