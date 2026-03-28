# ═══════════════════════════════════════════════════════════════
# correlations.py — Factor Model + Beta Estimation
# APT: each stock = weighted sum of factor exposures + alpha
# Factors: Nifty50, SectorIdx, Oil, USD/INR, Gold, VIX, SP500
# Cross-market (India/US) via common global factors
# ═══════════════════════════════════════════════════════════════

import numpy as np
import pandas as pd
from scipy.stats import linregress
from typing import Dict, List, Tuple
import warnings
warnings.filterwarnings('ignore')


# ── SECTOR → FACTOR MAPPING ───────────────────────────────────
# Maps stock sector to its primary factor exposure
SECTOR_FACTORS = {
    'Defence':          {'nifty': 0.55, 'oil': 0.15,  'usd': 0.10,  'gold': 0.05},
    'IT':               {'nifty': 0.45, 'usd': 0.45,  'sp500': 0.30, 'oil':-0.10},
    'Banking':          {'nifty': 0.85, 'oil':-0.10,  'usd':-0.15,  'gold':-0.10},
    'NBFC':             {'nifty': 0.80, 'oil':-0.10,  'usd':-0.10},
    'Oil Gas':          {'nifty': 0.45, 'oil': 0.65,  'usd': 0.10},
    'LNG':              {'nifty': 0.30, 'oil': 0.75,  'sp500': 0.25},
    'Nuclear':          {'nifty': 0.25, 'oil':-0.10,  'sp500': 0.45},
    'Pharma':           {'nifty': 0.40, 'usd': 0.40,  'sp500': 0.20, 'gold': 0.05},
    'FMCG':             {'nifty': 0.50, 'oil':-0.15,  'usd': 0.05,  'gold': 0.10},
    'Auto':             {'nifty': 0.70, 'oil':-0.25,  'usd':-0.10},
    'Gold ETF':         {'gold': 0.95,  'nifty':-0.10,'usd': 0.20},
    'Infra':            {'nifty': 0.75, 'oil':-0.10,  'usd':-0.05},
    'Power':            {'nifty': 0.55, 'oil': 0.10,  'usd': 0.00},
    'Metal':            {'nifty': 0.65, 'oil': 0.15,  'usd':-0.10,  'sp500': 0.15},
    'Realty':           {'nifty': 0.80, 'oil':-0.05,  'usd':-0.15},
    'Telecom':          {'nifty': 0.60, 'usd': 0.05},
    'AI Semiconductors':{'sp500': 0.75, 'nifty': 0.20, 'usd': 0.15},
    'Cloud AI':         {'sp500': 0.70, 'nifty': 0.15, 'usd': 0.10},
    'Edge AI Network':  {'sp500': 0.72, 'nifty': 0.15, 'usd': 0.10},
    'Investment Banking':{'sp500': 0.75,'nifty': 0.25, 'oil':-0.05},
    'Integrated Oil Gas':{'sp500': 0.45,'oil': 0.60,   'usd': 0.05},
    'US ETF':           {'sp500': 0.95, 'nifty': 0.20},
}


# ── BETA ESTIMATION FROM PRICE HISTORY ───────────────────────
def estimate_beta(stock_returns: pd.Series,
                  factor_returns: pd.DataFrame) -> Dict[str, float]:
    """
    Estimate factor betas using OLS regression.
    stock_returns: daily log returns of stock
    factor_returns: DataFrame with columns [nifty, oil, usd, gold, sp500]
    """
    betas    = {}
    alpha    = 0.0
    r2       = 0.0
    resid_std = 0.0

    # Align indices
    aligned = pd.concat([stock_returns, factor_returns], axis=1).dropna()
    if len(aligned) < 30:
        return {'beta_nifty': 1.0, 'alpha': 0.0, 'r2': 0.0, 'idio_vol': 0.25}

    y = aligned.iloc[:, 0].values
    X = aligned.iloc[:, 1:].values

    # Add intercept
    X_const = np.column_stack([np.ones(len(X)), X])

    try:
        # OLS: β = (X'X)^{-1} X'y
        coeffs  = np.linalg.lstsq(X_const, y, rcond=None)[0]
        alpha   = float(coeffs[0]) * 252  # annualized alpha
        y_hat   = X_const @ coeffs
        resids  = y - y_hat
        ss_res  = np.sum(resids**2)
        ss_tot  = np.sum((y - y.mean())**2)
        r2      = max(0, 1 - ss_res / ss_tot) if ss_tot > 0 else 0

        for i, col in enumerate(factor_returns.columns):
            betas[f'beta_{col}'] = round(float(coeffs[i+1]), 3)

        resid_std = float(resids.std() * np.sqrt(252))

    except Exception as e:
        betas['beta_nifty'] = 1.0

    return {
        **betas,
        'alpha':    round(alpha * 100, 2),  # annualized % alpha
        'r2':       round(r2, 3),
        'idio_vol': round(resid_std, 4),    # idiosyncratic (stock-specific) volatility
    }


# ── FACTOR CORRELATION MATRIX ─────────────────────────────────
def build_factor_correlation(factor_returns: pd.DataFrame,
                              regime: str) -> np.ndarray:
    """
    Build regime-conditional factor correlation matrix.
    Correlations change by regime — bear markets = higher correlations.
    """
    from garch import scale_correlation_for_regime

    base_corr = factor_returns.corr().values
    return scale_correlation_for_regime(base_corr, regime)


