import { ArbPath, FeeTier, PoolToken } from '../types';

/**
 * Generate all possible arbitrage paths:
 * 1. CEX-DEX: KuCoin ↔ Uniswap V3 (8 paths)
 * 2. Cross-DEX: Uniswap USDC pool ↔ Uniswap WETH pool (8 paths)
 * 3. Triangular: USDC→IDOS→WETH→USDC and WETH→IDOS→USDC→WETH (8 paths)
 */
export function generateArbPaths(): ArbPath[] {
  return [
    ...generateCexDexPaths(),
    ...generateCrossDexPaths(),
    ...generateTriangularPaths(),
  ];
}

function generateCexDexPaths(): ArbPath[] {
  const paths: ArbPath[] = [];
  const quoteTokens: PoolToken[] = ['USDC', 'WETH'];
  const feeTiers: FeeTier[] = [3000, 10000];

  for (const qt of quoteTokens) {
    for (const fee of feeTiers) {
      // Buy on KuCoin, Sell on Uniswap
      paths.push({
        id: `cex_dex__kucoin_buy__uni_sell_${qt}_${fee}`,
        pathType: 'cex_dex',
        buyVenue: 'kucoin',
        sellVenue: 'uniswap_v3',
        buyPair: 'IDOS/USDT',
        sellPair: `IDOS/${qt}`,
        sellFeeTier: fee,
        sellQuoteToken: qt,
      });

      // Buy on Uniswap, Sell on KuCoin
      paths.push({
        id: `cex_dex__uni_buy_${qt}_${fee}__kucoin_sell`,
        pathType: 'cex_dex',
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

function generateCrossDexPaths(): ArbPath[] {
  const paths: ArbPath[] = [];
  const feeTiers: FeeTier[] = [3000, 10000];

  for (const buyFee of feeTiers) {
    for (const sellFee of feeTiers) {
      // Buy IDOS/USDC → Sell IDOS/WETH
      paths.push({
        id: `cross_dex__buy_USDC_${buyFee}__sell_WETH_${sellFee}`,
        pathType: 'cross_dex',
        buyVenue: 'uniswap_v3',
        sellVenue: 'uniswap_v3',
        buyPair: 'IDOS/USDC',
        sellPair: 'IDOS/WETH',
        buyFeeTier: buyFee,
        sellFeeTier: sellFee,
        buyQuoteToken: 'USDC',
        sellQuoteToken: 'WETH',
      });

      // Buy IDOS/WETH → Sell IDOS/USDC
      paths.push({
        id: `cross_dex__buy_WETH_${buyFee}__sell_USDC_${sellFee}`,
        pathType: 'cross_dex',
        buyVenue: 'uniswap_v3',
        sellVenue: 'uniswap_v3',
        buyPair: 'IDOS/WETH',
        sellPair: 'IDOS/USDC',
        buyFeeTier: buyFee,
        sellFeeTier: sellFee,
        buyQuoteToken: 'WETH',
        sellQuoteToken: 'USDC',
      });
    }
  }

  return paths;
}

function generateTriangularPaths(): ArbPath[] {
  const paths: ArbPath[] = [];
  const feeTiers: FeeTier[] = [3000, 10000];

  // WETH/USDC pool fee tier for the 3rd leg (0.05% = 500 is standard, but we use 3000 as fallback)
  // On Arbitrum the main WETH/USDC pools are 500 (0.05%) and 3000 (0.3%)
  const thirdLegFeeTiers: FeeTier[] = [3000];

  for (const buyFee of feeTiers) {
    for (const sellFee of feeTiers) {
      for (const thirdFee of thirdLegFeeTiers) {
        // Triangular: USDC → IDOS (buy on USDC pool) → WETH (sell on WETH pool) → USDC (swap WETH→USDC)
        paths.push({
          id: `tri__USDC_${buyFee}__WETH_${sellFee}__back_${thirdFee}`,
          pathType: 'triangular',
          buyVenue: 'uniswap_v3',
          sellVenue: 'uniswap_v3',
          buyPair: 'IDOS/USDC',
          sellPair: 'IDOS/WETH',
          buyFeeTier: buyFee,
          sellFeeTier: sellFee,
          buyQuoteToken: 'USDC',
          sellQuoteToken: 'WETH',
          thirdLegTokenIn: 'WETH',
          thirdLegTokenOut: 'USDC',
          thirdLegFeeTier: thirdFee,
        });

        // Triangular: WETH → IDOS (buy on WETH pool) → USDC (sell on USDC pool) → WETH (swap USDC→WETH)
        paths.push({
          id: `tri__WETH_${buyFee}__USDC_${sellFee}__back_${thirdFee}`,
          pathType: 'triangular',
          buyVenue: 'uniswap_v3',
          sellVenue: 'uniswap_v3',
          buyPair: 'IDOS/WETH',
          sellPair: 'IDOS/USDC',
          buyFeeTier: buyFee,
          sellFeeTier: sellFee,
          buyQuoteToken: 'WETH',
          sellQuoteToken: 'USDC',
          thirdLegTokenIn: 'USDC',
          thirdLegTokenOut: 'WETH',
          thirdLegFeeTier: thirdFee,
        });
      }
    }
  }

  return paths;
}

export function getPathDescription(path: ArbPath): string {
  const feeStr = (fee: number | undefined) => fee ? `${fee / 10000}%` : '';

  if (path.pathType === 'cex_dex') {
    const buyDesc = path.buyVenue === 'kucoin'
      ? 'KuCoin(IDOS/USDT)'
      : `UniV3(IDOS/${path.buyQuoteToken} ${feeStr(path.buyFeeTier)})`;
    const sellDesc = path.sellVenue === 'kucoin'
      ? 'KuCoin(IDOS/USDT)'
      : `UniV3(IDOS/${path.sellQuoteToken} ${feeStr(path.sellFeeTier)})`;
    return `Buy ${buyDesc} → Sell ${sellDesc}`;
  }

  if (path.pathType === 'cross_dex') {
    return `Buy UniV3(IDOS/${path.buyQuoteToken} ${feeStr(path.buyFeeTier)}) → Sell UniV3(IDOS/${path.sellQuoteToken} ${feeStr(path.sellFeeTier)})`;
  }

  // Triangular
  return `△ ${path.buyQuoteToken}→IDOS(${feeStr(path.buyFeeTier)})→${path.sellQuoteToken}(${feeStr(path.sellFeeTier)})→${path.buyQuoteToken}(${feeStr(path.thirdLegFeeTier)})`;
}
