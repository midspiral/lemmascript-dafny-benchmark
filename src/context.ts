/**
 * Build the immutable task scaffold from a generated file plus semantic
 * declarations named in the benchmark-local context manifest.
 *
 * Context is deliberately demand-driven: Dafny resolution starts at the raw
 * `.dfy.gen`, and a configured function or predicate is selected only when its
 * name is unresolved. Resolving again discovers transitive semantic
 * dependencies. Nothing reachable only from reference-proof additions enters
 * the task, and upstream Dafny files contain no benchmark annotations.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanAddedLines } from "./banned.js";
import {
  declarationHeader,
  scrub,
  topLevelDeclarations,
  type DeclarationHeader,
  type LexState,
} from "./signature.js";
import { dafnyVersion, gitDiff, versionMatches } from "./validator.js";

const PROOF_TOKEN = /\b(assert|calc|reveal)\b|^\s*by\s+method\b/m;
const INELIGIBLE_TOP_LEVEL = /^\s*(datatype|type|newtype|const|class|trait|module|import|include)\b/m;

export interface ContextConfigEntry {
  key: string;
  declarations: string[];
}

/** Read and validate the benchmark-local declaration allowlist. */
export function loadContextConfig(configPath: string): Map<string, string[]> {
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  if (!Array.isArray(raw.pairs)) throw new Error(`${configPath}: expected a pairs array`);
  const result = new Map<string, string[]>();
  for (const entry of raw.pairs as ContextConfigEntry[]) {
    if (!entry || typeof entry.key !== "string" || !Array.isArray(entry.declarations)) {
      throw new Error(`${configPath}: every context entry needs a key and declarations array`);
    }
    if (result.has(entry.key)) throw new Error(`${configPath}: duplicate context key ${entry.key}`);
    if (entry.declarations.length === 0) throw new Error(`${configPath}: ${entry.key} has no declarations`);
    const names = new Set<string>();
    for (const name of entry.declarations) {
      if (typeof name !== "string" || !/^[A-Za-z_]\w*$/.test(name)) {
        throw new Error(`${configPath}: invalid declaration name ${String(name)} for ${entry.key}`);
      }
      if (names.has(name)) throw new Error(`${configPath}: duplicate declaration ${name} for ${entry.key}`);
      names.add(name);
    }
    result.set(entry.key, [...names]);
  }
  return result;
}

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
  /** Names supplied by config/context.json, whether or not construction passed. */
  configured: string[];
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

