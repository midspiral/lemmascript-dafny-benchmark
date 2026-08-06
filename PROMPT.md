<!-- TEMPLATE
This file is the prompt handed to whoever attempts a task. `bin/make-attempt.ts`
copies it into the attempt directory, substituting the placeholders below and
stripping this comment. Edit the wording here — nothing in the script needs to
change.

Placeholders:
  {{TASK_ID}}      the benchmark number, e.g. 0005
  {{BUDGET}}       prose form of the verification budget
  {{FLAGS}}        extra Dafny flags, or "none"
  {{DAFNY_FLAGS}}  the same flags spliced into a command line, or empty

An unrecognised {{...}} is an error rather than a silent literal, so the
template and the script cannot drift apart.
-->
# Dafny proof completion

`solution.dfy` is a Dafny file with its proofs missing. Some of its lemmas have
empty bodies, and its methods lack the invariants and assertions their
postconditions need. As given, it does not verify.

Your job is to make it verify, by **adding lines only**.

## Rules

1. **Additions only.** Every line already in `solution.dfy` must still be there,
   byte for byte, in the same order. Add lines between them; change nothing.
   Reformatting, rewrapping, or "cleaning up" an existing line counts as
   removing it. Neither is commenting one out — a `/* ... */` that swallows an
   existing line is a deletion by another name, and block comments are rejected
   for that reason.

2. **Prove it, don't assume it.** No `assume`, no `{:axiom}` (or `@Axiom`), no
   `{:verify false}`, no `{:extern}`, no `expect`, no `include`, no
   `{:selective_checking}` — nothing that makes Dafny accept a claim it has not
   checked. A lemma you add with no body is the same thing, and so is a bodyless
   `forall` statement or loop.

3. **Don't change the theorem.** You may not add `requires`, `reads`, or
   `modifies` to a declaration that is already in the file: narrowing what a
   lemma claims is not proving it. Helper lemmas *you* write may have whatever
   preconditions they need. Adding `ensures` to an existing declaration is fine
   — that is more to prove, not less.

4. **Proof only.** What you add must be proof: ghost declarations, proof
   statements, proof annotations, and the specifications rule 3 allows. It must
   not add executable behaviour, and it must not change the meaning of syntax
   that is already there. Concretely, do not add returns, assignments,
   executable calls, or control flow; do not attach attributes or modifiers to a
   declaration already in the file; and do not add tokens that continue or wrap
   an expression already present — a lone `|| true` on its own line attaches to
   the clause above it, and that is a change to the task, not a proof of it.

Otherwise the toolbox is open: helper lemmas, ghost functions and predicates,
loop invariants, `decreases` clauses, `assert`s, `calc` blocks, and proofs by
induction or contradiction.

## Checking your work

```sh
npx tsx .bench/check.ts
```

It exits 0 only when every automated check passes. For faster iteration you can
call Dafny directly, though this is *not* the authoritative command — it omits
the warning checks the benchmark applies:

```sh
dafny verify --allow-warnings --warn-contradictory-assumptions {{DAFNY_FLAGS}}solution.dfy
```

Verification budget for this task: {{BUDGET}}. Extra flags: {{FLAGS}}.

A `PASS` from the checker establishes the automated conditions. Rules 1–3 are
checked mechanically; **rule 4 is not fully enforceable** and is checked by
reading the diff. A submission that passes the checker while breaking rule 4 is
not a solution.

Do not edit anything under `.bench/` — that is the checker and the pristine
copy of the task it diffs against.

## Done

When `npx tsx .bench/check.ts` prints `PASS`. If you get stuck, say where and
what you tried; a partial proof with an honest account of the gap is more useful
than a passing one that reached for an escape hatch.
