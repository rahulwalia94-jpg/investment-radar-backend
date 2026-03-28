#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════
# run_scoring.py — Main Entry Point
# Called by Node.js via: python3 scoring/run_scoring.py
# Reads instruments + snapshot from Firebase
# Runs full quant engine (GARCH + DCC + Factor Model + Monte Carlo)
# Uses Claude Sonnet for narratives (not Haiku)
# Writes scores + backtest + portfolio analysis back to Firebase
# ═══════════════════════════════════════════════════════════════

import os, sys, json, time, traceback
import numpy as np
import pandas as pd
from datetime import datetime

# Add parent dir to path
sys.path.insert(0, os.path.dirname(__file__))

from signals    import calc_all_signals, score_instrument
from garch      import fit_garch, scale_correlation_for_regime
from monteCarlo import simulate_portfolio, kelly_fraction, calc_targets
from backtester import run_backtest
from correlations import build_portfolio_correlation

import anthropic
import sqlite3
import urllib.request
import base64
import json as _json


# ── BACKBLAZE B2: PRICE HISTORY ──────────────────────────────
def download_price_history():
    """Download price_history.db from Backblaze B2 to /tmp"""
    try:
        import base64, json as _json, urllib.request
        key_id  = os.environ['B2_KEY_ID']
        app_key = os.environ['B2_APP_KEY']
        bucket  = os.environ.get('B2_BUCKET_NAME', 'investment-radar-data')
        local   = '/tmp/price_history.db'
        # Authorize
        creds = base64.b64encode(f'{key_id}:{app_key}'.encode()).decode()
        req   = urllib.request.Request(
            'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
            headers={'Authorization': f'Basic {creds}'}
        )
        with urllib.request.urlopen(req) as resp:
            auth = _json.loads(resp.read())
        token  = auth['authorizationToken']
        dl_url = auth['apiInfo']['storageApi']['downloadUrl']
        # Download
        req2 = urllib.request.Request(
            f'{dl_url}/file/{bucket}/price_history.db',
            headers={'Authorization': token}
        )
        with urllib.request.urlopen(req2) as resp2:
            with open(local, 'wb') as f:
                f.write(resp2.read())
        print(f'✅ Price history downloaded ({os.path.getsize(local)/1024/1024:.1f}MB)')
        return local
    except Exception as e:
        print(f'B2 download error: {e}')
        return None

def get_price_history_from_sqlite(db_path, symbols):
    """Read price history for symbols from SQLite"""
    if not db_path or not os.path.exists(db_path): return {}
    conn   = sqlite3.connect(db_path)
    result = {}
    try:
        for sym in symbols:
            rows = conn.execute(
                'SELECT date,close,high,low,vol FROM price_history WHERE symbol=? ORDER BY date ASC',
                (sym,)
            ).fetchall()
            if rows:
                result[sym] = [{'date':r[0],'close':r[1],'high':r[2],'low':r[3],'vol':r[4]} for r in rows]
    finally:
        conn.close()
    return result

# ── B2 STORAGE CLIENT ─────────────────────────────────────────
_b2_auth = {}

def b2_authorize():
    if _b2_auth.get('token') and time.time() < _b2_auth.get('expiry', 0):
        return
    key_id  = os.environ['B2_KEY_ID']
    app_key = os.environ['B2_APP_KEY']
    creds   = base64.b64encode(f'{key_id}:{app_key}'.encode()).decode()
    req     = urllib.request.Request(
        'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
        headers={'Authorization': f'Basic {creds}'}
    )
    with urllib.request.urlopen(req) as resp:
        auth = _json.loads(resp.read())
    _b2_auth['token']       = auth['authorizationToken']
    _b2_auth['api_url']     = auth['apiInfo']['storageApi']['apiUrl']
    _b2_auth['dl_url']      = auth['apiInfo']['storageApi']['downloadUrl']
    _b2_auth['expiry']      = time.time() + 23 * 3600

