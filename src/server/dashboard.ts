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
        if (req.path === '/health') return next();

        const apiKey = req.headers['x-api-key'] || req.query['api_key'];
        if (apiKey !== config.dashboard.apiKey) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
      });
    }

    // --- HTML Dashboard ---
    this.app.get('/', (_req, res) => {
      const status = this.getStatus();
      res.type('html').send(this.renderDashboard(status));
    });

    // --- API Endpoints ---

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

    this.app.get('/balances', (_req, res) => {
      const status = this.getStatus();
      const b = status.balances;

      res.json({
        kucoin: {
          idos: b.kucoin.idos,
          usdt: b.kucoin.usdt,
        },
        arbitrum: {
          idos: b.arbitrum.idos,
          usdc: b.arbitrum.usdc,
          weth: b.arbitrum.weth,
          eth: b.arbitrum.eth,
        },
        totals: {
          idos: b.kucoin.idos + b.arbitrum.idos,
          stablecoinsUsd: b.kucoin.usdt + b.arbitrum.usdc,
          ethForGas: b.arbitrum.eth,
        },
      });
    });

    this.app.get('/trades', (_req, res) => {
      const status = this.getStatus();
      const trades = status.tradeHistory.map(t => ({
        id: t.id,
        timestamp: new Date(t.timestamp).toISOString(),
        pathType: t.execution.opportunity.path.pathType,
        pathId: t.execution.opportunity.path.id,
        status: t.execution.status,
        tradeSizeIdos: t.execution.opportunity.tradeSizeIdos,
        buyVenue: t.execution.buyLeg.venue,
        buyPrice: t.execution.buyLeg.priceUsd,
        buyTotal: t.execution.buyLeg.totalUsd,
        buySuccess: t.execution.buyLeg.success,
        buyFee: t.execution.buyLeg.feeUsd,
        buyTxHash: t.execution.buyLeg.txHash || null,
        buyOrderId: t.execution.buyLeg.orderId || null,
        sellVenue: t.execution.sellLeg.venue,
        sellPrice: t.execution.sellLeg.priceUsd,
        sellTotal: t.execution.sellLeg.totalUsd,
        sellSuccess: t.execution.sellLeg.success,
        sellFee: t.execution.sellLeg.feeUsd,
        sellTxHash: t.execution.sellLeg.txHash || null,
        sellOrderId: t.execution.sellLeg.orderId || null,
        thirdLeg: t.execution.thirdLeg ? {
          tokenIn: t.execution.thirdLeg.tokenIn,
          tokenOut: t.execution.thirdLeg.tokenOut,
          amountIn: t.execution.thirdLeg.amountIn,
          amountOut: t.execution.thirdLeg.amountOut,
          success: t.execution.thirdLeg.success,
          fee: t.execution.thirdLeg.feeUsd,
          txHash: t.execution.thirdLeg.txHash || null,
        } : null,
        netProfitUsd: t.execution.netProfitUsd,
        totalFeesUsd: t.execution.buyLeg.feeUsd + t.execution.sellLeg.feeUsd
          + (t.execution.thirdLeg?.feeUsd || 0),
        recoveryAction: t.execution.recoveryAction || null,
      }));

      res.json({
        totalTrades: trades.length,
        trades,
      });
    });

    this.app.get('/profits', (_req, res) => {
      const status = this.getStatus();
      const trades = status.tradeHistory;
      const successful = trades.filter(t => t.execution.status === 'success');

      res.json({
        totalProfitUsd: status.totalProfitUsd,
        totalTrades: status.totalTrades,
        successfulTrades: status.successfulTrades,
        failedTrades: status.totalTrades - status.successfulTrades,
        winRate: status.totalTrades > 0
          ? ((status.successfulTrades / status.totalTrades) * 100).toFixed(1) + '%'
          : 'N/A',
        avgProfitPerTrade: successful.length > 0
          ? (successful.reduce((sum, t) => sum + t.execution.netProfitUsd, 0) / successful.length)
          : 0,
        totalFeesUsd: trades.reduce((sum, t) =>
          sum + t.execution.buyLeg.feeUsd + t.execution.sellLeg.feeUsd
            + (t.execution.thirdLeg?.feeUsd || 0), 0),
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

  private renderDashboard(status: BotStatus): string {
    const b = status.balances;
    const totalIdos = b.kucoin.idos + b.arbitrum.idos;
    const totalStable = b.kucoin.usdt + b.arbitrum.usdc;
    const upH = (status.uptime / 3600000).toFixed(1);

    const pricesHtml = status.currentPrices.map(p => `
      <tr>
        <td>${p.venue}</td>
        <td>${p.pair}</td>
        <td>$${p.buyPriceUsd.toFixed(6)}</td>
        <td>$${p.sellPriceUsd.toFixed(6)}</td>
        <td>${p.feeTier ? (p.feeTier / 10000).toFixed(2) + '%' : '-'}</td>
      </tr>`).join('');

    const spreadsHtml = status.currentSpread
      .sort((a, c) => c.spreadPct - a.spreadPct)
      .slice(0, 10)
      .map(s => `
      <tr>
        <td>${s.pathId}</td>
        <td style="color:${s.spreadPct > 0 ? '#4f4' : '#f44'}">${s.spreadPct.toFixed(4)}%</td>
      </tr>`).join('');

    const tradesHtml = status.tradeHistory
      .slice()
      .reverse()
      .slice(0, 50)
      .map(t => {
        const e = t.execution;
        const statusColor = e.status === 'success' ? '#4f4'
          : e.status === 'both_failed' || e.status === 'all_failed' ? '#f44'
          : '#fa4';
        const profitColor = e.netProfitUsd >= 0 ? '#4f4' : '#f44';
        const time = new Date(t.timestamp).toISOString().slice(11, 19);
        const fees = e.buyLeg.feeUsd + e.sellLeg.feeUsd + (e.thirdLeg?.feeUsd || 0);
        return `
      <tr>
        <td>${time}</td>
        <td>${e.opportunity.path.pathType}</td>
        <td style="color:${statusColor}">${e.status}</td>
        <td>${e.opportunity.tradeSizeIdos.toFixed(1)}</td>
        <td>${e.buyLeg.venue}@$${e.buyLeg.priceUsd.toFixed(4)}</td>
        <td>${e.sellLeg.venue}@$${e.sellLeg.priceUsd.toFixed(4)}</td>
        <td style="color:${profitColor}">$${e.netProfitUsd.toFixed(4)}</td>
        <td>$${fees.toFixed(4)}</td>
        <td>${e.recoveryAction || '-'}</td>
      </tr>`;
      }).join('');

    const errorsHtml = status.errors
      .slice(-10)
      .reverse()
      .map(e => `<tr><td>${new Date(e.timestamp).toISOString().slice(11, 19)}</td><td>${this.escapeHtml(e.message)}</td></tr>`)
      .join('');

    return `<!DOCTYPE html>
<html>
<head>
  <title>IDOS Arb Bot</title>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="5">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #111; color: #ddd; font-family: 'Courier New', monospace; font-size: 13px; padding: 16px; }
    h1 { color: #4fc; font-size: 18px; margin-bottom: 12px; }
    h2 { color: #8af; font-size: 14px; margin: 16px 0 6px; border-bottom: 1px solid #333; padding-bottom: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 12px; }
    .card { background: #1a1a2e; border: 1px solid #333; border-radius: 6px; padding: 12px; }
    .card h3 { color: #aaa; font-size: 11px; text-transform: uppercase; margin-bottom: 8px; }
    .val { font-size: 22px; font-weight: bold; }
    .green { color: #4f4; }
    .red { color: #f44; }
    .blue { color: #4af; }
    .row { display: flex; justify-content: space-between; padding: 3px 0; }
    .row .label { color: #888; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th { text-align: left; color: #888; font-size: 11px; text-transform: uppercase; padding: 4px 8px; border-bottom: 1px solid #333; }
    td { padding: 4px 8px; border-bottom: 1px solid #222; white-space: nowrap; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .dot.on { background: #4f4; }
    .dot.off { background: #f44; }
    .links { margin-top: 16px; color: #666; font-size: 11px; }
    .links a { color: #48f; text-decoration: none; margin-right: 12px; }
  </style>
</head>
<body>
  <h1><span class="dot ${status.running ? 'on' : 'off'}"></span>IDOS Arbitrage Bot</h1>

  <div class="grid">
    <div class="card">
      <h3>Overview</h3>
      <div class="row"><span class="label">Uptime</span><span>${upH}h</span></div>
      <div class="row"><span class="label">Total Trades</span><span>${status.totalTrades}</span></div>
      <div class="row"><span class="label">Successful</span><span>${status.successfulTrades}</span></div>
      <div class="row"><span class="label">Win Rate</span><span>${status.totalTrades > 0 ? ((status.successfulTrades / status.totalTrades) * 100).toFixed(1) + '%' : 'N/A'}</span></div>
      <div class="row"><span class="label">Last Trade</span><span>${status.lastTradeAt ? new Date(status.lastTradeAt).toISOString().slice(11, 19) : 'Never'}</span></div>
    </div>

    <div class="card">
      <h3>Total P&amp;L</h3>
      <div class="val ${status.totalProfitUsd >= 0 ? 'green' : 'red'}">$${status.totalProfitUsd.toFixed(4)}</div>
    </div>

    <div class="card">
      <h3>KuCoin Balances</h3>
      <div class="row"><span class="label">IDOS</span><span>${b.kucoin.idos.toFixed(2)}</span></div>
      <div class="row"><span class="label">USDT</span><span>$${b.kucoin.usdt.toFixed(2)}</span></div>
    </div>

    <div class="card">
      <h3>Arbitrum Balances</h3>
      <div class="row"><span class="label">IDOS</span><span>${b.arbitrum.idos.toFixed(2)}</span></div>
      <div class="row"><span class="label">USDC</span><span>$${b.arbitrum.usdc.toFixed(2)}</span></div>
      <div class="row"><span class="label">WETH</span><span>${b.arbitrum.weth.toFixed(6)}</span></div>
      <div class="row"><span class="label">ETH (gas)</span><span>${b.arbitrum.eth.toFixed(6)}</span></div>
    </div>

    <div class="card">
      <h3>Cross-Venue Totals</h3>
      <div class="row"><span class="label">Total IDOS</span><span class="blue">${totalIdos.toFixed(2)}</span></div>
      <div class="row"><span class="label">Total Stables</span><span class="blue">$${totalStable.toFixed(2)}</span></div>
      <div class="row"><span class="label">KuCoin IDOS</span><span>${totalIdos > 0 ? ((b.kucoin.idos / totalIdos) * 100).toFixed(1) + '%' : '-'}</span></div>
      <div class="row"><span class="label">KuCoin Stable</span><span>${totalStable > 0 ? ((b.kucoin.usdt / totalStable) * 100).toFixed(1) + '%' : '-'}</span></div>
    </div>
  </div>

  <h2>Current Prices</h2>
  <table>
    <tr><th>Venue</th><th>Pair</th><th>Buy (Ask)</th><th>Sell (Bid)</th><th>Fee Tier</th></tr>
    ${pricesHtml || '<tr><td colspan="5" style="color:#666">No price data</td></tr>'}
  </table>

  <h2>Top Spreads</h2>
  <table>
    <tr><th>Path</th><th>Spread</th></tr>
    ${spreadsHtml || '<tr><td colspan="2" style="color:#666">No spread data</td></tr>'}
  </table>

  <h2>Trade History (last 50)</h2>
  <table>
    <tr><th>Time</th><th>Type</th><th>Status</th><th>Size</th><th>Buy</th><th>Sell</th><th>Profit</th><th>Fees</th><th>Recovery</th></tr>
    ${tradesHtml || '<tr><td colspan="9" style="color:#666">No trades yet</td></tr>'}
  </table>

  <h2>Recent Errors</h2>
  <table>
    <tr><th>Time</th><th>Message</th></tr>
    ${errorsHtml || '<tr><td colspan="2" style="color:#666">No errors</td></tr>'}
  </table>

  <div class="links">
    JSON API: <a href="/balances">/balances</a> <a href="/trades">/trades</a> <a href="/profits">/profits</a> <a href="/status">/status</a> <a href="/config">/config</a> <a href="/health">/health</a>
  </div>
</body>
</html>`;
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  start(): void {
    this.app.listen(config.dashboard.port, () => {
      logger.info(`Dashboard running on http://localhost:${config.dashboard.port}`);
    });
  }
}
