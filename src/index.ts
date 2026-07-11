/**
 * compounded-sofr — SOFR (and other RFR) compounding-in-arrears math.
 *
 * Implements the ARRC/ISDA conventions for compounding a daily risk-free rate
 * over an interest period: the compounded average, daily-simple accrual, the
 * SOFR Index method, and the lookback / observation-shift / lockout
 * conventions. Reproduces the New York Fed's published SOFR Index and 30/90/
 * 180-day averages.
 *
 * Rates are percents (3.53 = 3.53%), matching the NY Fed Markets Data API.
 * A daily observation is `{ date: "YYYY-MM-DD", rate }` for one business day;
 * SOFR only publishes on business days, so a Friday rate carries three
 * calendar days of weight automatically.
 */

export interface RateObservation {
  /** Business day the rate is effective (YYYY-MM-DD). */
  date: string;
  /** The rate for that day, as a percent (e.g. 3.53). */
  rate: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

function parse(dateStr: string, label: string): number {
  if (!DATE_RE.test(dateStr)) {
    throw new RangeError(`Invalid ${label}: "${dateStr}" (expected YYYY-MM-DD)`);
  }
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(t)) throw new RangeError(`Invalid calendar date for ${label}: "${dateStr}"`);
  return t;
}

function daysBetween(a: string, b: string): number {
  return Math.round((parse(b, "date") - parse(a, "date")) / MS_PER_DAY);
}

/** One weighted period in a compounding: a rate applied for a number of calendar days. */
export interface WeightedRate {
  /** Rate as a percent. */
  rate: number;
  /** Calendar days the rate applies (Friday → 3, accounting for the weekend). */
  days: number;
}

/**
 * The compounding primitive: compound a sequence of (rate, days) periods
 * in-arrears and annualize on a 360-day basis.
 *
 * `[∏ (1 + rate_i/100 × days_i/360) − 1] × 360 / Σ days_i`, returned as a percent.
 */
export function compoundInArrears(periods: readonly WeightedRate[]): number {
  if (periods.length === 0) throw new RangeError("compoundInArrears requires at least one period");
  let product = 1;
  let totalDays = 0;
  for (const p of periods) {
    if (!Number.isFinite(p.rate)) throw new RangeError(`Invalid rate: ${p.rate}`);
    if (!Number.isInteger(p.days) || p.days <= 0) {
      throw new RangeError(`days must be a positive integer, got ${p.days}`);
    }
    product *= 1 + (p.rate / 100) * (p.days / 360);
    totalDays += p.days;
  }
  return (product - 1) * (360 / totalDays) * 100;
}

/**
 * Non-compounded (daily simple) average: `Σ(rate_i × days_i) / Σ days_i`.
 * The alternative accrual method allowed by the ARRC conventions.
 */
export function dailySimpleAverage(periods: readonly WeightedRate[]): number {
  if (periods.length === 0) throw new RangeError("dailySimpleAverage requires at least one period");
  let weighted = 0;
  let totalDays = 0;
  for (const p of periods) {
    if (!Number.isInteger(p.days) || p.days <= 0) {
      throw new RangeError(`days must be a positive integer, got ${p.days}`);
    }
    weighted += p.rate * p.days;
    totalDays += p.days;
  }
  return weighted / totalDays;
}

/**
 * The SOFR-Index method — the exact, path-independent way to get the
 * compounded average between two dates from the published SOFR Index:
 * `(indexEnd / indexStart − 1) × 360 / days`, returned as a percent.
 *
 * ```ts
 * averageFromIndex(1.24986240, 1.25036103, 30); // ≈ the NY Fed's published 30-day average
 * ```
 */
export function averageFromIndex(startIndex: number, endIndex: number, days: number): number {
  if (!Number.isFinite(startIndex) || startIndex <= 0) {
    throw new RangeError(`Invalid startIndex: ${startIndex}`);
  }
  if (!Number.isFinite(endIndex) || endIndex <= 0) {
    throw new RangeError(`Invalid endIndex: ${endIndex}`);
  }
  if (!Number.isInteger(days) || days <= 0) throw new RangeError(`Invalid days: ${days}`);
  return (endIndex / startIndex - 1) * (360 / days) * 100;
}

/**
 * Compound a daily observation series forward into an index, seeded at
 * `startIndex` on the first observation's date. Each business day's rate
 * accrues over the calendar days until the next observation:
 * `index_{i+1} = index_i × (1 + rate_i/100 × n_i/360)`. Returns the index
 * value as of the last observation's date.
 *
 * Reproduces the NY Fed's published SOFR Index (which is seeded at
 * 1.00000000 on 2018-04-02) to 1e-8.
 */
export function indexFromRates(
  observations: readonly RateObservation[],
  startIndex = 1,
): number {
  if (observations.length < 2) {
    throw new RangeError("indexFromRates requires at least two observations");
  }
  const sorted = sortObservations(observations);
  let index = startIndex;
  for (let i = 0; i < sorted.length - 1; i++) {
    const n = daysBetween(sorted[i]!.date, sorted[i + 1]!.date);
    if (n <= 0) throw new RangeError(`Non-increasing observation dates near ${sorted[i]!.date}`);
    index *= 1 + (sorted[i]!.rate / 100) * (n / 360);
  }
  return index;
}

export type Convention =
  | { type: "plain" }
  | { type: "lookback"; businessDays: number }
  | { type: "observationShift"; businessDays: number }
  | { type: "lockout"; businessDays: number };

