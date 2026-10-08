"""Heads-up no-limit simulator: the advisor (hero) plays full hands against fixed bots.

Run: .venv/bin/python -m bench.sim --hands 600
Reports hero win-rate in bb/100 with a 95% confidence interval per bot.
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
from poker.opponents import range_fraction
from poker.policy import State
from poker.ranges import hand_pct

BB = 2
START = 200  # 100 bb
HERO_SIMS = 700
PRIOR = {"vpip": 0.28, "pfr": 0.15, "af": 1.5}
BOTS = ("station", "random", "tag")
_EVAL = Evaluator()


def _raise_to(bet, pot, to_call, frac):
    return max(bet) + max(BB, int(frac * (pot + to_call)))


# ---------- bots: ctx -> ("fold",) | ("call",) | ("raise", target_total_bet) ----------
def bot_station(ctx, rng):
    return ("call",)


def bot_random(ctx, rng):
    roll = rng.random()
    if ctx["to_call"] > 0 and roll < 0.33:
        return ("fold",)
    if roll > 0.66:
        return ("raise", _raise_to(ctx["bet"], ctx["pot"], ctx["to_call"], rng.choice((0.5, 1.0))))
    return ("call",)


def bot_tag(ctx, rng):
    hole, board, to_call, pot = ctx["hole"], ctx["board"], ctx["to_call"], ctx["pot"]
    if ctx["street"] == 0:
        pct = hand_pct(*hole)
        facing = max(ctx["bet"])
        if pct <= 0.12 and facing <= 3 * BB:
            return ("raise", 3 * BB if facing <= BB else 3 * facing)
        if pct <= 0.12 or (pct <= 0.35 and facing <= 3 * BB):
            return ("call",)
        return ("fold",) if to_call > 0 else ("call",)
    cls = _EVAL.get_rank_class(_EVAL.evaluate(board, hole))
    if cls <= 7:
        return ("raise", _raise_to(ctx["bet"], pot, to_call, 0.66)) if to_call == 0 else ("call",)
    if cls == 8:
        if to_call == 0:
            return ("raise", _raise_to(ctx["bet"], pot, to_call, 0.4))
        return ("call",) if to_call <= 0.7 * pot else ("fold",)
    if to_call == 0:
        return ("call",)
    return ("call",) if to_call <= 0.2 * pot else ("fold",)


BOT_FNS = {"station": bot_station, "random": bot_random, "tag": bot_tag}


# ---------- hero: the real advisor pipeline ----------
def hero_act(ctx, memory, rng):
    frac = range_fraction(PRIOR, ctx["street"], memory["last"], memory["frac"])
    sim = simulate(ctx["hole"], ctx["board"], [frac], n_sims=HERO_SIMS, budget=0.3,
                   rng=random.Random(rng.random()))
    s = State(equity=sim["equity"], pot=ctx["pot"], to_call=ctx["to_call"], stack=ctx["chips"],
              bb=BB, n_opp=1, street=ctx["street"], position=ctx["position"], opp_range=frac,
              opp_aggr=PRIOR["af"])
    pred = predict(s)
    cls = max(range(3), key=pred["probs"].__getitem__)
    action, amount = _label(s, cls, pred["size_frac"])
    if action == "fold":
        return ("fold",)
    if action in ("check", "call"):
        return ("call",)
    if action == "all-in":
        return ("raise", 10**9)
    return ("raise", ctx["bet"][0] + amount)


def play_hand(bot_name, rng, btn):
    """btn = index of the button/SB (0 = hero). Returns hero's net chips."""
    deck = FULL_DECK[:]
    rng.shuffle(deck)
    holes = [deck[0:2], deck[2:4]]
    full_board = deck[4:9]
    chips = [START, START]
    bet = [0, 0]
    for p, amt in ((btn, BB // 2), (1 - btn, BB)):
        chips[p] -= amt
        bet[p] += amt
    banked, folded = 0, None
    memory = {"last": "none", "frac": 0.6}
    for street in range(4):
        if street:
            banked += bet[0] + bet[1]
            bet = [0, 0]
            memory = {"last": "none", "frac": 0.6}
        if min(chips) <= 0:
            continue
        board = full_board[:[0, 3, 4, 5][street]]
        p = btn if street == 0 else 1 - btn
        acted, last_raise = [False, False], BB
        while folded is None:
            o = 1 - p
            if all(acted) and bet[0] == bet[1]:
                break
            if chips[p] == 0:
                acted[p] = True
                p = o
                continue
            to_call = max(bet) - bet[p]
            cap = min(bet[p] + chips[p], bet[o] + chips[o])
            ctx = {"hole": holes[p], "board": board, "street": street, "to_call": to_call,
                   "pot": banked + bet[0] + bet[1], "chips": chips[p], "bet": bet,
                   "position": 0.95 if p == btn else 0.0}
            act = hero_act(ctx, memory, rng) if p == 0 else BOT_FNS[bot_name](ctx, rng)
            if act[0] == "fold":
                folded = p
                break
            prev_max = max(bet)
            if act[0] == "raise" and cap > prev_max:
                target = min(max(act[1], prev_max + last_raise), cap)
                pot_now = banked + bet[0] + bet[1]
                chips[p] -= target - bet[p]
                bet[p] = target
                last_raise = max(last_raise, target - prev_max)
                acted = [False, False]
                if p == 1:
                    memory = {"last": "raise" if to_call > 0 else "bet",
                              "frac": (target - prev_max) / max(pot_now, 1)}
            else:
                pay = min(to_call, chips[p])
                chips[p] -= pay
                bet[p] += pay
                if p == 1 and to_call > 0:
                    memory = {"last": "call", "frac": memory["frac"]}
            acted[p] = True
            p = o
    pot = banked + bet[0] + bet[1]
    if folded is not None:
        chips[1 - folded] += pot
    else:
        s0 = _EVAL.evaluate(full_board, holes[0])
        s1 = _EVAL.evaluate(full_board, holes[1])
        if s0 < s1:
            chips[0] += pot
        elif s1 < s0:
            chips[1] += pot
        else:
            chips[0] += pot // 2
            chips[1] += pot - pot // 2
    assert sum(chips) == 2 * START, f"fiche non conservate: {chips}"
    return chips[0] - START


def run_chunk(args):
    bot_name, seed, n = args
    import torch
    torch.set_num_threads(1)
    rng = random.Random(seed)
    return [play_hand(bot_name, rng, i % 2) for i in range(n)]


def evaluate(bot_name, hands, workers, chunk=50):
    base = BOTS.index(bot_name) * 100_000
    jobs = [(bot_name, base + i, chunk) for i in range(hands // chunk)]
    with Pool(workers) as pool:
        nets = [x for part in pool.map(run_chunk, jobs) for x in part]
    mean = statistics.fmean(nets)
    half = 1.96 * statistics.stdev(nets) / math.sqrt(len(nets))
    return {"bot": bot_name, "hands": len(nets), "bb_per_100": mean / BB * 100,
            "ci95": half / BB * 100}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--hands", type=int, default=600)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--bots", nargs="+", default=list(BOTS), choices=BOTS)
    a = ap.parse_args()
    for name in a.bots:
        r = evaluate(name, a.hands, a.workers)
        print(f"{r['bot']:8s} {r['hands']} mani  {r['bb_per_100']:+8.1f} bb/100  (±{r['ci95']:.1f})", flush=True)
