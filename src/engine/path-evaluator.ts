import { config } from '../config';
import { ArbPath, FeeTier, PoolToken } from '../types';

// Generate all possible arbitrage paths between KuCoin and Uniswap V3
export function generateArbPaths(): ArbPath[] {
  const paths: ArbPath[] = [];
  const quoteTokens: PoolToken[] = ['USDC', 'WETH'];
  const feeTiers: FeeTier[] = [3000, 10000];

  for (const qt of quoteTokens) {
    for (const fee of feeTiers) {
      // Path: Buy on KuCoin, Sell on Uniswap
      paths.push({
        id: `kucoin_buy__uniswap_sell_${qt}_${fee}`,
        buyVenue: 'kucoin',
        sellVenue: 'uniswap_v3',
        buyPair: 'IDOS/USDT',
        sellPair: `IDOS/${qt}`,
        sellFeeTier: fee,
        sellQuoteToken: qt,
      });

      // Path: Buy on Uniswap, Sell on KuCoin
      paths.push({
        id: `uniswap_buy_${qt}_${fee}__kucoin_sell`,
        buyVenue: 'uniswap_v3',
        sellVenue: 'kucoin',
        buyPair: `IDOS/${qt}`,
        sellPair: 'IDOS/USDT',
        buyFeeTier: fee,
        buyQuoteToken: qt,
      });
    }
  }

  return paths;
}

export function getPathDescription(path: ArbPath): string {
  const buyDesc = path.buyVenue === 'kucoin'
    ? 'KuCoin(IDOS/USDT)'
    : `UniV3(IDOS/${path.buyQuoteToken} ${(path.buyFeeTier || 0) / 10000}%)`;
  const sellDesc = path.sellVenue === 'kucoin'
    ? 'KuCoin(IDOS/USDT)'
    : `UniV3(IDOS/${path.sellQuoteToken} ${(path.sellFeeTier || 0) / 10000}%)`;
  return `Buy ${buyDesc} → Sell ${sellDesc}`;
}
