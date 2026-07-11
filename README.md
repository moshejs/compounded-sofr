# compounded-sofr

**SOFR compounding-in-arrears** math — the ARRC & ISDA conventions (lookback, observation shift, lockout), the **SOFR Index** method, the compounded average, and daily-simple accrual. Zero dependencies.

```
npm install compounded-sofr
```

## Why

SOFR replaced LIBOR, and unlike LIBOR it is an *overnight* rate — so a three-month SOFR coupon is a **compounded average of daily rates set in arrears**, with a small zoo of conventions (how many business days to look back, whether to shift the observation window, whether to lock out the final days). The [New York Fed](https://www.newyorkfed.org/markets/reference-rates/sofr-averages-and-index) publishes a SOFR Index and 30/90/180-day averages built on exactly this math, and npm had no library that implements it. This one does — and reproduces those published numbers.

```ts
import { compoundedSofr, averageFromIndex, indexFromRates } from "compounded-sofr";

// observations: one { date, rate } per business day (rate in %), e.g. from the
// `newyorkfed` package. A Friday's rate carries its weekend weight automatically.
compoundedSofr({ observations, start: "2026-06-09", end: "2026-07-09" });
// 3.63409 — matches the NY Fed's published 30-day SOFR average for 2026-07-09

// The exact, path-independent method straight from the published SOFR Index
// (index on 2026-06-09 and 2026-07-09, 30 calendar days apart):
averageFromIndex(1.24646364, 1.25023844, 30); // 3.63409 — the same 30-day average

// Reconstruct the SOFR Index by compounding the daily series (seeded 1.0 on 2018-04-02):
indexFromRates(observations, 1.0);
```

## API

Rates are percents (`3.53` = 3.53%), matching the NY Fed API. Observations are `{ date: "YYYY-MM-DD", rate }`, one per business day.

- **`compoundedSofr({ observations, start, end, convention? })`** — compounded-in-arrears rate for the interest period `[start, end)`. `convention` is `{ type: "plain" }` (default), `{ type: "lookback", businessDays }`, `{ type: "observationShift", businessDays }`, or `{ type: "lockout", businessDays }`.
- **`averageFromIndex(startIndex, endIndex, days)`** — compounded average between two SOFR Index values: `(end/start − 1) × 360/days`.
- **`indexFromRates(observations, startIndex?)`** — compound a daily series forward into an index value.
- **`compoundInArrears(periods)`** / **`dailySimpleAverage(periods)`** — the underlying primitives over `{ rate, days }[]`.
- **`weightedRates(params)`** — the per-day `{ rate, days }` schedule a convention produces (inspect or reuse it).
- **`accruedInterest(notional, params)`** — `notional × rate/100 × totalDays/360`.
- **`withSpreadAdjustment(rate, spreadBps)`** — add an ISDA fallback spread.

The 360-day basis, the calendar-day weighting (weekends fold into the preceding business day), and in-arrears compounding all follow the ARRC conventions.

## Correctness

Every path is validated against the **NY Fed's own published series**: the `averageFromIndex` method reproduces the published 30/90/180-day averages across a year of data, and `indexFromRates` reconstructs the published SOFR Index to ~1e-8. Plain `compoundedSofr` and the index method agree to floating-point precision.

## Related

Pairs with [`newyorkfed`](https://github.com/moshejs/newyorkfed) (fetch the daily SOFR and index). Part of a fixed-income toolkit: [`treasurydirect`](https://github.com/moshejs/treasurydirect) · [`tbill`](https://github.com/moshejs/tbill) · [`tips-index-ratio`](https://github.com/moshejs/tips-index-ratio) · [`day-count`](https://github.com/moshejs/day-count) · [`accrued-interest`](https://github.com/moshejs/accrued-interest) · [`32nds`](https://github.com/moshejs/32nds) · [`sifma-holidays`](https://github.com/moshejs/sifma-holidays) · [`instrument-identifiers`](https://github.com/moshejs/instrument-identifiers).

## Author

Built by **[Moshe Malka](https://moshemalka.com)** — engineering leader in New York City. Studio work at [Quentin.Code](https://www.quentin.software/).

MIT © Moshe Malka
