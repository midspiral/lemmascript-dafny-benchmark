/**
 * The banned patterns, and how an added line is reduced to the text they are
 * scanned against.
 *
 * The list is DESIGN.md's, verbatim. Each entry carries a `name` so the
 * reference report and the fixture suite can talk about a specific ban rather
 * than about a regex source string.
 */

export interface BannedPattern {
  name: string;
  pattern: RegExp;
}

export const bannedPatterns: BannedPattern[] = [
  { name: "assume", pattern: /\bassume\b/ },
  { name: "expect", pattern: /\bexpect\b/ },
  { name: "include", pattern: /\binclude\b/ },

  { name: "block-comment-open", pattern: /\/\*/ },
  { name: "block-comment-close", pattern: /\*\// },
  { name: "verbatim-string", pattern: /@"/ },

  { name: "axiom", pattern: /\{\s*:axiom\b/ },
  { name: "extern", pattern: /\{\s*:extern\b/ },
  { name: "verify-false", pattern: /\{\s*:verify\s+false\b/ },
  { name: "only", pattern: /\{\s*:only\b/ },
  { name: "selective-checking", pattern: /\{\s*:selective_checking\b/ },
  { name: "assumption", pattern: /\{\s*:assumption\b/ },
  { name: "assume-concurrent", pattern: /\{\s*:assume_concurrent\b/ },
  { name: "contradiction", pattern: /\{\s*:contradiction\b/ },
  { name: "options", pattern: /\{\s*:options\b/ },

  { name: "at-axiom", pattern: /@Axiom\b/ },
  { name: "at-verify-false", pattern: /@Verify\s*\(\s*false\s*\)/ },
  { name: "at-verify-only", pattern: /@VerifyOnly\b/ },
  { name: "at-options", pattern: /@Options\s*\(/ },
];

/**
 * The text of an added line that the bans are scanned against.
 *
 * Whole line, minus a trailing `//` comment — but only when no `"` appears
 * before that `//`. The guard is what makes dropping the tail sound. DESIGN's
 * counterexample to stripping comments is
 *
 *     var s := "x//"; assume false;
 *
 * where the `//` opens no comment at all because it sits inside a string; here
 * the leading `"` suppresses the strip and the whole line is scanned, so the
 * `assume` is still caught. A `//` with no `"` anywhere before it cannot be
 * inside a string literal on this line, and cannot be inside a character
 * literal either (`'//'` is not a Dafny char). It could only be inside a block
 * comment carried over from an earlier line — and `/*` is itself banned on
 * added lines, so a candidate cannot open one.
 *
 * The cost is that a line mixing a string literal with a comment gets its
 * comment scanned too. That is the conservative direction, and rare.
 */
export function scannedText(line: string): string {
  const i = line.indexOf("//");
  if (i < 0) return line;
  if (line.slice(0, i).includes('"')) return line;
  return line.slice(0, i);
}

export interface BannedMatch {
  /** `name` of the pattern that matched. */
  pattern: string;
  /** 1-based index into the list of added lines, not a file line number: the
   *  candidate's line numbering is not something the diff hands us cheaply. */
  addedLineIndex: number;
  /** The added line, verbatim, without the diff's leading `+`. */
  text: string;
}

/** Every ban matched by every added line. One line can match several. */
export function scanAddedLines(addedLines: string[]): BannedMatch[] {
  const matches: BannedMatch[] = [];
  addedLines.forEach((line, i) => {
    const text = scannedText(line);
    for (const { name, pattern } of bannedPatterns) {
      if (pattern.test(text)) {
        matches.push({ pattern: name, addedLineIndex: i + 1, text: line });
      }
    }
  });
  return matches;
}

/**
 * Clauses that *weaken* what a declaration promises: a precondition narrows
 * the theorem's scope, and `reads` / `modifies` widen the frame it may touch.
 * Adding one to a **generated** declaration changes the theorem rather than
 * proving it — `requires false` being the degenerate case that discharges
 * every postcondition at once.
 *
 * `ensures` is deliberately absent. Adding one strengthens: there is more to
 * prove, not less. Five reference solutions add `ensures` to generated
 * declarations — xyflow annotates `isAcyclic` with `ensures res ==>
 * acyclic(edges)` — and that is proof work, not evasion.
 */
export const weakeningClause = /^\s*(requires|reads|modifies)\b/;

/** Anything a `requires` / `reads` / `modifies` clause can belong to. The
 *  modifiers (`ghost`, `twostate`, `least`, `greatest`) all precede one of
 *  these, so matching the head word is enough. */
export const declarationKeyword = /\b(lemma|function|method|predicate|constructor|iterator)\b/;

export interface WeakenedContract {
  /** `requires`, `reads` or `modifies`. */
  clause: string;
  addedLineIndex: number;
  text: string;
}
