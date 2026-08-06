# CI

What the two workflows check, and why they are split the way they are:
[`ci.yml`](.github/workflows/ci.yml) and
[`regenerate.yml`](.github/workflows/regenerate.yml).

The short version: **the cheap checks run on every push; the expensive one runs
weekly.** The split is not about tidiness. Regenerating the benchmark takes ten
minutes of solver time and clones 27 repositories, and its result depends on how
loaded the machine is — so it cannot be a gate on a pull request.

## `check` — every push and pull request, seconds

Needs neither Dafny nor the case studies.

| step | what it protects |
|---|---|
| `npm ci` | the lockfile governs; a dependency drift fails here |
| `npm run typecheck` | the usual |
| `npm run check-artifacts` | `tasks/`, `metadata.json`, `index.json` and the report are consistent views of one corpus |
| `npm run list-tasks` | the listing renders against the current metadata |

`check-artifacts` is the one worth understanding. The four emitted artifacts are
generated together but committed as ordinary files, so nothing stops a hand-edit,
a bad merge, or a half-finished regeneration from putting them out of step. It
asserts that every task in `metadata.json` has a file, an index entry with a
matching number, and an `admitted` verdict in the report; that no task file on
disk is unaccounted for; that no ID is issued twice or at-or-past `nextId`; that
each task's recorded licence matches the config; and — the important one — that
**every task file still hashes to the `sha256` metadata records for it**. A
stray edit to a task file would silently change every verdict for that task,
because it is what candidate diffs are taken against.

Regenerating would catch all of that too, and costs ten minutes and a Dafny
install. This costs a second.

## `fixtures` — every push and pull request, needs Dafny 4.11.0

This is the job that matters most, and the reason is subtle.

The validator's warning checks are matched on **Dafny's message text** — the
diagnostics carry no stable error IDs, so `bodyless declaration`,
`{:verify false}`, and `ensures clause proved using contradictory assumptions`
are all recognised by their wording. A Dafny release that rephrases any of them
would silently widen what the benchmark accepts. Nothing else would notice.

So the job installs the pinned 4.11.0 and runs the fixture suite: one small
cheating `.dfy` per banned mechanism and per disqualifying warning, each
asserting *the reason* it is rejected rather than merely that it fails. Seven
more assert the opposite direction — that legitimate work still passes, because
a validator tested only against attacks drifts toward rejecting everything.

Two smoke tests ride along:

- **the attempt directory works standalone.** `bin/make-attempt.ts` builds an
  isolated directory carrying *copies* of the validator's sources. Adding a
  module to the validator's import graph without adding it to that copy list
  breaks every attempt directory, and the fixture suite would not notice —
  it runs against the repo's own sources. This nearly shipped once. The step
  asserts both that the checker *ran* and that the untouched task *fails*;
  exiting non-zero is the expected outcome, so a crash would otherwise look
  like success.
- **the `check` CLI scores a candidate.** That is the contract a runner codes
  against, and nothing else exercises it.

## `regenerate` — weekly, and on manual dispatch

A separate workflow, [`regenerate.yml`](.github/workflows/regenerate.yml).

Clones every case study, re-verifies every reference solution, regenerates all
four artifacts, and uploads the report as an artifact.

It **reports its diff rather than failing on it**. The per-task verification
limits are wall-clock, so admission depends on machine load — one task passes
with a one-second margin. A difference here is a prompt to look, not proof that
something broke. Making it a hard gate would produce flaky red builds that
everyone learns to ignore.

This is also the only job that would notice a case study changing upstream, and
it runs once a week. A case-study edit can sit unseen for six days.

It lives in its own workflow file so that triggering CI by hand stays cheap.
When it was a job inside `ci.yml` gated on `workflow_dispatch`, the obvious way
to run the fast checks manually — `gh workflow run CI` — started the
ninety-minute regeneration too, and there was no way to ask for only the cheap
ones. Now `gh workflow run CI` runs `check` and `fixtures`; the regeneration
needs `gh workflow run Regenerate` explicitly.

## Running the same checks locally

```sh
npm ci
npm run typecheck
npm run check-artifacts     # no Dafny needed
npm test                    # needs Dafny 4.11.0
npm run generate            # what `regenerate` does, ~10 minutes
```

The validator refuses to run against any Dafny other than the pinned version, so
a local run on 4.12 reports `not-run` with the version mismatch rather than
producing a verdict that means something different.

## Two things deliberately not built

**A verification cache**, keyed on the file hashes, verify options, Dafny version
and validator version, so that an unchanged pair is not re-verified. It sounds
obviously worthwhile and mostly is not. After a documentation change you would
not run `generate` at all; after a *validator* change the cache must be
invalidated, so it saves nothing; on CI or a fresh clone the cache is cold. It
pays off in one case — a single case study changed — which is the weekly job.
Against that, the invalidation key has to include the validator's own logic, and
forgetting to bump it yields stale verdicts that look authoritative. That is a
fail-open bug in the one place a benchmark cannot afford one.

**A `--skip-slow` flag**, omitting pairs above some time threshold. Two files are
83% of the run, and both are excluded for timing out anyway. But that is exactly
why skipping them is wrong: their result is the only signal that an upstream
limit change worked. It would also make the corpus composition depend on a flag,
producing a report that looks complete and is not.

Ten minutes on a rare full regeneration is the cheaper problem than either.

## What CI does not cover

- Most of `bin/` — `reference-report --only`, `generate --dry-run`, and
  `--from-report` are untested.
- No formatter or linter is configured, so style drift is invisible.
- Nothing verifies the reference solutions on more than one machine. Everything
  known about the corpus was measured on a single Dafny 4.11.0 install; the
  weekly `regenerate` run on a GitHub runner is the only independent check, and
  it is advisory.
