# ═══════════════════════════════════════════════════════════════
# monteCarlo.py — Correlated Portfolio Simulation
# Uses DCC-GARCH volatilities + Cholesky decomposition
# 10,000 paths × horizon days × n_stocks simultaneously
# ═══════════════════════════════════════════════════════════════

import numpy as np
import pandas as pd
from typing import Dict, List, Tuple
from garch import fit_garch, nearest_psd


N_SIMS   = 10000
SEED     = 42  # reproducible results


# ── CHOLESKY DECOMPOSITION ────────────────────────────────────
def cholesky_decomp(corr_matrix: np.ndarray) -> np.ndarray:
    """
    Cholesky decomposition of correlation matrix.
    Ensures matrix is PSD before decomposing.
    Returns lower triangular L such that L @ L.T = corr_matrix
    """
    # Ensure PSD
    eigenvalues = np.linalg.eigvalsh(corr_matrix)
    if np.any(eigenvalues < -1e-8):
        corr_matrix = nearest_psd(corr_matrix)

    # Clip small negative eigenvalues to zero
    np.fill_diagonal(corr_matrix, 1.0)

    try:
        L = np.linalg.cholesky(corr_matrix)
    except np.linalg.LinAlgError:
        # Fallback: use eigendecomposition
        eigvals, eigvecs = np.linalg.eigh(corr_matrix)
        eigvals = np.maximum(eigvals, 1e-8)
        L = eigvecs @ np.diag(np.sqrt(eigvals))

    return L


# ── SINGLE STOCK MONTE CARLO ──────────────────────────────────
def simulate_single(mu: float, sigma: float,
                     horizon_days: int = 63,
                     n_sims: int = N_SIMS,
                     vix_scale: float = 1.0) -> np.ndarray:
    """
    Simulate single stock price paths.
    Returns array of total returns (shape: n_sims)
    """
    rng          = np.random.default_rng(SEED)
    dt           = 1 / 252
    adj_sigma    = sigma * vix_scale
    drift        = (mu - 0.5 * adj_sigma**2) * dt
    diffusion    = adj_sigma * np.sqrt(dt)

    # Vectorized simulation: shape (n_sims, horizon_days)
    Z            = rng.standard_normal((n_sims, horizon_days))
    log_returns  = drift + diffusion * Z
    total_return = np.exp(log_returns.sum(axis=1)) - 1

    return total_return


# ── CORRELATED PORTFOLIO SIMULATION ──────────────────────────
def simulate_portfolio(symbols: List[str],
                        mus: np.ndarray,
                        sigmas: np.ndarray,
                        corr_matrix: np.ndarray,
                        horizon_days: int = 63,
                        n_sims: int = N_SIMS,
                        vix: float = 18.0) -> Dict:
    """
    Simulate correlated portfolio paths using Cholesky decomposition.

    Parameters:
    -----------
    symbols:      list of stock symbols
    mus:          annual expected returns (array)
    sigmas:       annual volatilities from GARCH (array)
    corr_matrix:  DCC correlation matrix
    horizon_days: simulation horizon (63 = 3 months)
    vix:          current VIX for volatility scaling

    Returns:
    --------
    Dict with per-stock and portfolio statistics
    """
    n         = len(symbols)
    rng       = np.random.default_rng(SEED)
    dt        = 1 / 252

    # VIX scaling: VIX 15 = normal, higher VIX = more volatile
    vix_scale = np.clip(vix / 15.0, 0.7, 2.5)
    adj_sigmas = sigmas * vix_scale

    # Fat tails via Student-t (df=5 captures equity return distribution)
    # Better than normal for real market returns
    df = 5

    # Cholesky decomposition of correlation matrix
    L = cholesky_decomp(corr_matrix)

    # Simulate: shape (n_sims, horizon_days, n_stocks)
    # Generate correlated standard normals
    Z_indep = rng.standard_t(df=df, size=(n_sims, horizon_days, n))
    Z_indep /= np.sqrt(df / (df - 2))  # normalize to unit variance

    # Apply Cholesky: correlated returns
    # Z_corr[sim, day, :] = L @ Z_indep[sim, day, :]
    Z_corr = Z_indep @ L.T  # shape: (n_sims, horizon_days, n)

    # Compute log returns for each stock
    drifts     = (mus - 0.5 * adj_sigmas**2) * dt      # shape: (n,)
    diffusions = adj_sigmas * np.sqrt(dt)               # shape: (n,)

    log_ret    = drifts + diffusions * Z_corr            # broadcasting
    total_ret  = np.exp(log_ret.sum(axis=1)) - 1        # shape: (n_sims, n)

    # ── Per-stock statistics ──────────────────────────────────
    per_stock  = {}
    for i, sym in enumerate(symbols):
        r = total_ret[:, i]
        per_stock[sym] = _compute_stats(r, sym)

    # ── Portfolio statistics ──────────────────────────────────
    # Equal weight portfolio (will be Kelly-weighted in scoring)
    weights     = np.ones(n) / n
    port_ret    = total_ret @ weights  # shape: (n_sims,)
    port_stats  = _compute_stats(port_ret, 'PORTFOLIO')

    # ── Correlation realized in simulation ────────────────────
    sim_corr    = np.corrcoef(total_ret.T)

    # ── Diversification ratio ─────────────────────────────────
    weighted_avg_vol = float(np.sqrt(total_ret.var(axis=0)) @ weights)
    port_vol         = float(port_ret.std())
    div_ratio        = weighted_avg_vol / port_vol if port_vol > 0 else 1.0

    # ── Scenario analysis ─────────────────────────────────────
    # Sort by portfolio return, get corresponding stock returns
    sorted_idx     = np.argsort(port_ret)
    worst_5pct_idx = sorted_idx[:int(n_sims * 0.05)]
    scenarios = {
        'market_crash_5pct': {
            sym: float(total_ret[worst_5pct_idx, i].mean())
            for i, sym in enumerate(symbols)
        }
    }

    return {
        'per_stock':        per_stock,
        'portfolio':        port_stats,
        'sim_correlations': {
            symbols[i]: {symbols[j]: round(float(sim_corr[i, j]), 3)
                         for j in range(n)}
            for i in range(n)
        },
        'diversification_ratio': round(div_ratio, 3),
        'scenarios':        scenarios,
        'inputs': {
            'symbols':       symbols,
            'mus':           mus.tolist(),
            'sigmas':        sigmas.tolist(),
            'vix_scale':     round(float(vix_scale), 3),
            'horizon_days':  horizon_days,
            'n_sims':        n_sims,
        }
    }


