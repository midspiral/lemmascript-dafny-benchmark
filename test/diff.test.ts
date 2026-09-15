import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkAdditionsOnly, gitDiff } from "../src/validator.js";

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
  console.log("Additions-only diff regression passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
