# Validator

`src/validator.ts` checks a candidate against an immutable task scaffold and
runs Dafny with the task's verification options. Reference admission,
standalone attempts, and final scoring use this validator.

## Result

**PASS requires both `additions` and `verify` to be `passed`.**

- `passed`: the check completed and its requirements were met.
- `failed`: a rule was violated, or verification failed or timed out.
- `not-run`: the check could not complete; the result includes a reason.

Neither `failed` nor `not-run` permits PASS.

## Additions check

`git diff --no-index --minimal` checks that original lines, including
whitespace, remain unchanged and in order. Added lines are also checked for
banned constructs such as `assume`, added axioms, and disabled verification.
Precondition and frame-clause attribution uses full diff context.

A Git comparison succeeds with exit 0 and empty output, or exit 1 with diff
output and no subprocess error. Other exits, signals, missing executables,
output-buffer errors, and unexpected output produce `not-run`. Diagnostics
include stderr. Each invocation disables global/system Git configuration,
external diff drivers, and text conversion.

## Declaration ownership

`src/signature.ts` locates top-level callable declarations in both files.
Each original declaration has exactly one candidate counterpart of the same
kind and name. Original declarations remain in order; new helpers can appear
between them.

A **signature** consists of the header and contract clauses preceding the body.
Within each matched declaration:

1. Original signature lines remain unchanged and in order in its signature.
2. Original body lines remain unchanged and in order in its body.
3. Added signature lines satisfy the clause rules below.

A helper cannot take ownership of an original contract or body. The scaffold
sets permissions and trust; candidate boundaries locate the text being checked.
Git's line alignment does not assign declaration ownership.

| Signature addition | Rule |
| --- | --- |
| Blank line or whole-line `//` comment | Allowed |
| Complete `ensures` clause | Allowed only on an originally proved declaration |
| Complete `decreases` clause | Allowed without a wildcard |
| `requires`, `reads`, `modifies`, `decreases *`, or expression continuation | Rejected |

Originally bodyless or trusted declarations cannot receive added postconditions,
even if the candidate supplies a body. A signature line cannot hide a forbidden
clause after an allowed keyword.

The scanner supports the emitted declaration format: named single-line headers,
bodyless declarations, and body braces on a separate line or in an inline
header without contract clauses. Comments, quoted literals, and attributes do
not supply body braces. Unsupported headers or incomplete boundaries produce
`not-run`; missing counterparts and moved original text produce `failed`.
Ownership and signature violations share `additions.signatureViolations`.

## Verification and review

Benchmark entry points use Dafny 4.11.0, the task's recorded flags and time
limit, and the benchmark warning policy. Zero errors and no disqualifying
warnings are required. Timeouts are recorded separately from proof errors.
See [README.md](README.md#validation) for the warning rules.

These text and ownership checks do not establish that every addition is
proof-only. Executable additions, expression changes inside bodies, and
split-attribute escapes still require human review.

## Validation of changes

The fixture suite covers valid additions and attacks accepted by Dafny but
rejected by benchmark rules. Rejection tests assert the reason. Git error tests
cover both diff passes; a standalone-attempt test checks the copied validator.
Run `npm test`, `npm run typecheck`, and `npm run check-artifacts`.

Comparisons of additions rules use identical, hash-verified inputs and hold
Dafny results fixed. Fresh solver results and timeouts are reported separately.
Historical candidates, outcomes, ledgers, and review decisions remain unchanged;
revalidation results are stored in separate reports.
