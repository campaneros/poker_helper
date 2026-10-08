/** Cards (0..51 = rank*4 + suit) and a 5-7 card hand evaluator (higher score = better hand). */

export type Card = number;
export const RANKS = "23456789TJQKA";
export const SUITS = "shdc";
export const DECK: readonly Card[] = Array.from({ length: 52 }, (_, i) => i);

export const rankOf = (c: Card): number => c >> 2;
export const suitOf = (c: Card): number => c & 3;

/** 'As', 'td', '10h' -> Card. Throws on invalid input. */
export function parse(text: string): Card {
  let s = text.trim();
  if (s.length === 3 && s.startsWith("10")) s = "T" + s[2];
  const rank = RANKS.indexOf((s[0] ?? "").toUpperCase());
  const suit = SUITS.indexOf((s[1] ?? "").toLowerCase());
  if (s.length !== 2 || rank < 0 || suit < 0) throw new Error(`carta non valida: ${text}`);
  return rank * 4 + suit;
}

export const format = (c: Card): string => RANKS[rankOf(c)] + SUITS[suitOf(c)];

/** Python/treys integer encoding -> Card. Only used to read the golden vectors. */
export function fromTreys(t: number): Card {
  const rank = (t >> 8) & 0xf;
  const suit = Math.log2((t >> 12) & 0xf); // treys: s=1 h=2 d=4 c=8
  return rank * 4 + suit;
}

const CAT = 0x100000; // category weight: kickers are packed in 4-bit nibbles below it
// mask of distinct ranks -> high card of the best straight (wheel = 3), or -1
const STRAIGHT = new Int8Array(8192).fill(-1);
for (let m = 0; m < 8192; m++) {
  for (let hi = 12; hi >= 4; hi--) {
    if (((m >> (hi - 4)) & 31) === 31) { STRAIGHT[m] = hi; break; }
  }
  if (STRAIGHT[m] < 0 && (m & 0x100f) === 0x100f) STRAIGHT[m] = 3;
}

/** Top `n` ranks of `mask` (excluding `exclude`), packed as nibbles, zero-padded. */
function topRanks(mask: number, n: number, exclude: number): number {
  let out = 0, k = 0;
  for (let r = 12; r >= 0 && k < n; r--) {
    if ((mask >> r) & 1 && !((exclude >> r) & 1)) { out = out * 16 + r; k++; }
  }
  while (k++ < n) out *= 16;
  return out;
}

const rankCount = new Int8Array(13);
const suitMask = new Int32Array(4);
const suitCount = new Int8Array(4);

/** Score of the best 5-card hand among `n` (5..7) cards. Not re-entrant (shared scratch buffers). */
export function evaluate(cards: ArrayLike<Card>, n: number = cards.length): number {
  rankCount.fill(0); suitMask.fill(0); suitCount.fill(0);
  for (let i = 0; i < n; i++) {
    const r = cards[i] >> 2, s = cards[i] & 3;
    rankCount[r]++; suitMask[s] |= 1 << r; suitCount[s]++;
  }
  let flush = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s] >= 5) flush = s;
  if (flush >= 0) {
    const h = STRAIGHT[suitMask[flush]];
    if (h >= 0) return 8 * CAT + h;
  }
  let quad = -1, trip = -1, pair1 = -1, pair2 = -1, mask = 0;
  for (let r = 12; r >= 0; r--) {
    const c = rankCount[r];
    if (c) mask |= 1 << r;
    if (c === 4) quad = r;
    else if (c === 3 && trip < 0) trip = r;
    else if (c >= 2) { // a pair, or a second set of trips playing as the pair of a full house
      if (pair1 < 0) pair1 = r; else if (pair2 < 0) pair2 = r;
    }
  }
  if (quad >= 0) return 7 * CAT + quad * 16 + topRanks(mask, 1, 1 << quad);
  if (trip >= 0 && pair1 >= 0) return 6 * CAT + trip * 16 + pair1;
  if (flush >= 0) return 5 * CAT + topRanks(suitMask[flush], 5, 0);
  const straight = STRAIGHT[mask];
  if (straight >= 0) return 4 * CAT + straight;
  if (trip >= 0) return 3 * CAT + trip * 256 + topRanks(mask, 2, 1 << trip);
  if (pair2 >= 0) return 2 * CAT + (pair1 * 16 + pair2) * 16 + topRanks(mask, 1, (1 << pair1) | (1 << pair2));
  if (pair1 >= 0) return 1 * CAT + pair1 * 4096 + topRanks(mask, 3, 1 << pair1);
  return topRanks(mask, 5, 0);
}

/** treys-compatible hand class: 1 = straight flush ... 9 = high card. */
export const handClass = (score: number): number => 9 - Math.floor(score / CAT);
