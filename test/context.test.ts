#!/usr/bin/env -S npx tsx
/** Focused fixtures for benchmark-local semantic-context selection. */

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

function pair(gen: string, solution: string, declarations: string[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "lsdb-context-fixture-"));
  const genPath = path.join(dir, "fixture.dfy.gen");
  const solutionPath = path.join(dir, "fixture.dfy");
  writeFileSync(genPath, gen.trimStart());
  writeFileSync(solutionPath, solution.trimStart());
  return {
    dir,
    genPath,
    result: buildTaskScaffold(genPath, solutionPath, {
      expectedVersion: "4.11.0",
      declarations,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(
  name: string,
  gen: string,
  solution: string,
  declarations: string[],
  inspect: (result: ReturnType<typeof buildTaskScaffold>) => string | undefined,
) {
  const { result, cleanup } = pair(gen, solution, declarations);
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

predicate Model(x: int)
{
  x >= 0
}

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`;

run("direct predicate", directGen, directSolution, ["Model"], result =>
  result.context.status !== "passed"
    ? `expected passed, got ${result.context.status}: ${result.context.diagnostics}`
    : result.context.declarations.map(d => d.name).join(",") !== "Model"
      ? `selected ${result.context.declarations.map(d => d.name)}`
      : result.taskText.includes("@benchmark-context")
        ? "task scaffold contains a benchmark marker"
        : undefined,
);

{
  const fixture = pair(directGen, directSolution, ["Model"]);
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

predicate Leaf(x: int)
{
  x >= 0
}

predicate Mid(x: int)
{
  Leaf(x)
}

predicate Root(x: int)
{
  Mid(x)
}

method Decide(x: int) returns (res: bool)
  ensures res == Root(x)
{
  return x >= 0;
}
`,
  ["Leaf", "Mid", "Root"],
  result => {
    if (result.context.status !== "passed") return `expected passed: ${result.context.diagnostics}`;
    const rounds = result.context.resolutionRounds.map(round => round.join(",")).join(" -> ");
    return rounds !== "Root -> Mid -> Leaf" ? `unexpected rounds ${rounds}` : undefined;
  },
);

run(
  "unused definition rejected",
  directGen,
  `
// Generated fixture

predicate Model(x: int) { x >= 0 }

predicate Spare(x: int) { x == 0 }

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  ["Model", "Spare"],
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

lemma Model(x: int)
{
}

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  ["Model"],
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

function Model(x: int): bool
  ensures Model(x) == (x >= 0)
{
  x >= 0
}

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  ["Model"],
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

ghost predicate AbstractModel(x: int)

method Decide(x: int) returns (res: bool)
  ensures res == AbstractModel(x)
{
  return x >= 0;
}
`,
  ["AbstractModel"],
  result => {
    const declaration = result.context.declarations[0];
    return result.context.status !== "passed" || !declaration?.abstract
      ? `expected an accepted abstract declaration: ${result.context.status} ${result.context.diagnostics}`
      : undefined;
  },
);

run(
  "blank before body stays concrete",
  directGen,
  `
// Generated fixture

predicate Model(x: int)

{
  x >= 0
}

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  ["Model"],
  result => {
    const declaration = result.context.declarations[0];
    return result.context.status !== "passed" || declaration?.abstract
      ? `expected concrete context, got ${result.context.status}: ${result.context.diagnostics}`
      : result.taskText.includes("x >= 0")
        ? undefined
        : "concrete predicate body was omitted";
  },
);

run("missing manifest entry rejected", directGen, directGen, [], result =>
  result.context.causes.includes("unresolved-context-name")
    ? undefined
    : `expected unresolved-context-name, got ${result.context.causes}`,
);

run("unknown configured name rejected", directGen, directSolution, ["Missing"], result =>
  result.context.causes.includes("invalid-context")
    ? undefined
    : `expected invalid-context, got ${result.context.causes}`,
);

run(
  "ambiguous configured name rejected",
  directGen,
  `
// Generated fixture

predicate Model(x: int) { x >= 0 }
predicate Model(x: int) { x < 0 }

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`,
  ["Model"],
  result =>
    result.context.causes.includes("invalid-context")
      ? undefined
      : `expected invalid-context, got ${result.context.causes}`,
);

const generatedModel = `
// Generated fixture

predicate Model(x: int) { x >= 0 }

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  return x >= 0;
}
`;

run("generated declaration cannot be configured", generatedModel, generatedModel, ["Model"], result =>
  result.context.causes.includes("invalid-context")
    ? undefined
    : `expected invalid-context, got ${result.context.causes}`,
);

run(
  "reference proof lemma stays out",
  directGen,
  `
// Generated fixture

predicate Model(x: int)
{
  x >= 0
}

method Decide(x: int) returns (res: bool)
  ensures res == Model(x)
{
  Helper(x);
  return x >= 0;
}

lemma Helper(x: int)
  ensures x >= 0 || x < 0
{
}
`,
  ["Model"],
  result =>
    result.context.status !== "passed"
      ? `expected passed: ${result.context.diagnostics}`
      : result.taskText.includes("Helper")
        ? "task scaffold included a reference-only helper lemma or call"
        : undefined,
);

console.log(failures === 0 ? "\nall context fixtures behaved" : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
