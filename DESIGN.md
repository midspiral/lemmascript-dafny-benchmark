# lemmascript-dafny-benchmark design

## Task

Given a `.dfy.gen`, produce a `.dfy` that:

1. is **line additions only** relative to the `.dfy.gen`, with none of
   the banned patterns in those additions, and no added precondition or
   frame clause on a generated declaration; and
2. verifies with zero errors and no disqualifying warning.

## Validator

Two checks, each returning `passed` / `failed` / `not-run`. Cheapest
first; a CLI can stop at the first failure, a corpus mode can run both.

**1. Additions-only.** `git diff` against the `.gen`. Reject any `-`
line. Reject any `+` line matching a banned pattern, and any `+` line that
weakens a generated declaration's contract (see *Frozen preconditions*
below).

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

Scan the added line minus a trailing `//` comment — but only strip that
tail when no `"` appears before it on the line. String literals are always
scanned; only a comment that provably *is* one is dropped.

The guard is what makes dropping the tail sound. The counterexample to
stripping blindly is

```dafny
var s := "x//"; assume false;
```

where the `//` opens no comment at all because it sits inside a string. The
leading `"` suppresses the strip, the whole line is scanned, and the
`assume` is caught. A `//` with no `"` anywhere before it cannot be inside a
string literal on that line, cannot be inside a character literal (`'//'` is
not a Dafny char), and cannot be inside a block comment carried over from an
earlier line, because `/*` is itself banned on added lines.

The corpus is why this is worth ten lines of code. Scanning whole lines
rejects exactly two reference solutions, both for English prose:

```
balanced-match  +// Extending hi to include exactly one new match at hi position `matchK` adds 1.
infisical       +// matches a concrete path. The runtime matcher is picomatch; we assume `glmatch`
```

Proof commentary is the thing a proof-completion benchmark should least
discourage. The residual cost is that a line mixing a string literal with a
comment gets its comment scanned too; that is the conservative direction,
and rare.

### Frozen signatures

Everything in this section is computed from the `.dfy.gen`, which is immutable.
That is the point. If the regions were derived from the candidate, the candidate
could move them — an unbalanced brace inside a comment, a string containing `{`,
a declaration inserted to shift a boundary. Anchoring on the generated file
removes the class rather than defending against each instance, and it costs
nothing: the diff already carries generated-file line numbers.

**Signature interval.** For each declaration in the `.dfy.gen`: from its
declaration keyword through the last line before its body opens, or through its
last specification line when it has no body.

**Trusted declaration.** One carrying `{:axiom}`, `@Axiom`, `{:extern}`,
`@Extern`, `{:verify false}` or `@Verify(false)`, or having no body. Dafny
*assumes* such a declaration's postconditions rather than proving them.

**Inert line.** After removing comments and string literals it contributes no
tokens, *and* it leaves the lexer clean. A `//` line is inert; `/* …` is not.

An added line inside a signature interval is accepted only if it is inert, or
all of:

- it **begins** with `ensures` or `decreases`;
- **every** specification keyword on it is `ensures` or `decreases`;
- it contains no wildcard `decreases`;
- and, if it contributes an `ensures`, the declaration is not trusted.

Each condition closes one thing, and none of them is about counting:

| condition | rejects |
|---|---|
| begins an allowed clause | `\|\| true`, `&& false` — a fragment that merges into the clause above it |
| every keyword allowed | `ensures true requires false` — a disallowed clause riding along on an allowed line |
| no wildcard | `decreases *`, which drops the termination obligation |
| `ensures` only on proved declarations | `ensures false` on `{:axiom} f(…)`, which is `assume false` by another route |

The number of clauses on a line is deliberately unconstrained. `ensures A
ensures B` is two lines written as one and both strengthen; what matters is the
kind of each clause, not how many there are.

**Why these two kinds.** A `decreases` clause is a termination measure and
cannot weaken a postcondition. An `ensures` on a *proved* declaration increases
what must be shown. On a trusted one it does the opposite, which is why the
distinction is load-bearing rather than decorative: an axiom's postcondition is
believed, so `ensures false` there hands the candidate `false` outright.

**Why the continuation attack matters.** Newlines are ordinary whitespace in
Dafny, so

```
 ensures P
+  || true
```

is `ensures P || true` — one added line, and the generated theorem becomes
trivial. Nothing in the diff looks unusual and Dafny emits no diagnostic at all.
A line-prefix rule is not enough either, because

