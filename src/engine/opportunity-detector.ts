import { EventEmitter } from 'events';
import { PriceAggregator } from '../feeds/price-aggregator';
import { FeeCalculator } from './fee-calculator';
import { generateArbPaths, getPathDescription } from './path-evaluator';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ArbOpportunity, ArbPath, NormalizedPrice, PoolToken, FeeTier } from '../types';

export class OpportunityDetector extends EventEmitter {
  private aggregator: PriceAggregator;
  private feeCalculator: FeeCalculator;
  private paths: ArbPath[];
  private lastTradeAt = 0;
  private locked = false;
  private kucoinAvailable = true;
  private availableUniswapPools = new Set<string>(); // "USDC_3000", "WETH_10000", etc.

  constructor(aggregator: PriceAggregator, feeCalculator: FeeCalculator) {
    super();
    this.aggregator = aggregator;
    this.feeCalculator = feeCalculator;
    this.paths = generateArbPaths();

    const cexDex = this.paths.filter(p => p.pathType === 'cex_dex').length;
    const crossDex = this.paths.filter(p => p.pathType === 'cross_dex').length;
    const triangular = this.paths.filter(p => p.pathType === 'triangular').length;
    logger.info(`Generated ${this.paths.length} arbitrage paths (pre-filtering)`, {
      cexDex,
      crossDex,
      triangular,
    });
  }

  /**
   * Mark KuCoin as unavailable — all CEX-DEX paths will be skipped.
   */
  setKucoinAvailable(available: boolean): void {
    this.kucoinAvailable = available;
    if (!available) {
      logger.info('KuCoin unavailable — disabling CEX-DEX paths');
    }
  }

  /**
   * Register which Uniswap pools actually exist after pool discovery.
   * Paths referencing non-existent pools will be pruned.
   */
  setAvailableUniswapPools(pools: { quoteToken: PoolToken; fee: FeeTier }[]): void {
    this.availableUniswapPools.clear();
    for (const p of pools) {
      this.availableUniswapPools.add(`${p.quoteToken}_${p.fee}`);
    }

    // Prune paths that reference non-existent pools
    const before = this.paths.length;
    this.paths = this.paths.filter(path => this.isPathViable(path));
    const after = this.paths.length;

    if (before !== after) {
      logger.info(`Pruned ${before - after} paths with non-existent pools`, {
        remaining: after,
        availablePools: [...this.availableUniswapPools],
      });
    }

    const cexDex = this.paths.filter(p => p.pathType === 'cex_dex').length;
    const crossDex = this.paths.filter(p => p.pathType === 'cross_dex').length;
    const triangular = this.paths.filter(p => p.pathType === 'triangular').length;
    logger.info(`Active arbitrage paths: ${this.paths.length}`, { cexDex, crossDex, triangular });
  }

  /**
   * Check if a path's required pools actually exist.
   */
  private isPathViable(path: ArbPath): boolean {
    // Check buy-side Uniswap pool
    if (path.buyVenue === 'uniswap_v3' && path.buyQuoteToken && path.buyFeeTier) {
      if (!this.availableUniswapPools.has(`${path.buyQuoteToken}_${path.buyFeeTier}`)) {
        return false;
      }
    }
    // Check sell-side Uniswap pool
    if (path.sellVenue === 'uniswap_v3' && path.sellQuoteToken && path.sellFeeTier) {
      if (!this.availableUniswapPools.has(`${path.sellQuoteToken}_${path.sellFeeTier}`)) {
        return false;
      }
    }
    return true;
  }

  start(): void {
    this.aggregator.on('normalized', () => {
      this.evaluate();
    });
  }

  lock(): void {
    this.locked = true;
  }

  unlock(): void {
    this.locked = false;
  }

  private evaluate(): void {
    if (this.locked) return;
    if (Date.now() - this.lastTradeAt < config.trading.cooldownMs) return;

    const prices = this.aggregator.getAllPrices();
    if (prices.length === 0) return;

    this.feeCalculator.updateEthPrice(this.aggregator.getEthPriceUsd());

    let bestOpportunity: ArbOpportunity | null = null;

    const depeg = this.aggregator.isDepegDetected();

    for (const path of this.paths) {
      // Skip CEX-DEX paths if KuCoin is unavailable or depeg detected
      if (path.pathType === 'cex_dex' && (!this.kucoinAvailable || depeg)) continue;

      let opportunity: ArbOpportunity | null = null;

      try {
        if (path.pathType === 'triangular') {
          opportunity = this.evaluateTriangular(path, prices);
        } else {
          opportunity = this.evaluateTwoLeg(path, prices);
        }
      } catch (err) {
        // Never let a single path evaluation crash the loop
        logger.debug(`Error evaluating path ${path.id}`, { error: String(err) });
      }

      if (opportunity && (!bestOpportunity || opportunity.netProfitUsd > bestOpportunity.netProfitUsd)) {
        bestOpportunity = opportunity;
      }
    }

    if (bestOpportunity) {
      logger.info('Arbitrage opportunity detected!', {
        path: getPathDescription(bestOpportunity.path),
        type: bestOpportunity.path.pathType,
        spread: `${bestOpportunity.spreadPct.toFixed(3)}%`,
        netProfit: `$${bestOpportunity.netProfitUsd.toFixed(4)}`,
        size: bestOpportunity.tradeSizeIdos,
      });
      this.lastTradeAt = Date.now();
      this.emit('opportunity', bestOpportunity);
    }
  }