export interface CompoundedSofrParams {
  /**
   * Daily rate observations, one per business day. Must cover the interest
   * period and, for lookback/observation-shift, `businessDays` prior business
   * days as well.
   */
  observations: readonly RateObservation[];
  /** Interest period start (inclusive), YYYY-MM-DD, a business day in `observations`. */
  start: string;
  /** Interest period end (exclusive), YYYY-MM-DD, a business day in `observations`. */
  end: string;
  /** Convention. Default `{ type: "plain" }`. */
  convention?: Convention;
}

function sortObservations(observations: readonly RateObservation[]): RateObservation[] {
  const out = observations.map((o) => {
    if (!DATE_RE.test(o.date)) throw new RangeError(`Invalid observation date: "${o.date}"`);
    if (!Number.isFinite(o.rate)) throw new RangeError(`Invalid rate on ${o.date}: ${o.rate}`);
    return o;
  });
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.date === out[i - 1]!.date) {
      throw new RangeError(`Duplicate observation date: ${out[i]!.date}`);
    }
  }
  return out;
}

/**
 * Build the weighted (rate, days) periods for an interest period under a
 * convention — the schedule that {@link compoundInArrears} consumes. Exposed
 * so callers can inspect or reuse the weighting.
 */
export function weightedRates(params: CompoundedSofrParams): WeightedRate[] {
  const convention = params.convention ?? { type: "plain" };
  const obs = sortObservations(params.observations);
  const dates = obs.map((o) => o.date);
  const rateByDate = new Map(obs.map((o) => [o.date, o.rate]));

  const startIdx = dates.indexOf(params.start);
  if (startIdx < 0) throw new RangeError(`start ${params.start} is not a business day in observations`);
  const endIdx = dates.indexOf(params.end);
  if (endIdx < 0) throw new RangeError(`end ${params.end} is not a business day in observations`);
  if (endIdx <= startIdx) throw new RangeError("end must be after start");

  // Business days that set a rate during the interest period: start .. end-1.
  const settingIdx: number[] = [];
  for (let i = startIdx; i < endIdx; i++) settingIdx.push(i);

  const shift =
    convention.type === "lookback" || convention.type === "observationShift"
      ? convention.businessDays
      : 0;
  if (shift < 0 || !Number.isInteger(shift)) {
    throw new RangeError(`businessDays must be a non-negative integer`);
  }

  const periods: WeightedRate[] = [];
  const lockoutN = convention.type === "lockout" ? convention.businessDays : 0;
  if (lockoutN < 0 || !Number.isInteger(lockoutN)) {
    throw new RangeError(`businessDays must be a non-negative integer`);
  }
  // Lockout freezes the rate for the last `lockoutN` business days to the rate
  // observed on the business day that is lockoutN days before the period end.
  const lockedFromIdx = endIdx - 1 - lockoutN;

  for (let k = 0; k < settingIdx.length; k++) {
    const i = settingIdx[k]!;

    // Determine which observation supplies the RATE.
    let rateIdx = i;
    if (convention.type === "lookback" || convention.type === "observationShift") {
      rateIdx = i - shift;
    } else if (convention.type === "lockout" && i > lockedFromIdx) {
      rateIdx = lockedFromIdx;
    }
    if (rateIdx < 0) {
      throw new RangeError(
        `Not enough prior observations for a ${shift}-business-day shift before ${params.start}`,
      );
    }
    const rate = rateByDate.get(dates[rateIdx]!)!;

    // Determine the calendar-day WEIGHT.
    let days: number;
    if (convention.type === "observationShift") {
      // Weight from the shifted (observation) period.
      const from = dates[i - shift]!;
      const to = dates[i - shift + 1]!;
      days = daysBetween(from, to);
    } else {
      // Weight from the interest period itself; last day extends to `end`.
      const from = dates[i]!;
      const to = k === settingIdx.length - 1 ? params.end : dates[i + 1]!;
      days = daysBetween(from, to);
    }
    periods.push({ rate, days });
  }
  return periods;
}

/**
 * Compounded SOFR-in-arrears for an interest period, as a percent.
 *
 * ```ts
 * compoundedSofr({ observations, start: "2026-06-10", end: "2026-07-10" });
 * // ≈ NY Fed's published 30-day SOFR average for 2026-07-10
 *
 * compoundedSofr({ observations, start, end, convention: { type: "lookback", businessDays: 5 } });
 * ```
 */
export function compoundedSofr(params: CompoundedSofrParams): number {
  return compoundInArrears(weightedRates(params));
}

/**
 * Interest accrued on a notional over the period: `notional × compounded/100 ×
 * totalDays/360`. `compounded` defaults to the plain compounded SOFR for the
 * period.
 */
export function accruedInterest(
  notional: number,
  params: CompoundedSofrParams,
): number {
  if (!Number.isFinite(notional) || notional < 0) {
    throw new RangeError(`Invalid notional: ${notional}`);
  }
  const periods = weightedRates(params);
  const rate = compoundInArrears(periods);
  const totalDays = periods.reduce((s, p) => s + p.days, 0);
  return notional * (rate / 100) * (totalDays / 360);
}

/**
 * Convert a compounded average rate to an ISDA-style fallback rate by adding
 * a fixed spread adjustment (in basis points). Both in/out are percents.
 */
export function withSpreadAdjustment(compoundedRate: number, spreadBps: number): number {
  if (!Number.isFinite(compoundedRate)) throw new RangeError(`Invalid rate: ${compoundedRate}`);
  if (!Number.isFinite(spreadBps)) throw new RangeError(`Invalid spreadBps: ${spreadBps}`);
  return compoundedRate + spreadBps / 100;
}
