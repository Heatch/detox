# Holdings

Tickers for the Holdings lane. This file is the source of truth: the pipeline
re-reads it on every run, so editing it changes the dashboard on the next refresh.

One ticker per line, as a list item. The exchange prefix is recommended and
required for ambiguous Canadian listings. A company name after the ticker is
optional; the pipeline resolves names and exchange identifiers on its own when
it is missing.

Accepted forms:

- `TSX:SHOP` (Toronto)
- `TSXV:XYZ` (TSX Venture)
- `NASDAQ:MSFT`
- `NYSE:BRK.B`
- `AAPL` (bare ticker, resolved against US listings first)

Headings, blank lines, and HTML comments are ignored, so annotate freely.

## Tickers

<!-- Replace the examples below with your actual holdings. -->
- TSX:SHOP — Shopify
- TSX:ENB — Enbridge
- NASDAQ:MSFT — Microsoft

## Notes

Optional per-holdings context the selection stage should weigh. Keep it short.
