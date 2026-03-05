import { ethers } from 'ethers';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Balances } from '../types';
import { KuCoinTrader } from '../execution/kucoin-trader';
import { UniswapTrader } from '../execution/uniswap-trader';
import { sleep } from '../utils/helpers';
import { ERC20_ABI } from '../utils/abis';

export interface RebalanceSuggestion {
  action: string;
  from: 'kucoin' | 'arbitrum';
  to: 'kucoin' | 'arbitrum';
  token: string;
  amount: number;
  reason: string;
}

// Thresholds for initial funding and ongoing rebalancing
const INITIAL_IDOS_BUY_PCT = 0.20;                // Buy 20% worth of IDOS
const INITIAL_ARB_USDT_PCT = 0.25;                // Send 25% as USDT to Arbitrum
const INITIAL_GAS_ETH = 0.003;                    // Send 0.003 ETH for gas
const REBALANCE_IDOS_THRESHOLD = 0.75;            // Rebalance if >75% IDOS on one side
const REBALANCE_IDOS_TARGET = 0.50;               // Target 50/50 split
const REBALANCE_STABLE_HIGH = 0.85;               // Rebalance if >85% stables on one side
const REBALANCE_STABLE_LOW = 0.15;                // Rebalance if <15% stables on one side
const MIN_GAS_ETH = 0.001;                        // Minimum ETH for gas
const REBALANCE_COOLDOWN_MS = 300_000;            // Don't rebalance more than every 5 min

export class Rebalancer {
  private kucoinTrader: KuCoinTrader;
  private uniswapTrader: UniswapTrader;
  private walletAddress: string;
  private lastRebalanceAt = 0;
  private rebalancing = false;
  private bootstrapDone = false;

  constructor(kucoinTrader: KuCoinTrader, uniswapTrader: UniswapTrader) {
    this.kucoinTrader = kucoinTrader;
    this.uniswapTrader = uniswapTrader;
    this.walletAddress = uniswapTrader.getWalletAddress();
  }

  /**
   * Initial bootstrap: detect if this is a fresh start with all funds on KuCoin,
   * and distribute funds across KuCoin + Arbitrum for trading.
   *
   * Starting state: ~3500 USDT on KuCoin, nothing on Arbitrum.
   * Target state:
   *   KuCoin:   ~55% USDT (for CEX buys) + some IDOS (for CEX sells)
   *   Arbitrum: USDC (for DEX buys) + IDOS (for DEX sells) + ETH (gas)
   */
  async bootstrap(balances: Balances): Promise<void> {
    if (this.bootstrapDone) return;

    const totalKucoinUsd = balances.kucoin.usdt;
    const totalArbUsd = balances.arbitrum.usdc + balances.arbitrum.weth * 2000; // rough

    // Only bootstrap if nearly all funds are on KuCoin and Arbitrum is mostly empty
    if (totalKucoinUsd < 100) {
      logger.info('Bootstrap: insufficient KuCoin USDT, skipping');
      this.bootstrapDone = true;
      return;
    }

    const totalUsd = totalKucoinUsd + totalArbUsd;
    if (totalArbUsd > totalUsd * 0.1) {
      logger.info('Bootstrap: Arbitrum already has funds, skipping');
      this.bootstrapDone = true;
      return;
    }

    logger.info('=== BOOTSTRAP: Initial fund distribution ===', {
      kucoinUsdt: totalKucoinUsd.toFixed(2),
      arbUsdc: balances.arbitrum.usdc.toFixed(2),
      arbEth: balances.arbitrum.eth.toFixed(6),
    });

    const usdtAvailable = balances.kucoin.usdt;

    // Step 1: Buy IDOS on KuCoin (for inventory on both sides)
    const idosBuyUsd = usdtAvailable * INITIAL_IDOS_BUY_PCT;
    if (idosBuyUsd > 10) {
      const kucoinPrice = await this.estimateKucoinIdosPrice();
      if (kucoinPrice > 0) {
        const amountIdos = idosBuyUsd / kucoinPrice;
        logger.info(`Bootstrap step 1: buying ~${amountIdos.toFixed(0)} IDOS (~$${idosBuyUsd.toFixed(2)})`);
        const result = await this.kucoinTrader.executeTrade('buy', amountIdos, kucoinPrice);
        if (result.success) {
          logger.info('Bootstrap: IDOS purchase complete', {
            bought: result.amountIdos,
            spent: result.totalUsd.toFixed(2),
          });
        } else {
          logger.error('Bootstrap: IDOS purchase failed', { error: result.error });
        }
      }
    }

    await sleep(2000);

    // Step 2: Withdraw USDT to Arbitrum (will be swapped to USDC on arrival)
    const usdtToArb = usdtAvailable * INITIAL_ARB_USDT_PCT;
    if (usdtToArb > 10) {
      logger.info(`Bootstrap step 2: withdrawing ~$${usdtToArb.toFixed(2)} USDT → Arbitrum`);
      await this.withdrawToArbitrum('USDT', usdtToArb);
    }

    // Step 3: Withdraw some IDOS to Arbitrum for DEX selling
    const refreshedBal = await this.kucoinTrader.getTotalBalances();
    const idosToArb = refreshedBal.idos * 0.5;
    if (idosToArb > 1) {
      logger.info(`Bootstrap step 3: withdrawing ${idosToArb.toFixed(0)} IDOS → Arbitrum`);
      await this.withdrawToArbitrum('IDOS', idosToArb);
    }

    // Step 4: Withdraw ETH for gas
    if (balances.arbitrum.eth < MIN_GAS_ETH) {
      logger.info('Bootstrap step 4: withdrawing ETH for gas → Arbitrum');
      await this.withdrawToArbitrum('ETH', INITIAL_GAS_ETH);
    }

    logger.info('=== BOOTSTRAP COMPLETE ===');
    logger.info('Withdrawals may take a few minutes to arrive on Arbitrum.');
    logger.info('USDT on Arbitrum will need to be swapped to USDC. The bot will handle this automatically.');

    this.bootstrapDone = true;
  }

