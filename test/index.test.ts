import { describe, expect, it } from "vitest";
import {
  accruedInterest,
  averageFromIndex,
  compoundInArrears,
  compoundedSofr,
  dailySimpleAverage,
  indexFromRates,
  weightedRates,
  withSpreadAdjustment,
} from "../src/index.js";
import fixtures from "./fixtures.json";

const SOFR: { date: string; rate: number }[] = fixtures.sofr;
const INDEX: Record<string, number> = fixtures.index;
const AVG30: Record<string, number> = fixtures.avg30;
const AVG90: Record<string, number> = fixtures.avg90;
const AVG180: Record<string, number> = fixtures.avg180;

function minus(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Last business day at or before `date` in the SOFR series. */
function lastOnOrBefore(date: string): string {
  const hits = SOFR.filter((o) => o.date <= date);
  return hits[hits.length - 1]!.date;
}

describe("compoundInArrears primitive", () => {
  it("a single-day period annualizes to (approximately) the rate itself", () => {
    // one 360-day period at 5% compounds to exactly 5%
    expect(compoundInArrears([{ rate: 5, days: 360 }])).toBeCloseTo(5, 10);
  });

  it("compounds two periods correctly", () => {
    // (1 + .05*30/360)(1 + .05*30/360) - 1, annualized over 60 days
    const p = (1 + 0.05 * (30 / 360)) ** 2 - 1;
    expect(compoundInArrears([{ rate: 5, days: 30 }, { rate: 5, days: 30 }])).toBeCloseTo(
      p * (360 / 60) * 100,
      10,
    );
  });

  it("exceeds the simple average (compounding premium)", () => {
    const periods = [{ rate: 5, days: 90 }, { rate: 5, days: 90 }];
    expect(compoundInArrears(periods)).toBeGreaterThan(dailySimpleAverage(periods));
  });
});

describe("SOFR Index method — reproduces NY Fed published averages", () => {
  function checkAverage(published: Record<string, number>, tenor: number, minSamples: number) {
    let checked = 0;
    for (const end of Object.keys(published)) {
      const start = minus(end, tenor);
      if (INDEX[start] === undefined || INDEX[end] === undefined) continue;
      const calc = averageFromIndex(INDEX[start]!, INDEX[end]!, tenor);
      // published index is rounded to 8 decimals → percent accurate to ~5e-4
      expect(calc, `${tenor}d avg for ${end}`).toBeCloseTo(published[end]!, 3);
      checked++;
    }
    expect(checked).toBeGreaterThan(minSamples);
  }

  it("30-day average matches across the series", () => checkAverage(AVG30, 30, 100));
  it("90-day average matches across the series", () => checkAverage(AVG90, 90, 100));
  it("180-day average matches across the series", () => checkAverage(AVG180, 180, 30));
});

describe("indexFromRates — reconstructs the published SOFR Index", () => {
  it("compounds the daily series back to the published index (to 1e-6)", () => {
    // seed at a known published index and compound forward over ~6 months
    const start = SOFR.find((o) => INDEX[o.date] !== undefined)!.date;
    const endObs = SOFR[SOFR.length - 1]!;
    const window = SOFR.filter((o) => o.date >= start && o.date <= endObs.date);
    const recon = indexFromRates(window, INDEX[start]!);
    // the last observation has no "next" day inside the window, so compare the
    // index as of the last observation's date via the window minus that tail
    const upto = window.slice(0, -1);
    const reconUpto = indexFromRates([...upto, window[window.length - 1]!], INDEX[start]!);
    expect(reconUpto).toBeCloseTo(INDEX[endObs.date]!, 6);
    expect(recon).toBeCloseTo(INDEX[endObs.date]!, 6);
  });
});

describe("compoundedSofr (plain) equals the index method over the same window", () => {
  it("matches averageFromIndex for a real 1-month window", () => {
    // choose start/end that are both business days in the series
    const end = SOFR[SOFR.length - 1]!.date;
    const start = lastOnOrBefore(minus(end, 28));
    const days = Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
    );
    const viaCompound = compoundedSofr({ observations: SOFR, start, end });
    const viaIndex = averageFromIndex(INDEX[start]!, INDEX[end]!, days);
    expect(viaCompound).toBeCloseTo(viaIndex, 4);
  });
});

describe("conventions", () => {
  const end = SOFR[SOFR.length - 1]!.date;
  const start = lastOnOrBefore(minus(end, 40));

  it("lookback shifts the rate but keeps interest-period weights", () => {
    const plain = compoundedSofr({ observations: SOFR, start, end });
    const lb = compoundedSofr({
      observations: SOFR,
      start,
      end,
      convention: { type: "lookback", businessDays: 5 },
    });
    expect(lb).not.toBe(plain);
    expect(Number.isFinite(lb)).toBe(true);
  });

  it("lockout freezes the last business days' rate", () => {
    const periods = weightedRates({
      observations: SOFR,
      start,
      end,
      convention: { type: "lockout", businessDays: 3 },
    });
    // the final few periods share one rate
    const tail = periods.slice(-3).map((p) => p.rate);
    expect(new Set(tail).size).toBe(1);
  });

  it("observation shift moves both rate and weight", () => {
    const os = compoundedSofr({
      observations: SOFR,
      start,
      end,
      convention: { type: "observationShift", businessDays: 2 },
    });
    expect(Number.isFinite(os)).toBe(true);
  });

  it("throws when lookback runs past the start of the observations", () => {
    const early = SOFR[3]!.date;
    const later = SOFR[10]!.date;
    expect(() =>
      compoundedSofr({
        observations: SOFR,
        start: early,
        end: later,
        convention: { type: "lookback", businessDays: 10 },
      }),
    ).toThrow(RangeError);
  });
});

describe("accrual, spread, and validation", () => {
  it("accrued interest = notional × rate × days/360", () => {
    const end = SOFR[SOFR.length - 1]!.date;
    const start = lastOnOrBefore(minus(end, 30));
    const interest = accruedInterest(10_000_000, { observations: SOFR, start, end });
    const rate = compoundedSofr({ observations: SOFR, start, end });
    const days = weightedRates({ observations: SOFR, start, end }).reduce((s, p) => s + p.days, 0);
    expect(interest).toBeCloseTo(10_000_000 * (rate / 100) * (days / 360), 4);
  });

  it("spread adjustment adds basis points", () => {
    expect(withSpreadAdjustment(3.5, 11.448)).toBeCloseTo(3.61448, 10);
  });

  it("rejects bad inputs", () => {
    expect(() => compoundInArrears([])).toThrow(RangeError);
    expect(() => compoundInArrears([{ rate: 5, days: 0 }])).toThrow(RangeError);
    expect(() => averageFromIndex(0, 1, 30)).toThrow(RangeError);
    expect(() => averageFromIndex(1, 1.1, 0)).toThrow(RangeError);
    expect(() => indexFromRates([{ date: "2026-01-01", rate: 5 }])).toThrow(RangeError);
    expect(() => compoundedSofr({ observations: SOFR, start: "1999-01-01", end: "2026-01-01" })).toThrow(
      RangeError,
    );
  });
});
