import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkAdditionsOnly, gitDiff, validate } from "../src/validator.js";

// Pin Git's default algorithm so user configuration cannot mask the regression.
Object.assign(process.env, {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "diff.algorithm",
  GIT_CONFIG_VALUE_0: "myers",
});

// Text-only fixture: repeated braces make the default diff report a deletion
// despite preserving every original line, including whitespace and newlines.
const original = ["a", "{", "b", "c", "{", "d", "{", "e", "{",
                  "f", "{", "{", "g", "h", "{", "e", "{"];
const additions = [original[0], "i", original[1], "j", "k", "l", "m", "n", "o",
                   ...original.slice(2)];
const dir = mkdtempSync(path.join(tmpdir(), "benchmark-diff-"));
const gen = path.join(dir, "generated.txt");
const candidate = path.join(dir, "candidate.txt");
try {
  writeFileSync(gen, original.join("\n") + "\n");
  writeFileSync(candidate, additions.join("\n") + "\n");
  const { check } = checkAdditionsOnly(gen, candidate);
  assert.equal(check.status, "passed", "insertions among repeated braces must pass");
  assert.equal(check.deletedLines, 0);
  assert.equal(check.addedLines, 7);
  for (const fullContext of [false, true]) {
    const deletions = gitDiff(gen, candidate, fullContext).split("\n")
      .filter(line => line.startsWith("-") && !line.startsWith("---"));
    assert.deepEqual(deletions, [], `fullContext=${fullContext} must preserve original lines`);
  }

  for (const [name, lines] of [
    ["modified line", original.map(line => line === "b" ? "changed" : line)],
    ["deleted line", original.filter(line => line !== "b")],
    ["leading whitespace", original.map(line => line === "b" ? " b" : line)],
    ["trailing whitespace", original.map(line => line === "b" ? "b " : line)],
  ] as const) {
    writeFileSync(candidate, lines.join("\n") + "\n");
    const rejected = checkAdditionsOnly(gen, candidate).check;
    assert.equal(rejected.status, "failed", `${name} must still be rejected`);
    assert.ok(rejected.deletedLines > 0, `${name} must report the generated-line deletion`);
  }

  // Every Git failure must produce not-run, including a failure in the
  // full-context pass after a successful compact comparison.
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const mockBin = path.join(dir, "bin");
  mkdirSync(mockBin);
  const mockGit = path.join(mockBin, "git");
  const originalPath = process.env.PATH;
  const stub = (code: string) => writeFileSync(mockGit, `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
  const fakeDiff = "diff --git a/base b/candidate\n--- a/base\n+++ b/candidate\n@@ -1 +1 @@\n context\n";
  try {
    process.env.PATH = `${mockBin}${path.delimiter}${originalPath ?? ""}`;
    for (const [name, code] of [
      ["empty error output", 'process.stderr.write("fatal: config unavailable\\n"); process.exit(128);'],
      ["partial error output", `process.stdout.write(${JSON.stringify(fakeDiff)}); process.exit(128);`],
      ["exit 1 without diff", 'process.exit(1);'],
      ["exit 1 malformed stdout", 'process.stdout.write("not a diff\\n"); process.exit(1);'],
      ["exit 0 with unexpected output", 'process.stdout.write("comparison unavailable\\n"); process.exit(0);'],
      ["signal after partial output", `process.stdout.write(${JSON.stringify(fakeDiff)}); process.kill(process.pid, "SIGTERM");`],
      ["analysis pass error", `
        if (process.argv.includes("-U1000000")) {
          process.stderr.write("fatal: analysis comparison unavailable\\n"); process.exit(128);
        }
        const run = require("node:child_process").spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:"inherit"});
        process.exit(run.status ?? 128);
      `],
    ]) {
      stub(code);
      const result = checkAdditionsOnly(gen, candidate).check;
      assert.equal(result.status, "not-run", `${name} must fail closed`);
      assert.match(result.notRunReason ?? "", /could not run git diff/);
      if (name === "empty error output") assert.match(result.notRunReason ?? "", /config unavailable/);
    }
    stub('process.exit(128);');
    const badBase = path.join(dir, "precondition-base.dfy");
    const badProof = path.join(dir, "precondition-candidate.dfy");
    writeFileSync(badBase, "lemma Main(x: int)\n  ensures x >= 0\n{\n}\n");
    writeFileSync(badProof, "lemma Main(x: int)\n  requires x >= 0\n  ensures x >= 0\n{\n}\n");
    const result = await validate(badBase, badProof);
    assert.equal(result.verify.status, "passed", "The forbidden precondition is a real Dafny escape");
    assert.equal(result.additions.status, "not-run");
    assert.equal(result.passed, false, "Dafny success cannot override an unavailable comparison");

    process.env.PATH = path.join(dir, "nonexistent-bin");
    assert.equal(checkAdditionsOnly(gen, candidate).check.status, "not-run", "Missing Git must fail closed");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  assert.equal(gitDiff(gen, gen), "", "Identical files must still be accepted");
  const originalConfig = process.env.GIT_CONFIG_GLOBAL;
  try {
    const malformedConfig = path.join(dir, "bad.gitconfig");
    writeFileSync(malformedConfig, "[invalid config\n");
    process.env.GIT_CONFIG_GLOBAL = malformedConfig;
    assert.equal(gitDiff(gen, gen), "", "Comparison must not depend on the user's global Git configuration");
  } finally {
    if (originalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalConfig;
  }
  const supported = path.join(dir, "supported.dfy");
  const unsupported = path.join(dir, "unsupported.dfy");
  writeFileSync(supported, "lemma Main()\n{\n}\n");
  for (const [name, text, reason] of [
    ["split header", "lemma\nMain()\n{\n}\n", /unsupported declaration header/],
    ["inline contract braces", "function F(): bool ensures F() == (0 in {0})\n", /unsupported inline contract/],
    ["unclosed body", "lemma Main()\n{\n", /unterminated declaration/],
  ] as const) {
    writeFileSync(unsupported, text);
    for (const [base, proof] of [[unsupported, unsupported], [supported, unsupported]]) {
      const result = checkAdditionsOnly(base, proof).check;
      assert.equal(result.status, "not-run", `${name} must not skip declaration comparison`);
      assert.match(result.notRunReason ?? "", reason);
    }
  }
  console.log("Additions-only diff regression passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