def _compute_stats(returns: np.ndarray, symbol: str) -> Dict:
    """Compute full return distribution statistics."""
    sorted_r  = np.sort(returns)
    n         = len(sorted_r)

    win_prob  = int(np.mean(returns > 0) * 100)
    mean_ret  = float(returns.mean())
    std_ret   = float(returns.std())

    p5        = float(np.percentile(returns, 5))
    p25       = float(np.percentile(returns, 25))
    p50       = float(np.percentile(returns, 50))
    p75       = float(np.percentile(returns, 75))
    p95       = float(np.percentile(returns, 95))

    # CVaR = Expected Shortfall (mean of worst 5%)
    worst_5pct = sorted_r[:int(n * 0.05)]
    cvar       = float(worst_5pct.mean()) if len(worst_5pct) > 0 else p5

    # Skewness and kurtosis
    skew      = float(((returns - returns.mean())**3).mean() / std_ret**3) if std_ret > 0 else 0
    kurt      = float(((returns - returns.mean())**4).mean() / std_ret**4) - 3 if std_ret > 0 else 0

    return {
        'symbol':         symbol,
        'win_prob':       win_prob,
        'expected_return':round(mean_ret * 100, 1),
        'volatility':     round(std_ret * 100, 1),
        'p5_return':      round(p5  * 100, 1),
        'p25_return':     round(p25 * 100, 1),
        'median_return':  round(p50 * 100, 1),
        'p75_return':     round(p75 * 100, 1),
        'p95_return':     round(p95 * 100, 1),
        'var_5pct':       round(p5  * 100, 1),
        'cvar_5pct':      round(cvar * 100, 1),
        'skewness':       round(skew, 2),
        'excess_kurtosis':round(kurt, 2),
        'sharpe':         round(mean_ret / std_ret * np.sqrt(252/63), 2) if std_ret > 0 else 0,
    }


# ── KELLY CRITERION ───────────────────────────────────────────
def kelly_fraction(win_prob: float, expected_return: float,
                    var_5pct: float) -> float:
    """
    Kelly criterion using simulation output.
    f* = (p × b - q) / b
    where b = avg win / avg loss ratio
    """
    p = win_prob / 100
    q = 1 - p

    avg_win  = expected_return / 100 if expected_return > 0 else 0.10
    avg_loss = abs(var_5pct) / 100    if var_5pct < 0 else 0.10

    if avg_loss < 1e-6:
        return 0.0

    b      = avg_win / avg_loss
    kelly  = (p * b - q) / b

    # Cap at 25% (half-Kelly is safer in practice)
    return round(float(np.clip(kelly, 0, 0.25)), 4)


# ── TARGET PRICE + STOP LOSS ──────────────────────────────────
def calc_targets(current_price: float, mc_stats: Dict,
                  sigma_daily: float, regime: str) -> Dict:
    """
    Mathematical target price and stop loss from simulation output.
    """
    if not current_price or current_price <= 0:
        return {}

    p75_ret = mc_stats.get('p75_return', 10) / 100
    p25_ret = mc_stats.get('p25_return', -5) / 100
    p95_ret = mc_stats.get('p95_return', 25) / 100
    p5_ret  = mc_stats.get('var_5pct', -15) / 100

    # Stop loss: 2 standard deviations below current price (monthly)
    monthly_sigma = sigma_daily * np.sqrt(21)
    stop_mult     = 2.0 if regime in ('BEAR', 'SOFT_BEAR') else 1.5
    stop_loss     = current_price * (1 - stop_mult * monthly_sigma)

    return {
        'target_price':  round(current_price * (1 + p75_ret), 2),
        'bear_case':     round(current_price * (1 + p25_ret), 2),
        'bull_case':     round(current_price * (1 + p95_ret), 2),
        'stop_loss':     round(max(stop_loss, current_price * 0.70), 2),  # max 30% loss
        'risk_reward':   round(abs(p75_ret / p5_ret), 2) if p5_ret != 0 else 0,
        'upside_pct':    round(p75_ret * 100, 1),
        'downside_pct':  round(p5_ret  * 100, 1),
    }
