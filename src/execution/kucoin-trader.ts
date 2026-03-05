import { SpotClient } from 'kucoin-api';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TradeResult, Direction } from '../types';
import { generateTradeId } from '../utils/helpers';

export class KuCoinTrader {
  private client: SpotClient;

  constructor() {
    this.client = new SpotClient({
      apiKey: config.kucoin.apiKey,
      apiSecret: config.kucoin.apiSecret,
      apiPassphrase: config.kucoin.apiPassphrase,
    });
  }

  async executeTrade(
    direction: Direction,
    amountIdos: number,
    priceUsd: number,
  ): Promise<TradeResult> {
    const clientOid = generateTradeId();
    const startTime = Date.now();

    try {
      logger.info(`KuCoin ${direction} order`, {
        amount: amountIdos,
        price: priceUsd,
        clientOid,
      });

      const orderParams = {
        clientOid,
        side: direction === 'buy' ? 'buy' as const : 'sell' as const,
        symbol: config.kucoin.tradingPair,
        type: 'market' as const,
        ...(direction === 'buy'
          ? { funds: String(amountIdos * priceUsd) } // Buy: specify USDT amount to spend
          : { size: String(amountIdos) }),            // Sell: specify IDOS amount to sell
      };

      const result = await this.client.submitOrder(orderParams);

      if (result.data?.orderId) {
        // Wait briefly then check fill
        await new Promise(r => setTimeout(r, 500));
        const orderDetail = await this.client.getOrderByOrderId({
          orderId: result.data.orderId,
        });

        const detail = orderDetail.data;
        const filledSize = parseFloat(String(detail?.dealSize || amountIdos));
        const filledFunds = parseFloat(String(detail?.dealFunds || (amountIdos * priceUsd)));
        const fee = parseFloat(String(detail?.fee || 0));
        const avgPrice = filledSize > 0 ? filledFunds / filledSize : priceUsd;

        logger.info(`KuCoin order filled`, {
          orderId: result.data.orderId,
          filledSize,
          avgPrice,
          fee,
          latencyMs: Date.now() - startTime,
        });

        return {
          success: true,
          venue: 'kucoin',
          direction,
          amountIdos: filledSize,
          priceUsd: avgPrice,
          totalUsd: filledFunds,
          feeUsd: fee,
          orderId: result.data.orderId,
          timestamp: Date.now(),
        };
      }

      throw new Error('No order ID returned from KuCoin');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`KuCoin ${direction} order failed`, {
        error: errorMsg,
        amount: amountIdos,
        price: priceUsd,
        latencyMs: Date.now() - startTime,
      });

      return {
        success: false,
        venue: 'kucoin',
        direction,
        amountIdos,
        priceUsd,
        totalUsd: amountIdos * priceUsd,
        feeUsd: 0,
        error: errorMsg,
        timestamp: Date.now(),
      };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.client.cancelOrderById({ orderId });
      logger.info(`KuCoin order cancelled`, { orderId });
      return true;
    } catch (err) {
      logger.error(`KuCoin cancel failed`, { orderId, error: String(err) });
      return false;
    }
  }

  /**
   * Internal transfer between KuCoin accounts (trade ↔ main).
   * Withdrawals must come from the main account.
   */
  async innerTransfer(
    currency: string,
    amount: number,
    from: 'trade' | 'main',
    to: 'trade' | 'main',
  ): Promise<boolean> {
    try {
      logger.info('KuCoin inner transfer', { currency, amount, from, to });
      await this.client.submitInnerTransfer({
        clientOid: generateTradeId(),
        currency,
        from,
        to,
        amount: String(amount),
      });
      logger.info('KuCoin inner transfer succeeded', { currency, amount, from, to });
      return true;
    } catch (err) {
      logger.error('KuCoin inner transfer failed', {
        currency, amount, from, to,
        error: String(err),
      });
      return false;
    }
  }

  /**
   * Withdraw from KuCoin to an external address on a specific chain.
   * Funds must be in the main account first (use innerTransfer).
   */
  async withdraw(
    currency: string,
    amount: number,
    toAddress: string,
    chain: string,
    memo?: string,
  ): Promise<string | null> {
    try {
      logger.info('KuCoin withdrawal', { currency, amount, toAddress, chain });
      const result = await this.client.submitWithdraw({
        currency,
        address: toAddress,
        amount,
        chain,
        ...(memo ? { memo } : {}),
      });
      const withdrawalId = (result.data as any)?.withdrawalId || null;
      logger.info('KuCoin withdrawal submitted', { currency, amount, withdrawalId });
      return withdrawalId;
    } catch (err) {
      logger.error('KuCoin withdrawal failed', {
        currency, amount, toAddress, chain,
        error: String(err),
      });
      return null;
    }
  }

  /**
   * Get the KuCoin deposit address for receiving tokens from external wallets.
   */
  async getDepositAddress(currency: string, chain?: string): Promise<string | null> {
    try {
      const result = await this.client.getDepositAddressV1({
        currency,
        ...(chain ? { chain } : {}),
      });
      return result.data?.address || null;
    } catch (err) {
      logger.error('Failed to get KuCoin deposit address', {
        currency, chain, error: String(err),
      });
      return null;
    }
  }

  /**
   * Get balances across all KuCoin account types (main + trade).
   */
  async getTotalBalances(): Promise<{ idos: number; usdt: number }> {
    try {
      const accounts = await this.client.getBalances({});
      let idos = 0;
      let usdt = 0;

      if (accounts.data) {
        for (const acc of accounts.data) {
          if (acc.currency === 'IDOS') {
            idos += parseFloat(String(acc.available));
          } else if (acc.currency === 'USDT') {
            usdt += parseFloat(String(acc.available));
          }
        }
      }

      return { idos, usdt };
    } catch (err) {
      logger.error('Error fetching KuCoin total balances', { error: String(err) });
      return { idos: 0, usdt: 0 };
    }
  }

  async getBalances(): Promise<{ idos: number; usdt: number }> {
    try {
      const accounts = await this.client.getBalances({
        type: 'trade',
      });

      let idos = 0;
      let usdt = 0;

      if (accounts.data) {
        for (const acc of accounts.data) {
          if (acc.currency === 'IDOS') {
            idos = parseFloat(String(acc.available));
          } else if (acc.currency === 'USDT') {
            usdt = parseFloat(String(acc.available));
          }
        }
      }

      return { idos, usdt };
    } catch (err) {
      logger.error('Error fetching KuCoin balances', { error: String(err) });
      return { idos: 0, usdt: 0 };
    }
  }
}
