import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ArbOpportunity, ExecutionResult, TradeResult, SwapResult } from '../types';
import { KuCoinTrader } from './kucoin-trader';
import { UniswapTrader } from './uniswap-trader';
import { RecoveryManager } from './recovery';
import { generateTradeId } from '../utils/helpers';
import { PriceAggregator } from '../feeds/price-aggregator';

export class Executor extends EventEmitter {
  private kucoinTrader: KuCoinTrader;
  private uniswapTrader: UniswapTrader;
  private recovery: RecoveryManager;
  private aggregator: PriceAggregator;
  private executing = false;

  constructor(
    kucoinTrader: KuCoinTrader,
    uniswapTrader: UniswapTrader,
    aggregator: PriceAggregator,
  ) {
    super();
    this.kucoinTrader = kucoinTrader;
    this.uniswapTrader = uniswapTrader;
    this.aggregator = aggregator;
    this.recovery = new RecoveryManager(kucoinTrader, uniswapTrader);
  }

  isExecuting(): boolean {
    return this.executing;
  }

  async execute(opportunity: ArbOpportunity): Promise<ExecutionResult> {
    if (this.executing) {
      logger.warn('Execution already in progress, skipping');
      return this.createFailedResult(opportunity, 'Concurrent execution blocked');
    }

    this.executing = true;
    const tradeId = generateTradeId();

    try {
      logger.info(`Executing ${opportunity.path.pathType} trade ${tradeId}`, {
        path: opportunity.path.id,
        size: opportunity.tradeSizeIdos,
        expectedProfit: `$${opportunity.netProfitUsd.toFixed(4)}`,
      });

      switch (opportunity.path.pathType) {
        case 'cex_dex':
          return await this.executeCexDex(opportunity, tradeId);
        case 'cross_dex':
          return await this.executeCrossDex(opportunity, tradeId);
        case 'triangular':
          return await this.executeTriangular(opportunity, tradeId);
        default:
          return this.createFailedResult(opportunity, `Unknown path type`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Trade ${tradeId} ERROR`, { error: errorMsg });
      return this.createFailedResult(opportunity, errorMsg);
    } finally {
      this.executing = false;
    }
  }

  /**
   * CEX-DEX: Execute buy and sell legs simultaneously on KuCoin + Uniswap
   */
  private async executeCexDex(
    opportunity: ArbOpportunity,
    tradeId: string,
  ): Promise<ExecutionResult> {
    const buyLegPromise = this.executeLeg(opportunity, 'buy');
    const sellLegPromise = this.executeLeg(opportunity, 'sell');

    const timeout = new Promise<[TradeResult, TradeResult]>((_, reject) =>
      setTimeout(() => reject(new Error('Execution timeout')), config.trading.executionTimeoutMs),
    );

    const [buyResult, sellResult] = await Promise.race([
      Promise.all([buyLegPromise, sellLegPromise]),
      timeout,
    ]);

    return this.resolveResult(opportunity, buyResult, sellResult, tradeId);
  }

  /**
   * Cross-DEX: Execute buy and sell legs simultaneously on two different Uniswap pools
   * Both legs are on-chain, fired in parallel.
   */
  private async executeCrossDex(
    opportunity: ArbOpportunity,
    tradeId: string,
  ): Promise<ExecutionResult> {
    // Same execution pattern as CEX-DEX — both legs fire simultaneously
    const buyLegPromise = this.executeLeg(opportunity, 'buy');
    const sellLegPromise = this.executeLeg(opportunity, 'sell');

    const timeout = new Promise<[TradeResult, TradeResult]>((_, reject) =>
      setTimeout(() => reject(new Error('Execution timeout')), config.trading.executionTimeoutMs),
    );

    const [buyResult, sellResult] = await Promise.race([
      Promise.all([buyLegPromise, sellLegPromise]),
      timeout,
    ]);

    return this.resolveResult(opportunity, buyResult, sellResult, tradeId);
  }

  /**
   * Triangular: 3-leg sequential execution on Uniswap
   *   Leg 1: Buy IDOS with tokenA on pool A
   *   Leg 2: Sell IDOS for tokenB on pool B
   *   Leg 3: Swap tokenB back to tokenA
   *
   * Legs 1+2 can be parallel (independent swaps), leg 3 depends on leg 2 output.
   */
  private async executeTriangular(
    opportunity: ArbOpportunity,
    tradeId: string,
  ): Promise<ExecutionResult> {
    const path = opportunity.path;

    // Leg 1 + Leg 2: Buy IDOS and Sell IDOS in parallel
    const buyLegPromise = this.executeLeg(opportunity, 'buy');
    const sellLegPromise = this.executeLeg(opportunity, 'sell');

    const timeout12 = new Promise<[TradeResult, TradeResult]>((_, reject) =>
      setTimeout(() => reject(new Error('Triangular legs 1+2 timeout')), config.trading.executionTimeoutMs),
    );

    const [buyResult, sellResult] = await Promise.race([
      Promise.all([buyLegPromise, sellLegPromise]),
      timeout12,
    ]);

    // If either leg failed, handle recovery for the 2 legs (same as cross-DEX)
    if (!buyResult.success || !sellResult.success) {
      const result = await this.resolveResult(opportunity, buyResult, sellResult, tradeId);
      return result;
    }

    // Both legs succeeded — now execute leg 3: swap sellQuoteToken → buyQuoteToken
    logger.info(`Trade ${tradeId} legs 1+2 succeeded, executing leg 3`, {
      thirdLeg: `${path.thirdLegTokenIn}→${path.thirdLegTokenOut}`,
    });

    // Estimate how much of the sell-side token we received
    // sellResult.totalUsd gives us the USD value; we need the native amount
    // For WETH: amount = totalUsd / ethPrice; For USDC: amount ≈ totalUsd
    const ethPrice = this.aggregator.getEthPriceUsd();
    let thirdLegAmountIn: number;
    if (path.thirdLegTokenIn === 'WETH') {
      thirdLegAmountIn = ethPrice > 0 ? sellResult.totalUsd / ethPrice : 0;
    } else {
      thirdLegAmountIn = sellResult.totalUsd; // USDC ≈ USD
    }

    const thirdLegResult = await this.uniswapTrader.swapTokens(
      path.thirdLegTokenIn!,
      path.thirdLegTokenOut!,
      thirdLegAmountIn,
      path.thirdLegFeeTier!,
      ethPrice,
    );

    if (thirdLegResult.success) {
      const netProfitUsd = thirdLegResult.amountOut - (opportunity.buyPriceUsd * opportunity.tradeSizeIdos)
        - buyResult.feeUsd - sellResult.feeUsd - thirdLegResult.feeUsd;

      // For WETH-denominated final amount, convert to USD
      const finalUsd = path.thirdLegTokenOut === 'WETH'
        ? thirdLegResult.amountOut * ethPrice
        : thirdLegResult.amountOut;
      const startUsd = buyResult.totalUsd;
      const actualProfit = finalUsd - startUsd - buyResult.feeUsd - sellResult.feeUsd - thirdLegResult.feeUsd;

      logger.info(`Trade ${tradeId} TRIANGULAR SUCCESS`, {
        startUsd: startUsd.toFixed(4),
        finalUsd: finalUsd.toFixed(4),
        netProfit: `$${actualProfit.toFixed(4)}`,
      });

      const result: ExecutionResult = {
        opportunity,
        buyLeg: buyResult,
        sellLeg: sellResult,
        thirdLeg: thirdLegResult,
        netProfitUsd: actualProfit,
        status: 'success',
        timestamp: Date.now(),
      };
      this.emit('execution', result);
      return result;
    } else {
      // Leg 3 failed — we have tokenB but couldn't convert back to tokenA
      logger.error(`Trade ${tradeId} TRIANGULAR leg 3 FAILED`, {
        error: thirdLegResult.error,
        holdingToken: path.thirdLegTokenIn,
        holdingAmount: thirdLegAmountIn,
      });

      const result: ExecutionResult = {
        opportunity,
        buyLeg: buyResult,
        sellLeg: sellResult,
        thirdLeg: thirdLegResult,
        netProfitUsd: 0,
        status: 'partial_third',
        recoveryAction: `holding_${path.thirdLegTokenIn}_${thirdLegAmountIn.toFixed(6)}`,
        timestamp: Date.now(),
      };
      this.emit('execution', result);
      return result;
    }
  }

  private async executeLeg(
    opportunity: ArbOpportunity,
    side: 'buy' | 'sell',
  ): Promise<TradeResult> {
    const venue = side === 'buy' ? opportunity.path.buyVenue : opportunity.path.sellVenue;
    const amountIdos = opportunity.tradeSizeIdos;
    const priceUsd = side === 'buy' ? opportunity.buyPriceUsd : opportunity.sellPriceUsd;

    if (venue === 'kucoin') {
      return this.kucoinTrader.executeTrade(side, amountIdos, priceUsd);
    } else {
      const quoteToken = side === 'buy'
        ? opportunity.path.buyQuoteToken!
        : opportunity.path.sellQuoteToken!;
      const feeTier = side === 'buy'
        ? opportunity.path.buyFeeTier!
        : opportunity.path.sellFeeTier!;

      return this.uniswapTrader.executeTrade(side, amountIdos, priceUsd, quoteToken, feeTier);
    }
  }

  private async resolveResult(
    opportunity: ArbOpportunity,
    buyResult: TradeResult,
    sellResult: TradeResult,
    tradeId: string,
  ): Promise<ExecutionResult> {
    let status: ExecutionResult['status'];
    let netProfitUsd: number;
    let recoveryAction: string | undefined;

    if (buyResult.success && sellResult.success) {
      status = 'success';
      netProfitUsd = sellResult.totalUsd - buyResult.totalUsd - buyResult.feeUsd - sellResult.feeUsd;
      logger.info(`Trade ${tradeId} SUCCESS`, {
        netProfit: `$${netProfitUsd.toFixed(4)}`,
        buyPrice: buyResult.priceUsd,
        sellPrice: sellResult.priceUsd,
      });
    } else if (!buyResult.success && !sellResult.success) {
      status = 'both_failed';
      netProfitUsd = 0;
      logger.error(`Trade ${tradeId} BOTH LEGS FAILED`, {
        buyError: buyResult.error,
        sellError: sellResult.error,
      });
    } else {
      status = buyResult.success ? 'partial_buy' : 'partial_sell';
      netProfitUsd = 0;
      logger.error(`Trade ${tradeId} PARTIAL FILL — initiating recovery`, {
        buySuccess: buyResult.success,
        sellSuccess: sellResult.success,
      });
      recoveryAction = await this.recovery.handleOneSidedFill(opportunity, buyResult, sellResult);
    }

    const result: ExecutionResult = {
      opportunity,
      buyLeg: buyResult,
      sellLeg: sellResult,
      netProfitUsd,
      status,
      recoveryAction,
      timestamp: Date.now(),
    };

    this.emit('execution', result);
    return result;
  }

  private createFailedResult(opportunity: ArbOpportunity, error: string): ExecutionResult {
    const failedTrade: TradeResult = {
      success: false,
      venue: 'kucoin',
      direction: 'buy',
      amountIdos: 0,
      priceUsd: 0,
      totalUsd: 0,
      feeUsd: 0,
      error,
      timestamp: Date.now(),
    };

    return {
      opportunity,
      buyLeg: failedTrade,
      sellLeg: failedTrade,
      netProfitUsd: 0,
      status: 'both_failed',
      timestamp: Date.now(),
    };
  }
}
