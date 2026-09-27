# AGENTS.md

Guidance for AI coding agents working on this repository. The reasoning lives in
[DESIGN.md](DESIGN.md), validator behavior in
[DESIGN_VALIDATOR.md](DESIGN_VALIDATOR.md), semantic-context construction in
[DESIGN_CONTEXT.md](DESIGN_CONTEXT.md), the usage in [README.md](README.md), the
case-study to-do list in [UPSTREAM.md](UPSTREAM.md), and what CI checks in
[CI.md](CI.md).
This file collects what is easy to get wrong if you only read those — mostly
things that were got wrong once already.

## Orientation

A benchmark of Dafny proof-completion tasks. A task is an immutable scaffold:
the `.dfy.gen` that LemmaScript compiled from TypeScript plus, where needed,
the minimum resolver-demanded semantic definitions from the completed `.dfy`.
Solving it means adding proof lines until it verifies, without weakening what
it claims.

Four emitted artifacts, all derived except one:

| file | |
|---|---|
| `tasks/NNNN.dfy` | emitted immutable scaffold |
| `metadata.json` | one entry per task |
| `reference-report.json` | every pair, admitted or not, with its cause |
| `index.json` | **the only stateful file** — key → benchmark number |

`index.json` is append-only. A number, once issued, is never reused: published
results refer to task numbers, so renumbering silently changes what they mean.
Entries are tombstoned, never deleted.

Case studies are siblings (`../<repo>`), used as-is, dirty or not.

## Commands

```sh
npm run generate               # full pass: ~10 minutes
npm run generate -- --from-report   # rebuild artifacts from the last report: ~0.2s
npm run reference-report       # the report only
npm run check-artifacts        # artifacts agree, no Dafny needed
npm test                       # the fixture suite (needs Dafny 4.11.0)
npm run list-tasks             # the corpus, banded by difficulty
npm run check -- <id> <file>   # score a candidate
npm run make-attempt -- <id>   # build an isolated attempt directory
```

**Use `--from-report` for anything that does not need re-verification.** Two
files (charmchat, balanced-match) are 83% of the full pass, and both run to
their limit and then time out. The full pass exists to re-verify; changing the
shape of a JSON file does not need it.

Keep `--jobs` at 3 or lower. The per-task time limits are wall-clock, so a
loaded machine turns passing proofs into reported timeouts — one task passes
with a one-second margin.

Never hand-edit `tasks/`, `metadata.json`, `reference-report.json`, or
`index.json`. `check-artifacts` will catch you, but regenerate instead.

## Traps

**Do not hand-roll a Dafny scanner.** Every throwaway line/brace/keyword scanner
written during this repo's development had a bug in it, and two produced
confident wrong measurements that were nearly acted on. If you need to classify
source positions, use `src/signature.ts`, which is tested. If you need something
it does not do, extend it and add a fixture rather than writing a script.

**`git diff` truncates context.** Anything positional — locating an added line
relative to the generated file, tracking brace depth — must use `-U1000000`.
With default context, unchanged regions are absent, depth counters drift
negative, and the classification silently inverts.

**Dafny rejects filenames that do not end in `.dfy`.** The admission gate
verifies `.dfy.gen` files, so `checkVerifies` stages them under a `.dfy` name.
Without that the run returns `not-run` and, if a check treats that as "fine",
fails open. It did once.

**Attempt directories carry *copies* of the validator.** `bin/make-attempt.ts`
lists the source files to copy. Adding a module to the validator's import graph
without adding it there breaks every attempt directory, and the fixture suite
will not notice — it runs against the repo's own sources. CI has a smoke test
for this; keep it.

**Clause permissions and trust come from the immutable scaffold.** Candidate
declarations establish correspondence only: each original signature and body
must remain within its matching declaration. An added helper cannot capture
an original contract or body. Preserve the ownership attack fixtures whenever
changing this comparison.

**A new check that cannot run must fail closed.** Prefer a recorded cause over
silently admitting. `task-not-checked` exists because the first version of that
rule admitted on a check that never executed.

**Semantic context is not proof convenience.** `config/context.json` may name
one or more complete top-level functions or predicates from a completed
`.dfy`. Each declaration must occupy only lines added relative to `.dfy.gen`,
and Dafny resolution starting at the raw generated file must request its name.
Every configured declaration not reached by that transitive walk rejects the
pair as `unused-context`. Never configure a lemma, a lemma call inserted into a
method, an invariant, or a definition used only by reference-proof additions.
Those are exactly the choices a candidate is meant to reinvent. Keep the
upstream `.dfy` self-contained and free of benchmark-specific annotations.

The projection keeps each configured declaration at its position in the
completed file. That position must remain top-level after all other proof
additions are removed. If `context-not-resolved` reports a parse error, move
the definition to a projection-safe ordinary top-level position in the
completed `.dfy`; do not import the surrounding proof braces to make it parse.

## Changing a validator rule

The rules encode decisions, and each decision was measured. Follow the same
path, in this order:

1. **Reproduce the attack against real Dafny** before believing it exists. Of
   the escapes proposed during review, roughly half did not reproduce as
   described — `{:axiom}` does not skip verification of a *bodied* declaration,
   and weakening a loop invariant is self-defeating. Grammar reasoning is not
   evidence.
2. **Measure the corpus cost before adopting.** Run the candidate rule over all
   reference solutions and count what it would reject. The frozen-signature rule
   was adopted because it rejects 0 of 76; the "no comments in signatures"
   variant was not, because it costs a task.
3. **Add a fixture that asserts the *reason*,** not merely that the candidate
   fails. A fixture passing for the wrong cause is worse than no fixture. The
   suite also asserts coverage: every banned pattern and every frozen clause
   needs one.
4. **Add an acceptance fixture too.** A validator tested only against attacks
   drifts toward rejecting everything. Seven fixtures exist to pin legitimate
   work that earlier rules wrongly rejected.

A caution learned the hard way: **reference solutions are honest, so they
measure only the false-positive rate.** A rule validated solely against them
tells you nothing about what it lets through. One check was dropped on that
evidence and had to be restored when three escapes turned out to need it.

## What is deliberately open

Three confirmed escapes are documented rather than defended against — executable
statements added to a generated body, `|| true` continuing a generated predicate
body, and attributes split across lines. See *What the validator does not catch*
in the README. Do not close them piecemeal; they need a parser-backed structural
comparison, and partial fixes add machinery without changing the guarantee.

Additions-only is a transparency property, not a soundness boundary. Keep that
distinction in anything you write about the benchmark.
