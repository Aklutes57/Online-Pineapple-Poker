import { randomInt } from 'node:crypto';

// Cards travel as 2-char strings like 'As', 'Td', '2c'.
// Internally an integer form rank*4+suit is used by the evaluator
// (rank 0 = deuce ... 12 = ace; suit 0=c 1=d 2=h 3=s).

export const RANK_CHARS = '23456789TJQKA';
export const SUIT_CHARS = 'cdhs';

export function toInt(str) {
  const rank = RANK_CHARS.indexOf(str[0]);
  const suit = SUIT_CHARS.indexOf(str[1]);
  if (rank < 0 || suit < 0) throw new Error(`bad card: ${str}`);
  return rank * 4 + suit;
}

export function toStr(int) {
  return RANK_CHARS[int >> 2] + SUIT_CHARS[int & 3];
}

export function rankOf(int) {
  return int >> 2;
}

export function suitOf(int) {
  return int & 3;
}

export function freshDeck() {
  const deck = [];
  for (let r = 0; r < 13; r++) {
    for (let s = 0; s < 4; s++) deck.push(RANK_CHARS[r] + SUIT_CHARS[s]);
  }
  return deck;
}

export function shuffledDeck(rng = randomInt) {
  const deck = freshDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
