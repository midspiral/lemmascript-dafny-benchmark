datatype Box = Box(x: int)

lemma Main(b: Box)
  ensures (match b { case Box(x) => x == x })
  ensures true
{
  assert true;
}

lemma Helper()
  ensures true
{
}
