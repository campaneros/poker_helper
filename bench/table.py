"""Multiway no-limit simulator (3-6 players, equal 100bb stacks) with stylised opponents.

Run: .venv/bin/python -m bench.table --hands 3000
Compares the advisor when it KNOWS each opponent's true stats vs when it assumes a neutral prior.
With equal starting stacks every all-in is for the same total, so no side pots are needed.
"""
import argparse
import math
import random
import statistics
from multiprocessing import Pool

from treys import Evaluator

from poker.advisor import _label
from poker.cards import FULL_DECK
from poker.equity import simulate
from poker.model import predict
from poker.opponents import fold_to_bet, range_fraction
from poker.policy import State
from poker.ranges import hand_pct

BB, START, HERO_SIMS = 2, 200, 500
PRIOR = {"vpip": 0.28, "pfr": 0.15, "af": 1.5}
STYLES = {  # true behaviour of each bot (also what a perfect tracker would learn)
    "nit": {"vpip": 0.15, "pfr": 0.12, "af": 2.0},
    "tag": {"vpip": 0.22, "pfr": 0.17, "af": 2.5},
    "lag": {"vpip": 0.40, "pfr": 0.30, "af": 3.0},
    "fish": {"vpip": 0.55, "pfr": 0.06, "af": 0.6},
    "maniac": {"vpip": 0.70, "pfr": 0.45, "af": 4.0},
}
LINEUPS = {
    "3-handed": ["fish", "lag"],
    "6-max": ["nit", "tag", "lag", "fish", "maniac"],
}
_EVAL = Evaluator()
PER_OPP = True  # False = old behaviour: only the mean range/aggression reaches the policy


def _target(bet, pot, to_call, frac):
    return max(bet) + max(BB, int(frac * (pot + to_call)))


def bot_act(style, ctx, rng):
    """Stylised player: ('fold',) | ('call',) | ('raise', target_total_bet)."""
    st = STYLES[style]
    hole, board, to_call, pot, bet = ctx["hole"], ctx["board"], ctx["to_call"], ctx["pot"], ctx["bet"]
    if ctx["street"] == 0:
        pct, facing = hand_pct(*hole), max(bet)
        raised = facing > BB
        if pct <= st["pfr"] * (0.5 if facing > 3 * BB else 1.0) and (not raised or rng.random() < 0.35):
            return ("raise", 3 * facing if raised else 3 * BB)
        if pct <= st["vpip"] and facing <= 4 * BB:
            return ("call",)
        return ("fold",) if to_call > 0 else ("call",)
    cls = _EVAL.get_rank_class(_EVAL.evaluate(board, hole))
    p_agg = st["af"] / (st["af"] + 1)
    if cls <= 6:  # strong made hand
        return ("raise", _target(bet, pot, to_call, 0.7)) if rng.random() < p_agg else ("call",)
    if cls <= 8:  # pair / two pair
        if to_call == 0:
            return ("raise", _target(bet, pot, to_call, 0.5)) if rng.random() < p_agg * 0.6 else ("call",)
        return ("call",) if (cls == 7 or st["vpip"] > 0.2) and to_call <= 0.8 * pot else ("fold",)
    if to_call == 0:  # air
        return ("raise", _target(bet, pot, to_call, 0.5)) if rng.random() < p_agg * 0.25 else ("call",)
    return ("call",) if rng.random() < st["vpip"] * 0.4 and to_call <= 0.3 * pot else ("fold",)


def hero_act(ctx, mem, styles, know, rng):  # rng: hero-only stream, keeps bots' dice unaffected
    opps = [i for i in ctx["live"] if i != 0]
    stats = [(STYLES[styles[i]] if know else PRIOR) for i in opps]
    fracs = [range_fraction(st, ctx["street"], mem[i]["last"], mem[i]["frac"]) for st, i in zip(stats, opps)]
    sim = simulate(ctx["hole"], ctx["board"], fracs, n_sims=HERO_SIMS, budget=0.4,
                   rng=random.Random(rng.random()))
    s = State(equity=sim["equity"], pot=ctx["pot"], to_call=ctx["to_call"], stack=ctx["chips"], bb=BB,
              n_opp=len(opps), street=ctx["street"], position=ctx["position"],
              opp_range=sum(fracs) / len(fracs), opp_aggr=sum(st["af"] for st in stats) / len(stats),
              opp_ranges=tuple(fracs) if PER_OPP else (), opp_aggrs=tuple(st["af"] for st in stats) if PER_OPP else (),
              opp_folds=tuple(fold_to_bet(st) for st in stats) if PER_OPP else ())
    pred = predict(s)
    action, amount = _label(s, max(range(3), key=pred["probs"].__getitem__), pred["size_frac"])
    if action == "fold":
        return ("fold",)
    if action in ("check", "call"):
        return ("call",)
    return ("raise", 10**9 if action == "all-in" else ctx["bet"][0] + amount)


