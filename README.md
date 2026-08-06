# lemmascript-dafny-benchmark

A benchmark of Dafny proof-completion tasks, derived from the LemmaScript
case studies.

## The task

LemmaScript compiles annotated TypeScript to Dafny. That compilation
produces a `.dfy.gen` — the specifications and the skeleton, but not the
proofs — which a human then completes into a verifying `.dfy`.

Each benchmark task is one such completion. Given a `.dfy.gen`, produce a
`.dfy` that:

* **verifies**;
* is **line additions only** relative to the `.dfy.gen` — nothing
  removed, nothing edited;
* **adds no axioms**, whether through `{:axiom}`, `assume`, an
  unimplemented lemma, or any other route by which Dafny will accept a
  claim it hasn't proven;
* **leaves the generated contracts alone**. New helper lemmas may carry
  whatever `requires` they need, but a precondition may not be bolted onto a
  generated declaration. Adding `ensures` to one is fine — that is more to
  prove, not less.

The last two are what make the benchmark meaningful. A bodyless lemma
verifies vacuously, and `requires false` under every generated declaration
discharges every postcondition at once; without those constraints, a
one-line transformation solves every task.

## How tasks are made

Each case study repository carries a `LemmaScript-files.txt` listing the
TypeScript files it compiles. For each of those, LemmaScript emits a
`.dfy.gen`, and the repository also contains the completed `.dfy` beside
it. That pair — generated skeleton and human-written completion — is a
task and its reference solution.

A generator script walks the configured case study repositories, collects
every such pair, and emits:

* **`tasks/`** — one flat folder containing every admitted `.dfy.gen`,
  renamed to `NNNN.dfy` so they can be read and verified without ceremony,
  and copied byte for byte so the diff a candidate is judged on is clean.
  The numbering has gaps: IDs go to every pair the generator sees, not only
  the ones that became tasks.
* **`metadata.json`** — what benchmark number `0123.dfy` corresponds to:
  which repository, which path, which branch, and the Dafny options that
  task is verified with. Plus the size of the original `.dfy.gen`, the size
  of the solution, the difference between them, and the count of added
  non-blank non-comment lines, which is the better difficulty proxy.
* **`index.json`** — the key-to-number map, and the only stateful file here.
  Everything else can be regenerated from scratch.
* **`reference-report.json`** — whether each reference solution passes
  the benchmark's own constraints, and if not, why.

The generator is **reentrant**. Benchmark numbers are assigned once and
never reused, so a second run appends new entries after the existing ones
rather than renumbering, and a pair that disappears upstream is tombstoned
rather than dropped. Changing what an existing task *is* — refreshing a task
whose `.dfy.gen` moved, or deleting one that stopped being admitted — takes
an explicit `--update` or `--prune`.

## The reference report

Every constraint above is a claim about the case studies as much as about
candidate solutions: that the human-written `.dfy` files are themselves
additions-only, verify cleanly, and take nothing on trust that isn't
explicitly marked.

The generator checks this and reports it, rather than assuming it. Pairs
that fail are excluded from the benchmark and listed with their cause, so
the report serves both as a record of what the benchmark contains and as
a to-do list for the case studies. A reference solution that trips the
axiom check usually means an intentional axiom nobody marked as one.

## Validation

Two checks, run against the `.dfy.gen` and against Dafny — nothing else:

1. The diff against the `.dfy.gen` contains no deletions; no added line
   reaches for one of Dafny's trust escape hatches; and no added
   `requires` / `reads` / `modifies` attaches to a generated declaration. A
   line is scanned whole apart from a trailing `//` comment, and even that is
   only dropped when no `"` appears before it — so a banned word inside a
   string is still caught, while proof commentary is left alone.
2. `dafny verify` reports no errors, and none of the three warnings that
   indicate an unproven claim: a bodyless declaration, a bodyless `forall`,
   or a bodyless loop.

Contradictory-assumption warnings are counted but do not disqualify. They
fire on proof by contradiction, which is a technique rather than a cheat, and
the vacuous proof they were meant to catch is blocked by check 1 instead —
syntactically, and without the solver.

Each task carries the verification options its case study uses — a time
limit and any extra Dafny flags, taken from `LemmaScript-files.txt` — and
the validator applies them to reference and candidate alike. They change how
long Dafny looks, not what it will accept.

The escape hatches are enumerated as patterns, and each one has a
fixture: a small cheating `.dfy` that the test suite asserts is rejected.
Dafny spells several of these more than one way, so the list is kept
executable rather than documentary. Four fixtures run the other way and
assert that legitimate work passes: proof commentary containing the word
"assume", a proof by contradiction, a lemma whose `ensures false` is the
theorem, and a new helper carrying its own precondition.

The same code path validates candidate solutions and admits reference
solutions, so the two can't drift apart.

Of the 65 pairs in the case studies, one adds preconditions to a generated
declaration and is excluded for it — see DESIGN.md. That is the report
working as intended: it is an upstream to-do, not a benchmark defect.

## Running it

```sh
npm install
npm run generate             # the whole benchmark: tasks/, metadata.json, index.json, report
npm run reference-report     # just the report, leaving the benchmark alone
npm test                     # the fixture suite
```

Both clone any missing case study as a sibling; pass `--no-clone` to work with
what's already there and `--jobs=N` to change how many verifications run at
once. Keep `--jobs` low: the per-task time limits are wall-clock, so a loaded
machine can turn a passing proof into a reported timeout.

Checking a candidate against a task:

```sh
npm run check -- 42 my-attempt.dfy      # add --json for a machine-readable verdict
```

`generate` will not overwrite a task whose upstream `.dfy.gen` has moved, or
delete one that stopped being admitted, unless you ask — `--update` and
`--prune` respectively, and `--dry-run` to see what it would do. Only
`reference-report` takes `--only=<substring>`; a partial walk cannot produce a
coherent benchmark.

`--from-report` rebuilds `tasks/`, `metadata.json`, and `index.json` from the
report already on disk, in about a fifth of a second instead of ten minutes.
It re-hashes every `.dfy.gen` against the report first and refuses if any has
moved, so it can't emit tasks from a stale run.

See [DESIGN.md](DESIGN.md) for the reasoning, the exact token list, and
the loopholes each check closes.

## Repositories

Case study repositories are local clones, kept as siblings of this one:

```
lemmascript-dafny-benchmark/
some-case-study/
another-case-study/
```

The generator clones one if it's missing and otherwise leaves it alone.
Working trees are used as they are, dirty or not — the benchmark's output
is the reproducible artifact, so its input needn't be, and being able to
regenerate from an in-progress edit is useful.

Commits are recorded opportunistically but not relied upon. Explicit
commit pinning is more machinery than this needs right now.

## Status

The validator, the reference report, and the emitted benchmark are all in
place. Three pairs are excluded only because their proofs exceed the
wall-clock limit their case study sets for CI — an upstream fix, and the
reason IDs are issued to excluded pairs too, so those tasks keep their
numbers when it lands.

The open questions are recorded at the end of DESIGN.md. The substantive one
— whether adding preconditions to a generated declaration completes the proof
or changes the theorem — is now settled: weakening is banned, strengthening
is fine.