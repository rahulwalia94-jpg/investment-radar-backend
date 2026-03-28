# ═══════════════════════════════════════════════════════════════
# signals.py — Quantitative Signal Engine (Python/NumPy)
# 6 factor signals, all pure math, regime-weighted combination
# ═══════════════════════════════════════════════════════════════

import numpy as np
from typing import Dict, List


# ── REGIME WEIGHTS ────────────────────────────────────────────
REGIME_WEIGHTS = {
    'BULL':      {'valuation':0.10,'quality':0.15,'momentum':0.35,'macro_fit':0.25,'news':0.10,'mean_reversion':0.05},
    'SOFT_BULL': {'valuation':0.15,'quality':0.20,'momentum':0.25,'macro_fit':0.25,'news':0.10,'mean_reversion':0.05},
    'SIDEWAYS':  {'valuation':0.20,'quality':0.20,'momentum':0.15,'macro_fit':0.25,'news':0.12,'mean_reversion':0.08},
    'SOFT_BEAR': {'valuation':0.25,'quality':0.20,'momentum':0.10,'macro_fit':0.25,'news':0.12,'mean_reversion':0.08},
    'BEAR':      {'valuation':0.20,'quality':0.25,'momentum':0.05,'macro_fit':0.35,'news':0.08,'mean_reversion':0.07},
}

# ── SECTOR MACRO FIT ──────────────────────────────────────────
# [BULL, SOFT_BULL, SIDEWAYS, SOFT_BEAR, BEAR]
SECTOR_MACRO_FIT = {
    'defence':       [0.70, 0.80, 0.90, 0.90, 0.80],
    'it':            [0.80, 0.70, 0.50, 0.40, 0.20],
    'software':      [0.80, 0.70, 0.50, 0.40, 0.20],
    'cloud':         [0.85, 0.75, 0.55, 0.40, 0.20],
    'ai':            [0.90, 0.80, 0.55, 0.35, 0.15],
    'banking':       [0.80, 0.60, 0.30,-0.10,-0.40],
    'nbfc':          [0.70, 0.50, 0.20,-0.30,-0.60],
    'oil':           [0.50, 0.50, 0.60, 0.70, 0.60],
    'lng':           [0.60, 0.60, 0.70, 0.80, 0.80],
    'nuclear':       [0.70, 0.70, 0.80, 0.80, 0.70],
    'energy':        [0.55, 0.55, 0.60, 0.70, 0.60],
    'pharma':        [0.60, 0.70, 0.80, 0.90, 0.80],
    'health':        [0.55, 0.65, 0.75, 0.85, 0.80],
    'fmcg':          [0.40, 0.55, 0.70, 0.85, 0.90],
    'auto':          [0.70, 0.60, 0.30,-0.10,-0.40],
    'gold':          [-0.30,-0.10, 0.30, 0.70, 0.90],
    'silver':        [-0.20, 0.00, 0.30, 0.60, 0.80],
    'infra':         [0.80, 0.60, 0.40, 0.10,-0.20],
    'power':         [0.45, 0.55, 0.60, 0.65, 0.55],
    'metal':         [0.70, 0.50, 0.20,-0.20,-0.50],
    'realty':        [0.80, 0.55, 0.20,-0.20,-0.55],
    'telecom':       [0.50, 0.50, 0.50, 0.45, 0.40],
    'etf':           [0.70, 0.55, 0.40, 0.20,-0.10],
    'semiconductor': [0.85, 0.70, 0.45, 0.20,-0.10],
}

REGIME_IDX = {'BULL':0,'SOFT_BULL':1,'SIDEWAYS':2,'SOFT_BEAR':3,'BEAR':4}


def _get_sector_fit(sector: str, regime: str) -> float:
    """Look up sector macro fit for regime."""
    s   = sector.lower()
    idx = REGIME_IDX.get(regime, 2)
    for key, fits in SECTOR_MACRO_FIT.items():
        if key in s:
            return fits[idx]
    return 0.0  # unknown sector = neutral


