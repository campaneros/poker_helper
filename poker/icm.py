"""Malmuth-Harville ICM and the bubble factor used to price risk in tournaments."""
from functools import lru_cache


def icm_equity(stacks, payouts):
    n = len(stacks)
    pays = list(payouts) + [0.0] * (n - len(payouts))

    @lru_cache(maxsize=None)
    def rec(mask):  # mask = players still alive
        alive = [i for i in range(n) if mask >> i & 1]
        place = n - len(alive)
        total = sum(stacks[i] for i in alive)
        out = {i: 0.0 for i in alive}
        if len(alive) == 1:
            out[alive[0]] = pays[place]
            return out
        for j in alive:
            p = stacks[j] / total if total > 0 else 1 / len(alive)
            if p == 0:
                continue
            rest = rec(mask & ~(1 << j))
            for i in alive:
                out[i] += p * (pays[place] if i == j else rest[i])
        return out

    res = rec((1 << n) - 1)
    return [res[i] for i in range(n)]


def bubble_factor(stacks, payouts, hero=0, risk=None, cap=4.0):
    """Ratio of $ lost when losing a coin-flip pot vs $ gained when winning it,
    against the largest other stack. 1.0 = chip EV (cash game)."""
    others = [i for i in range(len(stacks)) if i != hero]
    if not others:
        return 1.0
    vil = max(others, key=lambda i: stacks[i])
    r = min(risk if risk is not None else stacks[hero], stacks[hero], stacks[vil])
    if r <= 0:
        return 1.0
    now = icm_equity(stacks, payouts)[hero]
    lose, win = list(stacks), list(stacks)
    lose[hero] -= r; lose[vil] += r
    win[hero] += r; win[vil] -= r
    gain = icm_equity(win, payouts)[hero] - now
    loss = now - icm_equity(lose, payouts)[hero]
    if gain <= 1e-9:
        return cap
    return max(1.0, min(cap, loss / gain))
