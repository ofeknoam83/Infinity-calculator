import { EventEmitter } from 'events';
import { PriceAggregator } from '../feeds/price-aggregator';
import { FeeCalculator } from './fee-calculator';
import { generateArbPaths, getPathDescription } from './path-evaluator';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ArbOpportunity, ArbPath, NormalizedPrice } from '../types';

export class OpportunityDetector extends EventEmitter {
  private aggregator: PriceAggregator;
  private feeCalculator: FeeCalculator;
  private paths: ArbPath[];
  private lastTradeAt = 0;
  private locked = false;

  constructor(aggregator: PriceAggregator, feeCalculator: FeeCalculator) {
    super();
    this.aggregator = aggregator;
    this.feeCalculator = feeCalculator;
    this.paths = generateArbPaths();

    const cexDex = this.paths.filter(p => p.pathType === 'cex_dex').length;
    const crossDex = this.paths.filter(p => p.pathType === 'cross_dex').length;
    const triangular = this.paths.filter(p => p.pathType === 'triangular').length;
    logger.info(`Initialized ${this.paths.length} arbitrage paths`, {
      cexDex,
      crossDex,
      triangular,
    });
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
    if (prices.length < 2) return;

    this.feeCalculator.updateEthPrice(this.aggregator.getEthPriceUsd());

    let bestOpportunity: ArbOpportunity | null = null;

    const depeg = this.aggregator.isDepegDetected();

    for (const path of this.paths) {
      // Skip CEX-DEX paths during stablecoin depeg (USDT vs USDC divergence)
      if (depeg && path.pathType === 'cex_dex') continue;

      let opportunity: ArbOpportunity | null = null;

      if (path.pathType === 'triangular') {
        opportunity = this.evaluateTriangular(path, prices);
      } else {
        // CEX-DEX and cross-DEX use the same 2-leg evaluation
        opportunity = this.evaluateTwoLeg(path, prices);
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

  /**
   * Triangular arb evaluation:
   *   Leg 1: Spend quoteA to buy IDOS on pool A
   *   Leg 2: Sell IDOS for quoteB on pool B
   *   Leg 3: Swap quoteB back to quoteA
   *
   * Profit = (amount of quoteA received after full cycle) - (amount of quoteA spent)
   *
   * We use the normalized USD prices to estimate the cycle profit.
   * The key insight: if buy price on USDC pool is lower than sell price on WETH pool
   * (after converting WETH→USDC), there's a triangular arb.
   */
  private evaluateTriangular(path: ArbPath, prices: NormalizedPrice[]): ArbOpportunity | null {
    const buyPrice = this.getPriceForLeg(path, 'buy', prices);
    const sellPrice = this.getPriceForLeg(path, 'sell', prices);

    if (!buyPrice || !sellPrice) return null;

    // The spread in USD terms already accounts for the WETH→USD conversion
    // The 3rd leg (WETH↔USDC swap) adds extra fee that we account for in FeeCalculator
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
