import express from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import { BotStatus } from '../types';

type StatusProvider = () => BotStatus;

export class Dashboard {
  private app: express.Express;
  private getStatus: StatusProvider;

  constructor(getStatus: StatusProvider) {
    this.app = express();
    this.getStatus = getStatus;
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Optional API key auth
    if (config.dashboard.apiKey) {
      this.app.use((req, res, next) => {
        // Health endpoint is always public
        if (req.path === '/health') return next();

        const apiKey = req.headers['x-api-key'] || req.query['api_key'];
        if (apiKey !== config.dashboard.apiKey) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
      });
    }

    this.app.get('/health', (_req, res) => {
      const status = this.getStatus();
      res.json({
        status: status.running ? 'healthy' : 'unhealthy',
        uptime: status.uptime,
      });
    });

    this.app.get('/status', (_req, res) => {
      const status = this.getStatus();
      res.json({
        running: status.running,
        uptime: status.uptime,
        startedAt: new Date(status.startedAt).toISOString(),
        lastTradeAt: status.lastTradeAt ? new Date(status.lastTradeAt).toISOString() : null,
        totalTrades: status.totalTrades,
        successfulTrades: status.successfulTrades,
        totalProfitUsd: status.totalProfitUsd,
        balances: status.balances,
        currentPrices: status.currentPrices.map((p) => ({
          venue: p.venue,
          pair: p.pair,
          buyPriceUsd: p.buyPriceUsd,
          sellPriceUsd: p.sellPriceUsd,
          feeTier: p.feeTier,
        })),
        currentSpreads: status.currentSpread,
        recentErrors: status.errors.slice(-10),
      });
    });

    this.app.get('/profits', (_req, res) => {
      const status = this.getStatus();
      res.json({
        totalProfitUsd: status.totalProfitUsd,
        totalTrades: status.totalTrades,
        successfulTrades: status.successfulTrades,
        winRate: status.totalTrades > 0
          ? ((status.successfulTrades / status.totalTrades) * 100).toFixed(1) + '%'
          : 'N/A',
      });
    });

    this.app.get('/config', (_req, res) => {
      res.json({
        tradingPair: config.kucoin.tradingPair,
        minProfitUsd: config.trading.minProfitUsd,
        minProfitPct: config.trading.minProfitPct,
        maxTradeSizeIdos: config.trading.maxTradeSizeIdos,
        maxSlippagePct: config.trading.maxSlippagePct,
        cooldownMs: config.trading.cooldownMs,
        recoveryStrategy: config.recovery.strategy,
        usePrivateRpc: config.mev.usePrivateRpc,
        uniswapFeeTiers: config.uniswap.feeTiers,
      });
    });
  }

  start(): void {
    this.app.listen(config.dashboard.port, () => {
      logger.info(`Dashboard running on port ${config.dashboard.port}`);
    });
  }
}
