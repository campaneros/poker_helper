"""Glue: request -> equity vs ranges -> network advice."""
import random

from .cards import parse
from .equity import simulate
from .icm import bubble_factor
from .model import predict
from .opponents import fold_to_bet, range_fraction
from .policy import RAISE, CALL, State, bet_amount

_STREET = {0: 0, 3: 1, 4: 2, 5: 3}


def _label(s: State, cls: int, frac: float) -> tuple[str, float]:
    call = min(s.to_call, s.stack)
    if cls == RAISE:
        b = bet_amount(s, frac)
        total = call + b
        if total >= s.stack * 0.9:
            return "all-in", s.stack
        name = "raise" if s.to_call > 0 else "bet"
        return name, round(total)
    if cls == CALL:
        return "call", call
    return ("fold" if s.to_call > 0 else "check"), 0.0


def advise(req: dict, store, rng: random.Random | None = None) -> dict:
    hero = [parse(c) for c in req["hero"]]
    board = [parse(c) for c in req["board"]]
    street = _STREET[len(board)]
    fracs, aggr, folds, used = [], [], [], []
    for o in req["opponents"]:
        st = store.get_stats(o.get("player_id"))
        for k in ("vpip", "pfr", "af"):
            if o.get(k) is not None:
                st[k] = o[k]
        st["pfr"] = min(st["pfr"], st["vpip"])
        f = range_fraction(st, street, o["action"], o.get("bet_frac", 0.6))
        fracs.append(f); aggr.append(st["af"]); folds.append(fold_to_bet(st))
        used.append({"player_id": o.get("player_id"), "range_pct": round(f * 100, 1),
                     "style": st.get("style"), "hands": st.get("hands", 0)})
    sim = simulate(hero, board, fracs, budget=req.get("budget", 0.8), rng=rng)

    bf = 1.0
    t = req.get("tournament")
    if t:
        bf = bubble_factor(t["stacks"], t["payouts"], hero=0,
                           risk=min(req["to_call"], req["stack"]) or req["stack"])
    s = State(equity=sim["equity"], pot=req["pot"], to_call=req["to_call"], stack=req["stack"],
              bb=req["bb"], n_opp=len(fracs), street=street, position=req["position"],
              opp_range=sum(fracs) / len(fracs), opp_aggr=sum(aggr) / len(aggr), bf=bf,
              pot_limit=req["structure"] == "pot_limit",
              opp_ranges=tuple(fracs), opp_aggrs=tuple(aggr), opp_folds=tuple(folds))
    pred = predict(s)
    probs = pred["probs"]
    cls = max(range(3), key=probs.__getitem__)
    action, amount = _label(s, cls, pred["size_frac"])
    t_probs = pred["teacher"]["evs"]
    return {
        "equity": sim["equity"], "win": sim["win"], "sims": sim["sims"],
        "categories": sim["categories"],
        "advice": {"action": action, "amount": amount,
                   "probs": {"fold_check": probs[0], "call": probs[1], "raise": probs[2]},
                   "evs": [None if e == float("-inf") else e for e in t_probs],
                   "source": pred["source"], "bubble_factor": bf},
        "opponents": used,
    }
