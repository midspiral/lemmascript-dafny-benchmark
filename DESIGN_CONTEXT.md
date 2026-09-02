# Semantic context in benchmark tasks

Status: implemented in September 2026. The implementation lives in
`src/context.ts`; focused boundary fixtures live in `test/context.test.ts`.

## Problem

The benchmark previously treated a LemmaScript pair as:

```text
task       = foo.dfy.gen
reference  = foo.dfy
proof      = reference - task
```

That is correct only when every addition in `foo.dfy` is proof. Several case
studies also add definitions that give meaning to names already used by the
generated program. Those additions are semantic context, not proof.

Equality-game is the clearest example. The generated postconditions say:

```dafny
ensures res ==> ExpressionsAgree(L, R)
ensures ExpressionsAgree(L, R) ==> res
```

but `ExpressionsAgree` is defined only in the completed `equality.dfy`. The
raw task therefore does not resolve, and a candidate is asked to supply the
meaning of the central property before proving it. That is not a well-posed
proof-completion task.

The same pattern is broader than Dafny-only ghost predicates. In opt-in
Lemmascript files, a verified TypeScript function can refer to an ordinary
same-file helper that is omitted from the derived model. The completed `.dfy`
then adds the helper and, sometimes, helpers used by that helper. All of those
definitions are context.

An audit of the pre-context 33-task corpus found 10 whose `.dfy.gen` has
unresolved identifiers. Five of those tasks become already verified after the
missing semantic definitions are supplied. They are model-completion examples,
not proof-completion examples, and should not be benchmark tasks.

## Goal

Construct each task from the generated file plus the *minimum semantic context*
needed to make the generated program meaningful, while leaving every proof
choice to the candidate.

The new relation is:

```text
G = generated skeleton       foo.dfy.gen
C = selected context         additions taken from foo.dfy
T = task scaffold            G plus C, in reference-file order
R = reference solution       foo.dfy
P = reference proof          R minus T

G <= T <= R                  line-subsequence relation
```

Candidates are validated against `T`, not against `G`. Context in `T` is
immutable in exactly the same way generated text is immutable.

The design must satisfy both sides of the boundary:

1. **Completeness:** every declaration needed to resolve the generated program
   is present in the task.
2. **Minimality:** no declaration is included merely because the reference proof
   uses it or because it might help a candidate.

## Non-goals

This phase does not:

- change the TypeScript or LemmaScript extraction rules;
- infer a stronger contract than the generated file states;
- include the reference author's helper lemmas, invariants, assertions, proof
  calculations, or proof-specific abbreviations;
- make every task verify without additions;
- translate omitted TypeScript automatically;
- infer semantic intent from names or comments.

The completed `.dfy` is the self-contained source for both context and proof.
The only new job is to distinguish the small part that must be in the question
from the larger part that constitutes the answer.

## The inclusion rule

A declaration belongs to context only if its name is demanded by Dafny name or
type resolution starting from the generated file.

Selection is demand-driven:

1. Resolve `G`.
2. For each unresolved name that is listed for this pair in
   `config/context.json`, extract and add that declaration from `R`.
3. Resolve again. Definitions just added may expose further unresolved names.
4. Repeat until resolution succeeds or no configured declaration supplies a
   requested name.
5. Reject the pair if any configured declaration was never requested.

This computes a semantic dependency closure rooted in generated text. It does
not compute a closure over the reference proof.

This boundary is strict. Suppose the reference adds both a call inside a
generated method and the lemma it calls:

```diff
 method f(...) {
+  PreserveInvariant(...);
   ...
 }

+lemma PreserveInvariant(...)
+  ensures ...
+{
+  ...
+}
```

Neither addition is context. The call is absent from `G`, so resolving `G` or a
partially enriched `T` never requests `PreserveInvariant`. The call and the
lemma remain in `P`, and a candidate may invent that lemma, choose a different
one, or avoid the proof pattern entirely. The context walk never resolves `R`
and then imports whatever declarations its added method bodies happen to use.

If `G` itself somehow calls a missing lemma, the first version fails closed:
lemmas are not eligible context declarations. It does not promote the reference
lemma into the task.

The final rejection in step 5 is the over-inclusion guard. A disconnected pair
of definitions that refer only to one another, or a useful helper the proof
happens to call, is never requested while resolving `G` and is therefore not
context.

The Dafny version is already pinned by the benchmark, so its resolver is the
authority. The benchmark must not approximate this rule with a lexical scan of
capitalized words or a hand-written free-variable analysis.

### Eligible declarations

For the first version, context is deliberately narrow. Each configured name
must identify exactly one complete top-level declaration of one of these
forms:

- `function` or `ghost function`;
- `predicate` or `ghost predicate`.

The block includes the declaration's domain and definition: type parameters,
parameters, result type, `requires`, `reads`, `decreases`, and body. These are
needed to preserve the actual meaning and well-foundedness of the definition.

A bodyless function or predicate is allowed. Some case studies intentionally
model an operation as an uninterpreted abstraction, such as URL decoding. Such
a declaration is part of the trusted model and belongs in the immutable task,
not among candidate additions. Metadata should record that the context
declaration is abstract.

