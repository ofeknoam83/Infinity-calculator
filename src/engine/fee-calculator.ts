import { ethers } from 'ethers';
import { config } from '../config';
import { FeeBreakdown, ArbPath, FeeTier } from '../types';

// Estimated gas for a Uniswap V3 exactInputSingle swap on Arbitrum
const ESTIMATED_SWAP_GAS = 250_000n;

export class FeeCalculator {
  private currentGasPriceWei: bigint = 0n;
  private ethPriceUsd: number = 0;

  updateGasPrice(gasPriceWei: bigint): void {
    this.currentGasPriceWei = gasPriceWei;
  }

  updateEthPrice(ethPriceUsd: number): void {
    this.ethPriceUsd = ethPriceUsd;
  }

  calculateFees(
    path: ArbPath,
    tradeSizeIdos: number,
    buyPriceUsd: number,
    sellPriceUsd: number,
  ): FeeBreakdown {
    const tradeValueUsd = tradeSizeIdos * ((buyPriceUsd + sellPriceUsd) / 2);

    // KuCoin trading fee — only applies if a leg is on KuCoin
    const hasKucoinLeg = path.buyVenue === 'kucoin' || path.sellVenue === 'kucoin';
    const kucoinFeeUsd = hasKucoinLeg ? tradeValueUsd * config.kucoin.tradingFeeRate : 0;

    // Uniswap pool fee (already factored into quoted prices, tracked for reporting)
    const buyFeeTier = path.buyFeeTier || 0;
    const sellFeeTier = path.sellFeeTier || 0;
    const buyFeeRate = buyFeeTier / 1_000_000;
    const sellFeeRate = sellFeeTier / 1_000_000;
    const uniswapPoolFeeUsd = tradeValueUsd * (buyFeeRate + sellFeeRate);

    // Gas cost: count on-chain swap transactions
    let numOnChainSwaps = 0;
    if (path.buyVenue === 'uniswap_v3') numOnChainSwaps++;
    if (path.sellVenue === 'uniswap_v3') numOnChainSwaps++;
    if (path.pathType === 'triangular') numOnChainSwaps++; // 3rd leg swap

    const gasEstimateUsd = this.estimateGasCostUsd(numOnChainSwaps);

    // Slippage estimate — compounds per on-chain swap leg
    const slippageEstimateUsd = this.estimateSlippage(tradeSizeIdos, tradeValueUsd, numOnChainSwaps);

    // 3rd leg fee (triangular only — WETH/USDC swap fee)
    let thirdLegFeeUsd = 0;
    if (path.pathType === 'triangular' && path.thirdLegFeeTier) {
      const thirdFeeRate = path.thirdLegFeeTier / 1_000_000;
      thirdLegFeeUsd = tradeValueUsd * thirdFeeRate;
    }

    // Total: KuCoin fee + gas + slippage + 3rd leg fee
    // Note: Uniswap pool fees are already in the quoted prices, NOT added to total
    const totalFeesUsd = kucoinFeeUsd + gasEstimateUsd + slippageEstimateUsd + thirdLegFeeUsd;

    return {
      kucoinFeeUsd,
      uniswapPoolFeeUsd,
      gasEstimateUsd,
      slippageEstimateUsd,
      totalFeesUsd,
      thirdLegFeeUsd: thirdLegFeeUsd > 0 ? thirdLegFeeUsd : undefined,
    };
  }

  private estimateGasCostUsd(numSwaps: number = 1): number {
    if (this.currentGasPriceWei === 0n || this.ethPriceUsd === 0) {
      return 0.05 * numSwaps; // Fallback: ~$0.05 per swap on Arbitrum
    }

    const totalGas = ESTIMATED_SWAP_GAS * BigInt(numSwaps);
    const gasCostWei = totalGas * this.currentGasPriceWei;
    const gasCostEth = parseFloat(ethers.formatEther(gasCostWei));
    return gasCostEth * this.ethPriceUsd;
  }

  /**
   * Slippage compounds per on-chain swap: each swap moves the pool's price,
   * and for cross-DEX / triangular, multiple swaps compound the impact.
   */
  private estimateSlippage(
    tradeSizeIdos: number,
    tradeValueUsd: number,
    numOnChainSwaps: number,
  ): number {
    const baseSlippagePct = 0.05;
    const sizeSlippagePct = (tradeValueUsd / 100) * 0.01;
    const perSwapSlippagePct = Math.min(baseSlippagePct + sizeSlippagePct, config.trading.maxSlippagePct);
    // Compound: total slippage = 1 - (1 - s)^n ≈ n*s for small s
    const totalSlippagePct = (1 - Math.pow(1 - perSwapSlippagePct / 100, numOnChainSwaps)) * 100;
    return tradeValueUsd * (totalSlippagePct / 100);
  }

  getMinimumSpreadRequired(feeTier: FeeTier): number {
    const kucoinFee = config.kucoin.tradingFeeRate * 100; // 0.1%
    const gasFeeApprox = 0.05;
    const slippageApprox = 0.05;
    return kucoinFee + gasFeeApprox + slippageApprox;
  }
}
