lemma Main()
  ensures 0 == 0
{
  var c := '}';
  var text := "{";
  var x' := '{';
  assert c != x'; // } in prose is inert
}

lemma Helper()
  ensures true
{
}
