import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ArbOpportunity, ExecutionResult, TradeResult } from '../types';
import { KuCoinTrader } from './kucoin-trader';
import { UniswapTrader } from './uniswap-trader';
import { RecoveryManager } from './recovery';
import { generateTradeId } from '../utils/helpers';

export class Executor extends EventEmitter {
  private kucoinTrader: KuCoinTrader;
  private uniswapTrader: UniswapTrader;
  private recovery: RecoveryManager;
  private executing = false;

  constructor(kucoinTrader: KuCoinTrader, uniswapTrader: UniswapTrader) {
    super();
    this.kucoinTrader = kucoinTrader;
    this.uniswapTrader = uniswapTrader;
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
      logger.info(`Executing arbitrage trade ${tradeId}`, {
        path: opportunity.path.id,
        size: opportunity.tradeSizeIdos,
        expectedProfit: `$${opportunity.netProfitUsd.toFixed(4)}`,
      });

      // Build the two legs
      const buyLegPromise = this.executeLeg(
        opportunity,
        'buy',
        opportunity.tradeSizeIdos,
        opportunity.buyPriceUsd,
      );

      const sellLegPromise = this.executeLeg(
        opportunity,
        'sell',
        opportunity.tradeSizeIdos,
        opportunity.sellPriceUsd,
      );

      // Execute both legs simultaneously with timeout
      const timeout = new Promise<[TradeResult, TradeResult]>((_, reject) =>
        setTimeout(() => reject(new Error('Execution timeout')), config.trading.executionTimeoutMs),
      );

      const [buyResult, sellResult] = await Promise.race([
        Promise.all([buyLegPromise, sellLegPromise]),
        timeout,
      ]);

      // Determine outcome
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

        // Attempt recovery
        recoveryAction = await this.recovery.handleOneSidedFill(
          opportunity,
          buyResult,
          sellResult,
        );
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
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Trade ${tradeId} ERROR`, { error: errorMsg });
      return this.createFailedResult(opportunity, errorMsg);
    } finally {
      this.executing = false;
    }
  }

  private async executeLeg(
    opportunity: ArbOpportunity,
    side: 'buy' | 'sell',
    amountIdos: number,
    priceUsd: number,
  ): Promise<TradeResult> {
    const venue = side === 'buy' ? opportunity.path.buyVenue : opportunity.path.sellVenue;

    if (venue === 'kucoin') {
      return this.kucoinTrader.executeTrade(
        side,
        amountIdos,
        priceUsd,
      );
    } else {
      const quoteToken = side === 'buy'
        ? opportunity.path.buyQuoteToken!
        : opportunity.path.sellQuoteToken!;
      const feeTier = side === 'buy'
        ? opportunity.path.buyFeeTier!
        : opportunity.path.sellFeeTier!;

      return this.uniswapTrader.executeTrade(
        side,
        amountIdos,
        priceUsd,
        quoteToken,
        feeTier,
      );
    }
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
