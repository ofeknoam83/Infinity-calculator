import { EventEmitter } from 'events';
import { KuCoinFeed } from './kucoin-feed';
import { UniswapFeed } from './uniswap-feed';
import { config } from '../config';
import { logger } from '../utils/logger';
import { NormalizedPrice, PriceQuote } from '../types';
import { isStale } from '../utils/helpers';

const PRICE_MAX_AGE_MS = 30_000; // 30 seconds

export class PriceAggregator extends EventEmitter {
  private kucoinFeed: KuCoinFeed;
  private uniswapFeed: UniswapFeed;
  private normalizedPrices = new Map<string, NormalizedPrice>();
  private ethPriceUsd: number = 0;
  private ethPriceTimer: NodeJS.Timeout | null = null;

  constructor(kucoinFeed: KuCoinFeed, uniswapFeed: UniswapFeed) {
    super();
    this.kucoinFeed = kucoinFeed;
    this.uniswapFeed = uniswapFeed;
  }

  async start(): Promise<void> {
    logger.info('Starting price aggregator');

    // Listen for price updates
    this.kucoinFeed.on('price', (quote: PriceQuote) => {
      this.normalizeAndStore(quote);
    });

    this.uniswapFeed.on('price', (quote: PriceQuote) => {
      this.normalizeAndStore(quote);
    });

    // Fetch ETH price for converting WETH-denominated prices
    await this.updateEthPrice();
    this.ethPriceTimer = setInterval(() => this.updateEthPrice(), 15_000);
  }

  private async updateEthPrice(): Promise<void> {
    // Use KuCoin ETH/USDT ticker as reference
    try {
      const { SpotClient } = await import('kucoin-api');
      const client = new SpotClient({
        apiKey: config.kucoin.apiKey,
        apiSecret: config.kucoin.apiSecret,
        apiPassphrase: config.kucoin.apiPassphrase,
      });
      const ticker = await client.getTicker({ symbol: 'ETH-USDT' });
      if (ticker.data) {
        this.ethPriceUsd = parseFloat(String(ticker.data.price));
        logger.debug('ETH price updated', { ethPriceUsd: this.ethPriceUsd });
      }
    } catch (err) {
      logger.error('Error fetching ETH price', { error: String(err) });
    }
  }

  private normalizeAndStore(quote: PriceQuote): void {
    let buyPriceUsd: number;
    let sellPriceUsd: number;

    if (quote.venue === 'kucoin') {
      // IDOS/USDT — USDT ≈ USD
      buyPriceUsd = quote.askPrice;
      sellPriceUsd = quote.bidPrice;
    } else if (quote.quoteToken === 'USDC') {
      // IDOS/USDC — USDC ≈ USD
      buyPriceUsd = quote.askPrice;
      sellPriceUsd = quote.bidPrice;
    } else if (quote.quoteToken === 'WETH') {
      // IDOS/WETH — convert via ETH price
      if (this.ethPriceUsd <= 0) {
        logger.debug('Skipping WETH price normalization, no ETH price available');
        return;
      }
      buyPriceUsd = quote.askPrice * this.ethPriceUsd;
      sellPriceUsd = quote.bidPrice * this.ethPriceUsd;
    } else {
      return;
    }

    const key = this.getKey(quote);
    const normalized: NormalizedPrice = {
      venue: quote.venue,
      pair: quote.pair,
      buyPriceUsd,
      sellPriceUsd,
      maxBuySizeIdos: quote.askSizeIdos,
      maxSellSizeIdos: quote.bidSizeIdos,
      feeTier: quote.feeTier,
      quoteToken: quote.quoteToken,
      timestamp: quote.timestamp,
    };

    this.normalizedPrices.set(key, normalized);
    this.emit('normalized', normalized);
  }

  private getKey(quote: PriceQuote): string {
    if (quote.venue === 'kucoin') return 'kucoin_USDT';
    return `uniswap_${quote.quoteToken}_${quote.feeTier}`;
  }

  getAllPrices(): NormalizedPrice[] {
    return Array.from(this.normalizedPrices.values()).filter(
      (p) => !isStale(p.timestamp, PRICE_MAX_AGE_MS),
    );
  }

  getPrice(key: string): NormalizedPrice | undefined {
    const p = this.normalizedPrices.get(key);
    if (p && !isStale(p.timestamp, PRICE_MAX_AGE_MS)) return p;
    return undefined;
  }

  getEthPriceUsd(): number {
    return this.ethPriceUsd;
  }

  async stop(): Promise<void> {
    logger.info('Stopping price aggregator');
    if (this.ethPriceTimer) clearInterval(this.ethPriceTimer);
  }
}
