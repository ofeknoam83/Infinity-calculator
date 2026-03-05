import { config } from './config';
import { logger } from './utils/logger';
import { KuCoinFeed } from './feeds/kucoin-feed';
import { UniswapFeed } from './feeds/uniswap-feed';
import { PriceAggregator } from './feeds/price-aggregator';
import { FeeCalculator } from './engine/fee-calculator';
import { OpportunityDetector } from './engine/opportunity-detector';
import { KuCoinTrader } from './execution/kucoin-trader';
import { UniswapTrader } from './execution/uniswap-trader';
import { Executor } from './execution/executor';
import { BalanceTracker } from './inventory/balance-tracker';
import { Rebalancer } from './inventory/rebalancer';
import { Dashboard } from './server/dashboard';
import { BotStatus, ArbOpportunity, ExecutionResult } from './types';
import { generateTradeId } from './utils/helpers';

class ArbitrageBot {
  private kucoinFeed: KuCoinFeed;
  private uniswapFeed: UniswapFeed;
  private aggregator: PriceAggregator;
  private feeCalculator: FeeCalculator;
  private detector: OpportunityDetector;
  private kucoinTrader: KuCoinTrader;
  private uniswapTrader: UniswapTrader;
  private executor: Executor;
  private balanceTracker: BalanceTracker;
  private rebalancer: Rebalancer;
  private dashboard: Dashboard;

  private startedAt = 0;
  private lastTradeAt: number | null = null;
  private running = false;
  private errors: { message: string; timestamp: number }[] = [];

  constructor() {
    // Price feeds
    this.kucoinFeed = new KuCoinFeed();
    this.uniswapFeed = new UniswapFeed();
    this.aggregator = new PriceAggregator(this.kucoinFeed, this.uniswapFeed);

    // Engine
    this.feeCalculator = new FeeCalculator();
    this.detector = new OpportunityDetector(this.aggregator, this.feeCalculator);

    // Execution
    this.kucoinTrader = new KuCoinTrader();
    this.uniswapTrader = new UniswapTrader(this.uniswapFeed.getProvider());
    this.executor = new Executor(this.kucoinTrader, this.uniswapTrader, this.aggregator);

    // Inventory
    this.balanceTracker = new BalanceTracker(this.kucoinTrader, this.uniswapTrader);
    this.rebalancer = new Rebalancer(this.kucoinTrader, this.uniswapTrader);

    // Dashboard
    this.dashboard = new Dashboard(() => this.getStatus());
  }