```
+  ensures true requires false
```

begins with an allowed keyword and still smuggles a precondition onto the
generated declaration. Both are rejected above, for their own stated reasons.

**Corpus cost: zero.** Across all 33 reference solutions, 76 added lines land
inside a generated signature — 55 `decreases`, 12 `ensures`, 9 inert — and every
one is accepted. No added clause lands on a trusted declaration, so that
restriction is free too. Two task files carry a generated `{:axiom}`
*declaration* (`0034`, `0046`); three more contain `assume {:axiom}`
*statements* inside bodies (`0029`, `0031`, `0063`), which are a different
construct and not a signature at all.

Outside signature intervals, added `requires` / `reads` / `modifies` clauses are
still rejected when they attach to a generated declaration; see *Notes on the
token list*.

**2. Verifies clean.**

```sh
dafny verify --allow-warnings --warn-contradictory-assumptions --json-output \
  [--standard-libraries] [--verification-time-limit N] [task flags…] candidate.dfy
```

Zero errors, and no *disqualifying* warning. Five categories disqualify:

| warning | Dafny 4.11.0 message |
|---|---|
| bodyless declaration | `… is part of a bodyless method` |
| bodyless `forall` | `this forall statement has no body` |
| bodyless loop | `this loop has no body (loop frame: …)` |
| `{:verify false}` | `The {:verify false} attribute should only be used…` |
| vacuous theorem | `ensures clause proved using contradictory assumptions` |

The last two each earn their place for a specific reason. Dafny announces
`{:verify false}` itself, which is worth more than any token scan: the attribute
can be split across lines,

```
+lemma {:verify
+       false} Cheat()
```

so no line-wise denylist sees it, but the warning fires regardless of spelling.

The vacuous-theorem category carries one exception — see *Vacuous theorems, and
the one exception*.

Every other warning Dafny emits — deprecated syntax, unused variables — is
ignored. Run in a directory containing only the candidate.

`--json-output` makes this a parse rather than a scrape: one JSON object per
line, `severity` 1 for errors and 2 for warnings, the text in
`defaultFormatMessage`, related locations nested inside their diagnostic
instead of arriving as separate ones. Error count is therefore exact.
`errorId` is null for these categories, so they are matched on
message text — which is what makes the fixtures below load-bearing.

### The verify command is per task

The bracketed options above are not decoration. Three of them are the
difference between a hard task and an impossible one:

- **`--standard-libraries`.** Twelve reference solutions reference `Std.`,
  and without the flag they do not resolve. Sniffed from the *candidate's*
  text (`content.includes("Std.")`), exactly as LemmaScript does it in
  `tools/src/dafny-commands.ts`, because a candidate may reach for the
  standard library even when the `.gen` does not.
- **`--verification-time-limit`** and **extra flags**, from the case study's
  `LemmaScript-files.txt` entry, whose format is
  `filepath [timeout_in_seconds] [extra dafny flags…]`. In the current corpus
  that means `balanced-match: 500 --isolate-assertions`,
  `charmchat/workflow: 600 --isolate-assertions`,
  `equality-game: 60 --isolate-assertions`, and `collab-todo: 50`.

These belong in `metadata.json` per task, and the validator applies them
identically to a reference solution and to a candidate. They are not a
cheat surface: a time limit and an assertion-isolation strategy change how
long Dafny looks, not what it will believe.

A timeout is worth separating from a proof failure. Dafny reports a
per-procedure expiry as an error (`Verification of 'X' timed out after N
seconds`), but it means *ran out of clock*, and since the limit is
wall-clock it depends on machine load: running the reference report six-wide
on sixteen cores made `collab-todo` time out at its 50s limit, and the same
file verifies in about a minute on its own. The validator counts timeouts
separately, the report gives them their own cause, and the report should be
run at low concurrency.

The reproducible successor is `--resource-limit`, which Dafny documents as a
deterministic alternative to a time limit. Adopting it means re-deriving one
rlimit per task, which is a change to the case studies, not to the
benchmark — deferred, but this is where it goes.

That's the whole validator. No `dafny audit`, no baseline, no per-task
*derived* state — a candidate is checked against the `.gen`, against the
verify options its case study already uses, and against Dafny. Nothing is
computed from the reference solution and stored.

### What the warning check catches

Cheats that verification alone misses surface as warnings:

