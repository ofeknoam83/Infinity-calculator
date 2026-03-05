import { config } from '../config';
import { logger } from '../utils/logger';
import { TradeResult, SwapResult, ArbOpportunity, ExecutionResult } from '../types';
import { KuCoinTrader } from './kucoin-trader';
import { UniswapTrader } from './uniswap-trader';

export class RecoveryManager {
  private kucoinTrader: KuCoinTrader;
  private uniswapTrader: UniswapTrader;

  constructor(kucoinTrader: KuCoinTrader, uniswapTrader: UniswapTrader) {
    this.kucoinTrader = kucoinTrader;
    this.uniswapTrader = uniswapTrader;
  }

  async handleOneSidedFill(
    opportunity: ArbOpportunity,
    buyResult: TradeResult,
    sellResult: TradeResult,
  ): Promise<string> {
    const strategy = config.recovery.strategy;

    if (buyResult.success && !sellResult.success) {
      return await this.handleBuyFilledSellFailed(opportunity, buyResult, sellResult, strategy);
    }

    if (!buyResult.success && sellResult.success) {
      return await this.handleBuyFailedSellFilled(opportunity, buyResult, sellResult, strategy);
    }

    return 'no_action';
  }

  private async handleBuyFilledSellFailed(
    opportunity: ArbOpportunity,
    buyResult: TradeResult,
    sellResult: TradeResult,
    strategy: string,
  ): Promise<string> {
    logger.warn('One-sided fill: BUY succeeded, SELL failed', {
      buyVenue: buyResult.venue,
      sellVenue: sellResult.venue,
      sellError: sellResult.error,
      strategy,
    });

    switch (strategy) {
      case 'unwind': {
        // Unwind: sell the bought IDOS back where we bought it
        if (buyResult.venue === 'kucoin') {
          // Bought on KuCoin, sell it back on KuCoin at market
          logger.info('Recovery: selling IDOS back on KuCoin');
          const unwind = await this.kucoinTrader.executeTrade(
            'sell',
            buyResult.amountIdos,
            buyResult.priceUsd,
          );
          const loss = unwind.success
            ? (buyResult.totalUsd - unwind.totalUsd)
            : buyResult.totalUsd * 0.002; // Estimate 0.2% loss
          logger.info('Recovery unwind result', {
            success: unwind.success,
            estimatedLoss: loss,
          });
          return `unwind_kucoin_${unwind.success ? 'ok' : 'failed'}`;
        } else {
          // Bought on Uniswap, sell back on Uniswap
          logger.info('Recovery: selling IDOS back on Uniswap');
          const unwind = await this.uniswapTrader.executeTrade(
            'sell',
            buyResult.amountIdos,
            buyResult.priceUsd,
            opportunity.path.buyQuoteToken!,
            opportunity.path.buyFeeTier!,
          );
          return `unwind_uniswap_${unwind.success ? 'ok' : 'failed'}`;
        }
      }

      case 'retry': {
        // Retry the failed sell leg once
        logger.info('Recovery: retrying failed sell leg');
        if (sellResult.venue === 'kucoin') {
          const retry = await this.kucoinTrader.executeTrade(
            'sell',
            buyResult.amountIdos,
            opportunity.sellPriceUsd,
          );
          return `retry_kucoin_${retry.success ? 'ok' : 'failed'}`;
        } else {
          const retry = await this.uniswapTrader.executeTrade(
            'sell',
            buyResult.amountIdos,
            opportunity.sellPriceUsd,
            opportunity.path.sellQuoteToken!,
            opportunity.path.sellFeeTier!,
          );
          return `retry_uniswap_${retry.success ? 'ok' : 'failed'}`;
        }
      }

      case 'hold':
      default:
        logger.warn('Recovery: HOLDING position — manual intervention may be needed', {
          holdingIdos: buyResult.amountIdos,
          boughtAt: buyResult.priceUsd,
        });
        return 'hold';
    }
  }

