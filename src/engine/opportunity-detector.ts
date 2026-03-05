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
    logger.info(`Initialized ${this.paths.length} arbitrage paths`);
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

    // Cooldown check
    if (Date.now() - this.lastTradeAt < config.trading.cooldownMs) return;

    const prices = this.aggregator.getAllPrices();
    if (prices.length < 2) return; // Need at least KuCoin + one Uniswap pool

    // Update fee calculator with latest data
    this.feeCalculator.updateEthPrice(this.aggregator.getEthPriceUsd());

    let bestOpportunity: ArbOpportunity | null = null;

    for (const path of this.paths) {
      const buyPrice = this.getPriceForLeg(path, 'buy', prices);
      const sellPrice = this.getPriceForLeg(path, 'sell', prices);

      if (!buyPrice || !sellPrice) continue;

      // Raw spread
      const spreadPct = ((sellPrice.sellPriceUsd - buyPrice.buyPriceUsd) / buyPrice.buyPriceUsd) * 100;

      if (spreadPct <= 0) continue; // No positive spread

      // Determine trade size (limited by available liquidity on both sides)
      const tradeSizeIdos = Math.min(
        buyPrice.maxBuySizeIdos,
        sellPrice.maxSellSizeIdos,
        config.trading.maxTradeSizeIdos,
      );

      if (tradeSizeIdos <= 0) continue;

      // Calculate fees
      const fees = this.feeCalculator.calculateFees(
        path,
        tradeSizeIdos,
        buyPrice.buyPriceUsd,
        sellPrice.sellPriceUsd,
      );

      // Net profit
      const grossProfitUsd = (sellPrice.sellPriceUsd - buyPrice.buyPriceUsd) * tradeSizeIdos;
      const netProfitUsd = grossProfitUsd - fees.totalFeesUsd;
      const netProfitPct = (netProfitUsd / (buyPrice.buyPriceUsd * tradeSizeIdos)) * 100;

      // Check thresholds
      if (netProfitUsd < config.trading.minProfitUsd) continue;
      if (netProfitPct < config.trading.minProfitPct) continue;

      const opportunity: ArbOpportunity = {
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

      // Track best opportunity
      if (!bestOpportunity || netProfitUsd > bestOpportunity.netProfitUsd) {
        bestOpportunity = opportunity;
      }
    }

    if (bestOpportunity) {
      logger.info('Arbitrage opportunity detected!', {
        path: getPathDescription(bestOpportunity.path),
        spread: `${bestOpportunity.spreadPct.toFixed(3)}%`,
        netProfit: `$${bestOpportunity.netProfitUsd.toFixed(4)}`,
        size: bestOpportunity.tradeSizeIdos,
      });
      this.lastTradeAt = Date.now();
      this.emit('opportunity', bestOpportunity);
    }
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