- **A newly added bodyless declaration.** Dafny warns that an `ensures`
  clause belongs to a bodyless declaration. Legitimate axioms in the `.gen`
  carry `{:axiom}`, which suppresses that warning — so the warning fires on
  exactly the unproven additions and not on the intentional axioms. That is
  why no baseline is needed: the distinction is already encoded in the
  source.
- **A bodyless `forall` or loop.** Dafny parses and verifies both as
  unchecked assumptions and only rejects them when compiling. Both warn.

Vacuous proofs used to be a third entry here. They are check 1's business
now — see *Frozen preconditions* and *Why the vacuous check is only
reported*.

`{:axiom}` is therefore a banned pattern. Dafny's own warning text
suggests adding it, so a candidate would otherwise be told exactly how to
silence the check. Existing `{:axiom}` attributes sit on unchanged lines
and are unaffected.

One correction to an earlier reading. LemmaScript emits proof obligations as
declarations with an *empty* body, not as bodyless ones — `lemma L(…)
ensures P { }`. So the unfilled `.gen` fails with errors, not warnings: the
`quota` skeleton produces 37 of them. The empty submission is defeated by
verification, and the bodyless warning guards a different door — a candidate
adding an unproven helper and calling it.

The heading is deliberately *what it catches*, not *why it suffices*. What
the warnings do not catch, the diff does.

### Why location is ignored

An earlier version of this design counted contradictory-assumption
warnings only on added lines, reasoning that one inherited from the
`.gen` isn't the candidate's doing. That was wrong: Dafny locates the
warning at the goal proved vacuously, not at the assumption that caused
it. An added `requires false` reports on the *unchanged* `ensures` line,
so the filter would have let it through.

The lesson outlived the check it was about. A warning's location is where the
obligation lives, not where the candidate wrote something — so the three
surviving categories disqualify regardless of location, and there is no
diagnostic-to-line mapping anywhere in the validator. Attribution is done on
the diff, where it is exact, rather than on diagnostics, where it is not.

The consequence for reference solutions is deliberate. One that trips a
category has a real defect — an intentional axiom nobody marked `{:axiom}`,
or an unfilled helper — and the fix is upstream. Exclude and log those rather
than accommodating them.

The reference report (see Generator) is what tests this. If many reference
solutions trip a category legitimately, the bar is wrong rather than the case
studies. That is exactly what happened to the fourth category; see below.

### Vacuous theorems, and the one exception

Dafny emits the contradictory-assumption warning in two shapes, and only the
first says the *theorem* was vacuous:

```
ensures clause proved using contradictory assumptions
proved using contradictory assumptions: <inner goal>
```

The second reports an obligation discharged inside a proof on an infeasible
path — an assertion, an index bound, a loop invariant, a termination check. That
is what proof by contradiction looks like from the verifier's side:

```dafny
if total > placed + n * G - 1 {
  assert total - placed >= n * G;      // ← "assertion always holds"
  ...
}
```

The branch is infeasible precisely because the lemma is true. Nine files in this
corpus contain one, so matching the second shape rejects a standard technique.
Only the first shape disqualifies.

**The exception.** A clause that is literally `ensures false` does not
disqualify. Such a lemma asserts that its own hypotheses are unsatisfiable, so
proving `false` from them *is* the theorem — the contrapositive idiom, which
hono-rate-limiter uses:

```dafny
lemma SlidingWindowBound(A: seq<int>, W: int, limit: int, s: int, p: int)
  requires Sorted(A) && Spread(A, W, limit)
  requires s < A[p] && A[p + limit] <= s + W
  ensures false
```

The exception is safe because a candidate cannot put `ensures false` on a
generated declaration: the signature rule rejects an added `ensures` on a
trusted one, and on a proved one the clause has to be discharged like any other.

**This category was briefly dropped, and that was wrong.** The argument for
dropping it was that the syntactic frozen-signature rule blocks the cheat it
existed for, so the semantic check was redundant and only contributed false
positives. Both halves were measured against reference solutions — which are
honest, so they reveal the false-positive rate and say nothing about the
false-negative rate. Three escapes were later found that it catches and nothing
else does: the multiline `{:verify false}`, `decreases *` on a nonterminating
loop, and `ensures false` on a generated `{:axiom}` declaration. Two of those now
have their own defence; the category stays as the third.

### On the warning mechanics

`--allow-warnings` keeps the command exiting successfully in the presence
of warnings, so a warning is reported as a warning rather than collapsing
into "didn't verify." `--json-output` supplies the diagnostics; see above.

