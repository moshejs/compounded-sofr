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
    if (!Number.isFinite(p.rate)) throw new RangeError(`Invalid rate: ${p.rate}`);
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
 * // published index on 2026-06-09 and 2026-07-09 (30 calendar days apart)
 * averageFromIndex(1.24646364, 1.25023844, 30); // 3.634089… (published 30-day average: 3.63409)
 * ```
 *
 * The published index is rounded to 8 decimals, so this agrees with the NY
 * Fed's published averages (computed from the daily rates) to within about
 * 2e-5 percentage points, not always to the 5th decimal. Use
 * {@link sofrAverage} with the daily rates to reproduce them exactly.
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
 * Reproduces the NY Fed's published SOFR Index (seeded at 1.00000000 on
 * 2018-04-02): compounding the full daily history and rounding to 8 decimals
 * gives the published value. The index published on date D includes the
 * rate for the business day before D, so include D's observation (any rate)
 * as the last element to get D's index.
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

/**
 * Interest-period conventions (ARRC / ISDA 2021 / QuantLib):
 * - `plain` — each business day's own rate, interest-period weights.
 * - `lookback` — rate from `businessDays` business days earlier, weights from
 *   the interest period ("lookback without observation shift").
 * - `observationShift` — rates and weights both from the observation period
 *   shifted `businessDays` business days earlier.
 * - `lockout` — the last `businessDays` business days of the period reuse the
 *   rate of the business day just before them (QuantLib `lockoutDays`). An
 *   ARRC-style "Rate Cut-Off Date" N business days before the period end
 *   (rate of the cut-off date applies from it onward) is `businessDays: N − 1`.
 */
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
  /**
   * Interest period start (inclusive), YYYY-MM-DD. If it is not a business
   * day, the preceding business day's rate applies (must be in
   * `observations`). Must be a business day for `observationShift`.
   */
  start: string;
  /**
   * Interest period end (exclusive), YYYY-MM-DD. Its own rate is never used;
   * it need not be in `observations` (except for `observationShift`), but may
   * be at most 7 calendar days after the last observation.
   */
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
 * A period may run at most this many calendar days past the last observation
 * (so the NY Fed's average for date D can be computed from rates through
 * D − 1), guarding against silently truncated data.
 */
const MAX_TRAILING_GAP_DAYS = 7;

/**
 * Build the weighted (rate, days) periods for an interest period under a
 * convention — the schedule that {@link compoundInArrears} consumes. Exposed
 * so callers can inspect or reuse the weighting.
 *
 * `start` and `end` need not be business days (except under
 * `observationShift`): a calendar day that is not a business day takes the
 * rate of the preceding business day, as in the NY Fed's SOFR Averages.
 */
export function weightedRates(params: CompoundedSofrParams): WeightedRate[] {
  const convention = params.convention ?? { type: "plain" };
  const obs = sortObservations(params.observations);
  const dates = obs.map((o) => o.date);
  parse(params.start, "start");
  parse(params.end, "end");
  if (params.end <= params.start) throw new RangeError("end must be after start");

  const n =
    convention.type === "plain"
      ? 0
      : convention.type === "lookback" ||
          convention.type === "observationShift" ||
          convention.type === "lockout"
        ? convention.businessDays
        : Number.NaN;
  if (Number.isNaN(n)) {
    throw new RangeError(`Unknown convention type: ${(convention as { type: string }).type}`);
  }
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`businessDays must be a non-negative integer, got ${n}`);
  }

  // The business day whose rate is in force on `start`: `start` itself, or
  // the preceding business day when `start` is a weekend/holiday.
  let firstIdx = -1;
  for (let i = 0; i < dates.length && dates[i]! <= params.start; i++) firstIdx = i;
  if (firstIdx < 0) {
    throw new RangeError(`No observation on or before start ${params.start}`);
  }
  // The last business day that sets a rate inside [start, end).
  let lastIdx = firstIdx;
  while (lastIdx + 1 < dates.length && dates[lastIdx + 1]! < params.end) lastIdx++;
  const endIsObserved = dates[lastIdx + 1] === params.end;
  if (!endIsObserved && daysBetween(dates[lastIdx]!, params.end) > MAX_TRAILING_GAP_DAYS) {
    throw new RangeError(
      `Observations end on ${dates[lastIdx]}, more than ${MAX_TRAILING_GAP_DAYS} days before end ${params.end}`,
    );
  }

  if (convention.type === "observationShift") {
    // The observation period is defined in business days, so both ends must
    // be business days present in the series.
    if (dates[firstIdx] !== params.start) {
      throw new RangeError(`start ${params.start} is not a business day in observations`);
    }
    if (!endIsObserved) {
      throw new RangeError(`end ${params.end} is not a business day in observations`);
    }
  }

  // Business days that set a rate during the interest period.
  const settingIdx: number[] = [];
  for (let i = firstIdx; i <= lastIdx; i++) settingIdx.push(i);

  const shift = convention.type === "lookback" || convention.type === "observationShift" ? n : 0;
  const lockoutN = convention.type === "lockout" ? n : 0;
  if (lockoutN >= settingIdx.length && lockoutN > 0) {
    throw new RangeError(
      `lockout of ${lockoutN} business days must be shorter than the period's ${settingIdx.length} business days`,
    );
  }
  // Lockout freezes the rate for the last `lockoutN` business days to the rate
  // of the business day immediately before them (QuantLib's `lockoutDays`).
  const lockedFrom = settingIdx.length - lockoutN; // position of first locked day

  const periods: WeightedRate[] = [];
  for (let k = 0; k < settingIdx.length; k++) {
    const i = settingIdx[k]!;

    // Determine which observation supplies the RATE.
    let rateIdx = i - shift;
    if (lockoutN > 0 && k >= lockedFrom) rateIdx = settingIdx[lockedFrom - 1]!;
    if (rateIdx < 0) {
      throw new RangeError(
        `Not enough prior observations for a ${shift}-business-day shift before ${params.start}`,
      );
    }
    const rate = obs[rateIdx]!.rate;

    // Determine the calendar-day WEIGHT.
    let days: number;
    if (convention.type === "observationShift") {
      // Weight from the shifted (observation) period.
      days = daysBetween(dates[i - shift]!, dates[i - shift + 1]!);
    } else {
      // Weight from the interest period itself, clipped to [start, end).
      const from = k === 0 ? params.start : dates[i]!;
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
 * interestDays/360`, where `interestDays` is the calendar days in the interest
 * period `[start, end)` — also under `observationShift`, whose rate is
 * annualized over the observation period but accrues over the interest period.
 */
export function accruedInterest(
  notional: number,
  params: CompoundedSofrParams,
): number {
  if (!Number.isFinite(notional) || notional < 0) {
    throw new RangeError(`Invalid notional: ${notional}`);
  }
  const rate = compoundInArrears(weightedRates(params));
  return notional * (rate / 100) * (daysBetween(params.start, params.end) / 360);
}

/**
 * The NY Fed's published SOFR Average for `asOf` (30, 90 or 180 calendar
 * days, or any other window): compounded SOFR over `[asOf − calendarDays,
 * asOf)`, a non-business start day taking the preceding business day's rate,
 * rounded to 5 decimals as published. Needs observations from the business
 * day on or before the window start through at least the business day before
 * `asOf`.
 *
 * ```ts
 * sofrAverage(observations, "2026-07-09", 30); // 3.63409
 * ```
 */
export function sofrAverage(
  observations: readonly RateObservation[],
  asOf: string,
  calendarDays: number,
): number {
  if (!Number.isInteger(calendarDays) || calendarDays <= 0) {
    throw new RangeError(`Invalid calendarDays: ${calendarDays}`);
  }
  const start = new Date(parse(asOf, "asOf") - calendarDays * MS_PER_DAY).toISOString().slice(0, 10);
  const rate = compoundedSofr({ observations, start, end: asOf });
  return Math.round(rate * 1e5) / 1e5;
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