# ── 1. VALUATION SIGNAL ───────────────────────────────────────
def valuation_signal(inst: Dict) -> float:
    val = inst.get('valuation') or {}
    cal = inst.get('calibration') or {}
    score, weight = 0.0, 0.0

    pe     = val.get('pe')
    pe5yr  = cal.get('pe_5yr_avg')
    pb     = val.get('pb')
    div    = val.get('divYield')

    if pe and pe5yr and pe > 0 and pe5yr > 0:
        pe_ratio = pe / pe5yr
        pe_sig   = np.clip((1 - pe_ratio) * 2.5, -1, 1)
        score   += pe_sig * 0.45
        weight  += 0.45

    if pb and pb > 0:
        pb_sig   = np.clip((2.5 - pb) / 2.5, -1, 1)
        score   += pb_sig * 0.25
        weight  += 0.25

    if pe and pe > 0:
        ey_sig   = np.clip((100/pe - 7.2) / 5, -1, 1)
        score   += ey_sig * 0.20
        weight  += 0.20

    if div and div > 0:
        div_sig  = min(0.5, div / 5)
        score   += div_sig * 0.10
        weight  += 0.10

    return float(score / weight) if weight > 0 else 0.0


# ── 2. QUALITY SIGNAL ─────────────────────────────────────────
def quality_signal(inst: Dict) -> float:
    val = inst.get('valuation') or {}
    score, weight = 0.0, 0.0

    roe  = val.get('roe')
    roce = val.get('roce')
    de   = val.get('de')
    prom = val.get('promoter')
    rev  = val.get('salesGrowth')

    if roe is not None:
        score  += np.clip((roe - 14) / 20, -1, 1) * 0.30
        weight += 0.30
    if roce is not None:
        score  += np.clip((roce - 12) / 18, -1, 1) * 0.20
        weight += 0.20
    if de is not None:
        score  += np.clip((0.5 - de) / 1.5, -1, 1) * 0.25
        weight += 0.25
    if prom is not None:
        score  += np.clip((prom - 35) / 30, -1, 1) * 0.15
        weight += 0.15
    if rev is not None:
        score  += np.clip(rev / 25, -1, 1) * 0.10
        weight += 0.10

    return float(score / weight) if weight > 0 else 0.0


# ── 3. MOMENTUM SIGNAL ────────────────────────────────────────
def momentum_signal(inst: Dict, regime: str) -> float:
    cal  = inst.get('calibration') or {}
    last = inst.get('last_price') or 0
    w52h = inst.get('week52_high') or 0
    w52l = inst.get('week52_low')  or 0
    bR   = cal.get('base_returns', {}).get(regime)
    bRBull = cal.get('base_returns', {}).get('BULL')

    score, weight = 0.0, 0.0

    if w52h > 0 and w52l > 0 and last > 0:
        rng = w52h - w52l
        if rng > 0:
            pos = (last - w52l) / rng
            score  += np.clip((0.5 - pos) * 2, -1, 1) * 0.40
            weight += 0.40

    if bR is not None:
        score  += np.clip(bR / 30, -1, 1) * 0.35
        weight += 0.35

    if bRBull is not None:
        score  += np.clip(bRBull / 40, -1, 1) * 0.25
        weight += 0.25

    return float(score / weight) if weight > 0 else 0.0


# ── 4. MACRO FIT SIGNAL ───────────────────────────────────────
def macro_fit_signal(inst: Dict, snap: Dict) -> float:
    regime  = snap.get('regime', 'SIDEWAYS')
    fii     = (snap.get('fii') or {}).get('fii_net', 0)
    brent   = snap.get('brent')  or 90
    usdInr  = snap.get('usdInr') or 86
    sector  = inst.get('sector', '').lower()
    country = inst.get('country', 'IN')

    score, weight = 0.0, 0.0

    # Sector-regime fit
    fit = _get_sector_fit(sector, regime)
    score  += fit * 0.35
    weight += 0.35

    # FII signal
    fii_sig = np.clip(fii / 8000, -1, 1)
    is_def  = any(k in sector for k in ['pharma','fmcg','gold','defence','it'])
    fii_adj = -fii_sig * 0.5 if is_def else fii_sig
    score  += fii_adj * 0.25
    weight += 0.25

    # Oil impact
    oil_sig = np.clip((brent - 85) / 20, -1, 1)
    if any(k in sector for k in ['oil','lng','energy','coal']):
        score  += oil_sig * 0.20
        weight += 0.20
    elif any(k in sector for k in ['aviation','airline','paint','tyre','auto']):
        score  += -oil_sig * 0.20
        weight += 0.20
    else:
        weight += 0.10

    # USD/INR impact
    usd_sig = np.clip((usdInr - 83) / 10, -1, 1)
    if any(k in sector for k in ['it','pharma','software']) or country == 'US':
        score  += usd_sig * 0.20
        weight += 0.20
    else:
        weight += 0.10

    return float(score / weight) if weight > 0 else 0.0


