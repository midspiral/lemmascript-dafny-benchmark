/** Declaration boundaries and signature permissions for the emitted scaffold format. */

/** Anything a specification clause can hang off. */
const DECLARATION =
  /^\s*(@\w+(\([^)]*\))?\s+)*(ghost\s+)?(twostate\s+|least\s+|greatest\s+|opaque\s+)?(lemma|function|method|predicate|constructor|iterator)\b/;

/** The same declaration prefix, with the callable kind and name captured.
 * Attributes may sit between the kind and name (`function {:axiom} f`). */
const DECLARATION_HEADER =
  /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(ghost\s+)?(?:twostate\s+|least\s+|greatest\s+|opaque\s+)?(lemma|function|method|predicate|constructor|iterator)\s+(?:\{\s*:[^{}]*\}\s*)*([A-Za-z_][\w']*)(?=\s|[<(])/;

/**
 * A declaration whose postconditions Dafny *assumes* rather than proves. Adding
 * an `ensures` to one is `assume` by another route — `ensures false` on an
 * `{:axiom}` function makes every caller's goal trivial.
 */
const TRUSTED_ATTRIBUTE =
  /\{\s*:(axiom|extern|verify\s+false)\b|@Axiom\b|@Extern\b|@Verify\s*\(\s*false\s*\)/;

/** Attribute groups, which are balanced and must not be mistaken for a body.
 *  `function {:axiom} f(x): bool` is bodyless; the braces belong to the
 *  attribute. */
const ATTRIBUTE_GROUP = /\{\s*:[^{}]*\}/g;

/** Every specification keyword, so a line's full contribution can be judged. */
const SPEC_KEYWORD = /\b(requires|ensures|reads|modifies|decreases|invariant|yields)\b/g;

/** The two a candidate may add to a generated signature. */
const ALLOWED_CLAUSE = new Set(["ensures", "decreases"]);

export interface LexState {
  block: boolean;
  str: boolean;
}

/**
 * The line with comments and quoted literals removed, advancing `state` across
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
    // Character literals can contain braces too. Match a complete literal,
    // rather than treating every apostrophe as a quote (x' is an identifier).
    if (c === "'") {
      const literal = /^'(?:\\u[0-9a-fA-F]{4}|\\.|[^'\\])'/u.exec(line.slice(i));
      if (literal) { i += literal[0].length - 1; continue; }
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

export interface DeclarationHeader {
  kind: "lemma" | "function" | "method" | "predicate" | "constructor" | "iterator";
  name: string;
  ghost: boolean;
}

/** Parse the kind and name from a scrubbed declaration line. */
export function declarationHeader(code: string): DeclarationHeader | null {
  const m = DECLARATION_HEADER.exec(code);
  if (!m) return null;
  return { kind: m[2] as DeclarationHeader["kind"], name: m[3], ghost: m[1] !== undefined };
}

export interface TopLevelDeclaration extends DeclarationHeader {
  /** 1-based inclusive source lines. */
  start: number;
  end: number;
  abstract: boolean;
  /** First body line, including its opening brace; null for a bodyless declaration. */
  bodyStart: number | null;
  /** Baseline trust is preserved even if a candidate adds an implementation. */
  trusted: boolean;
}

/**
 * Locate complete top-level callable declarations in source order.
 *
 * This shares the lexer and attribute handling used for frozen signatures.
 * The supported scaffold form puts a body's opening brace on its own line,
 * or on the declaration line for an inline definition. Specification braces
 * (sets, matches, and attributes) do not establish body ownership.
 * Strict mode rejects unsupported headers and incomplete boundaries.
 * Dafny remains the authority on syntax and resolution.
 */
export function topLevelDeclarations(text: string, strict = false): TopLevelDeclaration[] {
  const lines = text.split("\n");
  const state: LexState = { block: false, str: false };
  const declarations: TopLevelDeclaration[] = [];
  let depth = 0;
  let open:
    | (DeclarationHeader & {
        start: number;
        lastCode: number;
        bodyStart: number | null;
        trusted: boolean;
      })
    | null = null;

  const close = (end: number) => {
    if (!open) return;
    declarations.push({
      kind: open.kind,
      name: open.name,
      ghost: open.ghost,
      start: open.start,
      end,
      abstract: open.bodyStart === null,
      bodyStart: open.bodyStart,
      trusted: open.trusted || open.bodyStart === null,
    });
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const n = i + 1;
    const code = scrub(raw, state);
    const body = code.replace(ATTRIBUTE_GROUP, "");
    const header = depth === 0 ? declarationHeader(code) : null;
    if (strict && depth === 0 && beginsDeclaration(code) && !header) {
      throw new Error(`unsupported declaration header at line ${n}: ${raw.trim()}`);
    }

    if (strict && header && /\b(requires|ensures|reads|modifies|decreases)\b/.test(body.split("{")[0]) && body.includes("{")) {
      throw new Error(`unsupported inline contract/body boundary at line ${n}`);
    }

    // A second header at depth zero ends a preceding bodyless declaration.
    if (header) {
      if (open) close(open.lastCode);
      open = { ...header, start: n, lastCode: n, bodyStart: null, trusted: TRUSTED_ATTRIBUTE.test(code) };
    } else if (open && code.trim() !== "") {
      open.lastCode = n;
    }

    // Generated signatures put the body brace on its own line (or on a
    // one-line declaration). Braces in a specification expression, such as
    // `ensures (match x { ... })`, must not end the declaration. In particular,
    // an expression with balanced braces is not a complete callable body.
    if (open && open.bodyStart === null && depth === 0 &&
        (body.trimStart().startsWith("{") || (header && body.includes("{")))) {
      open.bodyStart = n;
    }

    for (const ch of body) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }

    // Blank lines are only whitespace in Dafny: a concrete declaration may
    // legally put one between its signature and opening brace. A bodyless
    // declaration therefore ends only at the next top-level callable (handled
    // above) or at EOF, never merely at a blank line.
    if (open && open.bodyStart !== null && depth === 0) close(n);
  }

  if (strict && (state.str || state.block || (open?.bodyStart != null && depth !== 0))) {
    throw new Error("unterminated declaration body, string, or comment");
  }
  if (open) close(open.lastCode);
  return declarations;
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
