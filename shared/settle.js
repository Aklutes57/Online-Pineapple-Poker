// Settle-up: the minimum set of payments that squares everyone up.
// Shared by the server (stats/exports) and the browser (ledger panel).

// rows: [{ playerId?, nickname, realName?, net }].
// Returns [{ from, to, amount, fromId, toId }].
// Repeatedly matches the biggest debtor against the biggest creditor, which
// produces at most (participants - 1) payments — the fewest transfers people
// can actually settle with.
//
// Names here are the ones money changes hands under, so a player who gave a
// real name is settled up under it rather than under their table username. A
// real name is free text and NOT unique, so the id travels with every payment:
// anything that sends actual money must key on that, never on the name.
const payee = (r) => r.realName || r.nickname;

export function settleUp(rows) {
  const side = (keep) => rows
    .filter(keep)
    .map((r) => ({ name: payee(r), id: r.playerId ?? null, amount: Math.abs(r.net) }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const debtors = side((r) => r.net < 0);
  const creditors = side((r) => r.net > 0);

  const payments = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    if (amount > 0) {
      payments.push({
        from: debtors[i].name, to: creditors[j].name, amount,
        fromId: debtors[i].id, toId: creditors[j].id,
      });
    }
    debtors[i].amount -= amount;
    creditors[j].amount -= amount;
    if (debtors[i].amount === 0) i++;
    if (creditors[j].amount === 0) j++;
  }
  return payments;
}
