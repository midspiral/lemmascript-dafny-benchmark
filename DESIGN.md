# lemmascript-dafny-benchmark design

## Task

Given a `.dfy.gen`, produce a `.dfy` that:

1. is **line additions only** relative to the `.dfy.gen`, with none of
   the banned patterns in those additions; and
2. verifies with zero errors and no disqualifying warning.

## Validator

Two checks, each returning `passed` / `failed` / `not-run`. Cheapest
first; a CLI can stop at the first failure, a corpus mode can run both.

**1. Additions-only.** `git diff` against the `.gen`. Reject any `-`
line. Reject any `+` line matching a banned pattern:

```ts
const bannedPatterns = [
  /\bassume\b/,
  /\bexpect\b/,
  /\binclude\b/,

  /\/\*/,
  /\*\//,
  /@"/,

  /\{\s*:axiom\b/,
  /\{\s*:extern\b/,
  /\{\s*:verify\s+false\b/,
  /\{\s*:only\b/,
  /\{\s*:selective_checking\b/,
  /\{\s*:assumption\b/,
  /\{\s*:assume_concurrent\b/,
  /\{\s*:contradiction\b/,
  /\{\s*:options\b/,

  /@Axiom\b/,
  /@Verify\s*\(\s*false\s*\)/,
  /@VerifyOnly\b/,
  /@Options\s*\(/
];
```

Scan the **complete** added line — comments and string literals included.
Banned text anywhere on the line is rejected conservatively. Stripping
`//` tails to spare proof comments is not worth it and is unsound anyway:
`var s := "x//"; assume false;` truncates to nothing after the string
opener.

**2. Verifies clean.**

```sh
dafny verify --allow-warnings --warn-contradictory-assumptions candidate.dfy
```

Zero errors, and no *disqualifying* warning. Two categories disqualify,
both regardless of location:

| warning | disqualifies |
|---|---|
| bodyless declaration | always |
| contradictory assumptions | always |

Every other warning Dafny emits — deprecated syntax, unused variables —
is ignored. Run in a directory containing only the candidate.

That's the whole validator. No `dafny audit`, no baseline, no per-task
derived state — a candidate is checked against the `.gen` and against
Dafny, and nothing else.

### What the warning check catches

Two cheats that verification alone misses surface as warnings:

- **An unfilled stub.** Dafny warns that an `ensures` clause belongs to a
  bodyless declaration. Legitimate axioms in the `.gen` carry `{:axiom}`,
  which suppresses that warning — so the warning fires on exactly the
  stubs and not on the intentional axioms. That is why no baseline is
  needed: the distinction is already encoded in the source.
- **A vacuous proof.** `requires false` on a lemma nothing calls verifies
  trivially; `--warn-contradictory-assumptions` reports it.

`{:axiom}` is therefore a banned pattern. Dafny's own warning text
suggests adding it, so a candidate would otherwise be told exactly how to
silence the check. Existing `{:axiom}` attributes sit on unchanged lines
and are unaffected.

The heading is deliberately *what it catches*, not *why it suffices*.
Contract strengthening (see Open) is outside the mechanism, and so are
bodyless statements until the fixtures below say otherwise.

### Why location is ignored

An earlier version of this design counted contradictory-assumption
warnings only on added lines, reasoning that one inherited from the
`.gen` isn't the candidate's doing. That was wrong: Dafny locates the
warning at the goal proved vacuously, not at the assumption that caused
it. An added `requires false` reports on the *unchanged* `ensures` line,
so the filter would have let it through.

Both categories therefore disqualify regardless of location, which is
also simpler — no diagnostic-to-line mapping at all.

The consequence for reference solutions is deliberate. One that trips
either category has a real defect — an intentional axiom nobody marked
`{:axiom}`, or a genuinely vacuous proof — and the fix is upstream.
Exclude and log those rather than accommodating them.

The reference report (see Generator) is what tests this. If many
reference solutions trip either category legitimately, the bar is wrong
rather than the case studies.

### On the warning mechanics

`--allow-warnings` keeps the command exiting successfully in the presence
of warnings, so a warning is reported as a warning rather than collapsing
into "didn't verify." Parse the diagnostics; JSON output is available if
the text form proves awkward.

The contradictory-assumption check is heuristic: proof-dependency
analysis uses solver-provided unsat cores, which aren't guaranteed
minimal, and some contradiction-based proofs go unwarned. State it as
*no warnings from the pinned Dafny version*, not *no vacuous proofs*.