What the check claims is *no warnings of these three kinds from the pinned
Dafny version*. Nothing stronger: warning-based checks are bounded by what
the pinned release chooses to report.

### Fixtures, not prose

A denylist written down is a denylist that rots. Dafny already has
multiple spellings for the same mechanism — `{:axiom}` and `@Axiom`,
`{:verify false}` and `@Verify(false)` — and a future release can add
more.

So `fixtures/` holds one small cheating `.dfy` per banned mechanism, and
the test suite asserts the validator rejects each. That makes the list
executable rather than documentary, and re-checks it on every Dafny bump.

The suite also asserts a *coverage* property: every pattern in the list, and
every frozen contract clause, has a fixture naming it. A ban with no fixture
fails the suite, so the list cannot grow past its own tests.

Four fixtures cover the frozen contracts outside signature intervals:
`requires`, `reads` and `modifies` bolted onto a generated declaration, plus
`cheat-weakened-precondition-reordered`, which pins attribution to the nearest
*preceding* declaration rather than to the enclosing run.

Five more cover the signature interval itself, and the suite asserts the
*reason* each is rejected, so a fixture cannot pass for the wrong cause:
`cheat-clause-continuation` (`|| true`), `cheat-clause-smuggle`
(`ensures true requires false`), `cheat-frame-smuggle`, `cheat-decreases-wildcard`,
and `cheat-ensures-on-trusted`. The last carries its own `.dfy.gen`, since the
trusted declaration has to be in the generated file for its signature to be a
generated one.

Two fixtures began as canaries for a known v0 gap rather than as banned
patterns: a **bodyless `forall`** and a **bodyless loop with invariants**.
Dafny parses and verifies both as unchecked assumptions and only rejects
them at compile time, so they might have slipped past the warning
categories. Against the pinned version they do not — both produce
identifiable warnings — so both are now disqualifying categories in their
own right, and the fixtures stopped being canaries and became tests.

Four more fixtures assert the opposite direction, that legitimate work is
*not* rejected:

- `ok-proof-comment` — proof commentary containing the English words
  "assume" and "include", which pins the quote-guarded comment strip;
- `ok-proof-by-contradiction` — a proof by contradiction, whose inner
  obligations Dafny reports as proved from contradictory assumptions;
- `ok-contrapositive-lemma` — a helper whose `ensures false` is the theorem,
  the shape that used to exclude hono-rate-limiter;
- `ok-new-helper-precondition` — a helper the candidate wrote, carrying its
  own `requires`, which pins the exception in the freeze;
- `ok-added-ensures`, `ok-added-decreases`, `ok-signature-comment` — the two
  clause kinds a candidate may add to a generated signature, and proof
  commentary beside them.

A validator with only negative fixtures drifts toward rejecting everything.
These four are the counterweight, and each encodes a decision the corpus
forced.

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

`(gen_path, candidate_path, verify_options) → passed | failed | not-run per
constraint`, plus the diff.

This is the only harness-adjacent thing worth fixing now: it's the
contract any future runner codes against. How the diff is computed —
`--no-index`, or seeding a throwaway git repo from the `.gen` and running
plain `git diff` — stays internal to the validator.

`verify_options` is the per-task time limit and flag list from
`metadata.json` (see *The verify command is per task*). It is an input
rather than derived state: the validator still stores nothing per task, and
the same options apply to a reference solution and to a candidate.

Implemented as `src/validator.ts`, and exposed to a runner as
`bin/check.ts`:

```ts
validate(genPath, candidatePath, { timeLimit, extraFlags })
  → { additions, verify, passed, diff }
```

```sh
check <task-id> <candidate.dfy> [--json] [--diff]
```

`check` resolves the task ID to `tasks/NNNN.dfy` and to the verify options
`metadata.json` records for it, so a candidate is held to exactly the budget
its reference solution was. Exit status is 0 only when both constraints
passed — a constraint that could not be run exits 1, since "we don't know" is
not a pass.

`additions` carries deleted-line count and samples, the banned matches
(pattern name, index into the added lines, the line), the weakened contracts
(clause, index, line), the signature violations (which generated declaration,
why, the line), added-line count, and added non-blank non-comment count. `verify` carries error count, of which timeouts, error samples,
disqualifying warnings by category, contradiction warnings, other warnings,
the argv used, and elapsed seconds. Both carry a `not-run` reason when they
could not run at all — no git, no `dafny`, a candidate that could not be
read, a Dafny run that produced no verification status.