  async start(): Promise<void> {
    logger.info('=== IDOS Arbitrage Bot Starting ===');
    logger.info('KuCoin pair: IDOS/USDT');
    logger.info('Uniswap V3 pools: IDOS/USDC, IDOS/WETH on Arbitrum');
    logger.info('Strategies: CEX-DEX, Cross-DEX, Triangular');
    logger.info(`Min profit: $${config.trading.minProfitUsd} / ${config.trading.minProfitPct}%`);
    logger.info(`Max trade size: ${config.trading.maxTradeSizeIdos} IDOS`);
    logger.info(`Recovery strategy: ${config.recovery.strategy}`);

    this.startedAt = Date.now();
    this.running = true;

    try {
      // --- Start feeds (gracefully handle individual failures) ---

      // Start KuCoin feed — if the pair doesn't exist, CEX-DEX paths are disabled
      try {
        await this.kucoinFeed.start();
      } catch (err) {
        logger.warn('KuCoin feed failed to start — CEX-DEX paths disabled', {
          error: String(err),
        });
      }

      // Inform detector about KuCoin availability
      if (!this.kucoinFeed.isPairAvailable()) {
        this.detector.setKucoinAvailable(false);
      }

      // Start Uniswap feed — discover pools
      try {
        await this.uniswapFeed.start();
      } catch (err) {
        logger.warn('Uniswap feed failed to start — DEX paths may be limited', {
          error: String(err),
        });
      }

      // Tell the detector which Uniswap pools actually exist so it prunes impossible paths
      const discoveredPools = this.uniswapFeed.getDiscoveredPools();
      this.detector.setAvailableUniswapPools(
        discoveredPools.map(p => ({ quoteToken: p.quoteToken, fee: p.fee })),
      );
      // Also tell it which WETH/USDC fee tiers exist for triangular 3rd leg
      this.detector.setAvailableThirdLegFeeTiers(
        this.uniswapFeed.getAvailableThirdLegFeeTiers(),
      );

      // Check if we have any viable data sources
      const hasKucoin = this.kucoinFeed.isPairAvailable();
      const hasUniswap = discoveredPools.length > 0;
      if (!hasKucoin && !hasUniswap) {
        logger.error('No price data sources available — bot cannot trade');
        logger.error('Neither KuCoin pair nor Uniswap pools are available.');
        // Don't throw — keep running in case things come online later
      } else {
        const sources: string[] = [];
        if (hasKucoin) sources.push('KuCoin');
        if (hasUniswap) sources.push(`Uniswap (${discoveredPools.length} pools)`);
        logger.info(`Active data sources: ${sources.join(', ')}`);
      }

      // Start aggregator
      await this.aggregator.start();

      // --- Balance tracking ---
      await this.balanceTracker.start();

      // --- Initial bootstrap: distribute funds if starting from KuCoin-only ---
      const initialBalances = this.balanceTracker.getBalances();
      logger.info('Initial balances', { balances: initialBalances });

      try {
        await this.rebalancer.bootstrap(initialBalances);
      } catch (err) {
        logger.warn('Bootstrap failed — continuing with current balances', {
          error: String(err),
        });
      }

      // Refresh balances after bootstrap
      await this.balanceTracker.refresh();

      // --- Start engine ---
      this.detector.start();

      // Wire up gas price and ETH price updates
      this.feeCalculator.updateGasPrice(this.uniswapFeed.getGasPrice());
      this.uniswapTrader.updateEthPrice(this.aggregator.getEthPriceUsd());
      setInterval(() => {
        this.feeCalculator.updateGasPrice(this.uniswapFeed.getGasPrice());
        this.uniswapTrader.updateEthPrice(this.aggregator.getEthPriceUsd());
      }, config.intervals.gasPricePollMs);

      // --- Periodic auto-rebalancing ---
      setInterval(async () => {
        if (this.executor.isExecuting() || this.rebalancer.isRebalancing()) return;
        try {
          const balances = this.balanceTracker.getBalances();
          await this.rebalancer.checkAndRebalance(balances);
        } catch (err) {
          logger.error('Rebalance check failed', { error: String(err) });
        }
      }, 60_000);

      // --- Wire up opportunity detection → execution ---
      this.detector.on('opportunity', async (opp: ArbOpportunity) => {
        if (this.executor.isExecuting()) {
          logger.debug('Skipping opportunity — execution in progress');
          return;
        }
        if (this.rebalancer.isRebalancing()) {
          logger.debug('Skipping opportunity — rebalancing in progress');
          return;
        }

        // Lock detector during execution
        this.detector.lock();
        try {
          const result = await this.executor.execute(opp);
          this.handleExecutionResult(result);
        } finally {
          this.detector.unlock();
        }
      });

      // Wire up execution results → balance tracker
      this.executor.on('execution', (result: ExecutionResult) => {
        this.balanceTracker.recordTrade({
          id: generateTradeId(),
          execution: result,
          timestamp: Date.now(),
        });
      });

      // Start dashboard
      this.dashboard.start();

      logger.info('=== Bot fully initialized and running ===');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Fatal error during startup', { error: errorMsg });
      this.recordError(errorMsg);
      throw err;
    }
  }

  private handleExecutionResult(result: ExecutionResult): void {
    this.lastTradeAt = Date.now();

    if (result.status === 'success') {
      logger.info('Trade completed successfully', {
        profit: `$${result.netProfitUsd.toFixed(4)}`,
        totalProfit: `$${this.balanceTracker.getTotalProfitUsd().toFixed(4)}`,
      });
    } else {
      const msg = `Trade ${result.status}: ${result.recoveryAction || 'no recovery'}`;
      logger.warn(msg);
      this.recordError(msg);
    }
  }

  private recordError(message: string): void {
    this.errors.push({ message, timestamp: Date.now() });
    // Keep last 100 errors
    if (this.errors.length > 100) {
      this.errors = this.errors.slice(-100);
    }
  }

  private getStatus(): BotStatus {
    return {
      running: this.running,
      uptime: Date.now() - this.startedAt,
      startedAt: this.startedAt,
      lastTradeAt: this.lastTradeAt,
      totalTrades: this.balanceTracker.getTradeCount(),
      successfulTrades: this.balanceTracker.getSuccessfulTradeCount(),
      totalProfitUsd: this.balanceTracker.getTotalProfitUsd(),
      balances: this.balanceTracker.getBalances(),
      currentPrices: this.aggregator.getAllPrices(),
      currentSpread: this.detector.getCurrentSpreads(),
      errors: this.errors,
      tradeHistory: this.balanceTracker.getTradeHistory(),
    };
  }

  async stop(): Promise<void> {
    logger.info('Shutting down...');
    this.running = false;
    await this.kucoinFeed.stop();
    await this.uniswapFeed.stop();
    await this.aggregator.stop();
    await this.balanceTracker.stop();
    logger.info('Bot stopped.');
  }
}

// --- Main ---
const bot = new ArbitrageBot();

bot.start().catch((err) => {
  logger.error('Bot failed to start', { error: String(err) });
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received');
  await bot.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received');
  await bot.stop();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});
