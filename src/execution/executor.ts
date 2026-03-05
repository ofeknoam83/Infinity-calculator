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

    // Block cross-venue trades during stablecoin depeg
    if (this.aggregator.isDepegDetected() && opportunity.path.pathType === 'cex_dex') {
      logger.warn('DEPEG active — skipping CEX-DEX opportunity');
      return this.createFailedResult(opportunity, 'USDT/USDC depeg detected');
    }

    this.executing = true;
    const tradeId = generateTradeId();

    try {
      // Keep ETH price in sync on the trader for gas fee calculation
      this.uniswapTrader.updateEthPrice(this.aggregator.getEthPriceUsd());

      // Pre-execution balance check
      const balanceError = await this.checkBalances(opportunity);
      if (balanceError) {
        logger.error(`Trade ${tradeId} INSUFFICIENT BALANCE`, { error: balanceError });
        return this.createFailedResult(opportunity, balanceError);
      }

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
   * Pre-flight balance check to avoid wasting gas on trades that will revert.
   */
  private async checkBalances(opportunity: ArbOpportunity): Promise<string | null> {
    try {
      const path = opportunity.path;
      const sizeIdos = opportunity.tradeSizeIdos;

      // Check Uniswap-side balances
      if (path.buyVenue === 'uniswap_v3' || path.sellVenue === 'uniswap_v3' || path.pathType === 'triangular') {
        const balances = await this.uniswapTrader.getBalances();

        // If buying IDOS on Uniswap, we need the quote token
        if (path.buyVenue === 'uniswap_v3') {
          const needed = sizeIdos * opportunity.buyPriceUsd * 1.02; // 2% buffer
          if (path.buyQuoteToken === 'USDC' && balances.usdc < needed) {
            return `Insufficient USDC: have ${balances.usdc.toFixed(2)}, need ~${needed.toFixed(2)}`;
          }
          if (path.buyQuoteToken === 'WETH') {
            const ethPrice = this.aggregator.getEthPriceUsd();
            const neededWeth = ethPrice > 0 ? needed / ethPrice : 0;
            if (balances.weth < neededWeth) {
              return `Insufficient WETH: have ${balances.weth.toFixed(6)}, need ~${neededWeth.toFixed(6)}`;
            }
          }
        }

        // If selling IDOS on Uniswap, we need IDOS
        if (path.sellVenue === 'uniswap_v3' && balances.idos < sizeIdos) {
          return `Insufficient IDOS on Arbitrum: have ${balances.idos.toFixed(2)}, need ${sizeIdos}`;
        }

        // Gas check (need ETH for gas)
        if (balances.eth < 0.001) {
          return `Insufficient ETH for gas: have ${balances.eth.toFixed(6)} ETH`;
        }
      }
    } catch (err) {
      logger.warn('Balance check failed, proceeding anyway', { error: String(err) });
    }
    return null;
  }

  /**
   * CEX-DEX: Execute buy and sell legs simultaneously on KuCoin + Uniswap.
   * Different venues, so parallel execution is safe (no nonce collision).
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
   * Cross-DEX: Both legs are on Uniswap — execute sequentially to avoid nonce collision.
   * NonceManager handles sequencing, but sequential execution is safer for error handling.
   * Buy first, then sell (if buy fails, we haven't committed to selling).
   */
  private async executeCrossDex(
    opportunity: ArbOpportunity,
    tradeId: string,
  ): Promise<ExecutionResult> {
    const buyResult = await this.executeLeg(opportunity, 'buy');

    if (!buyResult.success) {
      // Buy failed, don't proceed to sell
      const failedSell: TradeResult = {
        success: false,
        venue: 'uniswap_v3',
        direction: 'sell',
        amountIdos: 0,
        priceUsd: 0,
        totalUsd: 0,
        feeUsd: 0,
        error: 'Skipped: buy leg failed',
        timestamp: Date.now(),
      };
      return this.resolveResult(opportunity, buyResult, failedSell, tradeId);
    }

    const sellResult = await this.executeLeg(opportunity, 'sell');
    return this.resolveResult(opportunity, buyResult, sellResult, tradeId);
  }

  /**
   * Triangular: 3-leg execution, all on Uniswap.
   * Sequential: buy → sell → swap back.
   * Uses actual output amounts from Swap event decoding for each subsequent leg.
   */
  private async executeTriangular(
    opportunity: ArbOpportunity,
    tradeId: string,
  ): Promise<ExecutionResult> {
    const path = opportunity.path;

    // Leg 1: Buy IDOS with tokenA
    const buyResult = await this.executeLeg(opportunity, 'buy');
    if (!buyResult.success) {
      const failedSell: TradeResult = {
        success: false, venue: 'uniswap_v3', direction: 'sell',
        amountIdos: 0, priceUsd: 0, totalUsd: 0, feeUsd: 0,
        error: 'Skipped: buy leg failed', timestamp: Date.now(),
      };
      return this.resolveResult(opportunity, buyResult, failedSell, tradeId);
    }

    // Leg 2: Sell IDOS for tokenB
    const sellResult = await this.executeLeg(opportunity, 'sell');
    if (!sellResult.success) {
      return this.resolveResult(opportunity, buyResult, sellResult, tradeId);
    }

    // Both legs succeeded — execute leg 3: swap tokenB → tokenA
    logger.info(`Trade ${tradeId} legs 1+2 succeeded, executing leg 3`, {
      thirdLeg: `${path.thirdLegTokenIn}→${path.thirdLegTokenOut}`,
    });

    // Use actual sell output for 3rd leg input.
    // sellResult now contains real totalUsd from Swap event decoding.
    // Convert USD value to native token amount for the 3rd leg.
    const ethPrice = this.aggregator.getEthPriceUsd();
    let thirdLegAmountIn: number;
    if (path.sellQuoteToken === 'WETH') {
      // Sell leg received WETH — convert sell's USD totalUsd to WETH
      thirdLegAmountIn = ethPrice > 0 ? sellResult.totalUsd / ethPrice : 0;
    } else {
      // Sell leg received USDC — totalUsd ≈ USDC amount
      thirdLegAmountIn = sellResult.totalUsd;
    }

    if (thirdLegAmountIn <= 0) {
      logger.error(`Trade ${tradeId} cannot compute 3rd leg amount`);
      const failedThird: SwapResult = {
        success: false, tokenIn: path.thirdLegTokenIn || '', tokenOut: path.thirdLegTokenOut || '',
        amountIn: 0, amountOut: 0, feeUsd: 0, error: 'Zero input amount', timestamp: Date.now(),
      };
      return {
        opportunity, buyLeg: buyResult, sellLeg: sellResult, thirdLeg: failedThird,
        netProfitUsd: 0, status: 'partial_third', timestamp: Date.now(),
      };
    }

    const thirdLegResult = await this.uniswapTrader.swapTokens(
      path.thirdLegTokenIn!,
      path.thirdLegTokenOut!,
      thirdLegAmountIn,
      path.thirdLegFeeTier!,
      ethPrice,
    );

    if (thirdLegResult.success) {
      // Compute actual profit: final amount of tokenA - initial amount of tokenA spent
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
      logger.error(`Trade ${tradeId} TRIANGULAR leg 3 FAILED`, {
        error: thirdLegResult.error,
        holdingToken: path.thirdLegTokenIn,
        holdingAmount: thirdLegAmountIn,
      });

      // Attempt recovery for 3rd leg failure
      const recoveryAction = await this.recovery.handleThirdLegFailure(
        opportunity, thirdLegResult, thirdLegAmountIn,
      );

      const result: ExecutionResult = {
        opportunity,
        buyLeg: buyResult,
        sellLeg: sellResult,
        thirdLeg: thirdLegResult,
        netProfitUsd: 0,
        status: 'partial_third',
        recoveryAction,
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