## Layout

No `.dfy.gen` currently uses `include`, so tasks are self-contained and
the flat layout works:

```
tasks/0001.dfy        # the .dfy.gen, renamed for viewing
metadata.json
index.json
reference-report.json
```

The generator **enforces** this rather than assuming it: any `.gen`
containing `include` is skipped with a logged reason. Otherwise the first
case study to gain one silently emits an unsolvable task.

A task file is a **byte-for-byte** copy of its `.dfy.gen`. A candidate diffs
against it, so a header comment identifying the task would show up as a line
the candidate failed to add.

`tasks/` has **gaps**, by design. IDs are issued to every pair the generator
sees, not only the admitted ones — see *Reentrancy*.

## Generator

Node.js. Walks the repo list from metadata, reads each case study's
`LemmaScript-files.txt`, resolves `.ts` → `.dfy.gen` / `.dfy` pairs.

**Reentrancy.** `index.json` maps a stable key `repo + relpath` to a
monotonic ID. IDs are never reused or renumbered. Upstream deletions are
tombstoned, not removed.

IDs go to **every pair seen**, admitted or not. The alternative — numbering
only the admitted ones — makes a task's identity depend on where the
generator ran, which matters here because admission is not machine-independent:
wall-clock time limits mean a pair can time out on a loaded box and pass on an
idle one. Numbering everything costs only gaps in `tasks/`, and buys a number
that means the same thing everywhere.

New IDs are minted in key order, so a first run on a clean index is
reproducible.

Three flags guard the destructive parts. `--update` refreshes a task whose
upstream `.dfy.gen` has moved — that changes what the task *is*, so it does
not happen quietly. `--prune` deletes task files that are no longer admitted;
without it they are listed and left alone, so one flaky timeout cannot silently
drop a task from the benchmark. `--dry-run` reports and writes nothing.

`--only` is rejected outright: a partial walk would make every unvisited pair
look deleted. Use `bin/reference-report.ts` for that.

**Emission does not re-verify.** `--from-report` builds `tasks/`,
`metadata.json`, and `index.json` from an existing `reference-report.json`:
0.2 seconds against 10 minutes, and byte-identical output. This is not a
shortcut but the correct decomposition — everything emission needs is already
in the report (file facts, added-line counts, verify options, reference
timings, repo heads), plus each `.dfy.gen`'s path, which is `parentDir` +
repo + relpath. Nothing about changing the shape of a JSON file requires
asking Dafny 65 questions again.

What keeps it honest is the `sha256` the report records per file. Before
emitting, every `.dfy.gen` is re-hashed against it; a single mismatch means
the report describes a corpus that no longer exists, and the run aborts
rather than emit tasks nothing vouched for.

**Admission gate.** Each `(gen, solution)` pair is run through the
validator at generation time. Pairs that fail are excluded rather than
emitted, so every task is known-solvable under exactly the constraints
the harness enforces. Generator and validator share one code path.

Since the validator derives no per-task state, the gate is purely a
filter — the reference solution is needed to admit a task, never to check
a candidate.

**Reference report.** The gate's output is a deliverable, not a log:
`reference-report.json` plus a printed summary, produced by
`bin/reference-report.ts`. Per pair, the same tri-state result the validator
returns for any candidate, and for failures the specific cause:

- deleted lines (count)
- banned patterns matched (which pattern, which line)
- verification errors (count), of which timeouts
- disqualifying warnings, broken out by category

Aggregate: pairs seen, admitted, excluded by cause. A pair can trip more
than one cause, so the per-cause counts sum to at least the excluded count
rather than exactly to it.

**The skeleton has to fail.** A pair becomes a task only if the reference
passes both checks *and the `.dfy.gen` fails them*. Two sub-cases:

- **`no-additions`** — the solution is byte-identical to its `.gen`, so there
  was never anything to prove. A large share of the corpus: 26 of 65 pairs.
- **`already-verifies`** — the reference author wrote proof the solver did not
  need. Measured at 2 of the 35 pairs that otherwise qualified — leaving 33 —
  with 35 and 6 added code lines respectively.

Both are excluded under their own cause rather than shipped as freebies. The
second is the one that would otherwise corrupt the numbers: without it the
empty submission scores 2/35, and every reported success rate is inflated by
about six points. Only pairs that would otherwise be admitted pay for the extra
Dafny run.

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