# ── 5. NEWS SIGNAL ────────────────────────────────────────────
def news_signal(scored_news: List[Dict]) -> float:
    if not scored_news:
        return 0.0

    import time
    now    = time.time() * 1000  # ms
    total, wsum = 0.0, 0.0
    cnt3d, cntprev = 0, 0

    for item in scored_news:
        sent = item.get('sentiment')
        if sent is None:
            continue

        # Parse date
        try:
            from datetime import datetime
            dt_str = item.get('fetched_at') or item.get('date', '')
            if dt_str:
                dt = datetime.fromisoformat(dt_str.replace('Z',''))
                days_old = (datetime.utcnow() - dt).total_seconds() / 86400
            else:
                days_old = 7
        except:
            days_old = 7

        if days_old > 14:
            continue

        decay = np.exp(-0.15 * days_old)

        title = (item.get('title') or '').lower()
        ew = 1.0
        if any(k in title for k in ['order','contract','win','awarded']):   ew = 1.5
        elif any(k in title for k in ['fda','approval','approved']):        ew = 1.8
        elif any(k in title for k in ['results','earnings','profit']):      ew = 1.3
        elif any(k in title for k in ['miss','disappoint','loss']):         ew = 1.4
        elif any(k in title for k in ['ceo','resign','management']):        ew = 1.2
        elif any(k in title for k in ['dividend','buyback']):               ew = 0.8
        elif any(k in title for k in ['upgrade','target raised']):          ew = 0.9
        elif any(k in title for k in ['downgrade','cut','reduced']):        ew = 0.9

        total += float(sent) * decay * ew
        wsum  += decay * ew

        if days_old <= 3:  cnt3d   += 1
        elif days_old <= 6: cntprev += 1

    if wsum == 0:
        return 0.0

    raw      = total / wsum
    base     = float(np.tanh(raw / 2))
    velocity = np.clip((cnt3d - cntprev) * 0.05, -0.2, 0.2)
    return float(np.clip(base + velocity, -1, 1))


# ── 6. MEAN REVERSION SIGNAL ─────────────────────────────────
def mean_reversion_signal(inst: Dict, snap: Dict) -> float:
    last  = inst.get('last_price') or 0
    w52h  = inst.get('week52_high') or 0
    w52l  = inst.get('week52_low')  or 0
    vix   = ((snap.get('indices') or {}).get('INDIA VIX') or {}).get('last', 18)
    regime= snap.get('regime', 'SIDEWAYS')
    sigma = (inst.get('calibration') or {}).get('sigma', {}).get(regime, 0.25)

    score, weight = 0.0, 0.0

    if w52h > 0 and last > 0:
        pct_from_high = (last - w52h) / w52h
        rev_sig = np.clip(-pct_from_high * 3, -0.5, 1.0)
        score  += rev_sig * 0.40
        weight += 0.40

    if w52h > 0 and w52l > 0 and last > 0:
        rng = w52h - w52l
        if rng > 0:
            pos = (last - w52l) / rng
            score  += np.clip((0.35 - pos) * 2, -1, 1) * 0.30
            weight += 0.30

    vix_boost = 0.10 if vix > 20 else 0.0
    score  += vix_boost * 0.15
    weight += 0.15

    sig_adj = np.clip((0.25 - sigma) * 2, -0.3, 0.3)
    score  += sig_adj * 0.15
    weight += 0.15

    return float(score / weight) if weight > 0 else 0.0


