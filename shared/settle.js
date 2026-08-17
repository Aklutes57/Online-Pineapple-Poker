// Settle-up: the minimum set of payments that squares everyone up.
// Shared by the server (stats/exports) and the browser (ledger panel).

// rows: [{ nickname, realName?, net }]. Returns [{ from, to, amount }].
// Repeatedly matches the biggest debtor against the biggest creditor, which
// produces at most (participants - 1) payments — the fewest transfers people
// can actually settle with.
//
// Names here are the ones money changes hands under, so a player who gave a
// real name is settled up under it rather than under their table username.
const payee = (r) => r.realName || r.nickname;

export function settleUp(rows) {
  const debtors = rows
    .filter((r) => r.net < 0)
    .map((r) => ({ name: payee(r), amount: -r.net }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const creditors = rows
    .filter((r) => r.net > 0)
    .map((r) => ({ name: payee(r), amount: r.net }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));

  const payments = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    if (amount > 0) payments.push({ from: debtors[i].name, to: creditors[j].name, amount });
    debtors[i].amount -= amount;
    creditors[j].amount -= amount;
    if (debtors[i].amount === 0) i++;
    if (creditors[j].amount === 0) j++;
  }
  return payments;
}
