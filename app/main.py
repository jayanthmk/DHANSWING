from __future__ import annotations

import hmac
import os
import sqlite3
from contextlib import closing
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel, Field

APP_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("DATABASE_PATH", str(APP_DIR.parent / "data" / "dhan_swing.sqlite3")))
DHAN_API = "https://api.dhan.co/v2"
security = HTTPBasic()
app = FastAPI(title="DHANSWING", docs_url=None, redoc_url=None)


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS watchlist (
            security_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS managed_positions (
            security_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, isin TEXT,
            last_add_date TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    """)
    return conn


def fernet() -> Fernet:
    key = os.getenv("TOKEN_ENCRYPTION_KEY", "")
    if not key:
        raise HTTPException(503, "Server setup is incomplete: TOKEN_ENCRYPTION_KEY is missing")
    try:
        return Fernet(key.encode("ascii"))
    except (ValueError, TypeError):
        raise HTTPException(503, "TOKEN_ENCRYPTION_KEY is invalid")


@app.on_event("startup")
def startup() -> None:
    if not os.getenv("APP_PASSWORD"):
        raise RuntimeError("APP_PASSWORD must be configured")
    db().close()


def require_auth(credentials: HTTPBasicCredentials = Depends(security)) -> str:
    valid_user = hmac.compare_digest(credentials.username.encode(), b"trader")
    valid_password = hmac.compare_digest(credentials.password.encode(), os.getenv("APP_PASSWORD", "").encode())
    if not (valid_user and valid_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in required", headers={"WWW-Authenticate": "Basic"})
    return credentials.username


def get_token() -> str:
    with closing(db()) as conn:
        row = conn.execute("SELECT value FROM settings WHERE key='dhan_token'").fetchone()
    if not row:
        raise HTTPException(409, "Connect your Dhan access token in Settings")
    try:
        return fernet().decrypt(row["value"].encode()).decode()
    except InvalidToken:
        raise HTTPException(500, "Stored token cannot be decrypted; reconnect it in Settings")


async def dhan(method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.request(method, DHAN_API + path, headers={"access-token": get_token(), "Accept": "application/json"}, json=payload)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Could not reach Dhan ({exc.__class__.__name__})")
    if response.status_code in (401, 403):
        raise HTTPException(401, "Dhan rejected the token. Refresh it in Dhan and reconnect in Settings.")
    if response.status_code >= 400:
        raise HTTPException(502, f"Dhan API returned {response.status_code}: {response.text[:250]}")
    return response.json() if response.content else None


class TokenInput(BaseModel):
    access_token: str = Field(min_length=20, max_length=4096)


class WatchInput(BaseModel):
    symbol: str = Field(min_length=1, max_length=40)
    security_id: str = Field(min_length=1, max_length=32)


class ManagedInput(BaseModel):
    symbol: str
    security_id: str
    isin: str | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/status")
def api_status(_: str = Depends(require_auth)) -> dict[str, bool]:
    with closing(db()) as conn:
        connected = conn.execute("SELECT 1 FROM settings WHERE key='dhan_token'").fetchone() is not None
    return {"dhan_connected": connected, "manual_only": True}


@app.put("/api/settings/dhan-token")
def save_token(body: TokenInput, _: str = Depends(require_auth)) -> dict[str, str]:
    encrypted = fernet().encrypt(body.access_token.strip().encode()).decode()
    with closing(db()) as conn:
        conn.execute("INSERT INTO settings(key,value) VALUES('dhan_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (encrypted,))
        conn.commit()
    return {"message": "Dhan token stored encrypted on the server"}


@app.delete("/api/settings/dhan-token")
def delete_token(_: str = Depends(require_auth)) -> dict[str, str]:
    with closing(db()) as conn:
        conn.execute("DELETE FROM settings WHERE key='dhan_token'")
        conn.commit()
    return {"message": "Dhan token removed"}


@app.get("/api/account")
async def account(_: str = Depends(require_auth)) -> dict[str, Any]:
    # Read-only account endpoints. There is deliberately no order placement API in this app.
    import asyncio
    paths = {"holdings": "/holdings", "positions": "/positions", "orders": "/orders", "funds": "/fundlimit"}
    async def get(path: str) -> Any:
        return await dhan("GET", path)
    data = await asyncio.gather(*(get(path) for path in paths.values()), return_exceptions=True)
    result = {}
    for (name, _), value in zip(paths.items(), data):
        result[name] = {"error": str(value)[:160]} if isinstance(value, Exception) else value
    if all(isinstance(value, dict) and "error" in value for value in result.values()):
        raise HTTPException(502, "Dhan account data is unavailable")
    return result


@app.get("/api/watchlist")
def watchlist(_: str = Depends(require_auth)) -> list[dict[str, Any]]:
    with closing(db()) as conn:
        return [dict(row) for row in conn.execute("SELECT * FROM watchlist ORDER BY symbol")]


@app.post("/api/watchlist")
def add_watch(body: WatchInput, _: str = Depends(require_auth)) -> dict[str, str]:
    with closing(db()) as conn:
        conn.execute("INSERT INTO watchlist(security_id,symbol) VALUES(?,?) ON CONFLICT(security_id) DO UPDATE SET symbol=excluded.symbol", (body.security_id.strip(), body.symbol.strip().upper()))
        conn.commit()
    return {"message": f"{body.symbol.upper()} added"}


@app.delete("/api/watchlist/{security_id}")
def delete_watch(security_id: str, _: str = Depends(require_auth)) -> dict[str, str]:
    with closing(db()) as conn:
        conn.execute("DELETE FROM watchlist WHERE security_id=?", (security_id,))
        conn.commit()
    return {"message": "Removed from watchlist"}


@app.post("/api/managed")
def add_managed(body: ManagedInput, _: str = Depends(require_auth)) -> dict[str, str]:
    with closing(db()) as conn:
        conn.execute("INSERT INTO managed_positions(security_id,symbol,isin) VALUES(?,?,?) ON CONFLICT(security_id) DO UPDATE SET symbol=excluded.symbol,isin=excluded.isin", (body.security_id, body.symbol.upper(), body.isin))
        conn.commit()
    return {"message": f"{body.symbol.upper()} marked strategy-managed"}


@app.delete("/api/managed/{security_id}")
def delete_managed(security_id: str, _: str = Depends(require_auth)) -> dict[str, str]:
    with closing(db()) as conn:
        conn.execute("DELETE FROM managed_positions WHERE security_id=?", (security_id,))
        conn.commit()
    return {"message": "Position is no longer strategy-managed"}


@app.post("/api/managed/{security_id}/average-confirmed")
def confirm_average(security_id: str, _: str = Depends(require_auth)) -> dict[str, str]:
    with closing(db()) as conn:
        cursor = conn.execute("UPDATE managed_positions SET last_add_date=? WHERE security_id=?", (datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat(), security_id))
        conn.commit()
    if cursor.rowcount == 0:
        raise HTTPException(404, "Position is not marked strategy-managed")
    return {"message": "Average date saved; next average reminder is eligible after seven calendar days"}

def supertrend(candles: dict[str, Any], period: int = 10, multiplier: float = 3.0) -> dict[str, Any] | None:
    try:
        high = [float(x) for x in candles["high"]]
        low = [float(x) for x in candles["low"]]
        close = [float(x) for x in candles["close"]]
        n = min(len(high), len(low), len(close))
        high, low, close = high[-n:], low[-n:], close[-n:]
    except (KeyError, TypeError, ValueError):
        return None
    if n < period + 2:
        return None
    tr = [high[0] - low[0]] + [max(high[i] - low[i], abs(high[i] - close[i-1]), abs(low[i] - close[i-1])) for i in range(1, n)]
    atr = [sum(tr[:period]) / period]
    for value in tr[period:]:
        atr.append((atr[-1] * (period - 1) + value) / period)
    upper: list[float] = []
    lower: list[float] = []
    green: list[bool] = []
    st: list[float] = []
    for j, avg_tr in enumerate(atr):
        i = j + period - 1
        mid = (high[i] + low[i]) / 2
        basic_upper, basic_lower = mid + multiplier * avg_tr, mid - multiplier * avg_tr
        if j == 0:
            final_upper, final_lower = basic_upper, basic_lower
            is_green = close[i] >= mid
        else:
            final_upper = basic_upper if basic_upper < upper[-1] or close[i-1] > upper[-1] else upper[-1]
            final_lower = basic_lower if basic_lower > lower[-1] or close[i-1] < lower[-1] else lower[-1]
            is_green = close[i] > upper[-1] if not green[-1] else close[i] >= final_lower
        upper.append(final_upper)
        lower.append(final_lower)
        green.append(is_green)
        st.append(final_lower if is_green else final_upper)
    stamp = int(candles["timestamp"][-1]) if candles.get("timestamp") else None
    candle_day = datetime.fromtimestamp(stamp / (1000 if stamp and stamp > 10**12 else 1), ZoneInfo("Asia/Kolkata")).date().isoformat() if stamp else None
    return {"green": green[-1], "flipped_green": not green[-2] and green[-1], "flipped_red": green[-2] and not green[-1], "value": round(st[-1], 2), "close": close[-1], "candle_date": candle_day}


async def history(security_id: str) -> dict[str, Any]:
    now = datetime.now(ZoneInfo("Asia/Kolkata"))
    # Do not mistake an unfinished session candle for a daily close.
    end = now.date() if now.time() >= time(15, 35) else now.date() - timedelta(days=1)
    return await dhan("POST", "/charts/historical", {"securityId": security_id, "exchangeSegment": "NSE_EQ", "instrument": "EQUITY", "expiryCode": 0, "oi": False, "fromDate": (end - timedelta(days=400)).isoformat(), "toDate": end.isoformat()})


@app.get("/api/signals")
async def signals(_: str = Depends(require_auth)) -> dict[str, Any]:
    with closing(db()) as conn:
        watch = [dict(row) for row in conn.execute("SELECT * FROM watchlist ORDER BY symbol")]
        managed = [dict(row) for row in conn.execute("SELECT * FROM managed_positions ORDER BY symbol")]
    managed_by_id = {x["security_id"]: x for x in managed}
    by_id = {x["security_id"]: {**x, "managed": x["security_id"] in managed_by_id} for x in watch}
    for item in managed:
        by_id.setdefault(item["security_id"], {**item, "managed": True})
    holding_by_id: dict[str, dict[str, Any]] = {}
    if managed:
        try:
            holding_by_id = {str(x.get("securityId")): x for x in (await dhan("GET", "/holdings") or [])}
        except HTTPException:
            holding_by_id = {}
    output, errors = [], []
    now = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    for item in by_id.values():
        try:
            candles = await history(item["security_id"])
            st = supertrend(candles)
            if st is None:
                errors.append({"symbol": item["symbol"], "error": "Not enough historical candles"})
                continue
            highs = [float(x) for x in candles.get("high", [])]
            closes = [float(x) for x in candles.get("close", [])]
            breakout = len(highs) >= 253 and closes[-1] > max(highs[-253:-1])
            price = st["close"]
            shares = int(1000 // price) if price > 0 else 0
            action, detail, add_shares, add_amount = "WAIT", "No active signal", 0, 0
            holding = holding_by_id.get(str(item["security_id"]))
            if item["managed"]:
                if not holding or int(holding.get("totalQty", 0) or 0) <= 0:
                    action, detail = "CHECK HOLDING", "Marked managed, but Dhan has no demat holding for this security ID."
                elif not st["green"]:
                    action, detail = "EXIT FULL", "Supertrend is red. Exit the whole strategy position manually, regardless of P&L."
                else:
                    qty = int(holding.get("totalQty", 0) or 0)
                    average = float(holding.get("avgCostPrice", 0) or 0)
                    loss_pct = (price / average - 1) * 100 if average > 0 else 0
                    last_add = managed_by_id[item["security_id"]].get("last_add_date")
                    elapsed = (now - date.fromisoformat(last_add)).days if last_add else 7
                    if average > 0 and price <= average * 0.94 and elapsed >= 7:
                        import math
                        add_shares = max(1, math.ceil(qty / 10))
                        add_amount = int(round(add_shares * price))
                        action, detail = "AVERAGE", f"{loss_pct:.1f}% vs avg cost; add {add_shares} shares (~₹{add_amount}), about 1/10 shares, after 7-day interval."
                    elif average > 0 and price <= average * 0.94:
                        action, detail = "WAIT", f"Average threshold met; wait {7 - elapsed} more day(s) before next add."
                    else:
                        action, detail = "HOLD", "Supertrend green; average trigger is 6% below weighted average cost."
            elif breakout:
                if shares:
                    action, detail = "ENTRY SIGNAL", f"New 52-week closing high; initial budget ₹1,000 buys {shares} whole share(s)."
                else:
                    action, detail = "SKIP ENTRY", "New 52-week high, but one whole share costs more than ₹1,000."
            output.append({"symbol": item["symbol"], "security_id": item["security_id"], "candle_date": st["candle_date"], "price": price, "supertrend": "GREEN" if st["green"] else "RED", "supertrend_value": st["value"], "flip": "GREEN" if st["flipped_green"] else "RED" if st["flipped_red"] else "—", "new_52w_high": breakout, "entry_budget": 1000, "entry_shares": shares, "managed": item["managed"], "action": action, "detail": detail, "add_shares": add_shares, "add_amount": add_amount})
        except (HTTPException, ValueError, TypeError) as exc:
            errors.append({"symbol": item["symbol"], "error": str(getattr(exc, "detail", exc))[:160]})
    return {"as_of": max((x["candle_date"] for x in output if x["candle_date"]), default=now.isoformat()), "signals": output, "errors": errors, "universe_note": "Signals cover your watchlist and managed positions. This version does not scan the full NSE universe."}


@app.get("/", include_in_schema=False)
def home(_: str = Depends(require_auth)) -> Response:
    return Response((APP_DIR / "static" / "index.html").read_text(encoding="utf-8"), media_type="text/html")

