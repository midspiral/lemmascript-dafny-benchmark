/** Flag parsing shared by the two entry points. */

export function flag(name: string, fallback?: string): string | undefined {
  const hit = process.argv.slice(2).find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return fallback;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

export function boolFlag(name: string): boolean {
  return flag(name) !== undefined;
}
