import random
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from poker.advisor import advise
from poker.cards import parse
from poker.opponents import Store

ROOT = Path(__file__).resolve().parent.parent
store = Store(ROOT / "data" / "players.json")
app = FastAPI(title="Poker Advisor")


class Opp(BaseModel):
    player_id: str | None = None
    action: Literal["none", "call", "bet", "raise"] = "none"
    bet_frac: float = Field(0.6, ge=0, le=10)
    vpip: float | None = Field(None, ge=0, le=1)
    pfr: float | None = Field(None, ge=0, le=1)
    af: float | None = Field(None, ge=0, le=20)


class Tournament(BaseModel):
    stacks: list[float] = Field(min_length=2, max_length=9)  # hero first
    payouts: list[float] = Field(min_length=1, max_length=9)


class AdviseReq(BaseModel):
    hero: list[str]
    board: list[str] = []
    structure: Literal["no_limit", "pot_limit"] = "no_limit"
    bb: float = Field(gt=0)
    pot: float = Field(ge=0)
    to_call: float = Field(0, ge=0)
    stack: float = Field(gt=0)
    position: float = Field(0.5, ge=0, le=1)
    opponents: list[Opp] = Field(min_length=1, max_length=9)
    tournament: Tournament | None = None
    budget: float = Field(0.8, gt=0, le=5)

    @model_validator(mode="after")
    def _check(self):
        if len(self.hero) != 2 or len(self.board) not in (0, 3, 4, 5):
            raise ValueError("servono 2 carte hero e board di 0, 3, 4 o 5 carte")
        cards = [parse(c) for c in self.hero + self.board]  # ValueError on bad card
        if len(set(cards)) != len(cards):
            raise ValueError("carte duplicate")
        return self


class NewPlayer(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class HandRecord(BaseModel):
    vpip: bool = False
    pfr: bool = False
    bets: int = Field(0, ge=0, le=50)
    calls: int = Field(0, ge=0, le=50)


def _player(p):
    return {"id": p.id, "name": p.name, **p.stats()}


@app.post("/api/advise")
def api_advise(req: AdviseReq):
    return advise(req.model_dump(), store, random.Random())


@app.get("/api/players")
def list_players():
    return [_player(p) for p in store.players.values()]


@app.post("/api/players")
def add_player(body: NewPlayer):
    return _player(store.add(body.name.strip()))


@app.delete("/api/players/{pid}")
def delete_player(pid: str):
    if not store.remove(pid):
        raise HTTPException(404, "giocatore non trovato")
    return {"ok": True}


@app.post("/api/players/{pid}/hand")
def record_hand(pid: str, body: HandRecord):
    p = store.record_hand(pid, body.vpip, body.pfr, body.bets, body.calls)
    if p is None:
        raise HTTPException(404, "giocatore non trovato")
    return _player(p)


app.mount("/", StaticFiles(directory=ROOT / "app" / "static", html=True), name="static")