That config is `config/repos.json`: the thirty matrix entries in CI order,
transcribed by hand, alongside the pinned Dafny version (`4.11.0`, from
`.github/actions/setup-dafny`) and the parent directory. Nothing reads the
workflow file.

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

If the CI matrix lists a repo more than once, the first entry wins. Rather
than leave that to the accident of the directory already existing, the
config is deduplicated explicitly and the dropped entries are carried into
the report under `branchesDeferred`, so a second branch is visibly deferred
rather than quietly gone. Three entries are affected today: `guardians` on
`generate-verify-execute`, and `henri` on `generate-verify-execute` and
`session`.

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
solution size, size diff, added-line count, sha256 of each file, and the
task's **verify options** — the `--verification-time-limit` and extra Dafny
flags from the case study's `LemmaScript-files.txt` entry. No derived
baseline — the validator needs none.

The verify options are the one piece of per-task state the design does
carry, and they have to be carried: without them `balanced-match`,
`charmchat/workflow`, and `equality-game` cannot be verified in reasonable
time at all, and the tasks would look impossible rather than hard. They are
transcribed from the case study, not invented here, and they do not affect
what Dafny will believe — only how long it looks and how it batches the
work. `--standard-libraries` is deliberately *not* stored: it is sniffed
from the candidate, since a candidate may reach for `Std.` when the `.gen`
does not.

Globally: the pinned Dafny version.

Size diff is the intended difficulty signal, but it is a crude proxy — a
three-line `assert` with a nonobvious witness outranks a sixty-line
mechanical induction. Added non-blank non-comment lines are better and
cheap.

## Open

- **Solution visibility.** Mostly settled by the facts: every reference
  solution already sits beside its `.dfy.gen` in a public case-study repo,
  so there is nothing to unpublish. The live question is only whether to
  *copy* them into this repo. The answer is no — the generator reads them
  from the sibling checkout, and a copy would add a drift surface for no
  gain.
- ~~**Are the original specs frozen?**~~ **Settled**: yes, in the direction
  that matters. `requires` / `reads` / `modifies` may not be added to a
  generated declaration; `ensures` may, because it strengthens. See *Frozen
  preconditions*. The corpus cost of the rule was measured at zero before it
  was adopted.

  The remaining sliver: **attributes** on generated declarations. A candidate
  cannot add `{:axiom}` or the other banned ones, but nothing stops
  `{:induction}`, `{:fuel}`, `{:opaque}` and friends. Those are proof hints
  rather than trust hatches, so allowing them looks right — but nobody has
  checked whether one of them can be turned into an escape.
- **Bodyless declarations with no `ensures`.** Confirmed: a bare `lemma
  L()` with no postcondition verifies silently, no warning. It is also
  vacuous in practice — such a lemma proves nothing, so leaving it unfilled
  gains a candidate nothing — so this stays a note rather than a hole.
- **Three confirmed escapes, left open by choice.** Executable statements added
  to a generated body (`return None;` and its family); continuations of a
  generated expression outside a declaration signature (a `|| true` under a
  generated predicate body makes every `ensures Safe(…)` trivial); and
  attributes split across lines, which the line-wise denylist cannot see.

  The first two need a parser-backed structural comparison — every node from the
  `.dfy.gen` preserved, and the executable projections equal after erasing proof
  material. Note that erasure alone is *not* sufficient: the predicate-body case
  mutates ghost content, which an executable projection discards. Both halves
  are required.

  The third could be closed by comparing the attributes in the candidate against
  those in the `.gen`, but six task files already contain a generated
  `{:axiom}`, so a name-based comparison is blind exactly where it matters; a
  counting version would work and has not been judged worth the machinery.

  These are documented in the README as limitations rather than defended
  against. See *What the validator does not catch*.
- **Reproducibility of the verify step.** Wall-clock time limits make the
  admission gate depend on the machine and on how many verifications run at
  once. Two pairs sit near their limit today (`collab-todo` at 50s,
  `eventab/allocate` at Dafny's default 30s), which means the corpus can
  change between runs. `--resource-limit` is the deterministic fix and needs
  one rlimit derived per task, upstream. Until then, run the report at low
  concurrency and read a `verification-timeout` cause as "re-run it", not as
  "the solution is broken".
- **Is a `no-additions` pair worth anything?** They are excluded as tasks,
  but they are a large fraction of the corpus, and they do say something: the
  generated skeleton verified on the first try. Whether that is a fact about
  LemmaScript worth publishing alongside the benchmark, or just noise, is a
  question for whoever writes the results up.