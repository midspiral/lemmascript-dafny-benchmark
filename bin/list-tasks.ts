#!/usr/bin/env -S npx tsx
/**
 * list-tasks — the benchmark as a table, banded by how much proof the reference
 * solution needed.
 *
 * Added non-blank non-comment lines is a crude difficulty signal — a three-line
 * `assert` with a nonobvious witness outranks a sixty-line mechanical induction
 * — but it is the best one available without solving the tasks, and it is
 * already recorded per task.
 *
 * Usage:  list-tasks [--markdown]
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boolFlag } from "../src/cli.js";
import type { TaskMetadata } from "../src/benchmark.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const meta = JSON.parse(readFileSync(path.join(repoRoot, "metadata.json"), "utf-8")) as {
  taskCount: number;
  dafnyVersion: string;
  tasks: TaskMetadata[];
};

const bands = [
  { name: "small", lo: 1, hi: 10 },
  { name: "medium", lo: 11, hi: 50 },
  { name: "large", lo: 51, hi: 150 },
  { name: "very large", lo: 151, hi: Infinity },
];

const short = (t: TaskMetadata) => `${t.repo.split("/")[1].replace(/-lemmascript$/, "")}: ${t.relpath}`;
const budget = (t: TaskMetadata) =>
  [t.verify.timeLimit ? `${t.verify.timeLimit}s` : "", ...t.verify.flags].filter(Boolean).join(" ") || "—";

if (boolFlag("markdown")) {
  console.log(`| task | proof lines | source | verify options |`);
  console.log(`|---|---|---|---|`);
  for (const t of meta.tasks) {
    console.log(`| \`${String(t.id).padStart(4, "0")}\` | ${t.addedCodeLines} | ${short(t)} | ${budget(t)} |`);
  }
} else {
  for (const b of bands) {
    const inBand = meta.tasks.filter(t => t.addedCodeLines >= b.lo && t.addedCodeLines <= b.hi);
    if (!inBand.length) continue;
    const range = b.hi === Infinity ? `${b.lo}+` : `${b.lo}–${b.hi}`;
    console.log(`\n${b.name} (${range} proof lines) — ${inBand.length} task${inBand.length > 1 ? "s" : ""}`);
    for (const t of inBand.sort((x, y) => x.addedCodeLines - y.addedCodeLines)) {
      console.log(
        `  ${String(t.id).padStart(4, "0")}  ${String(t.addedCodeLines).padStart(4)} lines  ` +
        `${short(t).slice(0, 58).padEnd(60)}${budget(t)}`,
      );
    }
  }
  console.log(`\n${meta.taskCount} tasks, Dafny ${meta.dafnyVersion}`);
}
