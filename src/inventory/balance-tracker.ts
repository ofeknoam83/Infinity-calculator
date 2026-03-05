import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Balances, TradeRecord } from '../types';
import { KuCoinTrader } from '../execution/kucoin-trader';
import { UniswapTrader } from '../execution/uniswap-trader';

export class BalanceTracker extends EventEmitter {
  private kucoinTrader: KuCoinTrader;
  private uniswapTrader: UniswapTrader;
  private balances: Balances = {
    kucoin: { idos: 0, usdt: 0 },
    arbitrum: { idos: 0, usdc: 0, weth: 0, eth: 0 },
  };
  private tradeHistory: TradeRecord[] = [];
  private totalProfitUsd = 0;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(kucoinTrader: KuCoinTrader, uniswapTrader: UniswapTrader) {
    super();
    this.kucoinTrader = kucoinTrader;
    this.uniswapTrader = uniswapTrader;
  }

  async start(): Promise<void> {
    logger.info('Starting balance tracker');
    await this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), config.intervals.balancePollMs);
  }

  async refresh(): Promise<void> {
    try {
      const [kucoinBal, arbBal] = await Promise.all([
        this.kucoinTrader.getBalances(),
        this.uniswapTrader.getBalances(),
      ]);

      this.balances = {
        kucoin: kucoinBal,
        arbitrum: arbBal,
      };

      logger.debug('Balances refreshed', {
        kucoin: kucoinBal,
        arbitrum: arbBal,
      });

      // Check for low balances
      this.checkLowBalances();

      this.emit('balances', this.balances);
    } catch (err) {
      logger.error('Balance refresh failed', { error: String(err) });
    }
  }

  private checkLowBalances(): void {
    const { kucoin, arbitrum } = this.balances;

    if (kucoin.usdt < 10) {
      logger.warn('LOW BALANCE: KuCoin USDT', { balance: kucoin.usdt });
    }
    if (kucoin.idos < 10) {
      logger.warn('LOW BALANCE: KuCoin IDOS', { balance: kucoin.idos });
    }
    if (arbitrum.usdc < 10) {
      logger.warn('LOW BALANCE: Arbitrum USDC', { balance: arbitrum.usdc });
    }
    if (arbitrum.idos < 10) {
      logger.warn('LOW BALANCE: Arbitrum IDOS', { balance: arbitrum.idos });
    }
    if (arbitrum.eth < 0.001) {
      logger.warn('LOW BALANCE: Arbitrum ETH (gas)', { balance: arbitrum.eth });
    }
  }

  recordTrade(record: TradeRecord): void {
    this.tradeHistory.push(record);
    this.totalProfitUsd += record.execution.netProfitUsd;

    // Keep last 1000 trades
    if (this.tradeHistory.length > 1000) {
      this.tradeHistory = this.tradeHistory.slice(-1000);
    }

    // Refresh balances after trade
    this.refresh();
  }

  getBalances(): Balances {
    return { ...this.balances };
  }

  getTradeHistory(): TradeRecord[] {
    return [...this.tradeHistory];
  }

  getTotalProfitUsd(): number {
    return this.totalProfitUsd;
  }

  getTradeCount(): number {
    return this.tradeHistory.length;
  }

  getSuccessfulTradeCount(): number {
    return this.tradeHistory.filter((t) => t.execution.status === 'success').length;
  }

  async stop(): Promise<void> {
    logger.info('Stopping balance tracker');
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}