  /**
   * Periodic rebalancing during trading. Executes transfers when
   * inventory drifts beyond thresholds.
   */
  async checkAndRebalance(balances: Balances): Promise<RebalanceSuggestion[]> {
    const suggestions: RebalanceSuggestion[] = [];

    if (Date.now() - this.lastRebalanceAt < REBALANCE_COOLDOWN_MS) return suggestions;
    if (this.rebalancing) return suggestions;

    // --- IDOS rebalancing ---
    const totalIdos = balances.kucoin.idos + balances.arbitrum.idos;
    if (totalIdos > 1) {
      const kucoinRatio = balances.kucoin.idos / totalIdos;

      if (kucoinRatio > REBALANCE_IDOS_THRESHOLD) {
        const moveAmount = (kucoinRatio - REBALANCE_IDOS_TARGET) * totalIdos;
        suggestions.push({
          action: 'withdraw_idos',
          from: 'kucoin',
          to: 'arbitrum',
          token: 'IDOS',
          amount: moveAmount,
          reason: `KuCoin has ${(kucoinRatio * 100).toFixed(1)}% of IDOS inventory`,
        });
      }

      const arbRatio = balances.arbitrum.idos / totalIdos;
      if (arbRatio > REBALANCE_IDOS_THRESHOLD) {
        const moveAmount = (arbRatio - REBALANCE_IDOS_TARGET) * totalIdos;
        suggestions.push({
          action: 'deposit_idos',
          from: 'arbitrum',
          to: 'kucoin',
          token: 'IDOS',
          amount: moveAmount,
          reason: `Arbitrum has ${(arbRatio * 100).toFixed(1)}% of IDOS inventory`,
        });
      }
    }

    // --- Stablecoin rebalancing ---
    const totalStable = balances.kucoin.usdt + balances.arbitrum.usdc;
    if (totalStable > 10) {
      const kucoinStableRatio = balances.kucoin.usdt / totalStable;

      if (kucoinStableRatio > REBALANCE_STABLE_HIGH) {
        const moveAmount = balances.kucoin.usdt * 0.25;
        suggestions.push({
          action: 'withdraw_usdt',
          from: 'kucoin',
          to: 'arbitrum',
          token: 'USDT',
          amount: moveAmount,
          reason: `KuCoin has ${(kucoinStableRatio * 100).toFixed(1)}% of stablecoins`,
        });
      }

      if (kucoinStableRatio < REBALANCE_STABLE_LOW) {
        const moveAmount = balances.arbitrum.usdc * 0.25;
        suggestions.push({
          action: 'deposit_usdc',
          from: 'arbitrum',
          to: 'kucoin',
          token: 'USDC',
          amount: moveAmount,
          reason: `KuCoin has only ${(kucoinStableRatio * 100).toFixed(1)}% of stablecoins`,
        });
      }
    }

    // --- Gas reserve ---
    if (balances.arbitrum.eth < MIN_GAS_ETH) {
      suggestions.push({
        action: 'withdraw_eth',
        from: 'kucoin',
        to: 'arbitrum',
        token: 'ETH',
        amount: INITIAL_GAS_ETH,
        reason: `Arbitrum ETH critically low: ${balances.arbitrum.eth.toFixed(6)} ETH`,
      });
    }

    // Execute rebalancing actions
    if (suggestions.length > 0) {
      this.rebalancing = true;
      try {
        for (const suggestion of suggestions) {
          logger.warn('Executing rebalance', suggestion);
          await this.executeRebalance(suggestion, balances);
        }
        this.lastRebalanceAt = Date.now();
      } finally {
        this.rebalancing = false;
      }
    }

    return suggestions;
  }

