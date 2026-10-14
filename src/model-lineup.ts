import type { ChatModel } from "./chat-types.js";

// Splits a provider's catalog into the newest model of each family and the
// older versions it supersedes, e.g. "Claude Opus 5.5" retires "Claude Opus 4.8".
// Names without a version number are always current.
export function modelLineup(models: ChatModel[]) {
  const parse = (name: string) => {
    const match = name.match(/\d+(?:\.\d+)*/);
    if (!match) return undefined;
    return {
      family: name
        .replace(match[0], " ")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .join(" "),
      version: match[0].split(".").map(Number),
    };
  };
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
    return 0;
  };
  const newest = new Map<string, number[]>();
  for (const m of models) {
    const p = parse(m.name);
    if (!p) continue;
    const best = newest.get(p.family);
    if (!best || compare(p.version, best) > 0) newest.set(p.family, p.version);
  }
  const current: ChatModel[] = [];
  const older: ChatModel[] = [];
  for (const m of models) {
    const p = parse(m.name);
    if (p && compare(p.version, newest.get(p.family)!) < 0) older.push(m);
    else current.push(m);
  }
  return { current, older };
}
