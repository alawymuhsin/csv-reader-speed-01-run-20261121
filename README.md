# csv-reader-speed: a faster drop-in for csv-reader 1.0.0

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/alawymuhsin/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/alawymuhsin/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

`run(input)` in `solve.js` returns exactly the answer csv-reader 1.0.0 returns for
the same input `{text, header}`: the JSON value `{columns, rows, errors}` under
csv-reader's broken-row policy (BOM drop, LF/CRLF record ends, stray CRs dropped
with a `stray_cr` error, quoted fields with doubled quotes and CR/LF read as LF,
`quote_junk` for what follows a closing quote, `unterminated_quote` for a quote
that never closes, `short_row`/`long_row` padding and cutting to the first
record's width, errors as `{code, line, row}` in the order met).

## How it is faster

The reference reads one character at a time and builds every field a character
at a time. This reader jumps instead:

- An unquoted field is one regex search for the next comma or line break
  (`/[,\r\n]/g`) plus one `slice` — no loop over its characters.
- A quoted field is found by `indexOf` jumps from quote to quote; doubled
  quotes are folded in as whole slices, and the line breaks inside a quoted
  field are counted and normalised in a single `replace` pass, only when the
  field holds any.
- Fields are only ever assembled from slices, never built character by
  character, so the work per field is a couple of native searches instead of a
  loop over its characters. The only paths that fall back to a slower scan are
  the rare broken ones (a stray CR inside a field, junk after a closing quote,
  a quote that never closes).

On the kit's practice set (6 cases, ~10.5 MB of CSV) the parse itself
(`run`, warm) takes ~85 ms against the reference's ~490 ms, and the entry as
a whole (driver + JSON parse + answers written out, fresh process each run)
takes ~680 ms against the house baseline's ~1,500 ms — about 2.2x faster,
measured interleaved on this machine. See the build report for the full
numbers.

## How to run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=../kit/csv-reader-speed-01-run-20261121-kit/practice/input \
  MAKEFUN_OUTPUT_DIR=out node main.ts
```

That reads `cases.json` from the input directory and writes `answers.json` to
the output directory. Node 22.18 or later (Node runs the TypeScript driver as
it is). No dependencies, no network, no build step: `solve.js` is a
dependency-free ES module, `main.ts` the driver the harness runs.

## Files

- `solve.js` — the fast reader (entrypoint for the work; `run(input)`)
- `main.ts` — the driver: reads `/input/cases.json`, answers each case with
  `run`, writes `/output/answers.json`
- `README.md` — this file
- `LICENSE` — MIT

---

<sub>Entered on [make.fun](https://make.fun/?ref=0zkhwx20&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
