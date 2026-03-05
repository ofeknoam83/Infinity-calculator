import { SpotClient, WebsocketClient } from 'kucoin-api';
import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../utils/logger';
import { PriceQuote } from '../types';

export class KuCoinFeed extends EventEmitter {
  private spotClient: SpotClient;
  private wsClient: WebsocketClient;
  private latestQuote: PriceQuote | null = null;
  private connected = false;
  private pairAvailable = true;

  constructor() {
    super();
    this.spotClient = new SpotClient({
      apiKey: config.kucoin.apiKey,
      apiSecret: config.kucoin.apiSecret,
      apiPassphrase: config.kucoin.apiPassphrase,
    });
    this.wsClient = new WebsocketClient({
      apiKey: config.kucoin.apiKey,
      apiSecret: config.kucoin.apiSecret,
      apiPassphrase: config.kucoin.apiPassphrase,
    });
  }

  async start(): Promise<void> {
    logger.info('Starting KuCoin price feed', { pair: config.kucoin.tradingPair });

    // Verify pair exists via REST before subscribing to WS
    const snapshotOk = await this.fetchRestSnapshot();
    if (!snapshotOk) {
      logger.warn(`KuCoin pair ${config.kucoin.tradingPair} not available — CEX-DEX paths disabled`);
      this.pairAvailable = false;
      return; // Don't subscribe WS for a pair that doesn't exist
    }

    // Set up WebSocket event handlers
    this.wsClient.on('update', (data) => {
      this.handleWsMessage(data);
    });

    this.wsClient.on('open', ({ wsKey }) => {
      logger.info('KuCoin WebSocket connected', { wsKey });
      this.connected = true;
    });

    this.wsClient.on('reconnected', ({ wsKey }) => {
      logger.info('KuCoin WebSocket reconnected', { wsKey });
      this.connected = true;
    });

    this.wsClient.on('close', ({ wsKey }) => {
      logger.warn('KuCoin WebSocket disconnected', { wsKey });
      this.connected = false;
    });

    this.wsClient.on('error', ({ wsKey, error }) => {
      logger.error('KuCoin WebSocket error', { wsKey, error: String(error) });
    });

    // Subscribe to ticker for IDOS-USDT
    this.wsClient.subscribe(`/market/ticker:${config.kucoin.tradingPair}`, 'spotPublicV1');
  }

  /**
   * Fetch initial price snapshot via REST. Returns true if successful.
   */
  private async fetchRestSnapshot(): Promise<boolean> {
    try {
      const ticker = await this.spotClient.getTicker({ symbol: config.kucoin.tradingPair });
      if (ticker.data) {
        const data = ticker.data;
        const bid = parseFloat(String(data.bestBid));
        const ask = parseFloat(String(data.bestAsk));

        // Sanity check — a zero-price response means the pair is inactive
        if (bid <= 0 && ask <= 0) {
          logger.warn('KuCoin pair has zero prices — treating as unavailable');
          return false;
        }

        this.latestQuote = {
          venue: 'kucoin',
          pair: 'IDOS/USDT',
          bidPrice: bid,
          askPrice: ask,
          bidSizeIdos: parseFloat(String(data.bestBidSize)),
          askSizeIdos: parseFloat(String(data.bestAskSize)),
          timestamp: Date.now(),
        };
        this.emit('price', this.latestQuote);
        logger.info('KuCoin REST snapshot', {
          bid: this.latestQuote.bidPrice,
          ask: this.latestQuote.askPrice,
        });
        return true;
      }
      return false;
    } catch (err) {
      logger.error('Failed to fetch KuCoin REST snapshot', { error: String(err) });
      return false;
    }
  }

  private handleWsMessage(data: any): void {
    try {
      if (data.topic?.includes('/market/ticker') && data.data) {
        const d = data.data;
        this.latestQuote = {
          venue: 'kucoin',
          pair: 'IDOS/USDT',
          bidPrice: parseFloat(String(d.bestBid)),
          askPrice: parseFloat(String(d.bestAsk)),
          bidSizeIdos: parseFloat(String(d.bestBidSize)),
          askSizeIdos: parseFloat(String(d.bestAskSize)),
          timestamp: Date.now(),
        };
        this.emit('price', this.latestQuote);
      }
    } catch (err) {
      logger.error('Error parsing KuCoin WS message', { error: String(err) });
    }
  }

  getLatestQuote(): PriceQuote | null {
    return this.latestQuote;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isPairAvailable(): boolean {
    return this.pairAvailable;
  }

  async stop(): Promise<void> {
    logger.info('Stopping KuCoin price feed');
    if (this.pairAvailable) {
      this.wsClient.closeAll();
    }
    this.connected = false;
  }
}
