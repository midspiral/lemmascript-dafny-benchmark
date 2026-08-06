/**
 * Finding the (`.dfy.gen`, solution) pairs: the repo list, the sibling
 * checkouts, and each case study's `LemmaScript-files.txt`.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface RepoEntry {
  /** `owner/name`, as it appears in the CI matrix. */
  repo: string;
  branch: string;
}

export interface Config {
  source: string;
  seededAt: string;
  dafnyVersion: string;
  parentDir: string;
  repos: RepoEntry[];
}

export function loadConfig(configPath: string): Config {
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  return {
    source: raw.source,
    seededAt: raw.seededAt,
    dafnyVersion: raw.dafnyVersion,
    parentDir: raw.parentDir ?? "..",
    repos: raw.repos,
  };
}

/**
 * One branch per repo, first entry wins (DESIGN.md > Repos). Multiple branches
 * are deferred; the dropped entries are returned so the report can say so
 * rather than lose them silently.
 */
export function dedupeRepos(repos: RepoEntry[]): { kept: RepoEntry[]; dropped: RepoEntry[] } {
  const seen = new Set<string>();
  const kept: RepoEntry[] = [];
  const dropped: RepoEntry[] = [];
  for (const e of repos) {
    if (seen.has(e.repo)) dropped.push(e);
    else {
      seen.add(e.repo);
      kept.push(e);
    }
  }
  return { kept, dropped };
}

export function repoName(repo: string): string {
  return repo.includes("/") ? repo.slice(repo.indexOf("/") + 1) : repo;
}

export interface Checkout {
  entry: RepoEntry;
  dir: string;
  present: boolean;
  /** Recorded opportunistically; the working tree is used as-is, dirty or not. */
  head?: string;
  currentBranch?: string;
  dirty?: boolean;
  error?: string;
}

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Locate a case study's checkout, cloning it if absent. Present checkouts are
 * left alone — the working tree is the input, dirty or not.
 */
export function resolveCheckout(entry: RepoEntry, parentDir: string, opts: { clone: boolean }): Checkout {
  const dir = path.join(parentDir, repoName(entry.repo));
  if (!existsSync(dir)) {
    if (!opts.clone) return { entry, dir, present: false, error: "not checked out (pass --clone)" };
    try {
      execFileSync("git", ["clone", "--branch", entry.branch, `git@github.com:${entry.repo}.git`, dir], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      return { entry, dir, present: false, error: `clone failed: ${String(e?.stderr ?? e?.message ?? e).trim().slice(0, 200)}` };
    }
  }
  return {
    entry,
    dir,
    present: true,
    head: git(dir, ["rev-parse", "HEAD"]),
    currentBranch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: (git(dir, ["status", "--porcelain"]) ?? "") !== "",
  };
}

export interface FileEntry {
  file: string;
  timeout?: number;
  flags: string[];
}

/**
 * `LemmaScript-files.txt`, parsed the way `lsc` parses it (tools/src/lsc.ts,
 * readEntries): `filepath [timeout_in_seconds] [extra dafny flags…]`.
 */
export function readFileList(dir: string): FileEntry[] | undefined {
  const listPath = path.join(dir, "LemmaScript-files.txt");
  if (!existsSync(listPath)) return undefined;
  return readFileSync(listPath, "utf-8")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const [file, second, ...rest] = entry.split(/\s+/);
      const timeout = second && /^[1-9]\d*$/.test(second) ? parseInt(second) : undefined;
      const flags = (timeout === undefined ? [second, ...rest] : rest).filter(Boolean);
      return { file, timeout, flags };
    });
}

export interface Pair {
  /** The stable key: `repo` + `relpath` of the TypeScript source. */
  key: string;
  repo: string;
  branch: string;
  /** Path of the `.ts` source, relative to the case study root. */
  relpath: string;
  genPath: string;
  solutionPath: string;
  timeout?: number;
  flags: string[];
  /** Present when the pair cannot be formed at all. */
  missing?: "gen" | "solution";
}

export function pairsFor(checkout: Checkout, entries: FileEntry[]): Pair[] {
  return entries.map(e => {
    const base = e.file.replace(/\.ts$/, "");
    const genPath = path.join(checkout.dir, `${base}.dfy.gen`);
    const solutionPath = path.join(checkout.dir, `${base}.dfy`);
    return {
      key: `${checkout.entry.repo}:${e.file}`,
      repo: checkout.entry.repo,
      branch: checkout.entry.branch,
      relpath: e.file,
      genPath,
      solutionPath,
      timeout: e.timeout,
      flags: e.flags,
      missing: !existsSync(genPath) ? "gen" : !existsSync(solutionPath) ? "solution" : undefined,
    };
  });
}

export function fileFacts(p: string): { bytes: number; lines: number; sha256: string } {
  const buf = readFileSync(p);
  return {
    bytes: statSync(p).size,
    lines: buf.toString("utf-8").split("\n").length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}
