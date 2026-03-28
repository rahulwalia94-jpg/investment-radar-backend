# ═══════════════════════════════════════════════════════════════
# backtester.py — Walk-Forward Backtest Engine
# Tests the factor model against real historical performance
# Calculates Information Coefficient, hit rate, factor attribution
# ═══════════════════════════════════════════════════════════════

import numpy as np
import pandas as pd
from typing import Dict, List, Tuple
from signals import calc_all_signals
import warnings
warnings.filterwarnings('ignore')


# ── REGIME CLASSIFICATION (historical) ───────────────────────
def classify_regime(nifty_price: float, sma20: float,
                     momentum_10d: float, vol_proxy: float) -> str:
    score = 0
    if nifty_price > sma20 * 1.03 and momentum_10d > 3:   score += 2
    elif nifty_price > sma20 * 1.01 and momentum_10d > 0:  score += 1
    elif nifty_price < sma20 * 0.97 and momentum_10d < -3: score -= 2
    elif nifty_price < sma20 * 0.99 and momentum_10d < 0:  score -= 1
    if vol_proxy < 14:   score += 2
    elif vol_proxy > 22: score -= 2
    elif vol_proxy > 18: score -= 1
    if score >= 3:    return 'BULL'
    if score >= 1:    return 'SOFT_BULL'
    if score >= -1:   return 'SIDEWAYS'
    if score >= -3:   return 'SOFT_BEAR'
    return 'BEAR'


# ── RECONSTRUCT HISTORICAL SNAPSHOT ──────────────────────────
def build_historical_snapshot(nifty_hist: List[Dict],
                               idx: int,
                               fii_net: float = 0) -> Dict:
    """Build a snapshot dict as if we were at day idx in history."""
    if idx < 20 or idx >= len(nifty_hist):
        return {'regime': 'SIDEWAYS', 'fii': {'fii_net': 0}, 'indices': {}}

    window  = nifty_hist[max(0, idx-20):idx]
    prices  = [d['close'] for d in window if d.get('close')]
    if len(prices) < 10:
        return {'regime': 'SIDEWAYS', 'fii': {'fii_net': 0}, 'indices': {}}

    sma20   = np.mean(prices)
    current = prices[-1]
    old10   = prices[-10] if len(prices) >= 10 else prices[0]
    mom10   = (current - old10) / old10 * 100

    # Proxy VIX from realized volatility
    log_rets = np.diff(np.log(prices))
    vol_proxy = float(np.std(log_rets) * np.sqrt(252) * 100) if len(log_rets) > 1 else 18.0

    regime  = classify_regime(current, sma20, mom10, vol_proxy)

    return {
        'regime':       regime,
        'regime_score': 0,
        'fii':          {'fii_net': fii_net},
        'indices':      {'INDIA VIX': {'last': vol_proxy},
                         'NIFTY 50':  {'last': current, 'pChange': mom10}},
        'brent':        90,
        'usdInr':       86,
        'usPrices':     {},
    }