  /**
   * Handle triangular arb 3rd leg failure.
   * Legs 1+2 succeeded, but the final swap (tokenB→tokenA) failed.
   * We're holding tokenB (the sell-side quote token).
   * Strategy: retry the swap, or hold for manual intervention.
   */
  async handleThirdLegFailure(
    opportunity: ArbOpportunity,
    thirdLegResult: SwapResult,
    amountHeld: number,
  ): Promise<string> {
    const path = opportunity.path;
    const tokenHeld = path.thirdLegTokenIn;
    const tokenTarget = path.thirdLegTokenOut;
    const strategy = config.recovery.strategy;

    logger.warn('Triangular 3rd leg failed — recovery', {
      tokenHeld,
      amountHeld,
      tokenTarget,
      error: thirdLegResult.error,
      strategy,
    });

    switch (strategy) {
      case 'unwind':
      case 'retry': {
        // Retry the WETH→USDC (or USDC→WETH) swap once
        logger.info(`Recovery: retrying ${tokenHeld}→${tokenTarget} swap`);
        const retry = await this.uniswapTrader.swapTokens(
          path.thirdLegTokenIn!,
          path.thirdLegTokenOut!,
          amountHeld,
          path.thirdLegFeeTier!,
          0, // ETH price not needed for retry slippage — the trader has its own
        );
        return retry.success
          ? `retry_third_leg_ok`
          : `retry_third_leg_failed_holding_${tokenHeld}_${amountHeld.toFixed(6)}`;
      }

      case 'hold':
      default:
        logger.warn('Recovery: HOLDING intermediate token — manual intervention needed', {
          tokenHeld,
          amountHeld,
        });
        return `hold_${tokenHeld}_${amountHeld.toFixed(6)}`;
    }
  }

  private async handleBuyFailedSellFilled(
    opportunity: ArbOpportunity,
    buyResult: TradeResult,
    sellResult: TradeResult,
    strategy: string,
  ): Promise<string> {
    logger.warn('One-sided fill: BUY failed, SELL succeeded (SHORT position!)', {
      buyVenue: buyResult.venue,
      sellVenue: sellResult.venue,
      buyError: buyResult.error,
      strategy,
    });

    // This is a dangerous situation — we sold IDOS we don't have (if using pre-funded inventory).
    // Actually, with pre-funded balances, the sell uses existing inventory.
    // We need to replenish by buying on the venue that failed.

    switch (strategy) {
      case 'unwind': {
        // Buy back on the sell venue to restore inventory
        if (sellResult.venue === 'kucoin') {
          logger.info('Recovery: buying IDOS back on KuCoin to restore inventory');
          const unwind = await this.kucoinTrader.executeTrade(
            'buy',
            sellResult.amountIdos,
            sellResult.priceUsd,
          );
          return `unwind_buy_kucoin_${unwind.success ? 'ok' : 'failed'}`;
        } else {
          logger.info('Recovery: buying IDOS back on Uniswap to restore inventory');
          const unwind = await this.uniswapTrader.executeTrade(
            'buy',
            sellResult.amountIdos,
            sellResult.priceUsd,
            opportunity.path.sellQuoteToken!,
            opportunity.path.sellFeeTier!,
          );
          return `unwind_buy_uniswap_${unwind.success ? 'ok' : 'failed'}`;
        }
      }

      case 'retry': {
        // Retry the failed buy
        logger.info('Recovery: retrying failed buy leg');
        if (buyResult.venue === 'kucoin') {
          const retry = await this.kucoinTrader.executeTrade(
            'buy',
            sellResult.amountIdos,
            opportunity.buyPriceUsd,
          );
          return `retry_buy_kucoin_${retry.success ? 'ok' : 'failed'}`;
        } else {
          const retry = await this.uniswapTrader.executeTrade(
            'buy',
            sellResult.amountIdos,
            opportunity.buyPriceUsd,
            opportunity.path.buyQuoteToken!,
            opportunity.path.buyFeeTier!,
          );
          return `retry_buy_uniswap_${retry.success ? 'ok' : 'failed'}`;
        }
      }

      case 'hold':
      default:
        logger.warn('Recovery: HOLDING short position — manual intervention needed', {
          soldIdos: sellResult.amountIdos,
          soldAt: sellResult.priceUsd,
        });
        return 'hold';
    }
  }
}
