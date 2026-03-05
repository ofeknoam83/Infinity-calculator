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

    // Fetch initial snapshot via REST
    await this.fetchRestSnapshot();
  }

  private async fetchRestSnapshot(): Promise<void> {
    try {
      const ticker = await this.spotClient.getTicker({ symbol: config.kucoin.tradingPair });
      if (ticker.data) {
        const data = ticker.data;
        this.latestQuote = {
          venue: 'kucoin',
          pair: 'IDOS/USDT',
          bidPrice: parseFloat(String(data.bestBid)),
          askPrice: parseFloat(String(data.bestAsk)),
          bidSizeIdos: parseFloat(String(data.bestBidSize)),
          askSizeIdos: parseFloat(String(data.bestAskSize)),
          timestamp: Date.now(),
        };
        this.emit('price', this.latestQuote);
        logger.info('KuCoin REST snapshot', {
          bid: this.latestQuote.bidPrice,
          ask: this.latestQuote.askPrice,
        });
      }
    } catch (err) {
      logger.error('Failed to fetch KuCoin REST snapshot', { error: String(err) });
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

  async stop(): Promise<void> {
    logger.info('Stopping KuCoin price feed');
    this.wsClient.closeAll();
    this.connected = false;
  }
}
