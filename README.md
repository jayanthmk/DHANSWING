# DHANSWING

A free, static GitHub Pages dashboard for reviewing trading recommendations from Excel or CSV files. Files are read in your browser; this app has no broker connection, backend, or order placement.

## Run it

After GitHub Pages is enabled for this public repository, open:

https://jayanthmk.github.io/DHANSWING/

If the page is not available yet, open repository Settings → Pages, set the build and deployment source to GitHub Actions, and wait for the Publish GitHub Pages workflow to finish. This repository is public, so the webpage itself is public. The uploaded account and price files are processed only in your browser tab and are not sent to GitHub or another server. Refreshing the page clears them.

GitHub Pages is available at no charge for public repositories on GitHub Free. It serves a static site; it cannot run the former Python backend. This version is deliberately static so it does not need paid cloud hosting.

## Upload formats

Download the Excel template from the page. It contains two sheets:

### Positions

Columns: Symbol, Quantity, AvgCost, Managed, LastAverageDate.

- Use one row per open holding.
- Set Managed to Yes only for positions this strategy manages.
- LastAverageDate is optional. Enter it after manually placing an average so the weekly cooldown is respected.
- Unmanaged positions do not receive exit or averaging recommendations.

### Prices

Columns: Symbol, Date, Open, High, Low, Close. Volume is optional.

- Use one row per symbol per trading day.
- Upload completed daily bars. For a 52-week signal the symbol needs at least 253 daily rows.
- The page checks a new closing high against the highest high of the previous 252 sessions.
- A single workbook can be uploaded, or use separate Positions and Prices CSV/Excel files.

Supported files: CSV, XLS, XLSX.

## Strategy logic

- Entry: close above the prior 252 sessions' highest high.
- Initial size: ₹1,000, whole shares only; skip when one share costs more than ₹1,000.
- Maximum: 200 managed open positions by default; change the limit in the page if needed.
- Average: when Supertrend (10, 3) is green and price is at least 6% below average cost, suggest adding one tenth of current shares, rounded up, no more often than once every seven calendar days.
- Exit: when Supertrend is red, recommend exiting the entire managed position regardless of P&L.
- Manual-only: the page never connects to Dhan or places, modifies, or cancels orders.

The current version depends on the SheetJS browser library from its official CDN to parse Excel and CSV. The file contents are handled in the browser by the page; no upload request is made.

