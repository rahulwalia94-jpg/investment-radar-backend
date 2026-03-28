# ═══════════════════════════════════════════════════════════════
# garch.py — GARCH(1,1) + DCC Volatility Engine
# Estimates time-varying volatility and dynamic correlations
# Uses arch library for proper MLE estimation
# ═══════════════════════════════════════════════════════════════

import numpy as np
import pandas as pd
from arch import arch_model
from scipy.optimize import minimize
import warnings
warnings.filterwarnings('ignore')


# ── GARCH(1,1) PER STOCK ─────────────────────────────────────
def fit_garch(returns: pd.Series, symbol: str = '') -> dict:
    """
    Fit GARCH(1,1) to a return series.
    Returns: omega, alpha, beta, today's conditional volatility,
             volatility forecast for next 21 days (1 month)
    """
    try:
        r = returns.dropna() * 100  # arch works better with % returns
        if len(r) < 60:
            raise ValueError(f"Insufficient data: {len(r)} observations")

        model  = arch_model(r, vol='GARCH', p=1, q=1, dist='skewt')
        result = model.fit(disp='off', show_warning=False)

        params = result.params
        omega  = float(params.get('omega', 0.1))
        alpha  = float(params.get('alpha[1]', 0.05))
        beta   = float(params.get('beta[1]', 0.90))

        # Today's conditional volatility (annualized)
        cond_vol_daily  = float(result.conditional_volatility.iloc[-1]) / 100
        cond_vol_annual = cond_vol_daily * np.sqrt(252)

        # 21-day ahead forecast
        forecast        = result.forecast(horizon=21, reindex=False)
        fwd_vol_daily   = float(np.sqrt(forecast.variance.iloc[-1].mean())) / 100
        fwd_vol_annual  = fwd_vol_daily * np.sqrt(252)

        # Long-run (unconditional) volatility
        if alpha + beta < 1:
            lr_var     = omega / (1 - alpha - beta)
            lr_vol     = np.sqrt(lr_var) / 100 * np.sqrt(252)
        else:
            lr_vol     = cond_vol_annual

        return {
            'symbol':       symbol,
            'omega':        round(omega, 6),
            'alpha':        round(alpha, 4),
            'beta':         round(beta, 4),
            'persistence':  round(alpha + beta, 4),
            'sigma_today':  round(cond_vol_annual, 4),
            'sigma_21d':    round(fwd_vol_annual, 4),
            'sigma_lr':     round(lr_vol, 4),
            'vol_regime':   'HIGH' if cond_vol_annual > lr_vol * 1.3 else
                           'LOW'  if cond_vol_annual < lr_vol * 0.7 else 'NORMAL',
            'aic':          round(float(result.aic), 2),
            'fitted':       True,
        }

    except Exception as e:
        # Fallback: use simple realized volatility
        r_clean = returns.dropna()
        if len(r_clean) > 20:
            rv = float(r_clean.std() * np.sqrt(252))
        else:
            rv = 0.25
        return {
            'symbol':       symbol,
            'sigma_today':  round(rv, 4),
            'sigma_21d':    round(rv, 4),
            'sigma_lr':     round(rv, 4),
            'vol_regime':   'NORMAL',
            'fitted':       False,
            'error':        str(e),
        }