  private evaluateTwoLeg(path: ArbPath, prices: NormalizedPrice[]): ArbOpportunity | null {
    const buyPrice = this.getPriceForLeg(path, 'buy', prices);
    const sellPrice = this.getPriceForLeg(path, 'sell', prices);

    if (!buyPrice || !sellPrice) return null;

    const spreadPct = ((sellPrice.sellPriceUsd - buyPrice.buyPriceUsd) / buyPrice.buyPriceUsd) * 100;
    if (spreadPct <= 0) return null;

    const tradeSizeIdos = Math.min(
      buyPrice.maxBuySizeIdos,
      sellPrice.maxSellSizeIdos,
      config.trading.maxTradeSizeIdos,
    );
    if (tradeSizeIdos <= 0) return null;

    const fees = this.feeCalculator.calculateFees(
      path,
      tradeSizeIdos,
      buyPrice.buyPriceUsd,
      sellPrice.sellPriceUsd,
    );

    const grossProfitUsd = (sellPrice.sellPriceUsd - buyPrice.buyPriceUsd) * tradeSizeIdos;
    const netProfitUsd = grossProfitUsd - fees.totalFeesUsd;
    const netProfitPct = (netProfitUsd / (buyPrice.buyPriceUsd * tradeSizeIdos)) * 100;

    if (netProfitUsd < config.trading.minProfitUsd) return null;
    if (netProfitPct < config.trading.minProfitPct) return null;

    return {
      path,
      buyPriceUsd: buyPrice.buyPriceUsd,
      sellPriceUsd: sellPrice.sellPriceUsd,
      spreadPct,
      tradeSizeIdos,
      estimatedFees: fees,
      netProfitUsd,
      netProfitPct,
      timestamp: Date.now(),
    };
  }

  private evaluateTriangular(path: ArbPath, prices: NormalizedPrice[]): ArbOpportunity | null {
    const buyPrice = this.getPriceForLeg(path, 'buy', prices);
    const sellPrice = this.getPriceForLeg(path, 'sell', prices);

    if (!buyPrice || !sellPrice) return null;

    const spreadPct = ((sellPrice.sellPriceUsd - buyPrice.buyPriceUsd) / buyPrice.buyPriceUsd) * 100;
    if (spreadPct <= 0) return null;

    const tradeSizeIdos = Math.min(
      buyPrice.maxBuySizeIdos,
      sellPrice.maxSellSizeIdos,
      config.trading.maxTradeSizeIdos,
    );
    if (tradeSizeIdos <= 0) return null;

    const fees = this.feeCalculator.calculateFees(
      path,
      tradeSizeIdos,
      buyPrice.buyPriceUsd,
      sellPrice.sellPriceUsd,
    );

    const grossProfitUsd = (sellPrice.sellPriceUsd - buyPrice.buyPriceUsd) * tradeSizeIdos;
    const netProfitUsd = grossProfitUsd - fees.totalFeesUsd;
    const netProfitPct = (netProfitUsd / (buyPrice.buyPriceUsd * tradeSizeIdos)) * 100;

    if (netProfitUsd < config.trading.minProfitUsd) return null;
    if (netProfitPct < config.trading.minProfitPct) return null;

    const triangularAmountIn = buyPrice.buyPriceUsd * tradeSizeIdos;
    const triangularAmountOut = sellPrice.sellPriceUsd * tradeSizeIdos;

    return {
      path,
      buyPriceUsd: buyPrice.buyPriceUsd,
      sellPriceUsd: sellPrice.sellPriceUsd,
      spreadPct,
      tradeSizeIdos,
      estimatedFees: fees,
      netProfitUsd,
      netProfitPct,
      timestamp: Date.now(),
      triangularAmountIn,
      triangularAmountOut,
    };
  }

  private getPriceForLeg(
    path: ArbPath,
    leg: 'buy' | 'sell',
    prices: NormalizedPrice[],
  ): NormalizedPrice | undefined {
    const venue = leg === 'buy' ? path.buyVenue : path.sellVenue;
    const feeTier = leg === 'buy' ? path.buyFeeTier : path.sellFeeTier;
    const quoteToken = leg === 'buy' ? path.buyQuoteToken : path.sellQuoteToken;

    return prices.find((p) => {
      if (p.venue !== venue) return false;
      if (venue === 'kucoin') return true;
      return p.feeTier === feeTier && p.quoteToken === quoteToken;
    });
  }

  getCurrentSpreads(): { pathId: string; spreadPct: number }[] {
    const prices = this.aggregator.getAllPrices();
    const spreads: { pathId: string; spreadPct: number }[] = [];

    for (const path of this.paths) {
      const buyPrice = this.getPriceForLeg(path, 'buy', prices);
      const sellPrice = this.getPriceForLeg(path, 'sell', prices);
      if (!buyPrice || !sellPrice) continue;
      const spreadPct = ((sellPrice.sellPriceUsd - buyPrice.buyPriceUsd) / buyPrice.buyPriceUsd) * 100;
      spreads.push({ pathId: path.id, spreadPct });
    }

    return spreads;
  }
}