The first version rejects configured declarations containing `ensures`. An
`ensures` clause exports a proved fact to callers and can give away part of the
proof. If a future case requires one, that should be justified and measured as
an extension of this design rather than silently accepted.

The first version also rejects configured `lemma`, `method`, `datatype`, `type`,
`newtype`, and `const` declarations. The present corpus does not need them for
this repair. Failing closed leaves room to add a declaration kind later with a
real example and fixtures.

### Never context

The following remain proof additions even when the reference uses them heavily:

- lemmas and theorem-like methods;
- loop invariants;
- assertions, calculations, reveals, and lemma calls;
- proof-only ghost variables and statements;
- clauses added to generated declarations;
- definitions referenced only by other proof additions;
- convenient abbreviations that are not needed to resolve generated text.

In equality-game, `ExpressionsAgree` is context because the generated
postcondition names it. `Pow2Pos`, `ReachableExists`, `LeavesNonEmpty`,
`WitnessCombine`, and the other proof machinery are not context merely because
the reference proof uses them. A candidate remains free to rediscover those
helpers, replace them, or prove the result another way.

## Declaring context in the benchmark manifest

Context selection is explicit, but the classification belongs to the
benchmark rather than to the case-study source. `config/context.json` maps a
stable pair key to declaration names:

```json
{
  "key": "midspiral/equality-game-lemmascript:src/equality.ts",
  "declarations": ["ExpressionsAgree"]
}
```

The completed `.dfy` stays ordinary, self-contained Dafny. It contains no
benchmark annotations or delimiters. For each configured name, the builder
uses the existing scanner in `src/signature.ts` to locate the exact complete
top-level declaration. The name must have exactly one top-level match, and
every line in its span must be an addition relative to `.dfy.gen`. Leading
attributes must be on the declaration line so the extracted boundary is
unambiguous.

One name per declaration makes selection, diagnostics, and minimality
auditable without placing benchmark metadata in upstream code. Unconfigured
additions are proof. There is no automatic fallback that hoists a declaration
merely because it would be useful. A missing, ambiguous, or ineligible manifest
entry makes the pair fail corpus construction with a recorded cause.

The manifest is an allowlist, not an instruction to include everything listed.
Dafny must demand every entry from the generated program's resolution closure;
otherwise the pair fails as `unused-context`. This prevents a benchmark editor
from quietly adding reference-proof conveniences to the question.

## Building the task scaffold

The builder receives `G` and `R` and performs these steps:

1. Run the existing full-context additions-only diff from `G` to `R`. Any
   deletion still disqualifies the pair.
2. Load the names for this pair from `config/context.json`, locate their exact
   top-level declarations in `R`, and validate each declaration.
3. Starting from `G`, run the demand-driven resolution process above to select
   configured declarations.
4. Project `R` onto all unchanged generated lines plus all lines in selected
   declarations. This projection is `T` and preserves reference-file order.
5. Assert mechanically that `G <= T <= R`.
6. Run Dafny resolution on `T`. An unresolved identifier, type error, parse
   error, or unused manifest entry is a context-construction failure.
7. Validate `R` as additions-only against `T`, using the normal benchmark
   validator.
8. Check whether `T` already verifies. If it does, exclude the pair as
   `already-verifies-after-context`.

Projection rather than concatenation matters. The reference remains an
additions-only completion of the emitted task, so the same validator can score
the reference and candidates. Dafny permits forward references, but preserving
the author's order avoids needless drift and keeps diffs intelligible.

An additions-only proof can insert braces that make a later declaration
top-level in `R` even though the corresponding generated closing brace occurs
after it. Removing those proof additions then nests the declaration in `T`.
The resolver deliberately rejects that projection; the declaration must be
moved to a projection-safe top-level position in the completed `.dfy`. Importing
the surrounding proof braces would violate minimality.

The context phase is intended for generated files that parse far enough for
Dafny to report resolution errors. If a generated file contains an intentional
syntactic expression hole, resolution cannot serve as the dependency oracle.
Such a pair does not get a heuristic exception; it remains on the old path or
is excluded until a parser-backed extension is designed.

## Context safety checks

Context is trusted input to the task, so it needs a narrower policy than proof
additions rather than no policy at all.

Each selected declaration must pass all of these checks:

- its declaration name was requested during the iterative resolution process;
- its kind is eligible;
- it contains no `ensures`;
- it contains no lemma, method, nested top-level declaration, or proof
  statement;
- it contains none of the benchmark's explicit trust attributes or commands,
  including `assume`, `expect`, `{:axiom}`, `{:verify false}`, or an include;
- its complete text already occurs as additions in the verifying reference;
- removing all context and restoring `G` reproduces the original generated
  file byte-for-byte.

Bodyless functions and predicates are the one intentional form of abstraction.
They are allowed only as a whole configured declaration with no
postconditions, and are reported explicitly in metadata. Bodyless lemmas and
methods remain forbidden.

All source-region classification must use the existing scanner in
`src/signature.ts`, extended with fixtures if necessary. This phase must not
introduce a second Dafny brace or comment scanner.