# ── WALK-FORWARD BACKTEST ─────────────────────────────────────
def run_backtest(instruments: Dict,
                  nifty_history: List[Dict],
                  lookback_months: int = 12,
                  holding_days: int = 63,   # 3-month holding
                  top_n: int = 10) -> Dict:
    """
    Walk-forward backtest of the factor model.

    For each month in lookback period:
    1. Score all instruments using only data available at that date
    2. Select top-N stocks
    3. Measure actual forward return over holding_days
    4. Calculate IC, hit rate, factor attribution

    Returns backtest report dict.
    """
    results     = []
    ic_series   = []
    monthly_rets= []

    total_steps = lookback_months
    step_days   = 21  # monthly rebalancing

    print(f"Running {lookback_months}-month walk-forward backtest...")

    for month in range(lookback_months, 0, -1):
        eval_idx   = len(nifty_history) - (month * step_days)
        fwd_idx    = eval_idx + holding_days

        if eval_idx < 30 or fwd_idx >= len(nifty_history):
            continue

        snap = build_historical_snapshot(nifty_history, eval_idx)
        regime = snap['regime']
        eval_date = nifty_history[eval_idx].get('date', f'T-{month}m')

        # Score each instrument using data up to eval_idx
        scores_at_date = {}
        actual_returns = {}

        for sym, inst in instruments.items():
            hist = inst.get('_price_history', [])
            if len(hist) < eval_idx + 10:
                continue

            # Truncate to data available at eval date
            inst_at_date = {
                **inst,
                '_price_history': hist[:eval_idx],
                'last_price':     hist[eval_idx].get('close') if eval_idx < len(hist) else None,
                'week52_high':    max((h['close'] for h in hist[max(0,eval_idx-252):eval_idx] if h.get('close')), default=None),
                'week52_low':     min((h['close'] for h in hist[max(0,eval_idx-252):eval_idx] if h.get('close')), default=None),
            }

            try:
                sig_result  = calc_all_signals(inst_at_date, snap, [])
                scores_at_date[sym] = sig_result['score']
            except:
                continue

            # Calculate actual forward return
            if fwd_idx < len(hist):
                entry = hist[eval_idx].get('close')
                exit_ = hist[fwd_idx].get('close')
                if entry and exit_ and entry > 0:
                    actual_returns[sym] = (exit_ - entry) / entry * 100

        if len(scores_at_date) < 5 or len(actual_returns) < 5:
            continue

        # Information Coefficient = rank correlation between scores and returns
        common = list(set(scores_at_date.keys()) & set(actual_returns.keys()))
        if len(common) < 5:
            continue

        pred   = pd.Series({s: scores_at_date[s]  for s in common})
        actual = pd.Series({s: actual_returns[s] for s in common})

        # Spearman rank correlation
        ic = float(pred.rank().corr(actual.rank()))
        ic_series.append(ic)

        # Top-N portfolio return
        top_syms   = pred.nlargest(top_n).index.tolist()
        top_rets   = [actual_returns[s] for s in top_syms if s in actual_returns]
        port_ret   = np.mean(top_rets) if top_rets else 0

        # Nifty return over same period
        nifty_entry = nifty_history[eval_idx].get('close', 23000)
        nifty_exit  = nifty_history[fwd_idx].get('close', 23000)
        nifty_ret   = (nifty_exit - nifty_entry) / nifty_entry * 100

        # Hit rate: how many top-N picks outperformed Nifty
        hit_rate = np.mean([actual_returns.get(s, 0) > nifty_ret
                            for s in top_syms]) * 100

        monthly_rets.append({
            'date':          eval_date,
            'regime':        regime,
            'ic':            round(ic, 3),
            'portfolio_ret': round(port_ret, 2),
            'nifty_ret':     round(nifty_ret, 2),
            'alpha':         round(port_ret - nifty_ret, 2),
            'hit_rate':      round(hit_rate, 1),
            'top_picks':     top_syms[:5],
            'n_scored':      len(scores_at_date),
        })

    if not monthly_rets:
        return {'error': 'Insufficient data for backtest'}

    df = pd.DataFrame(monthly_rets)

    # ── CUMULATIVE PERFORMANCE ────────────────────────────────
    df['port_cum']  = (1 + df['portfolio_ret']/100).cumprod() - 1
    df['nifty_cum'] = (1 + df['nifty_ret']/100).cumprod() - 1

    # ── REGIME ATTRIBUTION ────────────────────────────────────
    regime_perf = {}
    for reg in ['BULL', 'SOFT_BULL', 'SIDEWAYS', 'SOFT_BEAR', 'BEAR']:
        sub = df[df['regime'] == reg]
        if len(sub) > 0:
            regime_perf[reg] = {
                'avg_alpha':    round(float(sub['alpha'].mean()), 2),
                'avg_ic':       round(float(sub['ic'].mean()), 3),
                'hit_rate':     round(float(sub['hit_rate'].mean()), 1),
                'n_periods':    len(sub),
                'best_month':   round(float(sub['portfolio_ret'].max()), 2),
                'worst_month':  round(float(sub['portfolio_ret'].min()), 2),
            }

    # ── SUMMARY STATISTICS ────────────────────────────────────
    total_port_ret  = float((1 + df['portfolio_ret']/100).prod() - 1) * 100
    total_nifty_ret = float((1 + df['nifty_ret']/100).prod() - 1) * 100
    sharpe          = float(df['alpha'].mean() / df['alpha'].std()) * np.sqrt(12) if df['alpha'].std() > 0 else 0
    max_dd          = float((df['port_cum'] - df['port_cum'].cummax()).min()) * 100

    return {
        'summary': {
            'total_return_model':  round(total_port_ret, 1),
            'total_return_nifty':  round(total_nifty_ret, 1),
            'total_alpha':         round(total_port_ret - total_nifty_ret, 1),
            'avg_ic':              round(float(np.mean(ic_series)), 3),
            'ic_positive_rate':    round(float(np.mean([i > 0 for i in ic_series])) * 100, 1),
            'avg_monthly_alpha':   round(float(df['alpha'].mean()), 2),
            'sharpe_ratio':        round(sharpe, 2),
            'max_drawdown':        round(max_dd, 1),
            'avg_hit_rate':        round(float(df['hit_rate'].mean()), 1),
            'n_periods':           len(df),
            'lookback_months':     lookback_months,
            'holding_days':        holding_days,
            'top_n':               top_n,
        },
        'regime_attribution':  regime_perf,
        'monthly_results':     monthly_rets,
        'ic_series':           ic_series,
    }
