import { logger } from '../utils/logger';
import { Balances } from '../types';

export interface RebalanceSuggestion {
  action: string;
  from: 'kucoin' | 'arbitrum';
  to: 'kucoin' | 'arbitrum';
  token: string;
  amount: number;
  reason: string;
}

export class Rebalancer {
  private targetRatio = 0.5; // 50% of IDOS on each side

  checkRebalanceNeeded(balances: Balances): RebalanceSuggestion[] {
    const suggestions: RebalanceSuggestion[] = [];

    const totalIdos = balances.kucoin.idos + balances.arbitrum.idos;
    if (totalIdos <= 0) return suggestions;

    const kucoinRatio = balances.kucoin.idos / totalIdos;
    const arbRatio = balances.arbitrum.idos / totalIdos;

    // If one side has >70% of IDOS, suggest rebalancing
    if (kucoinRatio > 0.7) {
      const moveAmount = (kucoinRatio - this.targetRatio) * totalIdos;
      suggestions.push({
        action: 'Withdraw IDOS from KuCoin → Arbitrum wallet',
        from: 'kucoin',
        to: 'arbitrum',
        token: 'IDOS',
        amount: moveAmount,
        reason: `KuCoin has ${(kucoinRatio * 100).toFixed(1)}% of IDOS inventory`,
      });
    }

    if (arbRatio > 0.7) {
      const moveAmount = (arbRatio - this.targetRatio) * totalIdos;
      suggestions.push({
        action: 'Deposit IDOS to KuCoin from Arbitrum wallet',
        from: 'arbitrum',
        to: 'kucoin',
        token: 'IDOS',
        amount: moveAmount,
        reason: `Arbitrum has ${(arbRatio * 100).toFixed(1)}% of IDOS inventory`,
      });
    }

    // Check stablecoin balance
    const totalStable = balances.kucoin.usdt + balances.arbitrum.usdc;
    if (totalStable > 0) {
      const kucoinStableRatio = balances.kucoin.usdt / totalStable;
      if (kucoinStableRatio > 0.8) {
        suggestions.push({
          action: 'Transfer USDT/USDC to Arbitrum wallet',
          from: 'kucoin',
          to: 'arbitrum',
          token: 'USDT→USDC',
          amount: balances.kucoin.usdt * 0.3,
          reason: `KuCoin has ${(kucoinStableRatio * 100).toFixed(1)}% of stablecoin inventory`,
        });
      }
      if (kucoinStableRatio < 0.2) {
        suggestions.push({
          action: 'Transfer USDC to KuCoin',
          from: 'arbitrum',
          to: 'kucoin',
          token: 'USDC→USDT',
          amount: balances.arbitrum.usdc * 0.3,
          reason: `KuCoin has only ${(kucoinStableRatio * 100).toFixed(1)}% of stablecoin inventory`,
        });
      }
    }

    // Check gas balance
    if (balances.arbitrum.eth < 0.005) {
      suggestions.push({
        action: 'Top up Arbitrum ETH for gas',
        from: 'kucoin',
        to: 'arbitrum',
        token: 'ETH',
        amount: 0.01,
        reason: `Arbitrum ETH balance critically low: ${balances.arbitrum.eth.toFixed(6)} ETH`,
      });
    }

    if (suggestions.length > 0) {
      for (const s of suggestions) {
        logger.warn('Rebalance suggestion', s);
      }
    }

    return suggestions;
  }
}