Once emitted, context is part of the candidate baseline. Signature freezing and
all other candidate checks derive their regions from `T`, so a candidate cannot
delete it, redefine it, add a precondition to it, or weaken it.

## Reporting and metadata

The report distinguishes four artifacts:

```text
gen       original .dfy.gen facts
context   selected declaration names, lines, hash, and abstract/concrete status
task      composed scaffold facts
solution  completed .dfy facts
```

Difficulty is measured from `T` to `R`, not from `G` to `R`. Context lines are
not proof lines. `sizeDiffBytes`, `addedLines`, and `addedCodeLines` should all
describe the remaining reference proof.

Useful context-specific causes include:

- `unresolved-context-name` — resolution requests a name with no configured
  declaration;
- `unused-context` — a configured declaration is not in the demanded closure;
- `invalid-context` — a configured name is missing or ambiguous, or its
  declaration contains generated lines, an ineligible kind, proof, contract
  fact, or trust material;
- `context-not-checked` — Dafny resolution or context construction could not
  run, and the pair therefore fails closed;
- `context-not-resolved` — the composed scaffold still does not resolve;
- `already-verifies-after-context` — context was the entire completion.

`reference-report.json` must record enough facts to reconstruct `T`
deterministically. `--from-report` must validate both the generated-file hash
and the solution-file hash before rebuilding: context now comes from the
solution as well as the generated file. The composed task hash is recorded and
checked like today's generated hash.

## Worked examples

### Equality-game

Resolving `equality.dfy.gen` requests `ExpressionsAgree`. The configured
`ExpressionsAgree` predicate is added. It refers only to declarations already
present in the generated file, so the closure is complete.

No equality-game lemma is selected. In particular, the following remain for a
candidate to invent or avoid:

```text
Pow2Pos
ReachableExists
LeavesNonEmpty
SplitPartitions
WitnessCombine
CompletenessFromMaskCoverage
...
```

The enriched task resolves but does not verify, so it remains a benchmark task
with essentially the same mathematical challenge and a properly fixed meaning.

### Henri permissions

The generated file requests `isAllowed`, `pathGranted`, `resolvePath`, and
`isWithin`. Adding their configured definitions exposes dependencies such as
`normalize`, `normalizeFrom`, `isPrefix`, and `seqEq`, which are selected in
turn. The closure contains only the omitted program model.

The standalone escape-witness and monotonicity lemmas at the end of the
reference are never requested by resolution and remain proof additions.

With the semantic closure present, the generated obligations already verify.
The pair is therefore excluded as `already-verifies-after-context`: those
standalone extra theorems are real work, but the generated task does not ask for
them.

### Hono path abstractions

The generated files request bodyless ghost abstractions such as `Decoded`,
`HasPathTraversal`, and `ContainsParentDir`. Their configured declarations are
selected and reported as abstract context. The enriched files then already
verify, so these pairs also cease to be benchmark tasks.

## Migration

Completed for the September 2026 regeneration:

1. Add context-phase fixtures before touching corpus artifacts.
2. Add the minimal declaration names to `config/context.json`, leaving the
   case-study `.dfy` files free of benchmark annotations.
3. Generate a context audit for all pairs and review every selected name.
4. Re-run the full reference report with low concurrency.
5. Refresh changed tasks explicitly and prune tasks that become already
   verified. Their index entries remain reserved; IDs are never reused.
6. Update `README.md`, `DESIGN.md`, `AGENTS.md`, `CI.md`, artifact checks, and
   attempt-generation wording to refer to a task scaffold rather than a
   byte-identical `.dfy.gen`.

Changing an existing task's scaffold changes the exact benchmark instance.
Stable IDs continue to identify the upstream `repo:relpath`, while the task hash
identifies the precise instance used by a run. Results across the migration
must therefore report task hashes and should not be compared as if the inputs
were byte-identical.

## Boundary fixtures

The focused suite pins the behavior that defines the boundary:

- one directly requested predicate;
- a two- or three-step transitive definition closure;
- an unused configured definition rejected as over-inclusion;
- a configured helper lemma rejected;
- a configured definition with `ensures` rejected;
- an allowed bodyless predicate recorded as abstract;
- a configured name with no matching top-level declaration;
- an ambiguous configured name rejected;
- generated lines rejected when configuration attempts to capture them;
- deletion of selected context rejected by the normal additions-only check;
- a reference-only lemma call and its helper both left outside the scaffold.

Every rejection fixture must assert its specific cause. Acceptance fixtures
must demonstrate both direct and transitive context without including a proof
helper. The existing additions-only fixtures separately establish that a
candidate cannot alter any line of the emitted scaffold, including context.
The artifact and `--from-report` checks cover task hashes and stale source
rejection at the pipeline level.

## Decision summary

The benchmark question is not the raw generated file when that file omits the
meaning of names it already uses. It is the generated file plus the minimum
semantic closure demanded by resolution.

That closure is explicit, declaration-sized, and rooted only in generated text.
Everything else in the completed `.dfy` remains the answer. In particular,
helper lemmas are never promoted merely because the reference author found them
useful; reinventing them is exactly what the benchmark is meant to measure.
