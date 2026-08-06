#!/usr/bin/env -S npx tsx
/**
 * check-artifacts — assert that the committed benchmark is internally coherent.
 *
 * `tasks/`, `metadata.json` and `index.json` are three views of one thing, and
 * nothing stops a hand-edit, a half-finished regeneration, or a bad merge from
 * putting them out of step. Regenerating would catch it, but regenerating costs
 * ten minutes and a Dafny install; this costs a second and needs neither, so CI
 * can run it on every push.
 *
 * What it does *not* check is whether the tasks are solvable — that is the
 * reference report's job, and it needs the case studies and Dafny.
 *
 * Usage:  check-artifacts
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taskFileName, type Index, type TaskMetadata } from "../src/benchmark.js";
import { dedupeRepos, loadConfig } from "../src/pairs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems: string[] = [];
const fail = (msg: string) => problems.push(msg);

function readJson<T>(name: string): T | undefined {
  const p = path.join(repoRoot, name);
  if (!existsSync(p)) {
    fail(`${name} is missing — run \`npm run generate\``);
    return undefined;
  }
  return JSON.parse(readFileSync(p, "utf-8")) as T;
}

const config = loadConfig(path.join(repoRoot, "config", "repos.json"));
const metadata = readJson<{ dafnyVersion: string; taskCount: number; tasks: TaskMetadata[] }>("metadata.json");
const index = readJson<Index>("index.json");
const report = readJson<{ dafnyVersion: string; pairs: { key: string; admitted: boolean }[] }>("reference-report.json");

if (metadata && index && report) {
  const tasks = metadata.tasks;

  // --- config -----------------------------------------------------------
  const { kept } = dedupeRepos(config.repos);
  for (const r of config.repos) {
    if (!r.license) fail(`config: ${r.repo} has no license — ATTRIBUTION.md would be wrong`);
  }
  const excluded = new Set(kept.filter(r => r.exclude).map(r => r.repo));
  for (const t of tasks) {
    if (excluded.has(t.repo)) fail(`task ${t.id} comes from ${t.repo}, which config excludes`);
  }

  // --- metadata self-consistency ----------------------------------------
  if (metadata.taskCount !== tasks.length) {
    fail(`metadata.taskCount is ${metadata.taskCount} but there are ${tasks.length} tasks`);
  }
  if (metadata.dafnyVersion !== config.dafnyVersion) {
    fail(`metadata pins Dafny ${metadata.dafnyVersion}, config pins ${config.dafnyVersion}`);
  }
  const ids = new Set<number>();
  for (const t of tasks) {
    if (ids.has(t.id)) fail(`duplicate task id ${t.id}`);
    ids.add(t.id);
    if (t.file !== `tasks/${taskFileName(t.id)}`) fail(`task ${t.id} claims file ${t.file}`);
    if (t.key !== `${t.repo}:${t.relpath}`) fail(`task ${t.id} key ${t.key} disagrees with repo/relpath`);
  }

  // --- index ------------------------------------------------------------
  const indexed = new Map(index.entries.map(e => [e.key, e]));
  const indexIds = new Set<number>();
  for (const e of index.entries) {
    if (indexIds.has(e.id)) fail(`index: id ${e.id} issued twice`);
    indexIds.add(e.id);
    if (e.id >= index.nextId) fail(`index: id ${e.id} is at or past nextId ${index.nextId}`);
  }
  for (const t of tasks) {
    const e = indexed.get(t.key);
    if (!e) fail(`task ${t.id} (${t.key}) is not in index.json`);
    else if (e.id !== t.id) fail(`${t.key} is task ${t.id} but index says ${e.id}`);
    else if (e.tombstoned) fail(`task ${t.id} is tombstoned in index.json yet still emitted`);
  }

  // --- report agrees on what was admitted --------------------------------
  const admitted = new Set(report.pairs.filter(p => p.admitted).map(p => p.key));
  for (const t of tasks) {
    if (!admitted.has(t.key)) fail(`task ${t.id} (${t.key}) is not admitted in reference-report.json`);
  }
  for (const key of admitted) {
    if (!tasks.some(t => t.key === key)) fail(`${key} is admitted in the report but has no task`);
  }

  // --- tasks/ on disk ----------------------------------------------------
  const tasksDir = path.join(repoRoot, "tasks");
  const onDisk = existsSync(tasksDir) ? readdirSync(tasksDir).filter(f => f.endsWith(".dfy")) : [];
  const expected = new Set(tasks.map(t => taskFileName(t.id)));
  for (const f of onDisk) if (!expected.has(f)) fail(`tasks/${f} is on disk but not in metadata.json`);

  for (const t of tasks) {
    const p = path.join(repoRoot, t.file);
    if (!existsSync(p)) {
      fail(`${t.file} is missing`);
      continue;
    }
    // The task file must still be the exact `.dfy.gen` its hash was taken from:
    // a candidate's diff is measured against it, so a stray edit here silently
    // changes every verdict for that task.
    const actual = createHash("sha256").update(readFileSync(p)).digest("hex");
    if (actual !== t.gen.sha256) fail(`${t.file} does not match the sha256 recorded in metadata.json`);
  }

  if (!existsSync(path.join(tasksDir, "ATTRIBUTION.md"))) {
    fail("tasks/ATTRIBUTION.md is missing — task files are derived works and need it");
  }

  console.log(`checked ${tasks.length} tasks, ${index.entries.length} indexed keys, ${onDisk.length} files in tasks/`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("artifacts are consistent");