# ── IMPLIED STOCK CORRELATION ─────────────────────────────────
def implied_correlation(beta_i: Dict, beta_j: Dict,
                         factor_corr: np.ndarray,
                         factor_names: List[str],
                         sigma_i: float, sigma_j: float,
                         idio_vol_i: float, idio_vol_j: float) -> float:
    """
    Compute implied correlation between stocks i and j
    from their factor exposures.

    corr(i,j) = (β_i' Σ_F β_j) / (σ_i × σ_j)
    where Σ_F is the factor covariance matrix
    """
    b_i = np.array([beta_i.get(f'beta_{f}', 0.0) for f in factor_names])
    b_j = np.array([beta_j.get(f'beta_{f}', 0.0) for f in factor_names])

    # Factor covariance = correlation × vol_i × vol_j
    # Using factor volatilities (approximate as 1 for normalized factors)
    factor_cov = factor_corr  # normalized

    # Cross-covariance from factors
    cov_ij = b_i @ factor_cov @ b_j

    # Total variance includes idiosyncratic (stocks independent in idio)
    var_i = (b_i @ factor_cov @ b_i) + idio_vol_i**2
    var_j = (b_j @ factor_cov @ b_j) + idio_vol_j**2

    denom = np.sqrt(var_i * var_j)
    if denom < 1e-8:
        return 0.0

    return float(np.clip(cov_ij / denom, -0.99, 0.99))


# ── BUILD FULL CORRELATION MATRIX FOR PORTFOLIO ───────────────
def build_portfolio_correlation(portfolio_symbols: List[str],
                                 instruments: Dict,
                                 factor_returns: pd.DataFrame,
                                 regime: str) -> Tuple[np.ndarray, List[str]]:
    """
    Build correlation matrix for a set of portfolio stocks.
    Uses DCC-GARCH if price history available, else factor model.
    """
    from garch import fit_garch, fit_dcc, scale_correlation_for_regime

    n         = len(portfolio_symbols)
    corr_mat  = np.eye(n)
    garch_res = {}

    # Step 1: Fit GARCH to each stock, get standardized residuals
    std_resids = {}
    for sym in portfolio_symbols:
        inst = instruments.get(sym, {})
        hist = inst.get('_price_history', [])
        if len(hist) < 60:
            continue
        prices  = pd.Series([h['close'] for h in hist if h.get('close')])
        returns = np.log(prices / prices.shift(1)).dropna()
        g       = fit_garch(returns, sym)
        garch_res[sym] = g

        # Get standardized residuals for DCC
        if g['fitted'] and len(returns) > 0:
            # Reconstruct conditional volatility
            vol_daily = returns.std()  # fallback
            std_resids[sym] = (returns / vol_daily).fillna(0)

    # Step 2: DCC on standardized residuals if enough data
    if len(std_resids) >= 2:
        common_idx  = None
        for s, sr in std_resids.items():
            common_idx = sr.index if common_idx is None else common_idx.intersection(sr.index)

        if common_idx is not None and len(common_idx) >= 30:
            resid_df = pd.DataFrame({s: std_resids[s].loc[common_idx]
                                     for s in portfolio_symbols if s in std_resids})
            if resid_df.shape[1] >= 2:
                dcc = fit_dcc(resid_df)
                raw_corr = dcc['corr_matrix']
                # Scale for regime
                corr_mat = scale_correlation_for_regime(raw_corr, regime)
                return corr_mat, list(resid_df.columns)

    # Step 3: Fall back to factor model correlation
    factor_names = list(factor_returns.columns)
    factor_corr  = build_factor_correlation(factor_returns, regime)

    betas = {}
    sigmas = {}
    idios  = {}

    for sym in portfolio_symbols:
        inst = instruments.get(sym, {})
        hist = inst.get('_price_history', [])
        sector = inst.get('sector', 'Unknown')

        if len(hist) >= 30:
            prices  = pd.Series([h['close'] for h in hist if h.get('close')])
            returns = np.log(prices / prices.shift(1)).dropna()
            b       = estimate_beta(returns, factor_returns.reindex(returns.index))
            betas[sym]  = b
            sigmas[sym] = garch_res.get(sym, {}).get('sigma_today',
                          inst.get('calibration', {}).get('sigma', {}).get(regime, 0.25))
            idios[sym]  = b.get('idio_vol', 0.15)
        else:
            # Use sector defaults
            sf = {}
            for k, v in SECTOR_FACTORS.items():
                if k.lower() in sector.lower():
                    sf = v
                    break
            betas[sym]  = {f'beta_{f}': sf.get(f, 0) for f in factor_names}
            sigmas[sym] = inst.get('calibration', {}).get('sigma', {}).get(regime, 0.25)
            idios[sym]  = 0.15

    # Build correlation matrix from factor model
    for i, sym_i in enumerate(portfolio_symbols):
        for j, sym_j in enumerate(portfolio_symbols):
            if i == j:
                corr_mat[i, j] = 1.0
            elif i < j:
                c = implied_correlation(
                    betas[sym_i], betas[sym_j],
                    factor_corr, factor_names,
                    sigmas[sym_i], sigmas[sym_j],
                    idios[sym_i], idios[sym_j],
                )
                corr_mat[i, j] = c
                corr_mat[j, i] = c

    return corr_mat, portfolio_symbols
