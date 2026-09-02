#!/usr/bin/env -S npx tsx
/** Focused fixtures for semantic-context selection and minimality. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTaskScaffold } from "../src/context.js";
import { checkAdditionsOnly } from "../src/validator.js";

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

function pair(gen: string, solution: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "lsdb-context-fixture-"));
  const genPath = path.join(dir, "fixture.dfy.gen");
  const solutionPath = path.join(dir, "fixture.dfy");
  writeFileSync(genPath, gen.trimStart());
  writeFileSync(solutionPath, solution.trimStart());
  return {
    dir,
    genPath,
    result: buildTaskScaffold(genPath, solutionPath, { expectedVersion: "4.11.0" }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(name: string, gen: string, solution: string, inspect: (result: ReturnType<typeof buildTaskScaffold>) => string | undefined) {
  const { result, cleanup } = pair(gen, solution);
  try {
    const problem = inspect(result);
    check(name, problem === undefined, problem ?? "");
  } finally {
    cleanup();
  }
}

const directGen = `
// Generated fixture

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`;

const directSolution = `
// Generated fixture

// @benchmark-context begin Model
predicate Model(x: int)
{
  x >= 0
}
// @benchmark-context end Model

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`;

run(
  "direct predicate",
  directGen,
  directSolution,
  result =>
    result.context.status !== "passed"
      ? `expected passed, got ${result.context.status}: ${result.context.diagnostics}`
      : result.context.declarations.map(d => d.name).join(",") !== "Model"
        ? `selected ${result.context.declarations.map(d => d.name)}`
        : undefined,
);

{
  const fixture = pair(directGen, directSolution);
  try {
    const taskPath = path.join(fixture.dir, "task.dfy.gen");
    writeFileSync(taskPath, fixture.result.taskText);
    const additions = checkAdditionsOnly(taskPath, fixture.genPath).check;
    check(
      "selected context is immutable",
      additions.status === "failed" && additions.deletedLines > 0,
      `expected deletion failure, got ${additions.status} with ${additions.deletedLines} deletions`,
    );
  } finally {
    fixture.cleanup();
  }
}

run(
  "transitive closure",
  directGen.replaceAll("Model", "Root"),
  `
// Generated fixture

// @benchmark-context begin Leaf
predicate Leaf(x: int)
{
  x >= 0
}
// @benchmark-context end Leaf

// @benchmark-context begin Mid
predicate Mid(x: int)
{
  Leaf(x)
}
// @benchmark-context end Mid

// @benchmark-context begin Root
predicate Root(x: int)
{
  Mid(x)
}
// @benchmark-context end Root

method Decide(x: int) returns (res: bool)
  ensures res == Root(x)
{
  return x >= 0;
}
`,
  result => {
    if (result.context.status !== "passed") return `expected passed: ${result.context.diagnostics}`;
    const rounds = result.context.resolutionRounds.map(r => r.join(",")).join(" -> ");
    return rounds !== "Root -> Mid -> Leaf" ? `unexpected rounds ${rounds}` : undefined;
  },
);

run(
  "unused definition rejected",
  directGen,
  `
// Generated fixture

// @benchmark-context begin Model
predicate Model(x: int) { x >= 0 }
// @benchmark-context end Model

// @benchmark-context begin Spare
predicate Spare(x: int) { x == 0 }
// @benchmark-context end Spare

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  result =>
    result.context.causes.includes("unused-context")
      ? undefined
      : `expected unused-context, got ${result.context.causes}`,
);

run(
  "helper lemma rejected",
  directGen,
  `
// Generated fixture

// @benchmark-context begin Model
lemma Model(x: int)
{
}
// @benchmark-context end Model

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  result =>
    result.context.causes.includes("invalid-context")
      ? undefined
      : `expected invalid-context, got ${result.context.causes}`,
);

run(
  "exported proof fact rejected",
  directGen,
  `
// Generated fixture

// @benchmark-context begin Model
function Model(x: int): bool
  ensures Model(x) == (x >= 0)
{
  x >= 0
}
// @benchmark-context end Model

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  result =>
    result.context.causes.includes("invalid-context")
      ? undefined
      : `expected invalid-context, got ${result.context.causes}`,
);

run(
  "bodyless abstraction accepted",
  directGen.replaceAll("Model", "AbstractModel"),
  `
// Generated fixture

// @benchmark-context begin AbstractModel
ghost predicate AbstractModel(x: int)
// @benchmark-context end AbstractModel

method Decide(x: int) returns (res: bool)
  ensures res == AbstractModel(x)
{
  return x >= 0;
}
`,
  result => {
    const declaration = result.context.declarations[0];
    return result.context.status !== "passed" || !declaration?.abstract
      ? `expected an accepted abstract declaration: ${result.context.status} ${result.context.diagnostics}`
      : undefined;
  },
);

run(
  "missing marker rejected",
  directGen,
  directGen,
  result =>
    result.context.causes.includes("unresolved-context-name")
      ? undefined
      : `expected unresolved-context-name, got ${result.context.causes}`,
);

run(
  "unbalanced marker rejected",
  directGen,
  `
// Generated fixture

// @benchmark-context begin Model
predicate Model(x: int) { x >= 0 }

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  result =>
    result.context.causes.includes("invalid-context")
      ? undefined
      : `expected invalid-context, got ${result.context.causes}`,
);

run(
  "mismatched marker rejected",
  directGen,
  `
// Generated fixture

// @benchmark-context begin Model
predicate Model(x: int) { x >= 0 }
// @benchmark-context end Other

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  result =>
    result.context.causes.includes("invalid-context")
      ? undefined
      : `expected invalid-context, got ${result.context.causes}`,
);

run(
  "generated lines cannot be marked",
  `
// Generated fixture

predicate Model(x: int) { x >= 0 }

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  `
// Generated fixture

// @benchmark-context begin Model
predicate Model(x: int) { x >= 0 }
// @benchmark-context end Model

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  result =>
    result.context.causes.includes("invalid-context")
      ? undefined
      : `expected invalid-context, got ${result.context.causes}`,
);

run(
  "reference proof lemma stays out",
  directGen,
  `
// Generated fixture

// @benchmark-context begin Model
predicate Model(x: int)
{
  x >= 0
}
// @benchmark-context end Model

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
+  Helper(x);
  return x >= 0;
}

lemma Helper(x: int)
  ensures x >= 0 || x < 0
{
}
`.replace("+  Helper", "  Helper"),
  result =>
    result.context.status !== "passed"
      ? `expected passed: ${result.context.diagnostics}`
      : result.taskText.includes("Helper")
        ? "task scaffold included a reference-only helper lemma or call"
        : undefined,
);

console.log(failures === 0 ? "\nall context fixtures behaved" : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