### Fixtures, not prose

A denylist written down is a denylist that rots. Dafny already has
multiple spellings for the same mechanism — `{:axiom}` and `@Axiom`,
`{:verify false}` and `@Verify(false)` — and a future release can add
more.

So `fixtures/` holds one small cheating `.dfy` per banned mechanism, and
the test suite asserts the validator rejects each. That makes the list
executable rather than documentary, and re-checks it on every Dafny bump.

Two fixtures cover the known v0 gap rather than a banned pattern: a
**bodyless `forall`** and a **bodyless loop with invariants**. Dafny
parses and verifies both as unchecked assumptions and only rejects them
at compile time, so they may slip past the two warning categories. Run
them against the pinned version:

- if they produce identifiable warnings, add those warnings as
  disqualifying;
- if they pass silently, add a narrow textual check or document them as a
  known v0 limitation.

That is the right use of a canary — two concrete constructs, not a
revived assumption-analysis subsystem.

### Notes on the token list

The comment loophole is the motivating case: a candidate can neutralize
an existing `ensures` purely by addition.

```
+/*
   ensures P(x)
+*/
```

`@"` is the same trick via verbatim strings, which span newlines. Line
comments need no ban — `//` only affects the line it sits on, so using
one requires an edit, which shows up as a deletion.

`{:selective_checking}` deserves its own mention: Dafny documents it as
turning assertions into assumptions outside selected regions, so it
defeats check 2 wholesale rather than at one site.

The rest close procedural holes. An added `include` is the worst: Dafny
doesn't verify included files without `--verify-included-files`, so a
candidate could pull in trusted declarations that never get checked.
`expect P` before `assert P` discharges the assertion on the strength of
a runtime check that a verify-only benchmark never runs.
`{:contradiction}` and the options attributes suppress or reconfigure
check 2.

`assume`, `{:assumption}`, `{:extern}`, `{:verify false}`, `{:only}`, and
`{:assume_concurrent}` are Dafny's ordinary soundness escape hatches —
none produces a warning, so the diff is the only thing standing between
them and a passing candidate. `{:extern}` matters even though these case
studies are verify-only: postconditions on an extern declaration are
trusted rather than proven, and a candidate could declare an extern
helper with exactly the postcondition it needs.

The precise alternative is stripping comments and strings before
diffing, so neutralized code appears as a deletion. Needs a Dafny lexer;
only worth it if the bans prove too blunt.

### The `.gen` never has to resolve

The `.gen` is only ever read as text — the diff and the `include` scan
are both string-level. Nothing resolves, audits, or verifies it.

This matters, because at least one `.gen` genuinely does not resolve: the
pure/impure connection case. Those tasks are valid and among the most
interesting, since the model must repair resolution *and* prove. So the
admission gate must **not** acquire a "`.gen` must resolve" sanity check,
which would silently drop exactly these.

## Validator interface

`(task_id, candidate_path) → passed | failed | not-run per constraint`,
plus the diff.

This is the only harness-adjacent thing worth fixing now: it's the
contract any future runner codes against. How the diff is computed —
`--no-index`, or seeding a throwaway git repo from the `.gen` and running
plain `git diff` — stays internal to the validator.



## Layout

No `.dfy.gen` currently uses `include`, so tasks are self-contained and
the flat layout works:

```
tasks/0001.dfy        # the .dfy.gen, renamed for viewing
metadata.json
index.json
```

The generator **enforces** this rather than assuming it: any `.gen`
containing `include` is skipped with a logged reason. Otherwise the first
case study to gain one silently emits an unsolvable task.

## Generator

Node.js. Walks the repo list from metadata, reads each case study's
`LemmaScript-files.txt`, resolves `.ts` → `.dfy.gen` / `.dfy` pairs.

**Reentrancy.** `index.json` maps a stable key `repo + relpath` to a
monotonic ID. IDs are never reused or renumbered. Upstream deletions are
tombstoned, not removed. `--update` refreshes existing entries.

**Admission gate.** Each `(gen, solution)` pair is run through the
validator at generation time. Pairs that fail are excluded rather than
emitted, so every task is known-solvable under exactly the constraints
the harness enforces. Generator and validator share one code path.

Since the validator derives no per-task state, the gate is purely a
filter — the reference solution is needed to admit a task, never to check
a candidate.

**Reference report.** The gate's output is a deliverable, not a log:
`reference-report.json` plus a printed summary. Per pair, the same
tri-state result the validator returns for any candidate, and for
failures the specific cause:

