/**
 * Signature intervals of the generated program, and what may be added inside
 * one.
 *
 * Everything here is computed from the `.dfy.gen`, which is immutable. That is
 * the point: if the regions were derived from the candidate, the candidate
 * could move them — an unbalanced brace in a comment, a string containing `{`,
 * a declaration inserted to shift the boundary. Anchoring on the generated file
 * removes the whole class rather than defending against each instance.
 */

/** Anything a specification clause can hang off. */
const DECLARATION =
  /^\s*(@\w+(\([^)]*\))?\s+)*(ghost\s+)?(twostate\s+|least\s+|greatest\s+|opaque\s+)?(lemma|function|method|predicate|constructor|iterator)\b/;

/**
 * A declaration whose postconditions Dafny *assumes* rather than proves. Adding
 * an `ensures` to one is `assume` by another route — `ensures false` on an
 * `{:axiom}` function makes every caller's goal trivial.
 */
const TRUSTED_ATTRIBUTE =
  /\{\s*:(axiom|extern|verify\s+false)\b|@Axiom\b|@Extern\b|@Verify\s*\(\s*false\s*\)/;

/** Every specification keyword, so a line's full contribution can be judged. */
const SPEC_KEYWORD = /\b(requires|ensures|reads|modifies|decreases|invariant|yields)\b/g;

/** The two a candidate may add to a generated signature. */
const ALLOWED_CLAUSE = new Set(["ensures", "decreases"]);

export interface LexState {
  block: boolean;
  str: boolean;
}

/**
 * The line with comments and string literals removed, advancing `state` across
 * lines so a block comment or an unterminated string is tracked.
 */
export function scrub(line: string, state: LexState): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const d = line[i + 1];
    if (state.block) {
      if (c === "*" && d === "/") {
        state.block = false;
        i++;
      }
      continue;
    }
    if (state.str) {
      if (c === "\\") i++;
      else if (c === '"') state.str = false;
      continue;
    }
    if (c === "/" && d === "/") break;
    if (c === "/" && d === "*") {
      state.block = true;
      i++;
      continue;
    }
    if (c === '"') {
      state.str = true;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * A line that contributes no tokens and leaves the lexer clean — proof
 * commentary, in other words. Safe to add anywhere: a `//` comment cannot span
 * lines, so it can neither continue an expression nor hide a clause. A line
 * that *opens* a block comment is not inert, because it would swallow the
 * generated lines that follow.
 */
export function isInert(line: string): boolean {
  const state: LexState = { block: false, str: false };
  return scrub(line, state).trim() === "" && !state.block && !state.str;
}

export function beginsDeclaration(code: string): boolean {
  return DECLARATION.test(code);
}

export interface SignatureInterval {
  /** 1-based line of the declaration keyword in the `.dfy.gen`. */
  start: number;
  /** 1-based line of the last specification line, before the body opens. */
  end: number;
  /** Postconditions are assumed, not proved. */
  trusted: boolean;
  /** For diagnostics. */
  text: string;
}

/**
 * The signature interval of every declaration in the generated program: from
 * its declaration keyword through the last line before its body opens, or
 * through its last specification line when it has no body.
 */
export function signatureIntervals(genText: string): SignatureInterval[] {
  const lines = genText.split("\n");
  const state: LexState = { block: false, str: false };
  const intervals: SignatureInterval[] = [];
  let depth = 0;
  let open: SignatureInterval | null = null;

  const close = (end: number) => {
    if (open && end >= open.start) {
      open.end = end;
      intervals.push(open);
    }
    open = null;
  };

  lines.forEach((raw, i) => {
    const n = i + 1;
    const code = scrub(raw, state);

    if (depth === 0 && DECLARATION.test(code)) {
      close(n - 1);
      // A bodyless declaration is trusted for the same reason an {:axiom} one
      // is: its postconditions are exposed to callers without an implementation
      // proof. Whether it has a body is decided below, when the body opens.
      open = { start: n, end: n, trusted: TRUSTED_ATTRIBUTE.test(code), text: code.trim() };
    }

    let d = 0;
    for (const ch of code) {
      if (ch === "{") d++;
      else if (ch === "}") d--;
    }
    const before = depth;
    depth += d;

    if (open && before === 0 && depth > 0) close(n - 1);
    else if (open && depth === 0 && code.trim() === "") close(n - 1);
  });
  close(lines.length);

  // A declaration whose body never opened is bodyless, hence trusted.
  const bodied = new Set<number>();
  let depth2 = 0;
  const state2: LexState = { block: false, str: false };
  lines.forEach((raw, i) => {
    const code = scrub(raw, state2);
    const before = depth2;
    for (const ch of code) {
      if (ch === "{") depth2++;
      else if (ch === "}") depth2--;
    }
    if (before === 0 && depth2 > 0) {
      const owner = intervals.find(iv => i + 1 === iv.end + 1);
      if (owner) bodied.add(owner.start);
    }
  });
  for (const iv of intervals) if (!bodied.has(iv.start)) iv.trusted = true;

  return intervals;
}

export type ClauseVerdict = { ok: true; kind: string } | { ok: false; why: string };

/**
 * Whether an added line may stand inside a generated signature.
 *
 * Three independent conditions, each closing one thing:
 *
 *   begins an allowed clause  — rejects `|| true`, which would otherwise merge
 *                               into the generated clause above it
 *   every keyword allowed     — rejects `ensures true requires false`, where the
 *                               problem is the `requires`, not the count
 *   no wildcard               — rejects `decreases *`, which drops the
 *                               termination obligation entirely
 *
 * The number of clauses is deliberately not constrained: `ensures A ensures B`
 * is two lines written as one, and both strengthen.
 */
export function judgeSignatureLine(code: string, trusted: boolean): ClauseVerdict {
  const first = /^\s*(\w+)/.exec(code);
  if (!first || !ALLOWED_CLAUSE.has(first[1])) {
    return { ok: false, why: "does not begin an `ensures` or `decreases` clause" };
  }
  SPEC_KEYWORD.lastIndex = 0;
  const keywords = [...code.matchAll(SPEC_KEYWORD)].map(m => m[1]);
  const disallowed = keywords.find(k => !ALLOWED_CLAUSE.has(k));
  if (disallowed) return { ok: false, why: `also contributes a \`${disallowed}\` clause` };
  if (/\bdecreases\s+\*/.test(code)) return { ok: false, why: "wildcard `decreases *`" };
  if (keywords.includes("ensures") && trusted) {
    return { ok: false, why: "`ensures` on a trusted declaration, whose postconditions are assumed" };
  }
  return { ok: true, kind: keywords.includes("ensures") ? "ensures" : "decreases" };
}
