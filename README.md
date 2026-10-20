# DHANSWING

A mobile-friendly, remotely hosted swing-trading assistant for Dhan. It reads Dhan account data and daily candles, then presents recommendations for you to execute manually.

## Implemented strategy

- Entry: new 52-week closing high, measured against the prior 252 daily highs.
- Initial size: ₹1,000 per position; whole shares only. If one share costs over ₹1,000, the app marks the signal as skipped.
- Average down: only when Supertrend (10, 3) is green and the close is at least 6% below Dhan's average cost. The suggested add is 10% of current shares, rounded up to a whole share, no more often than every seven calendar days.
- Exit: recommend exiting the full managed position whenever Supertrend is red, regardless of P&L.
- Manual-only: no order placement, modification, or cancellation code is exposed.

The scan covers the watchlist you maintain and positions you mark as strategy-managed. It does not scan all NSE stocks yet. Unmanaged holdings are never assigned strategy actions.

## Run locally

Requires Python 3.11 or newer.

1. Create a virtual environment, install dependencies from requirements.txt.
2. Generate a Fernet key with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())".
3. Set APP_PASSWORD to a strong password and TOKEN_ENCRYPTION_KEY to the generated key. Optionally set DATABASE_PATH; default is data/dhan_swing.sqlite3.
4. Start with uvicorn app.main:app --reload.
5. Open http://127.0.0.1:8000. Sign in with username trader and your APP_PASSWORD. Paste the active Dhan access token in the app.

Do not put real credentials in Git, .env.example, screenshots, or support requests. Keep the same encryption key across restarts or the saved token cannot be decrypted. Dhan access tokens expire; refresh the token through Dhan and replace it in Settings when needed.

## Host it for travel access (Railway)

1. Create a Railway project and deploy the jayanthmk/DHANSWING GitHub repository.
2. Add a persistent Railway volume mounted at /data.
3. Set these service variables:
   - APP_PASSWORD: a unique, strong password for this dashboard.
   - TOKEN_ENCRYPTION_KEY: the Fernet key generated above. Store it safely; do not rotate it without reconnecting the Dhan token.
   - DATABASE_PATH: /data/dhan_swing.sqlite3
4. Deploy and open the generated HTTPS domain. Sign in, connect Dhan, then add stocks to monitor.
5. Save that URL on your phone. Refresh the Dhan access token when it expires.

The app needs outbound HTTPS access to Dhan's API. Railway serves the domain and routes over HTTPS; do not expose the app through an unencrypted host. The SQLite volume holds the encrypted Dhan token, watchlist, and managed-position flags.

## Dhan data used

- Holdings, current positions, order book, and funds are fetched read-only.
- Historical daily OHLCV comes from Dhan /charts/historical.
- Signals use completed daily candles; before 3:35 p.m. IST, the current session date is excluded.
- Add a watchlist row using the NSE symbol and its Dhan security ID.

See [Dhan authentication](https://dhanhq.co/docs/v2/authentication/), [portfolio](https://dhanhq.co/docs/v2/portfolio/), [historical data](https://dhanhq.co/docs/v2/historical-data/), and [instrument list](https://dhanhq.co/docs/v2/instruments/).

## Security

- HTTP Basic authentication protects the dashboard and API.
- The Dhan token is encrypted at rest using TOKEN_ENCRYPTION_KEY.
- No browser local storage is used for the broker token.
- The app does not include any Dhan order-write endpoint.

