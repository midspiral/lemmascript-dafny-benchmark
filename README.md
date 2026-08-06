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
  claim it hasn't proven.

The third constraint is what makes the benchmark meaningful. A bodyless
lemma verifies vacuously, so without it the empty submission passes.

## How tasks are made

Each case study repository carries a `LemmaScript-files.txt` listing the
TypeScript files it compiles. For each of those, LemmaScript emits a
`.dfy.gen`, and the repository also contains the completed `.dfy` beside
it. That pair — generated skeleton and human-written completion — is a
task and its reference solution.

A generator script walks the configured case study repositories, collects
every such pair, and emits:

* **`tasks/`** — one flat folder containing every `.dfy.gen`, renamed to
  `NNNN.dfy` so they can be read and verified without ceremony.
* **`metadata.json`** — what benchmark number `123.dfy` corresponds to:
  which repository, which path, which branch. Plus the size of the
  original `.dfy.gen`, the size of the solution, and the difference
  between them, which serves as a first-order difficulty ranking.
* **`reference-report.json`** — whether each reference solution passes
  the benchmark's own constraints, and if not, why.

The generator is **reentrant**. Benchmark numbers are assigned once and
never reused, so a second run appends new entries after the existing ones
rather than renumbering. An `--update` mode refreshes entries whose
source has changed.

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

Two checks, run against the `.dfy.gen` and against Dafny — nothing else,
and no per-task stored state:

1. The diff against the `.dfy.gen` contains no deletions, and no added
   line reaches for one of Dafny's trust escape hatches. Added lines are
   scanned whole, so a banned word in a comment is rejected too.
2. `dafny verify` reports no errors, and none of the warnings that
   indicate an unproven claim — a bodyless declaration, or a proof that
   succeeded by contradiction rather than by argument.

The escape hatches are enumerated as patterns, and each one has a
fixture: a small cheating `.dfy` that the test suite asserts is rejected.
Dafny spells several of these more than one way, so the list is kept
executable rather than documentary.

The same code path validates candidate solutions and admits reference
solutions, so the two can't drift apart.

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

Early. The generator, the validator, and the emitted benchmark all live
here. The open questions are recorded at the end of DESIGN.md; the
substantive one is whether adding preconditions to a generated
declaration counts as completing the proof or as changing the theorem.