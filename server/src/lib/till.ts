/**
 * What should be in the drawer.
 *
 * The whole point of opening and closing a till is this one subtraction: what
 * was counted, less what the software says should be there. A shop discovers
 * pilferage, a mis-keyed bill or a forgotten payout from that number and from
 * nothing else.
 *
 * It is only meaningful if the opening float was recorded. A session that was
 * created by the first sale of the day — because nobody opened the till — has
 * no float to speak of, and its variance says more about the formality being
 * skipped than about the cash. That case is carried through explicitly rather
 * than being quietly treated as a float of zero.
 */

export type TillComponents = {
  /** Cash put in the drawer at the start, in paise. */
  opening_float_paise: number;
  /** Cash taken over the counter for bills rung up in this session. */
  cash_sales_paise: number;
  /** Cash handed back for returns against those bills. */
  cash_refunds_paise: number;
  /** Cash received against a customer's outstanding account. */
  cash_receipts_paise: number;
  /** Cash added to the drawer for any other reason — change brought in. */
  pay_in_paise: number;
  /** Cash removed — a supplier paid in cash, takings sent to the bank. */
  pay_out_paise: number;
};

/** What the drawer should hold, in paise. Never negative in practice, but a
 *  shop that pays out more than it took in should see that honestly. */
export function expectedCashPaise(c: TillComponents): number {
  return c.opening_float_paise
    + c.cash_sales_paise
    - c.cash_refunds_paise
    + c.cash_receipts_paise
    + c.pay_in_paise
    - c.pay_out_paise;
}

/**
 * Counted minus expected.
 *
 * Positive means more cash than the books account for, which is not good news
 * either — usually a bill that was never rung up.
 */
export function variancePaise(countedPaise: number, expected: number): number {
  return countedPaise - expected;
}

/** Indian currency in circulation, largest first, for counting the drawer. */
export const DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

export type DenominationCount = Partial<Record<(typeof DENOMINATIONS)[number], number>>;

/**
 * Total a count of notes and coins, in paise.
 *
 * Counting by denomination rather than typing one figure is slower by a few
 * seconds and much harder to fudge: an arbitrary number can be made to match
 * the expected total, a count of notes has to be justified note by note.
 */
export function countTotalPaise(counts: DenominationCount): number {
  let paise = 0;
  for (const value of DENOMINATIONS) {
    const n = counts[value];
    if (!n || n < 0) continue;
    paise += Math.round(n) * value * 100;
  }
  return paise;
}

/**
 * How the variance should be described to whoever is closing the till.
 *
 * Rupee amounts are what a shopkeeper reasons in, and a variance of a few
 * rupees on a day of thousands is rounding and small change, not theft. Saying
 * so keeps the alarm meaningful when it does matter.
 */
export function describeVariance(variance: number): {
  severity: 'balanced' | 'minor' | 'significant';
  text: string;
} {
  if (variance === 0) return { severity: 'balanced', text: 'The drawer balances exactly.' };

  const rupees = Math.abs(variance) / 100;
  const short = variance < 0;
  const amount = `₹${rupees.toFixed(2)}`;

  if (rupees <= 10) {
    return {
      severity: 'minor',
      text: short
        ? `${amount} short — small change, worth noting but not chasing.`
        : `${amount} over — small change, worth noting but not chasing.`,
    };
  }
  return {
    severity: 'significant',
    text: short
      ? `${amount} short. Check for a bill taken in cash but rung up as UPI, or a payout nobody recorded.`
      : `${amount} over. Usually money taken without a bill being raised — find the sale before closing.`,
  };
}
