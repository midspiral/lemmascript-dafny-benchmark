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

## Attempting a task

```sh
npm run make-attempt -- 5
```

That builds a self-contained directory for task 5:

```
attempts/0005/
  PROMPT.md         the task, the rules, and how to check
  solution.dfy      the working copy — starts as an exact copy of the task
  package.json      marks the directory as ESM so the checker runs standalone
  .bench/
    task.dfy.gen    pristine copy, what the diff is taken against
    check.ts        the validator, with this task's Dafny budget inlined
    validator.ts
    banned.ts
```

The prompt comes from [`PROMPT.md`](PROMPT.md) at the root of this repo — edit
the wording there and every future attempt directory picks it up; only the
per-task facts (budget, extra flags) are substituted in. A placeholder the
script doesn't recognise is an error rather than a literal `{{FOO}}` shipped to
the attempter, so the template and the script can't drift apart.

Move it anywhere, point a session or a person at `PROMPT.md`, and iterate:

```sh
npx tsx .bench/check.ts     # both constraints; exit 0 only when both pass
```

It needs **Dafny 4.11.0** ([install](https://github.com/dafny-lang/dafny/releases/tag/v4.11.0)),
`git`, and `node` with `tsx` on `PATH`. Nothing else — the validator has no npm
dependencies. The version matters: the warning categories are matched on Dafny's
message text, so a different release can change what the validator accepts.

**The directory deliberately has no path back to this repo.** That is not
tidiness. `metadata.json` names the upstream repository and relpath of every
task, and the reference solutions live in sibling checkouts, so anything that
can reach the benchmark can read the answer. The attempt directory carries a
copy of the validator instead, and neither `metadata.json` nor the rest of
`tasks/` goes with it.

To score a candidate you already have, from inside this repo:

```sh
npm run check -- 5 my-attempt.dfy       # add --json for a machine-readable verdict
```

To pick one, `npm run list-tasks` prints the corpus banded by how much proof the
reference solution needed — 1 to 575 lines, median 54:

```
small (1–10 proof lines) — 6 tasks
medium (11–50)           — 9 tasks
large (51–150)           — 11 tasks
very large (151+)        — 7 tasks
```

Added non-blank non-comment lines is a crude signal — a three-line `assert` with
a nonobvious witness outranks a sixty-line mechanical induction — but it is the
best one available short of solving the tasks. `--markdown` emits the full table.

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

[UPSTREAM.md](UPSTREAM.md) is that to-do list, written out: which case studies
state a contract in Dafny that belongs in their TypeScript, which verification
budgets are too tight, and what each one costs the benchmark.

## Validation

Two checks, run against the `.dfy.gen` and against Dafny — nothing else:

1. The diff against the `.dfy.gen` contains no deletions, no added line reaches
   for one of Dafny's trust escape hatches, and the specifications the
   generated file already states are left alone. Inside a generated
   declaration's signature a candidate may add only a complete `ensures` or
   `decreases` clause — and an `ensures` only where the declaration is actually
   proved, never on an axiom, whose postconditions Dafny assumes. That is what
   stops a lone `|| true` on its own line from turning a generated
   postcondition into a tautology, since Dafny treats newlines as whitespace.
2. `dafny verify` reports no errors, and none of the warnings that indicate an
   unproven claim: a bodyless declaration, `forall` or loop, a `{:verify false}`
   attribute, or a theorem proved from contradictory assumptions.

The last has one exception: a lemma whose postcondition is literally
`ensures false` asserts that its own hypotheses are unsatisfiable, so proving
`false` from them *is* the theorem. Warnings about obligations discharged
*inside* a proof are ignored entirely — that is what proof by contradiction
looks like to the verifier, and nine files in the corpus rely on it.

All regions are computed from the `.dfy.gen`, never from the candidate, so no
addition can move the boundary it is judged against.

Each task carries the verification options its case study uses — a time
limit and any extra Dafny flags, taken from `LemmaScript-files.txt` — and
the validator applies them to reference and candidate alike. They change how
long Dafny looks, not what it will accept.

The escape hatches are enumerated as patterns, and each one has a
fixture: a small cheating `.dfy` that the test suite asserts is rejected.
Dafny spells several of these more than one way, so the list is kept
executable rather than documentary, and each fixture asserts the *reason* it is
rejected rather than merely that it fails. Seven fixtures run the other way and
assert that legitimate work passes: proof commentary containing the word
"assume", a proof by contradiction, a lemma whose `ensures false` is the
theorem, a new helper carrying its own precondition, and the clauses and
comments a candidate may add to a generated signature.

The same code path validates candidate solutions and admits reference
solutions, so the two can't drift apart.

Of the 65 pairs in the case studies, one adds preconditions to a generated
declaration and is excluded for it — see DESIGN.md. That is the report
working as intended: it is an upstream to-do, not a benchmark defect.

## What the validator does not catch

Additions-only is a **transparency property, not a soundness boundary**. It makes
every submission auditable — the diff is the whole story — and the checks reject
the cheats a model is likely to reach for. It does not make gaming impossible,
and it cannot: "this candidate only added proof" is a property of the *parsed*
program, and the validator checks text.

Three known escapes, each reproduced against Dafny 4.11.0 on a real task:

**Executable statements added to a generated body.** A candidate may insert
statements into a method the generator wrote:

```diff
 method decodeAndValidatePath(rawPath: string) returns (res: Option<string>)
   ensures (match res { case Some(v) => … case None => true })
 {
+  return None;
   var filename: string := *;
```

The method now always returns `None`, the specification's `None` branch is
trivially true, and it verifies. Nothing was deleted, no banned token appears,
and Dafny emits no diagnostic at all. It needs a specification with a trivially
satisfiable branch — six of the 33 tasks have one — but the general form is
unrestricted: an early return, an assignment, a conditional, a loop, a call.

**Continuations of a generated expression outside a declaration signature.**
Dafny treats newlines as whitespace, so an added line can extend an expression
the generator wrote:

```diff
 predicate Safe(x: int)
 {
   x > 0
+  || true
 }
```

Every `ensures Safe(…)` in the file is now trivial. Inside a declaration's
signature this is rejected; inside a predicate body, an assertion, or a
quantifier it is not. Loop invariants happen to resist it — weakening one makes
it useless at loop exit, so the proof fails anyway — but that is luck, not a
defence.

**Attributes split across lines.** The banned-pattern scan is line-wise, so

```dafny
lemma {:
  axiom
} Oracle()
  ensures …
```

spells `{:axiom}` without any line containing it. Comparing the attributes in
the candidate against those in the `.dfy.gen` would close it, except that six
task files already contain a generated `{:axiom}`, so a name-based comparison is
blind exactly where it matters. A counting version would work and has not been
judged worth the machinery.

Closing the first two properly means a parser-backed structural comparison:
every node originating in the `.dfy.gen` preserved unchanged, and the executable
projections of the two programs equal after erasing proof material. That is real
work maintained against Dafny's internals, and it is not currently planned.

Two consequences for anyone using this benchmark. **Publish the diff alongside
any result** — it is already computed, and `|| true` is obvious to a human
reading it. And treat published tasks as a development set: the reference
solutions live in public repositories that `metadata.json` names, so headline
comparisons want a private task set.

## Regenerating the benchmark

```sh
npm install
npm run generate             # the whole benchmark: tasks/, metadata.json, index.json, report
npm run reference-report     # just the report, leaving the benchmark alone
npm test                     # the fixture suite (needs Dafny)
npm run check-artifacts      # tasks/, metadata.json and index.json agree (no Dafny)
```

Both clone any missing case study as a sibling; pass `--no-clone` to work with
what's already there and `--jobs=N` to change how many verifications run at
once. Keep `--jobs` low: the per-task time limits are wall-clock, so a loaded
machine can turn a passing proof into a reported timeout.

`generate` will not overwrite a task whose upstream `.dfy.gen` has moved, or
delete one that stopped being admitted, unless you ask — `--update` and
`--prune` respectively, and `--dry-run` to see what it would do. Only
`reference-report` takes `--only=<substring>`; a partial walk cannot produce a
coherent benchmark.

`--from-report` rebuilds `tasks/`, `metadata.json`, and `index.json` from the
report already on disk, in about a fifth of a second instead of ten minutes.
It re-hashes every `.dfy.gen` against the report first and refuses if any has
moved, so it can't emit tasks from a stale run.

`check-artifacts` is the cheap guard: it asserts that `tasks/`, `metadata.json`
and `index.json` are three consistent views of one thing, and that every task
file still hashes to what metadata records — a stray edit there would silently
change every verdict for that task. It needs no Dafny and no case studies, so
CI runs it on every push, while a full regeneration runs weekly and on demand.

See [DESIGN.md](DESIGN.md) for the reasoning, the exact token list, and
the loopholes each check closes.

## Licensing

This repository is MIT — see [LICENSE](LICENSE). That covers the validator, the
generator, the fixtures, and the metadata.

It does **not** cover `tasks/`. Each task file is a Dafny skeleton compiled from
TypeScript in another repository and is a derived work of it, governed by that
repository's licence. [`tasks/ATTRIBUTION.md`](tasks/ATTRIBUTION.md) is generated
alongside the tasks and maps every one of them to its upstream and licence.

Every repository that contributes a task is MIT. A case study whose licence
cannot ship under MIT is excluded in `config/repos.json` rather than quietly
dropped — one is today: rallly is AGPL-3.0, so its pair is validated and
reported like any other but never becomes a task.

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
place: **35 tasks** from 65 pairs across 27 case studies.

Two caveats a reader should have up front. Three pairs are excluded only
because their proofs exceed the wall-clock limit their case study sets for CI,
which is an upstream fix — and the reason IDs are issued to excluded pairs too,
so those tasks keep their numbers when it lands. And because those limits are
wall-clock, **which pairs are admitted depends on the machine**: a loaded box
turns a passing proof into a reported timeout. One task today verifies with a
one-second margin. Read a `verification-timeout` cause as "re-run it", not as
"the solution is broken".

The open questions are recorded at the end of DESIGN.md. The substantive one
— whether adding preconditions to a generated declaration completes the proof
or changes the theorem — is now settled: weakening is banned, strengthening
is fine.