# ── DCC-GARCH CORRELATION ─────────────────────────────────────
def fit_dcc(standardized_residuals: pd.DataFrame) -> dict:
    """
    Fit DCC(1,1) to standardized GARCH residuals.
    Engle (2002) two-step estimator.
    Returns: current correlation matrix + DCC parameters a, b
    """
    n      = standardized_residuals.shape[1]
    T      = standardized_residuals.shape[0]
    eps    = standardized_residuals.values

    # Step 1: Unconditional correlation matrix Q_bar
    Q_bar  = np.corrcoef(eps.T)

    def dcc_loglik(params):
        a, b = params
        if a <= 0 or b <= 0 or a + b >= 1:
            return 1e10
        Q   = Q_bar.copy()
        ll  = 0
        for t in range(1, T):
            e   = eps[t-1].reshape(-1, 1)
            Q   = (1 - a - b) * Q_bar + a * (e @ e.T) + b * Q
            # Normalize to correlation matrix
            d   = np.sqrt(np.diag(Q))
            R   = Q / np.outer(d, d)
            # Log-likelihood contribution
            try:
                sign, logdet = np.linalg.slogdet(R)
                if sign <= 0:
                    return 1e10
                ll += -0.5 * (logdet + eps[t] @ np.linalg.solve(R, eps[t]))
            except:
                return 1e10
        return -ll  # minimize negative log-likelihood

    # Optimize DCC parameters
    try:
        result = minimize(
            dcc_loglik,
            x0     = [0.05, 0.90],
            bounds = [(1e-6, 0.5), (1e-6, 0.999)],
            method = 'L-BFGS-B',
        )
        a_dcc, b_dcc = result.x
    except:
        a_dcc, b_dcc = 0.05, 0.90

    # Compute final correlation matrix using DCC
    Q = Q_bar.copy()
    for t in range(T):
        e   = eps[t].reshape(-1, 1)
        Q   = (1 - a_dcc - b_dcc) * Q_bar + a_dcc * (e @ e.T) + b_dcc * Q

    d  = np.sqrt(np.diag(Q))
    R  = Q / np.outer(d, d)
    np.fill_diagonal(R, 1.0)

    return {
        'corr_matrix': R,
        'a':           round(float(a_dcc), 4),
        'b':           round(float(b_dcc), 4),
        'persistence': round(float(a_dcc + b_dcc), 4),
        'symbols':     list(standardized_residuals.columns),
    }


# ── REGIME-CONDITIONAL SCALING ────────────────────────────────
# In bear markets correlations spike — scale DCC output
REGIME_CORR_SCALE = {
    'BULL':      0.80,  # correlations lower in bull (diversification works)
    'SOFT_BULL': 0.90,
    'SIDEWAYS':  1.00,  # baseline
    'SOFT_BEAR': 1.15,  # correlations rising
    'BEAR':      1.35,  # correlations spike (diversification fails)
}

def scale_correlation_for_regime(corr_matrix: np.ndarray, regime: str) -> np.ndarray:
    """Scale correlation matrix for regime — crisis = higher correlations."""
    scale  = REGIME_CORR_SCALE.get(regime, 1.0)
    n      = corr_matrix.shape[0]
    scaled = corr_matrix.copy()

    for i in range(n):
        for j in range(n):
            if i != j:
                # Scale off-diagonal, cap at 0.99
                scaled[i, j] = min(0.99, max(-0.99, corr_matrix[i, j] * scale))

    # Ensure positive semi-definite after scaling
    eigenvalues = np.linalg.eigvalsh(scaled)
    if np.any(eigenvalues < 0):
        # Higham nearest PSD matrix
        scaled = nearest_psd(scaled)

    np.fill_diagonal(scaled, 1.0)
    return scaled


def nearest_psd(A: np.ndarray) -> np.ndarray:
    """Find nearest positive semi-definite matrix (Higham 1988)."""
    B      = (A + A.T) / 2
    _, s, V = np.linalg.svd(B)
    H      = V.T @ np.diag(s) @ V
    A2     = (B + H) / 2
    A3     = (A2 + A2.T) / 2
    if np.all(np.linalg.eigvalsh(A3) >= -1e-8):
        return A3
    spacing = np.spacing(np.linalg.norm(A))
    I       = np.eye(A.shape[0])
    k       = 1
    while not np.all(np.linalg.eigvalsh(A3) >= 0):
        mineig = np.min(np.linalg.eigvalsh(A3))
        A3    += I * (-mineig * k**2 + spacing)
        k     += 1
    return A3