def play_table(styles, know, rng, btn, hrng=None):
    """styles[0] is the hero (None). Returns hero's net chips."""
    n = len(styles)
    deck = FULL_DECK[:]
    rng.shuffle(deck)
    holes = [deck[2 * i:2 * i + 2] for i in range(n)]
    full_board = deck[2 * n:2 * n + 5]
    chips, bet, folded = [START] * n, [0] * n, [False] * n
    sb, bbp = (btn + 1) % n, (btn + 2) % n
    for p, amt in ((sb, BB // 2), (bbp, BB)):
        chips[p] -= amt
        bet[p] += amt
    banked = 0
    mem = [{"last": "none", "frac": 0.6} for _ in range(n)]
    for street in range(4):
        if street:
            banked += sum(bet)
            bet = [0] * n
            mem = [{"last": "none", "frac": 0.6} for _ in range(n)]
        if sum(not f for f in folded) == 1 or sum(1 for i in range(n) if not folded[i] and chips[i] > 0) < 2:
            continue
        board = full_board[:[0, 3, 4, 5][street]]
        p = (bbp + 1) % n if street == 0 else (btn + 1) % n
        acted, last_raise = [False] * n, BB
        while True:
            live = [i for i in range(n) if not folded[i]]
            if len(live) == 1:
                break
            need = [i for i in live if chips[i] > 0 and (not acted[i] or bet[i] < max(bet))]
            if not need:
                break
            while p not in need:
                p = (p + 1) % n
            order = [i for i in live if i in need or acted[i]]
            to_call, prev_max = max(bet) - bet[p], max(bet)
            ctx = {"hole": holes[p], "board": board, "street": street, "to_call": to_call,
                   "pot": banked + sum(bet), "chips": chips[p], "bet": bet, "live": live,
                   "position": order.index(p) / max(len(order) - 1, 1) if p in order else 1.0}
            act = hero_act(ctx, mem, styles, know, hrng or rng) if p == 0 else bot_act(styles[p], ctx, rng)
            cap = bet[p] + chips[p]
            if act[0] == "fold" and to_call > 0:
                folded[p] = True
            elif act[0] == "raise" and cap > prev_max:
                target = min(max(act[1], prev_max + last_raise), cap)
                pot_now = banked + sum(bet)
                chips[p] -= target - bet[p]
                bet[p] = target
                last_raise = max(last_raise, target - prev_max)
                acted = [False] * n
                mem[p] = {"last": "raise" if to_call > 0 else "bet", "frac": (target - prev_max) / max(pot_now, 1)}
            else:
                pay = min(to_call, chips[p])
                chips[p] -= pay
                bet[p] += pay
                if to_call > 0:
                    mem[p] = {"last": "call", "frac": mem[p]["frac"]}
            acted[p] = True
            p = (p + 1) % n
    pot = banked + sum(bet)
    live = [i for i in range(n) if not folded[i]]
    if len(live) == 1:
        chips[live[0]] += pot
    else:
        scores = {i: _EVAL.evaluate(full_board, holes[i]) for i in live}
        best = min(scores.values())
        winners = [i for i in live if scores[i] == best]
        for k, w in enumerate(winners):
            chips[w] += pot // len(winners) + (1 if k < pot % len(winners) else 0)
    assert sum(chips) == n * START, f"fiche non conservate: {chips}"
    return chips[0] - START


def run_chunk(args):
    lineup, know, seed, n, per_opp = args
    import torch
    torch.set_num_threads(1)
    global PER_OPP
    PER_OPP = per_opp
    styles = [None] + lineup
    return [play_table(styles, know, random.Random(seed * 1000 + i), i % len(styles),
                       random.Random(seed * 1000 + i + 500_000)) for i in range(n)]


def evaluate(name, know, hands, workers, per_opp=True, chunk=50):
    base = 1000 * list(LINEUPS).index(name)  # same deals for every condition: paired comparison
    jobs = [(LINEUPS[name], know, base + i, chunk, per_opp) for i in range(hands // chunk)]
    with Pool(workers) as pool:
        nets = [x for part in pool.map(run_chunk, jobs) for x in part]
    return {"hands": len(nets), "bb100": statistics.fmean(nets) / BB * 100,
            "ci": 1.96 * statistics.stdev(nets) / math.sqrt(len(nets)) / BB * 100, "nets": nets}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--hands", type=int, default=3000)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--mean-only", action="store_true", help="policy sees only the mean opponent range")
    a = ap.parse_args()
    for name in LINEUPS:
        res = {}
        for know in (False, True):
            r = res[know] = evaluate(name, know, a.hands, a.workers, per_opp=not a.mean_only)
            label = "conosce i profili" if know else "profilo neutro   "
            print(f"{name:9s} {label} {r['hands']} mani {r['bb100']:+8.1f} bb/100 (±{r['ci']:.1f})", flush=True)
        d = [k - n for k, n in zip(res[True]["nets"], res[False]["nets"])]  # paired difference per hand
        print(f"{name:9s} valore dei profili: {statistics.fmean(d) / BB * 100:+.1f} bb/100 "
              f"(±{1.96 * statistics.stdev(d) / math.sqrt(len(d)) / BB * 100:.1f}, appaiato)", flush=True)
