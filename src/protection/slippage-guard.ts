import { config } from '../config';
import { logger } from '../utils/logger';

export class SlippageGuard {
  /**
   * Calculate dynamic slippage tolerance based on trade size and liquidity.
   * Larger trades relative to pool liquidity need more slippage tolerance.
   */
  calculateSlippage(
    tradeSizeIdos: number,
    poolLiquidity: number,
    baseSlippagePct: number = 0.3,
  ): number {
    if (poolLiquidity <= 0) return config.trading.maxSlippagePct;

    // Trade size as fraction of pool liquidity
    const sizeFraction = tradeSizeIdos / poolLiquidity;

    // Slippage scales quadratically with size fraction
    // For small trades (<1% of pool): ~baseSlippage
    // For medium trades (1-5%): 2-3x base
    // For large trades (>5%): capped at max
    const dynamicSlippage = baseSlippagePct * (1 + sizeFraction * 100);

    const finalSlippage = Math.min(dynamicSlippage, config.trading.maxSlippagePct);

    logger.debug('Slippage calculation', {
      tradeSizeIdos,
      poolLiquidity,
      sizeFraction: `${(sizeFraction * 100).toFixed(2)}%`,
      dynamicSlippage: `${dynamicSlippage.toFixed(3)}%`,
      finalSlippage: `${finalSlippage.toFixed(3)}%`,
    });

    return finalSlippage;
  }

  /**
   * Verify a trade result didn't suffer excessive slippage.
   */
  verifyExecution(
    expectedPrice: number,
    actualPrice: number,
    direction: 'buy' | 'sell',
  ): { ok: boolean; slippagePct: number } {
    const slippagePct = direction === 'buy'
      ? ((actualPrice - expectedPrice) / expectedPrice) * 100  // Buying: paying more is bad
      : ((expectedPrice - actualPrice) / expectedPrice) * 100; // Selling: receiving less is bad

    const ok = slippagePct <= config.trading.maxSlippagePct;

    if (!ok) {
      logger.warn('Excessive slippage detected', {
        direction,
        expectedPrice,
        actualPrice,
        slippagePct: `${slippagePct.toFixed(3)}%`,
        maxAllowed: `${config.trading.maxSlippagePct}%`,
      });
    }

    return { ok, slippagePct };
  }
}