# ── COMBINE ALL SIGNALS ───────────────────────────────────────
def calc_all_signals(inst: Dict, snap: Dict,
                      scored_news: List[Dict]) -> Dict:
    regime  = snap.get('regime', 'SIDEWAYS')
    weights = REGIME_WEIGHTS.get(regime, REGIME_WEIGHTS['SIDEWAYS'])

    signals = {
        'valuation':      valuation_signal(inst),
        'quality':        quality_signal(inst),
        'momentum':       momentum_signal(inst, regime),
        'macro_fit':      macro_fit_signal(inst, snap),
        'news':           news_signal(scored_news),
        'mean_reversion': mean_reversion_signal(inst, snap),
    }

    raw_score = sum(signals[k] * weights[k] for k in weights)
    # Map [-1, +1] → [0, 100]
    final = int(np.clip(round((raw_score + 1) * 50), 0, 100))

    if final >= 75:   signal_label = 'BUY'
    elif final >= 65: signal_label = 'ACCUMULATE'
    elif final >= 50: signal_label = 'HOLD'
    elif final >= 35: signal_label = 'REDUCE'
    else:             signal_label = 'AVOID'

    return {
        'score':   final,
        'signal':  signal_label,
        'raw':     round(raw_score, 4),
        'signals': {k: round(v, 3) for k, v in signals.items()},
        'weights': weights,
    }


# ── MULTI-ASSET SIGNAL (non-equity instruments) ───────────────
# Bonds, REITs, InvITs, Arbitrage, Gold, Silver, Liquid

ASSET_CLASS_REGIME_FIT = {
    # [BULL, SOFT_BULL, SIDEWAYS, SOFT_BEAR, BEAR]
    'COMMODITY':         [-0.3, -0.1,  0.3,  0.7,  0.9],
    'BOND':              [-0.4, -0.2,  0.2,  0.6,  0.8],
    'LIQUID':            [-0.2, -0.1,  0.3,  0.5,  0.6],
    'ARBITRAGE':         [ 0.0,  0.1,  0.3,  0.5,  0.5],
    'REIT':              [ 0.5,  0.4,  0.3,  0.0, -0.3],
    'INVIT':             [ 0.4,  0.5,  0.5,  0.4,  0.3],
    'DOMESTIC_ETF':      [ 0.8,  0.6,  0.3, -0.1, -0.4],
    'INTERNATIONAL_ETF': [ 0.7,  0.6,  0.4,  0.1, -0.2],
}

GSEC_10YR = 7.2  # current 10-year G-Sec yield %