- deleted lines (count)
- banned patterns matched (which pattern, which line)
- verification errors (count)
- disqualifying warnings, broken out by category

Aggregate: pairs seen, admitted, excluded by cause.

This is how the design gets falsified. Every ban and every disqualifying
warning category is a guess that the reference solutions clear it. If a
third of them trip the bodyless warning, or several legitimately use
`assume` in a proof, the bar is wrong rather than the case studies —
and the breakdown by cause is what distinguishes those two readings.

Excluded pairs stay listed with their cause rather than vanishing, so the
report doubles as an upstream to-do list for the case studies.

**Drift detection.** Store `sha256` of both the `.gen` and the solution.

## Repos

### Seeding the list

The initial `(repo, branch)` list comes from the LemmaScript CI Dafny
matrix. Extract it **once** into a checked-in config rather than parsing
the workflow at generation time — coupling the generator to the CI file's
schema means a CI refactor silently changes the benchmark. A
`bin/seed-from-ci.js` that emits the config, run by hand, keeps the
result diffable and reviewable.

### Checkouts

Case study repos are **siblings** of the benchmark repo — `../<repo>`
from the `lemmascript-dafny-benchmark` directory — matching the existing
flat layout where everything lives next to everything else.

The generator clones a repo if missing and otherwise leaves it alone
unless `--fetch` is passed. Full clone, not `--depth 1`.

Note that this means the generator writes *outside* its own repo, so the
parent path should be a config value defaulting to `..` rather than
hardcoded. The upside of the layout: checkouts can't be accidentally
committed into the benchmark repo, so no `.gitignore` juggling.

If the CI matrix lists a repo more than once, the first entry wins. This
needs no special handling — the first entry clones the directory, and
later ones find it already present and leave it alone.

Working-tree state is used as-is, dirty or not. This is deliberate: the
generator's *output* is the reproducible artifact, so its input does not
need to be, and regenerating from an in-progress edit of a case study is
a feature.

Explicit commit tracking is skipped as overkill; the generator
opportunistically records `git rev-parse HEAD` and the branch, since it
costs nothing.

## Deferred

Dropped for now as answers to questions the first run will settle better
than guessing:

- **Multiple branches per repo.** One branch each. If it turns out a
  case study is meaningfully different on another branch, revisit —
  that would mean the key gains `branch`, plus dedup on `sha256(gen)`
  for `.gen`s identical across branches, plus a rule for when two
  branches disagree on the solution.
- **Occurrence lists**, for the same reason.
- **`bin/seed-from-ci.js`.** Paste the list once instead.
- **Harness design**, including what a run costs and how attempts are
  scored. Out of scope for the four deliverables.

## Metadata

Per entry: benchmark ID, source repo + branch + relpath, `.dfy.gen` size,
solution size, size diff, added-line count, sha256 of each file. No
derived baseline — the validator needs none.

Globally: the pinned Dafny version.

Size diff is the intended difficulty signal, but it is a crude proxy — a
three-line `assert` with a nonobvious witness outranks a sixty-line
mechanical induction. Added non-blank non-comment lines are better and
cheap.

## Open

- **Solution visibility.** Solutions are not needed by the validator,
  only by the generation-time admission gate, so keeping them in a
  private sibling repo is nearly free. Decide before the first commit —
  moving them later does not unpublish them.
- **Are the original specs frozen?** A candidate can add `requires P(x)`
  to a generated declaration that already has `ensures P(x)`. That is a
  pure addition, produces no warning, and is not a contradictory
  specification — the proof genuinely uses the new precondition. The
  candidate has changed the theorem rather than proved it. Partial
  natural defense: a lemma with real callers breaks them. Lemmas nothing
  calls are unprotected.

  If contract strengthening is acceptable, say so in the README and the
  design is coherent as written. If not, the validator needs to freeze
  original `requires` / `ensures` / `reads` / `modifies` / attributes. A
  cheap approximation needs no parser: allow those clauses on added lines
  only inside a contiguous run of added lines that also contains a
  declaration keyword — i.e. on genuinely new helpers. Computable from
  diff hunks alone.
- **Bodyless declarations with no `ensures`.** The stub warning attaches
  to the `ensures` clause, so a bodyless declaration specified only by
  `requires` would not warn. Probably vacuous in practice — such a lemma
  proves nothing, so leaving it unfilled gains a candidate nothing — but
  worth confirming none exist in the corpus.