interface ContextBlock {
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
  blocks: ContextBlock[];
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

function validateBlock(
  name: string,
  lines: string[],
  header: DeclarationHeader,
  abstract: boolean,
  trailingNewline: boolean,
): { declaration?: ContextDeclaration; errors: string[] } {
  const errors: string[] = [];
  const scrubbed = scrubbedLines(lines);
  const headers = scrubbed.map(line => declarationHeader(line)).filter(h => h !== null);
  if (headers.length !== 1) {
    errors.push(`context ${name}: expected exactly one callable declaration, found ${headers.length}`);
    return { errors };
  }

  if (header.name !== name) errors.push(`context ${name}: extracted declaration is ${header.name}`);
  if (header.kind !== "function" && header.kind !== "predicate") {
    errors.push(`context ${name}: ${header.kind} declarations are not eligible context`);
  }

  const code = scrubbed.join("\n");
  if (/\bensures\b/.test(code)) errors.push(`context ${name}: context declarations may not contain ensures clauses`);
  if (PROOF_TOKEN.test(code)) errors.push(`context ${name}: context declarations may not contain proof statements`);
  if (INELIGIBLE_TOP_LEVEL.test(code)) errors.push(`context ${name}: block contains an ineligible top-level declaration`);
  const banned = scanAddedLines(lines);
  if (banned.length > 0) {
    errors.push(`context ${name}: contains banned material (${[...new Set(banned.map(b => b.pattern))].join(", ")})`);
  }
  if (errors.length > 0 || (header.kind !== "function" && header.kind !== "predicate")) return { errors };

  const whole = renderLines(lines, trailingNewline);
  const addedCodeLines = lines.filter((line, i) => scrubbed[i].trim() !== "").length;
  return {
    errors,
    declaration: {
      name,
      kind: header.kind,
      ghost: header.ghost,
      abstract,
      addedLines: lines.length,
      addedCodeLines,
      sha256: textHash(whole),
    },
  };
}

function prepare(genPath: string, solutionPath: string, configured: string[]): Prepared {
  const genText = readFileSync(genPath, "utf-8");
  const solutionText = readFileSync(solutionPath, "utf-8");
  const { entries, deletions, errors: diffErrors } = diffEntries(genPath, solutionPath);
  const errors = [...diffErrors];
  if (deletions > 0) errors.push(`solution deletes ${deletions} generated line(s)`);

  const blocks: ContextBlock[] = [];
  const solutionLines = physicalLines(solutionText).lines;
  const declarations = topLevelDeclarations(solutionText);
  for (const name of configured) {
    const matches = declarations.filter(declaration => declaration.name === name);
    if (matches.length === 0) {
      errors.push(`context ${name}: configured declaration was not found at top level`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(`context ${name}: configured declaration is ambiguous (${matches.length} top-level matches)`);
      continue;
    }

    const span = matches[0];
    const start = span.start - 1;
    const end = span.end - 1;
    const lines = solutionLines.slice(start, end + 1);
    if (entries.slice(start, end + 1).some(entry => entry?.origin !== "added")) {
      errors.push(`context ${name}: declaration contains a generated line`);
      continue;
    }
    const previousCode = start > 0 ? scrubbedLines([solutionLines[start - 1]])[0].trim() : "";
    if (/^\{\s*:/.test(previousCode) || /^@\w+/.test(previousCode)) {
      errors.push(`context ${name}: leading declaration attributes must be on the declaration line`);
      continue;
    }
    const checked = validateBlock(
      name,
      lines,
      span,
      span.abstract,
      end < solutionLines.length - 1 || solutionText.endsWith("\n"),
    );
    errors.push(...checked.errors);
    if (checked.declaration) blocks.push({ name, start, end, declaration: checked.declaration });
  }

  blocks.sort((a, b) => a.start - b.start);

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

function emptyReport(
  status: ContextReport["status"],
  configured: string[],
  causes: string[] = [],
  diagnostics: string[] = [],
): ContextReport {
  return {
    status,
    causes,
    diagnostics,
    configured,
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
  opts: { expectedVersion?: string; declarations?: string[] } = {},
): ContextBuildResult {
  const configured = opts.declarations ?? [];
  let prepared: Prepared;
  try {
    prepared = prepare(genPath, solutionPath, configured);
  } catch (error: any) {
    return {
      taskText: readFileSync(genPath, "utf-8"),
      context: emptyReport("not-run", configured, ["context-not-checked"], [String(error?.message ?? error)]),
    };
  }
  if (prepared.errors.length > 0) {
    return {
      taskText: prepared.genText,
      context: emptyReport("failed", configured, ["invalid-context"], prepared.errors),
    };
  }

  const raw = resolveText(prepared.genText, opts.expectedVersion);
  if (raw.status === "not-run") {
    return {
      taskText: prepared.genText,
      context: emptyReport(
        "not-run",
        configured,
        ["context-not-checked"],
        [raw.notRunReason ?? "dafny resolve did not run"],
      ),
    };
  }

  if (prepared.blocks.length === 0) {
    if (raw.unresolved.length > 0) {
      return {
        taskText: prepared.genText,
        context: emptyReport(
          "failed",
          configured,
          ["unresolved-context-name"],
          [`unresolved names with no configured context: ${raw.unresolved.join(", ")}`],
        ),
      };
    }
    return { taskText: prepared.genText, context: emptyReport("none", configured) };
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
          ...emptyReport("failed", configured, ["context-not-resolved"], [outputSample(resolution.output)]),
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
            configured,
            ["unresolved-context-name"],
            [`no configured context supplies: ${resolution.unresolved.join(", ")}`],
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
          ...emptyReport(
            "not-run",
            configured,
            ["context-not-checked"],
            [resolution.notRunReason ?? "dafny resolve did not run"],
          ),
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
        ...emptyReport(
          "failed",
          configured,
          ["unused-context"],
          [`configured context was not requested: ${unused.join(", ")}`],
        ),
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
      configured,
      declarations,
      resolutionRounds: rounds,
      addedLines: declarations.reduce((n, d) => n + d.addedLines, 0),
      addedCodeLines: declarations.reduce((n, d) => n + d.addedCodeLines, 0),
    },
  };
}

/** Recompose a previously reported scaffold without invoking Dafny. */
export function scaffoldFromReport(genPath: string, solutionPath: string, declarationNames: string[]): string {
  const prepared = prepare(genPath, solutionPath, declarationNames);
  if (prepared.errors.length > 0) throw new Error(prepared.errors.join("; "));
  const available = new Set(prepared.blocks.map(block => block.name));
  const missing = declarationNames.filter(name => !available.has(name));
  if (missing.length > 0) throw new Error(`reported context declarations are unavailable: ${missing.join(", ")}`);
  return project(prepared, new Set(declarationNames));
}

export function textFacts(text: string): { bytes: number; lines: number; sha256: string } {
  return {
    bytes: Buffer.byteLength(text),
    lines: text.split("\n").length,
    sha256: textHash(text),
  };
}