def calc_multi_asset_signal(inst: Dict, snap: Dict) -> Dict:
    """
    Score non-equity instruments: bonds, REITs, InvITs, arbitrage, gold.
    Returns same format as calc_all_signals.
    """
    regime     = snap.get('regime', 'SIDEWAYS')
    asset_class = inst.get('asset_class', 'DOMESTIC_ETF')
    reg_idx    = REGIME_IDX.get(regime, 2)
    fits       = ASSET_CLASS_REGIME_FIT.get(asset_class, [0]*5)
    base_fit   = fits[reg_idx]

    # ── COMMODITY (Gold/Silver) ────────────────────────────────
    if asset_class == 'COMMODITY':
        fii    = (snap.get('fii') or {}).get('fii_net', 0)
        vix    = ((snap.get('indices') or {}).get('INDIA VIX') or {}).get('last', 18)
        # Gold thrives: high VIX, FII selling, USD strength
        fear_score = np.clip(vix / 20 - 0.5, -0.5, 0.5)
        fii_score  = np.clip(-fii / 8000, -0.5, 0.5)  # negative FII = gold up
        usd_score  = np.clip((snap.get('usdInr', 86) - 83) / 10, -0.3, 0.3)
        raw = base_fit * 0.4 + fear_score * 0.25 + fii_score * 0.20 + usd_score * 0.15
        final = int(np.clip(round((raw + 1) * 50), 0, 100))
        reason = f"Fear hedge: VIX {vix:.1f}, FII {round(fii)} Cr"

    # ── BONDS ──────────────────────────────────────────────────
    elif asset_class == 'BOND':
        duration = inst.get('duration_yrs', 5)
        yield_pct = inst.get('yield_pct', 7.2)
        credit    = inst.get('credit', 'SOVEREIGN')
        # Yield spread vs 10yr G-Sec
        spread    = yield_pct - GSEC_10YR
        # Duration: long bonds benefit when rates fall
        dur_score = np.clip((10 - duration) / 10, -0.5, 0.5)  # prefer shorter in rising rate env
        spread_s  = np.clip(spread / 1.5, -0.5, 0.5)
        credit_bonus = 0.1 if credit == 'SOVEREIGN' else 0.0
        raw = base_fit * 0.4 + spread_s * 0.3 + dur_score * 0.2 + credit_bonus * 0.1
        final = int(np.clip(round((raw + 1) * 50), 0, 100))
        reason = f"Yield {yield_pct}% vs G-Sec {GSEC_10YR}%, {duration}yr duration"

    # ── ARBITRAGE ──────────────────────────────────────────────
    elif asset_class == 'ARBITRAGE':
        ret  = inst.get('expected_return_pct', 7.1)
        # Always scores around 55-65 — steady, low-risk, equity-taxed
        tax_benefit = 0.15  # post-tax advantage vs FD
        spread_vs_fd = np.clip((ret - 7.0) / 1.0, -0.3, 0.3)
        raw  = base_fit * 0.5 + spread_vs_fd * 0.3 + tax_benefit * 0.2
        final = int(np.clip(round((raw + 1) * 50), 0, 100))
        reason = f"~{ret}%/yr, equity-taxed (better than FD post-tax)"

    # ── REIT ───────────────────────────────────────────────────
    elif asset_class == 'REIT':
        yield_pct  = inst.get('yield_pct', 6.5)
        noi_growth = inst.get('noi_growth_pct', 8)
        spread     = yield_pct - GSEC_10YR
        spread_s   = np.clip(spread / 1.5, -0.5, 0.5)
        growth_s   = np.clip((noi_growth - 7) / 5, -0.3, 0.3)
        raw = base_fit * 0.4 + spread_s * 0.35 + growth_s * 0.25
        final = int(np.clip(round((raw + 1) * 50), 0, 100))
        reason = f"Yield {yield_pct}% + {noi_growth}% NOI growth"

    # ── InvIT ──────────────────────────────────────────────────
    elif asset_class == 'INVIT':
        yield_pct  = inst.get('yield_pct', 8.5)
        spread     = yield_pct - GSEC_10YR
        spread_s   = np.clip(spread / 2.0, -0.5, 0.5)
        raw = base_fit * 0.5 + spread_s * 0.5
        final = int(np.clip(round((raw + 1) * 50), 0, 100))
        reason = f"Infrastructure yield {yield_pct}% vs G-Sec {GSEC_10YR}%"

    # ── LIQUID ─────────────────────────────────────────────────
    elif asset_class == 'LIQUID':
        yield_pct = inst.get('yield_pct', 6.5)
        raw  = base_fit * 0.4 + np.clip((yield_pct - 6) / 2, -0.3, 0.3) * 0.6
        final = int(np.clip(round((raw + 1) * 50), 0, 100))
        reason = f"~{yield_pct}%/yr, overnight liquidity, near-zero risk"

    # ── ETFs ───────────────────────────────────────────────────
    else:
        # Treat like equity based on regime
        raw   = base_fit
        final = int(np.clip(round((raw + 1) * 50), 0, 100))
        reason = f"Regime fit for {asset_class}"

    if final >= 70:   signal = 'BUY'
    elif final >= 60: signal = 'ACCUMULATE'
    elif final >= 50: signal = 'HOLD'
    elif final >= 35: signal = 'REDUCE'
    else:             signal = 'AVOID'

    return {
        'score':  final,
        'signal': signal,
        'reason': reason,
        'signals': {'macro_fit': base_fit},
        'raw':    round(base_fit, 3),
        'asset_class': asset_class,
    }


def score_instrument(inst: Dict, snap: Dict, scored_news: List[Dict]) -> Dict:
    """
    Universal scorer — routes to equity or multi-asset scoring
    based on asset_class field.
    """
    asset_class = inst.get('asset_class', 'EQUITY')

    if asset_class in ('EQUITY', '') or asset_class is None:
        return calc_all_signals(inst, snap, scored_news)
    else:
        return calc_multi_asset_signal(inst, snap)
