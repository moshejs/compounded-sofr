# compounded-sofr

**SOFR compounding-in-arrears** math — the ARRC & ISDA conventions (lookback, observation shift, lockout), the **SOFR Index** method, the compounded average, and daily-simple accrual. Zero dependencies.

```
npm install compounded-sofr
```

## Why

SOFR replaced LIBOR, and unlike LIBOR it is an *overnight* rate — so a three-month SOFR coupon is a **compounded average of daily rates set in arrears**, with a small zoo of conventions (how many business days to look back, whether to shift the observation window, whether to lock out the final days). The [New York Fed](https://www.newyorkfed.org/markets/reference-rates/sofr-averages-and-index) publishes a SOFR Index and 30/90/180-day averages built on exactly this math, and npm had no library that implements it. This one does — and reproduces those published numbers.

```ts
import { compoundedSofr, sofrAverage, averageFromIndex, indexFromRates } from "compounded-sofr";

// observations: one { date, rate } per business day (rate in %), e.g. from the
// `newyorkfed` package. A Friday's rate carries its weekend weight automatically.
compoundedSofr({ observations, start: "2026-06-09", end: "2026-07-09" });
// 3.634089… — the NY Fed's published 30-day SOFR average for 2026-07-09 is 3.63409

// Exactly the published SOFR Average (window may start on a weekend; rounded to 5 dp):
sofrAverage(observations, "2026-07-09", 30); // 3.63409

// The exact, path-independent method straight from the published SOFR Index
// (index on 2026-06-09 and 2026-07-09, 30 calendar days apart):
averageFromIndex(1.24646364, 1.25023844, 30); // 3.634089… — within ~2e-5 of the published average

// Reconstruct the SOFR Index by compounding the daily series (seeded 1.0 on 2018-04-02):
indexFromRates(observations, 1.0);
```

## API

Rates are percents (`3.53` = 3.53%), matching the NY Fed API. Observations are `{ date: "YYYY-MM-DD", rate }`, one per business day.

- **`compoundedSofr({ observations, start, end, convention? })`** — compounded-in-arrears rate for the interest period `[start, end)`. `convention` is `{ type: "plain" }` (default), `{ type: "lookback", businessDays }`, `{ type: "observationShift", businessDays }`, or `{ type: "lockout", businessDays }`.
  - `start`/`end` may fall on weekends or holidays: such a day takes the preceding business day's rate (the NY Fed's rule). `end`'s own rate is never used, so observations need only run to the business day before `end` (at most 7 calendar days short). Under `observationShift` both must be business days in `observations`.
  - `lookback`: rate from `businessDays` business days earlier, weights from the interest period. `observationShift`: rates *and* weights from the shifted observation period. `lockout`: the last `businessDays` business days reuse the rate of the business day just before them (QuantLib's `lockoutDays`); an ARRC-style Rate Cut-Off Date *N* business days before the end corresponds to `businessDays: N − 1`.
  - For lookback / observation shift / lockout the observations double as the business-day calendar, so they must include every business day of the period (and the shift days before it).
- **`sofrAverage(observations, asOf, calendarDays)`** — the NY Fed's SOFR Average for `asOf`: compounded over `[asOf − calendarDays, asOf)`, rounded to 5 decimals as published.
- **`averageFromIndex(startIndex, endIndex, days)`** — compounded average between two SOFR Index values: `(end/start − 1) × 360/days`. Unrounded; because the published index is rounded to 8 decimals it can differ from the published average by ~1–2 units in the 5th decimal.
- **`indexFromRates(observations, startIndex?)`** — compound a daily series forward into an index value as of the last observation's date (each rate accrues until the next observation; the last observation's rate is not used).
- **`compoundInArrears(periods)`** / **`dailySimpleAverage(periods)`** — the underlying primitives over `{ rate, days }[]`.
- **`weightedRates(params)`** — the per-day `{ rate, days }` schedule a convention produces (inspect or reuse it).
- **`accruedInterest(notional, params)`** — `notional × rate/100 × interestDays/360`, with `interestDays` the calendar days in `[start, end)` (also under observation shift).
- **`withSpreadAdjustment(rate, spreadBps)`** — add an ISDA fallback spread.

The 360-day basis, the calendar-day weighting (weekends fold into the preceding business day), and in-arrears compounding all follow the ARRC conventions.

## Correctness

Validated against independent sources (the test suite carries fixtures from both):

- **NY Fed published data** — `sofrAverage` reproduces every published 30/90/180-day SOFR Average exactly (all 4,956 values from 2018-04-02 to 2026-10-09 in the audit cross-check; 750 in the test fixtures), including windows that start on weekends and holidays. Compounding the full daily history from 1.0 on 2018-04-02 with `indexFromRates` and rounding to 8 decimals reproduces every published SOFR Index value.
- **QuantLib** (`OvernightIndexedCoupon`) — plain, lookback, observation-shift and lockout rates and accrued amounts agree to 1e-9 over 1,698 random periods on real SOFR fixings, including non-business-day starts and ends.

## Related

Pairs with [`newyorkfed`](https://github.com/moshejs/newyorkfed) (fetch the daily SOFR and index). Part of a fixed-income toolkit: [`treasurydirect`](https://github.com/moshejs/treasurydirect) · [`tbill`](https://github.com/moshejs/tbill) · [`tips-index-ratio`](https://github.com/moshejs/tips-index-ratio) · [`day-count`](https://github.com/moshejs/day-count) · [`accrued-interest`](https://github.com/moshejs/accrued-interest) · [`32nds`](https://github.com/moshejs/32nds) · [`sifma-holidays`](https://github.com/moshejs/sifma-holidays) · [`instrument-identifiers`](https://github.com/moshejs/instrument-identifiers).

## Author

Built by **[Moshe Malka](https://moshemalka.com)** — engineering leader in New York City. Studio work at [Quentin.Code](https://www.quentin.software/).

MIT © Moshe Malka
