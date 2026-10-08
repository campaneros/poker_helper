/** Malmuth-Harville ICM and the bubble factor used to price risk in tournaments. */

export function icmEquity(stacks: readonly number[], payouts: readonly number[]): number[] {
  const n = stacks.length;
  const pays = [...payouts, ...Array<number>(Math.max(0, n - payouts.length)).fill(0)];
  const memo = new Map<number, number[]>();

  const rec = (mask: number): number[] => {
    const cached = memo.get(mask);
    if (cached) return cached;
    const alive: number[] = [];
    for (let i = 0; i < n; i++) if ((mask >> i) & 1) alive.push(i);
    const place = n - alive.length;
    const out = Array<number>(n).fill(0);
    if (alive.length === 1) {
      out[alive[0]] = pays[place];
    } else {
      const total = alive.reduce((sum, i) => sum + stacks[i], 0);
      for (const j of alive) {
        const p = total > 0 ? stacks[j] / total : 1 / alive.length;
        if (p === 0) continue;
        const rest = rec(mask & ~(1 << j));
        for (const i of alive) out[i] += p * (i === j ? pays[place] : rest[i]);
      }
    }
    memo.set(mask, out);
    return out;
  };

  return rec((1 << n) - 1);
}

/** Ratio of $ lost when losing a coin-flip pot vs $ gained when winning it, against the largest other
 * stack. 1.0 = chip EV (cash game). */
export function bubbleFactor(
  stacks: readonly number[], payouts: readonly number[], hero = 0, risk?: number, cap = 4,
): number {
  let villain = -1;
  for (let i = 0; i < stacks.length; i++) {
    if (i !== hero && (villain < 0 || stacks[i] > stacks[villain])) villain = i; // first max wins ties
  }
  if (villain < 0) return 1;
  const r = Math.min(risk ?? stacks[hero], stacks[hero], stacks[villain]);
  if (r <= 0) return 1;
  const now = icmEquity(stacks, payouts)[hero];
  const lose = [...stacks], win = [...stacks];
  lose[hero] -= r; lose[villain] += r;
  win[hero] += r; win[villain] -= r;
  const gain = icmEquity(win, payouts)[hero] - now;
  const loss = now - icmEquity(lose, payouts)[hero];
  if (gain <= 1e-9) return cap;
  return Math.max(1, Math.min(cap, loss / gain));
}
