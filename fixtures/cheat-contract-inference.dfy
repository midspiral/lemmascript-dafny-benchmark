// Base for the validator fixtures.
//
// Stands in for a `.dfy.gen`. It verifies cleanly and warning-free on its own,
// so each fixture beside it fails for exactly one reason: the lines it adds.
// The class exists so that `reads` and `modifies` clauses are expressible.
function Sum(s: seq<int>): int
{
  if |s| == 0 then 0 else s[0] + Sum(s[1..])
}

@AutoRequires
lemma SumNonNegative(s: seq<int>)
  requires forall i :: 0 <= i < |s| ==> s[i] >= 0
  ensures Sum(s) >= 0
{
  if |s| != 0 {
    SumNonNegative(s[1..]);
  }
}

class Tally {
  var total: int

  function Peek(): int
  {
    0
  }

  method Bump()
  {
  }
}
