import { ArbPath, FeeTier, PoolToken } from '../types';
import { config } from '../config';

/**
 * Generate all possible arbitrage paths across all configured fee tiers.
 * Non-existent pools will be pruned by OpportunityDetector at startup
 * after Uniswap pool discovery completes — so it's safe to generate
 * paths for fee tiers that may not have pools deployed.
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
  const feeTiers = config.uniswap.feeTiers;

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
        sellFeeTier: fee as FeeTier,
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
        buyFeeTier: fee as FeeTier,
        buyQuoteToken: qt,
      });
    }
  }

  return paths;
}

function generateCrossDexPaths(): ArbPath[] {
  const paths: ArbPath[] = [];
  const feeTiers = config.uniswap.feeTiers;

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
        buyFeeTier: buyFee as FeeTier,
        sellFeeTier: sellFee as FeeTier,
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
        buyFeeTier: buyFee as FeeTier,
        sellFeeTier: sellFee as FeeTier,
        buyQuoteToken: 'WETH',
        sellQuoteToken: 'USDC',
      });
    }
  }

  return paths;
}

function generateTriangularPaths(): ArbPath[] {
  const paths: ArbPath[] = [];
  const feeTiers = config.uniswap.feeTiers;

  // 3rd leg (WETH↔USDC) also tries all fee tiers — the 500 (0.05%) pool
  // has deepest liquidity for major pairs, but we generate all and prune at runtime.
  const thirdLegFeeTiers = config.uniswap.feeTiers;

  for (const buyFee of feeTiers) {
    for (const sellFee of feeTiers) {
      for (const thirdFee of thirdLegFeeTiers) {
        // Triangular: USDC → IDOS → WETH → USDC
        paths.push({
          id: `tri__USDC_${buyFee}__WETH_${sellFee}__back_${thirdFee}`,
          pathType: 'triangular',
          buyVenue: 'uniswap_v3',
          sellVenue: 'uniswap_v3',
          buyPair: 'IDOS/USDC',
          sellPair: 'IDOS/WETH',
          buyFeeTier: buyFee as FeeTier,
          sellFeeTier: sellFee as FeeTier,
          buyQuoteToken: 'USDC',
          sellQuoteToken: 'WETH',
          thirdLegTokenIn: 'WETH',
          thirdLegTokenOut: 'USDC',
          thirdLegFeeTier: thirdFee as FeeTier,
        });

        // Triangular: WETH → IDOS → USDC → WETH
        paths.push({
          id: `tri__WETH_${buyFee}__USDC_${sellFee}__back_${thirdFee}`,
          pathType: 'triangular',
          buyVenue: 'uniswap_v3',
          sellVenue: 'uniswap_v3',
          buyPair: 'IDOS/WETH',
          sellPair: 'IDOS/USDC',
          buyFeeTier: buyFee as FeeTier,
          sellFeeTier: sellFee as FeeTier,
          buyQuoteToken: 'WETH',
          sellQuoteToken: 'USDC',
          thirdLegTokenIn: 'USDC',
          thirdLegTokenOut: 'WETH',
          thirdLegFeeTier: thirdFee as FeeTier,
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
