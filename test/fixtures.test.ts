#!/usr/bin/env -S npx tsx
/**
 * The denylist, executable.
 *
 * A denylist written down is a denylist that rots — Dafny spells several of
 * these mechanisms more than one way, and a release can add another. So every
 * banned pattern and every disqualifying warning category has a fixture: a
 * small cheating `.dfy` beside `fixtures/base.dfy.gen`, and this suite asserts
 * the validator rejects it *for the expected reason*. A Dafny bump that
 * reworded a warning fails here rather than silently widening the benchmark.
 *
 * `fixtures/base.dfy.gen` verifies cleanly and warning-free, so each fixture
 * fails on the lines it adds and nothing else.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate, versionMatches } from "../src/validator.js";
import { bannedPatterns } from "../src/banned.js";
import type { WarningCategory } from "../src/validator.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (n: string) => path.join(repoRoot, "fixtures", `${n}.dfy`);
// Most fixtures are judged against the shared base. A few need their own
// generated file — one whose .gen already contains a trusted declaration, say.
const genFor = (n: string) => {
  const own = path.join(repoRoot, "fixtures", `${n}.dfy.gen`);
  return existsSync(own) ? own : path.join(repoRoot, "fixtures", "base.dfy.gen");
};

type Expectation =
  | { kind: "banned"; patterns: string[] }
  | { kind: "weakened"; clause: string }
  | { kind: "signature"; why: RegExp }
  | { kind: "warning"; category: WarningCategory }
  | { kind: "deletion" }
  | { kind: "accepted" };

const cases: Record<string, Expectation> = {
  // One per banned pattern, in the order they appear in src/banned.ts.
  "cheat-assume": { kind: "banned", patterns: ["assume"] },
  "cheat-expect": { kind: "banned", patterns: ["expect"] },
  "cheat-include": { kind: "banned", patterns: ["include"] },
  "cheat-block-comment": { kind: "banned", patterns: ["block-comment-open", "block-comment-close"] },
  "cheat-verbatim-string": { kind: "banned", patterns: ["verbatim-string"] },
  "cheat-axiom": { kind: "banned", patterns: ["axiom"] },
  "cheat-extern": { kind: "banned", patterns: ["extern"] },
  "cheat-verify-false": { kind: "banned", patterns: ["verify-false"] },
  "cheat-only": { kind: "banned", patterns: ["only"] },
  "cheat-selective-checking": { kind: "banned", patterns: ["selective-checking"] },
  "cheat-assumption": { kind: "banned", patterns: ["assumption"] },
  "cheat-assume-concurrent": { kind: "banned", patterns: ["assume-concurrent"] },
  "cheat-contradiction": { kind: "banned", patterns: ["contradiction"] },
  "cheat-options": { kind: "banned", patterns: ["options"] },
  "cheat-at-axiom": { kind: "banned", patterns: ["at-axiom"] },
  "cheat-at-verify-false": { kind: "banned", patterns: ["at-verify-false"] },
  "cheat-at-verify-only": { kind: "banned", patterns: ["at-verify-only"] },
  "cheat-at-options": { kind: "banned", patterns: ["at-options"] },
  "cheat-decreases-star": { kind: "banned", patterns: ["decreases-wildcard"] },
  "cheat-contract-inference": { kind: "banned", patterns: ["contract-inference"] },

  // The line DESIGN.md cites against stripping `//` tails: the `//` is inside a
  // string, so the code continues after it. The quote guard must decline to
  // strip and still see the `assume`.
  "cheat-string-slash-slash": { kind: "banned", patterns: ["assume"] },

  // Contract clauses bolted onto a generated declaration. `requires false` is
  // the one that matters: it discharges every postcondition at once, and a
  // generated lemma nothing calls has no caller to break.
  "cheat-weakened-precondition": { kind: "weakened", clause: "requires" },
  "cheat-weakened-reads": { kind: "weakened", clause: "reads" },
  "cheat-weakened-modifies": { kind: "weakened", clause: "modifies" },
  // Pins the attribution rule as *nearest preceding declaration*, not "some
  // declaration keyword anywhere in this run of added lines".
  "cheat-weakened-precondition-reordered": { kind: "weakened", clause: "requires" },

  // Caught by the warning check, not by any pattern.
  "cheat-bodyless-declaration": { kind: "warning", category: "bodyless-declaration" },
  "cheat-bodyless-forall": { kind: "warning", category: "bodyless-forall" },
  "cheat-bodyless-loop": { kind: "warning", category: "bodyless-loop" },

  // Additions inside a generated declaration's signature. Each rejection
  // reason is asserted, so a fixture cannot pass for the wrong cause.
  "cheat-clause-continuation": { kind: "signature", why: /does not begin an/ },
  "cheat-clause-smuggle": { kind: "signature", why: /contributes a `requires`/ },
  "cheat-frame-smuggle": { kind: "signature", why: /contributes a `modifies`/ },
  "cheat-decreases-wildcard": { kind: "signature", why: /wildcard/ },
  "cheat-ensures-on-trusted": { kind: "signature", why: /trusted declaration/ },
  // An added declaration inside a generated signature captures that
  // declaration's clauses and body, leaving the generated one claiming nothing.
  "cheat-declaration-inside-signature": { kind: "signature", why: /does not begin an/ },

  "cheat-deletion": { kind: "deletion" },

  // Must pass: proof prose that happens to contain banned English. This is the
  // fixture that pins the quote-guarded comment strip as a feature.
  "ok-proof-comment": { kind: "accepted" },

  // Must pass: proof by contradiction. Dafny warns that the inner assertions
  // were proved using contradictory assumptions — which is the point of the
  // technique, not a vacuous theorem.
  "ok-proof-by-contradiction": { kind: "accepted" },

  // Must pass: a contrapositive helper, whose `ensures false` is proved from
  // hypotheses that are unsatisfiable precisely because the theorem holds.
  // This is the shape that used to exclude hono-rate-limiter.
  "ok-contrapositive-lemma": { kind: "accepted" },

  // Must pass: a helper the candidate wrote, carrying its own precondition.
  // The freeze allows it, and Dafny keeps it honest — the call site has to
  // discharge the precondition from context the candidate cannot weaken, so a
  // helper with an unsatisfiable one is unusable rather than a cheat.
  "ok-new-helper-precondition": { kind: "accepted" },

  // Must pass: the two clause kinds a candidate may add to a generated
  // signature, and proof commentary beside them.
  "ok-added-ensures": { kind: "accepted" },
  "ok-added-decreases": { kind: "accepted" },
  "ok-signature-comment": { kind: "accepted" },
};

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

// Version comparison. Release builds report a bare `4.11.0`; the CI action
// installs one reporting `4.11.0+<sha>`, and semver ignores build metadata. An
// exact string match rejected the very toolchain it required — caught only when
// the check first ran somewhere other than the development machine.
for (const [expected, found, want] of [
  ["4.11.0", "4.11.0", true],
  ["4.11.0", "4.11.0+fcb2042d6d043a2634f0854338c08feeaaaf4ae2", true],
  ["4.11.0", "4.12.0", false],
  ["4.11.0", "4.11.1", false],
  ["4.11.0", "4.11.0-rc1", false],
] as [string, string, boolean][]) {
  check(`version: ${expected} vs ${found}`, versionMatches(expected, found) === want, "wrong verdict");
}

// Every banned pattern needs a fixture, or the list has rotted past the suite.
const covered = new Set(Object.values(cases).flatMap(e => (e.kind === "banned" ? e.patterns : [])));
for (const { name } of bannedPatterns) {
  check(`coverage: ${name}`, covered.has(name), "no fixture asserts this pattern is caught");
}

// Same for the frozen contract clauses.
const clauses = new Set(Object.values(cases).flatMap(e => (e.kind === "weakened" ? [e.clause] : [])));
for (const clause of ["requires", "reads", "modifies"]) {
  check(`coverage: ${clause}`, clauses.has(clause), "no fixture asserts this clause is frozen");
}

for (const [name, want] of Object.entries(cases)) {
  const r = await validate(genFor(name), fixture(name));
  const patterns = r.additions.bannedMatches.map(m => m.pattern);
  const weakened = r.additions.weakenedContracts.map(w => w.clause);
  const sigWhy = r.additions.signatureViolations.map(v => v.why);
  const categories = r.verify.disqualifyingWarnings.map(w => w.category);
  const summary =
    `additions=${r.additions.status} verify=${r.verify.status} banned=[${patterns}] ` +
    `weakened=[${weakened}] signature=[${sigWhy}] warnings=[${categories}] errors=${r.verify.errors}`;

  switch (want.kind) {
    case "banned":
      check(
        name,
        !r.passed && want.patterns.every(p => patterns.includes(p)),
        `expected banned:[${want.patterns}]; got ${summary}`,
      );
      break;
    case "warning":
      // Also assert zero errors: otherwise the fixture proves only that broken
      // Dafny is rejected, not that the warning category does any work.
      check(
        name,
        !r.passed && r.verify.errors === 0 && categories.includes(want.category),
        `expected warning:${want.category} with no errors; got ${summary}`,
      );
      break;
    case "weakened":
      check(name, !r.passed && weakened.includes(want.clause), `expected weakened:${want.clause}; got ${summary}`);
      break;
    case "signature":
      check(
        name,
        !r.passed && sigWhy.some(w => want.why.test(w)),
        `expected a signature violation matching ${want.why}; got ${summary}`,
      );
      break;
    case "deletion":
      check(name, !r.passed && r.additions.deletedLines > 0, `expected deleted lines; got ${summary}`);
      break;
    case "accepted":
      check(name, r.passed, `expected to pass; got ${summary}`);
      break;
  }
}

console.log(failures === 0 ? "\nall fixtures behaved" : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