  private async executeRebalance(
    suggestion: RebalanceSuggestion,
    balances: Balances,
  ): Promise<void> {
    try {
      switch (suggestion.action) {
        case 'withdraw_idos':
          await this.withdrawToArbitrum('IDOS', suggestion.amount);
          break;

        case 'withdraw_usdt':
          await this.withdrawToArbitrum('USDT', suggestion.amount);
          break;

        case 'withdraw_eth':
          await this.withdrawToArbitrum('ETH', suggestion.amount);
          break;

        case 'deposit_idos':
          await this.depositToKucoin('IDOS', suggestion.amount);
          break;

        case 'deposit_usdc':
          await this.depositToKucoin('USDC', suggestion.amount);
          break;

        default:
          logger.warn('Unknown rebalance action', { action: suggestion.action });
      }
    } catch (err) {
      logger.error('Rebalance action failed', {
        action: suggestion.action,
        error: String(err),
      });
    }
  }

  /**
   * Withdraw from KuCoin to Arbitrum wallet.
   * Flow: trade account → main account → external withdrawal.
   */
  private async withdrawToArbitrum(currency: string, amount: number): Promise<boolean> {
    if (amount <= 0) return false;

    logger.info(`Withdrawing ${amount} ${currency} KuCoin → Arbitrum`);

    // Transfer from trade → main
    const transferOk = await this.kucoinTrader.innerTransfer(currency, amount, 'trade', 'main');
    if (!transferOk) {
      logger.error(`Failed to transfer ${currency} to main account for withdrawal`);
      return false;
    }

    await sleep(1000);

    // Withdraw from main → Arbitrum
    const withdrawalId = await this.kucoinTrader.withdraw(
      currency,
      amount,
      this.walletAddress,
      'ARBITRUM',
    );

    if (!withdrawalId) {
      logger.error(`Failed to withdraw ${currency} to Arbitrum`);
      // Move funds back to trade
      await this.kucoinTrader.innerTransfer(currency, amount, 'main', 'trade');
      return false;
    }

    logger.info(`Withdrawal submitted: ${amount} ${currency} → Arbitrum`, { withdrawalId });
    return true;
  }

  /**
   * Deposit from Arbitrum wallet to KuCoin.
   * Sends on-chain transfer to KuCoin deposit address, then moves to trade account.
   */
  private async depositToKucoin(currency: string, amount: number): Promise<boolean> {
    if (amount <= 0) return false;

    const depositAddress = await this.kucoinTrader.getDepositAddress(currency, 'ARBITRUM');
    if (!depositAddress) {
      logger.error(`Cannot get KuCoin deposit address for ${currency}`);
      return false;
    }

    try {
      const provider = new ethers.JsonRpcProvider(config.arbitrum.rpcUrl);
      const wallet = new ethers.Wallet(config.arbitrum.privateKey, provider);

      let tokenAddress: string;
      let decimals: number;

      if (currency === 'IDOS') {
        tokenAddress = config.tokens.IDOS;
        decimals = 18;
      } else if (currency === 'USDC') {
        tokenAddress = config.tokens.USDC;
        decimals = 6;
      } else {
        logger.warn(`Unsupported deposit currency: ${currency}`);
        return false;
      }

      logger.info(`Depositing ${amount} ${currency} Arbitrum → KuCoin`, { depositAddress });

      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
      const amountWei = ethers.parseUnits(amount.toFixed(decimals), decimals);

      const tx = await tokenContract.transfer(depositAddress, amountWei);
      const receipt = await tx.wait();

      logger.info(`Deposit tx confirmed: ${currency} → KuCoin`, { txHash: receipt.hash });

      // Wait for KuCoin to credit, then move to trade account
      logger.info('Waiting for KuCoin to credit deposit (30s)...');
      await sleep(30_000);

      await this.kucoinTrader.innerTransfer(currency, amount, 'main', 'trade');
      return true;
    } catch (err) {
      logger.error(`Deposit ${currency} → KuCoin failed`, { error: String(err) });
      return false;
    }
  }

  private async estimateKucoinIdosPrice(): Promise<number> {
    try {
      const { SpotClient } = await import('kucoin-api');
      const client = new SpotClient({
        apiKey: config.kucoin.apiKey,
        apiSecret: config.kucoin.apiSecret,
        apiPassphrase: config.kucoin.apiPassphrase,
      });
      const ticker = await client.getTicker({ symbol: config.kucoin.tradingPair });
      if (ticker.data) {
        return parseFloat(String(ticker.data.price));
      }
    } catch (err) {
      logger.error('Failed to estimate IDOS price', { error: String(err) });
    }
    return 0;
  }

  isRebalancing(): boolean {
    return this.rebalancing;
  }
}
