# Upstream to-do

Things the reference report found in the case studies. None of them is a
benchmark defect; each is a fix that belongs in a case study repository, and
most would make the benchmark *better* — more tasks, harder tasks, or tasks that
measure what they claim to.

Generated from `reference-report.json` and checked by hand. Task numbers are
stable, so an item that gets fixed upstream comes back at the same number.

## 1. Specification written in Dafny that belongs in TypeScript

This is the big one, and it affects more tasks than the exclusion list suggests.

LemmaScript compiles `//@ requires` and `//@ ensures` annotations from the
TypeScript into the `.dfy.gen`. When a case study instead writes a contract
directly into the `.dfy`, two things happen: the benchmark task carries a weaker
specification than the one the author actually cared about, and the human's
proof is doing work the task never asked for.

**13 added `ensures` clauses across 5 case studies** sit on generated
declarations:

| case study | file | added to a generated declaration |
|---|---|---|
| xyflow | `packages/system/src/utils/graph.ts` | `ensures res ==> reach(edges, from, to)` and its converse, ×3 pairs — soundness and completeness for `canReach`, the reverse direction, and `isAcyclic` |
| equality-game | `src/equality.ts` | `ensures Pow2(n) >= 1`; `ensures forall v :: v in res <==> ReachableExists(cards, v)` split in two |
| hono-rate-limiter | `src/core.verified.ts` | `ensures \|pruneWindow(log, now, W)\| == CountIn(log, now, W)`; `ensures activeCount(...) == CountIn(...)` |
| quorum-tutorial | `src/domain.ts` | `ensures \|heatmapUpto(ps, k)\| == k` |
| charmchat | `backend/src/services/workflow.ts` | `ensures \|res\| == \|nodes\|` |

These are all *admitted* today — the validator permits adding an `ensures` to a
generated declaration, because doing so strengthens what must be proved. But the
task a candidate is given is the weaker one. Moving each clause into a `//@
ensures` on the TypeScript would put the obligation in the `.dfy.gen`, where it
belongs, and make the corresponding task properly hard.

xyflow is the clearest case: the reference proves soundness *and* completeness
of `canReach` and `isAcyclic`, and the generated task asks for neither.

### 1a. charmchat also weakens a generated declaration — task excluded

`backend/src/services/workflow.ts`, method `topologicalSort`. The reference adds
four preconditions to a **generated** declaration:

```dafny
 method topologicalSort(nodes: seq<WorkflowNode>, deps: …) returns (res: …)
+  requires forall i, j :: 0 <= i < j < |nodes| ==> nodes[i].id != nodes[j].id
+  requires forall k :: k in deps ==> k in NodeIds(nodes)
+  requires forall k, v :: k in deps && v in deps[k] ==> v in NodeIds(nodes)
+  requires exists rank: map<string, nat> :: IsRanking(NodeIds(nodes), deps, rank)
   ensures (|res| <= |nodes|)          ← generated
+  ensures |res| == |nodes|            ← added
```

The motive is sound — a topological sort really does need acyclicity to return
every node — but the side effect is that the *generated* obligation
`|res| <= |nodes|` is now conditional too. The validator rejects this
(`weakened:requires`), so the pair is excluded.

Fix: move all four to `//@ requires` in `workflow.ts`, and the added `ensures`
with them. The task then becomes well-posed and admissible.

### 1b. opencode/arity proves a property the spec never states — task excluded

`packages/opencode/src/permission/arity.ts`, 35 added code lines. The reference
author explains it in the file:

> The production `prefix(tokens)` is a method — its body's invariants aren't
> visible from external lemmas, so the longest-match property can't be stated as
> a TS-level `//@ ensures` and discharged through LS's spec language. Instead:
> define a pure recursive function that mirrors the algorithm, prove the
> longest-match property on it. The connection to production `prefix` is by code
> inspection — the two implementations match statement-for-statement.

So the proof is real, but it is attached to a mirror of the algorithm rather
than to the algorithm, and the generated specification is weak enough to verify
without it. The benchmark excludes the pair as `already-verifies`.

This one is a LemmaScript question as much as a case-study one: the author
wanted a postcondition on a method whose invariants aren't reachable from
external lemmas. If that becomes expressible, the property moves into the
TypeScript and the task becomes a good one.

## 2. Verification budgets

`LemmaScript-files.txt` carries a per-file time limit and extra Dafny flags. Four
files are at or over theirs, which costs the benchmark three tasks.

| case study | file | budget | observed |
|---|---|---|---|
| charmchat | `backend/src/services/workflow.ts` | 600s, `--isolate-assertions` | **604s — times out** |
| balanced-match | `src/index.ts` | 500s, `--isolate-assertions` | **525s — times out** |
| eventab | `src/allocate.ts` | *no limit* (Dafny's 30s default) | **times out; verifies clean at 300s** |
| collab-todo | `src/domain.ts` | 50s | 49s — passes with a one-second margin |

The first three are excluded as `verification-timeout`; balanced-match is the
largest reference proof in the corpus at 1169 added lines, so it is the most
valuable of the three to recover. eventab is the cheapest fix: it has no limit
at all and needs one.

collab-todo is not excluded but is one loaded machine away from being so.

These limits exist to bound CI, which is a different problem from bounding a
benchmark task. Raising them costs CI time; leaving them costs the benchmark
three tasks and makes admission depend on the machine.

## 3. Licensing

Resolved, recorded for completeness. Every case study contributing a task is now
MIT. One remains excluded:

- **rallly** — AGPL-3.0, so a derived task cannot ship under this repository's
  MIT licence. `apps/web/src/features/poll/scoring.ts` is validated and reported
  like any other pair but never becomes a task. Not fixable upstream; noted so
  nobody re-derives the question.

## 4. Not a defect: 26 pairs need no proof at all

26 of 65 pairs have a `.dfy` byte-identical to its `.dfy.gen` — LemmaScript's
output verified on the first try, so there was nothing to complete. Six case
studies are entirely in this category: `pi` (6/6), `node-casbin` (5/5), `flue`
(5/5), `colorwheel`, `mcp-sdk`, `anthropic-sdk`.

Nothing to fix. Recorded because it is the single most striking number the
benchmark produced, and because it explains why 27 configured repositories yield
tasks from only 17.

The caveat that belongs with it: case-study authors choose which files to
compile, so this is a selected sample rather than a claim about arbitrary
TypeScript.