def b2_load(key):
    b2_authorize()
    bucket = os.environ.get('B2_BUCKET_NAME', 'investment-radar-data')
    req = urllib.request.Request(
        f"{_b2_auth['dl_url']}/file/{bucket}/{key}",
        headers={'Authorization': _b2_auth['token']}
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return _json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise

def b2_save(key, data):
    import hashlib, http.client
    b2_authorize()
    bucket_id = os.environ['B2_BUCKET_ID']
    # Get upload URL
    payload = _json.dumps({'bucketId': bucket_id}).encode()
    api_url = urllib.request.urlopen(
        urllib.request.Request(
            f"{_b2_auth['api_url']}/b2api/v3/b2_get_upload_url",
            data=payload,
            headers={
                'Authorization': _b2_auth['token'],
                'Content-Type':  'application/json',
            }
        )
    )
    url_data   = _json.loads(api_url.read())
    buf        = _json.dumps(data).encode('utf-8')
    sha1       = hashlib.sha1(buf).hexdigest()
    upload_url = url_data['uploadUrl']
    upload_tok = url_data['authorizationToken']
    up_req     = urllib.request.Request(
        upload_url, data=buf,
        headers={
            'Authorization':     upload_tok,
            'X-Bz-File-Name':    urllib.parse.quote(key),
            'Content-Type':      'application/json',
            'Content-Length':    str(len(buf)),
            'X-Bz-Content-Sha1': sha1,
        }
    )
    with urllib.request.urlopen(up_req): pass

def init_b2():
    b2_authorize()
    return True


# ── LOAD DATA FROM B2 ────────────────────────────────────────
def load_data(_ignored):
    print("Loading data from Backblaze B2...")

    # Snapshot
    snap = b2_load('snapshot_latest.json') or {}
    print(f"  Snapshot: {snap.get('regime','?')} @ {snap.get('ts','?')[:10]}")

    # Instruments
    instruments = b2_load('instruments.json') or {}

    # Add multi-asset if not already in instruments
    try:
        shared_path = os.path.join(os.path.dirname(__file__), '../shared/india_instruments_data.json')
        if not os.path.exists(shared_path):
            shared_path = os.path.join(os.path.dirname(__file__), '../../shared/india_instruments_data.json')
        if os.path.exists(shared_path):
            with open(shared_path) as f:
                multi_asset = _json.load(f)
            for sym, inst in multi_asset.items():
                if sym not in instruments:
                    instruments[sym] = inst
            print(f"  Multi-asset: {len(multi_asset)} instruments")
    except Exception as e:
        pass

    print(f"  Loaded {len(instruments)} instruments total")

    # ── DOWNLOAD PRICE HISTORY FROM B2 ───────────────────────
    print('Downloading price history from B2...')
    db_path     = download_price_history()
    all_syms    = list(instruments.keys())
    price_hists = get_price_history_from_sqlite(db_path, all_syms) if db_path else {}
    print(f'  Price history: {len(price_hists)} symbols')
    for sym, hist in price_hists.items():
        if sym in instruments:
            instruments[sym]['_price_history'] = hist
    if db_path and os.path.exists(db_path):
        os.remove(db_path)

    # News
    news_data   = b2_load('news_latest.json') or {}
    scored_news = news_data.get('stocks', {})

    return snap, instruments, {}, scored_news


# ── SCORE ALL INSTRUMENTS ─────────────────────────────────────
def score_all(instruments: dict, snap: dict,
               scored_news: dict, db) -> dict:
    print("Scoring all instruments...")
    t0       = time.time()
    all_scores = {}
    n          = len(instruments)

    for i, (sym, inst) in enumerate(instruments.items()):
        try:
            news = scored_news.get(sym, [])
            res  = score_instrument(inst, snap, news)
            all_scores[sym] = {
                'score':   res['score'],
                'signal':  res['signal'],
                'signals': res['signals'],
                'raw':     res['raw'],
            }
        except Exception as e:
            pass

    print(f"  Scored {len(all_scores)}/{n} instruments in {time.time()-t0:.1f}s")
    return all_scores


# ── PORTFOLIO ANALYTICS ───────────────────────────────────────
def run_portfolio_analytics(instruments: dict, snap: dict,
                              scored_news: dict) -> dict:
    print("Running portfolio analytics...")

    # Your holdings + key watchlist
    portfolio_syms = ['NET', 'CEG', 'GLNG']
    extended_syms  = portfolio_syms + ['NVDA','MSFT','ONGC','HAL','TCS','GLD','INFY']

    regime = snap.get('regime', 'SIDEWAYS')
    vix    = (snap.get('indices') or {}).get('INDIA VIX', {}).get('last', 18)

    # Build factor returns from available data
    # Use instrument calibration data as proxy
    factor_data = {}
    for sym in extended_syms:
        inst = instruments.get(sym, {})
        hist = inst.get('_price_history', [])
        if len(hist) > 30:
            prices   = pd.Series([h['close'] for h in hist if h.get('close')])
            returns  = np.log(prices / prices.shift(1)).dropna()
            factor_data[sym] = returns

    # Build correlation matrix
    available = [s for s in extended_syms if s in instruments]
    try:
        factor_df = pd.DataFrame(factor_data).dropna()
        corr_mat, symbols = build_portfolio_correlation(
            available, instruments, factor_df, regime
        )
    except Exception as e:
        print(f"  Correlation error: {e}, using fallback")
        n_avail = len(available)
        corr_mat = np.eye(n_avail)
        symbols  = available

    # Get GARCH volatilities
    sigmas = []
    mus    = []
    for sym in symbols:
        inst  = instruments.get(sym, {})
        cal   = inst.get('calibration') or {}
        hist  = inst.get('_price_history', [])

        # GARCH sigma
        if len(hist) > 60:
            prices  = pd.Series([h['close'] for h in hist if h.get('close')])
            returns = np.log(prices / prices.shift(1)).dropna()
            g       = fit_garch(returns, sym)
            sigma   = g.get('sigma_today', 0.25)
        else:
            sigma = cal.get('sigma', {}).get(regime, 0.25)

        mu    = (cal.get('base_returns') or {}).get(regime, 5) / 100
        sigmas.append(sigma)
        mus.append(mu)

    sigmas_arr = np.array(sigmas)
    mus_arr    = np.array(mus)

    # Run correlated Monte Carlo
    try:
        mc_result = simulate_portfolio(
            symbols    = symbols,
            mus        = mus_arr,
            sigmas     = sigmas_arr,
            corr_matrix= corr_mat,
            horizon_days= 63,
            n_sims     = 10000,
            vix        = float(vix),
        )
    except Exception as e:
        print(f"  Monte Carlo error: {e}")
        mc_result = {}

    # Kelly fractions for each stock
    kelly_results = {}
    for sym in symbols:
        ps = mc_result.get('per_stock', {}).get(sym, {})
        if ps:
            k = kelly_fraction(
                ps.get('win_prob', 50),
                ps.get('expected_return', 5),
                ps.get('var_5pct', -10),
            )
            kelly_results[sym] = k

    # Target prices + stop losses
    targets = {}
    for sym in symbols:
        inst  = instruments.get(sym, {})
        price = inst.get('last_price', 0)
        ps    = mc_result.get('per_stock', {}).get(sym, {})
        cal   = inst.get('calibration') or {}
        sigma_daily = cal.get('sigma', {}).get(regime, 0.25) / np.sqrt(252)
        if price and ps:
            targets[sym] = calc_targets(price, ps, sigma_daily, regime)

    # ── PORTFOLIO OPTIMIZATION ───────────────────────────────
    # Kelly sizing adjusted for cross-asset correlations
    # Over-allocated correlated positions get reduced
    portfolio_kelly_optimized = {}
    if len(symbols) >= 2 and kelly_results:
        raw_kellys  = np.array([kelly_results.get(s, 0) for s in symbols])
        total_kelly = raw_kellys.sum()
        if total_kelly > 0.5:
            # Scale down if total exceeds 50% — diversification constraint
            scale = 0.5 / total_kelly
            raw_kellys *= scale
        # Correlation penalty: reduce allocation for highly correlated pairs
        for i, sym in enumerate(symbols):
            k = raw_kellys[i]
            for j, sym2 in enumerate(symbols):
                if i != j:
                    corr = float(corr_mat[i,j]) if i < corr_mat.shape[0] and j < corr_mat.shape[1] else 0
                    if corr > 0.7:  # highly correlated
                        k *= (1 - (corr - 0.7) * 0.5)
            portfolio_kelly_optimized[sym] = round(float(max(0, k)), 4)

    return {
        'correlation_matrix': {
            symbols[i]: {symbols[j]: round(float(corr_mat[i,j]), 3)
                         for j in range(len(symbols))}
            for i in range(len(symbols))
        },
        'monte_carlo':   mc_result,
        'kelly':                    kelly_results,
        'kelly_optimized':          portfolio_kelly_optimized,
        'targets':       targets,
        'symbols':       symbols,
        'regime':        regime,
        'generated_at':  datetime.utcnow().isoformat(),
    }


# ── BACKTEST ──────────────────────────────────────────────────
def run_full_backtest(instruments: dict, snap: dict) -> dict:
    print("Running walk-forward backtest...")

    # Build Nifty history from Nifty 50 instrument if available
    nifty_inst = instruments.get('NIFTY50') or instruments.get('NIFTY 50') or {}
    nifty_hist = nifty_inst.get('_price_history', [])

    if len(nifty_hist) < 60:
        # Build from any large-cap stock as proxy
        for sym in ['HDFCBANK', 'RELIANCE', 'TCS']:
            inst = instruments.get(sym, {})
            hist = inst.get('_price_history', [])
            if len(hist) >= 60:
                nifty_hist = hist
                break

    if len(nifty_hist) < 60:
        return {'error': 'Insufficient price history for backtest'}

    try:
        result = run_backtest(
            instruments    = instruments,
            nifty_history  = nifty_hist,
            lookback_months= min(12, len(nifty_hist) // 21),
            holding_days   = 63,
            top_n          = 10,
        )
        return result
    except Exception as e:
        return {'error': str(e)}


# ── AI NARRATIVE (Claude Sonnet) ──────────────────────────────
def generate_narrative(snap: dict, all_scores: dict,
                        portfolio_analytics: dict) -> dict:
    print("Generating narratives with Claude Sonnet...")
    client = anthropic.Anthropic(api_key=os.environ['ANTHROPIC_API_KEY'])

    regime  = snap.get('regime', 'SIDEWAYS')
    fii     = (snap.get('fii') or {}).get('fii_net', 0)
    vix     = (snap.get('indices') or {}).get('INDIA VIX', {}).get('last', 18)
    nifty   = (snap.get('indices') or {}).get('NIFTY 50', {}).get('last', 23000)
    brent   = snap.get('brent') or 90
    usdInr  = snap.get('usdInr') or 86

    # Top 10 stocks
    top10 = sorted(all_scores.items(), key=lambda x: x[1]['score'], reverse=True)[:10]
    top10_str = ', '.join([f"{sym}({s['score']})" for sym, s in top10])

    # Portfolio MC stats
    port_stats = portfolio_analytics.get('monte_carlo', {}).get('portfolio', {})
    net_k  = portfolio_analytics.get('kelly', {}).get('NET', 0)
    ceg_k  = portfolio_analytics.get('kelly', {}).get('CEG', 0)
    glng_k = portfolio_analytics.get('kelly', {}).get('GLNG', 0)
    div_ratio = portfolio_analytics.get('monte_carlo', {}).get('diversification_ratio', 1.0)

    prompt = f"""You are a senior investment analyst. Write a concise market briefing.

QUANTITATIVE SIGNALS (mathematically derived):
Regime: {regime} | FII: {round(fii)} Cr | VIX: {vix} | Nifty: {round(nifty)} | Oil: ${brent} | USD/INR: {usdInr}

TOP 10 QUANT SCORES (factor model, not guesses):
{top10_str}

PORTFOLIO ANALYTICS (DCC-GARCH + Cholesky Monte Carlo, 10,000 paths):
Portfolio win prob (3m): {port_stats.get('win_prob', '--')}%
Portfolio expected return: {port_stats.get('expected_return', '--')}%
Portfolio CVaR (5%): {port_stats.get('cvar_5pct', '--')}%
Diversification ratio: {div_ratio} (>1.2 = well diversified)
NET Kelly: {round(net_k*100, 1)}% | CEG Kelly: {round(ceg_k*100, 1)}% | GLNG Kelly: {round(glng_k*100, 1)}%
GLNG-NET correlation: {portfolio_analytics.get('correlation_matrix', {}).get('GLNG', {}).get('NET', '--')}

Write 4 sections:
**Why {regime}**: 2 sentences with specific numbers
**Dominant Theme**: biggest market driver right now
**Domino Chains**: 2-3 active cause-effect chains (be specific)
**Portfolio Signal**: one sentence each for NET, CEG, GLNG based on Kelly sizing

Under 200 words total. Precise. No fluff."""

    try:
        response = client.messages.create(
            model      = 'claude-sonnet-4-5',
            max_tokens = 500,
            messages   = [{'role': 'user', 'content': prompt}]
        )
        narrative = response.content[0].text
    except Exception as e:
        narrative = f"Regime: {regime}. FII {round(fii)} Cr. VIX {vix}. Top picks: {top10_str[:100]}"

    # Domino chains (separate Sonnet call)
    chains_prompt = f"""Identify 3 active domino chains for Indian markets now.
Oil ${brent}, FII {round(fii)} Cr, VIX {vix}, Iran war active, all CBs holding.
User holds NET/CEG/GLNG.

Return ONLY JSON (no markdown):
{{"chains":[{{"trigger":"...","mechanism":"...","severity":4,"positive":[{{"stock":"HAL","adj":3,"reason":"..."}}],"negative":[{{"stock":"INDIGO","adj":-4,"reason":"..."}}]}}]}}"""

    try:
        chains_resp = client.messages.create(
            model      = 'claude-sonnet-4-5',
            max_tokens = 600,
            messages   = [{'role': 'user', 'content': chains_prompt}]
        )
        chains_text = chains_resp.content[0].text.replace('```json','').replace('```','').strip()
        chains = json.loads(chains_text)
    except:
        chains = {'chains': []}

    # Portfolio signal
    port_prompt = f"""Analyse for Indian investor. Return ONLY JSON (no markdown):
NET $208.62avg, CEG $310.43avg, GLNG $50.93avg
USD/INR {usdInr}, Oil ${brent}, FII {round(fii)} Cr, Regime {regime}
Kelly sizing: NET {round(net_k*100,1)}%, CEG {round(ceg_k*100,1)}%, GLNG {round(glng_k*100,1)}%

{{"NET":{{"action":"HOLD","reason":"...","stop_loss":175,"target":265,"kelly_pct":{round(net_k*100,1)}}},"CEG":{{"action":"HOLD","reason":"...","stop_loss":270,"target":380,"kelly_pct":{round(ceg_k*100,1)}}},"GLNG":{{"action":"ADD","reason":"...","stop_loss":42,"target":68,"kelly_pct":{round(glng_k*100,1)}}},"coherence":"...","weekly_outlook":"..."}}"""

    try:
        port_resp = client.messages.create(
            model      = 'claude-sonnet-4-5',
            max_tokens = 400,
            messages   = [{'role': 'user', 'content': port_prompt}]
        )
        port_text   = port_resp.content[0].text.replace('```json','').replace('```','').strip()
        port_signal = json.loads(port_text)
    except:
        port_signal = {}

    return {
        'regimeNarrative': narrative,
        'chains':          chains,
        'portfolioSignal': port_signal,
    }


# ── SAVE TO FIREBASE ──────────────────────────────────────────
def save_results(_ignored, all_scores: dict, portfolio_analytics: dict,
                  backtest: dict, narratives: dict, snap: dict):
    print("Saving results to B2...")
    ts = datetime.utcnow().isoformat()

    scores_payload = {
        'scores':      all_scores,
        'top5':        [s for s,_ in sorted(all_scores.items(),
                         key=lambda x: x[1]['score'], reverse=True)[:5]],
        'avoid':       [s for s,_ in sorted(all_scores.items(),
                         key=lambda x: x[1]['score'])[:5]],
        'regime_note': f"{snap.get('regime')} — quant factor model",
        'generated_at': ts,
        'model':       'python-quant-v1',
    }

    ai_doc = {
        **scores_payload,
        **narratives,
        'portfolio_analytics': portfolio_analytics,
        'market_mood': 'CAUTIOUS' if snap.get('regime') in ('SOFT_BEAR','BEAR') else 'NEUTRAL',
        'generated_at': ts,
    }

    b2_save('ai_analysis_latest.json', ai_doc)

    if backtest and 'error' not in backtest:
        b2_save('backtest_latest.json', {**backtest, 'saved_at': ts})

    b2_save('portfolio_analytics_latest.json', {**portfolio_analytics, 'saved_at': ts})

    print(f"  Saved {len(all_scores)} scores + backtest + portfolio analytics to B2")


# ── MAIN ──────────────────────────────────────────────────────
def main():
    t_start = time.time()
    print(f"\n{'='*60}")
    print(f"PYTHON QUANT ENGINE — {datetime.utcnow().isoformat()}")
    print(f"{'='*60}\n")

    try:
        db = init_b2()
        snap, instruments, news_idx, scored_news = load_data(db)

        if not snap:
            print("ERROR: No snapshot in Firebase. Run morning refresh first.")
            sys.exit(1)

        if len(instruments) == 0:
            print("ERROR: No instruments in Firebase. Run recalibration first.")
            sys.exit(1)

        # 1. Score all instruments (pure math)
        all_scores = score_all(instruments, snap, scored_news, db)

        # 2. Portfolio analytics (GARCH + DCC + Monte Carlo)
        portfolio_analytics = run_portfolio_analytics(instruments, snap, scored_news)

        # 3. Walk-forward backtest
        backtest = run_full_backtest(instruments, snap)

        # 4. AI narratives (Sonnet — only 3 calls)
        narratives = generate_narrative(snap, all_scores, portfolio_analytics)

        # 5. Save everything
        save_results(db, all_scores, portfolio_analytics, backtest, narratives, snap)

        elapsed = round(time.time() - t_start, 1)
        print(f"\n{'='*60}")
        print(f"COMPLETE in {elapsed}s")
        print(f"  Scored:    {len(all_scores)} instruments")
        print(f"  Portfolio: {len(portfolio_analytics.get('symbols',[]))} stocks")
        print(f"  Backtest:  {backtest.get('summary',{}).get('n_periods','--')} periods")
        print(f"  Model IC:  {backtest.get('summary',{}).get('avg_ic','--')}")
        print(f"{'='*60}\n")

        # Output JSON for Node.js to read
        print(json.dumps({'ok': True, 'scored': len(all_scores), 'elapsed': elapsed}))

    except Exception as e:
        print(f"\nERROR: {e}")
        traceback.print_exc()
        print(json.dumps({'ok': False, 'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
