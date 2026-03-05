import { ethers } from 'ethers';
import { config } from '../config';
import { logger } from '../utils/logger';
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

    // KuCoin trading fee (applies to the KuCoin leg)
    const kucoinFeeUsd = tradeValueUsd * config.kucoin.tradingFeeRate;

    // Uniswap pool fee (already factored into the quote, but we track it for reporting)
    const uniswapFeeTier = path.buyFeeTier || path.sellFeeTier || 3000;
    const uniswapFeeRate = uniswapFeeTier / 1_000_000; // 3000 = 0.3%, 10000 = 1%
    const uniswapPoolFeeUsd = tradeValueUsd * uniswapFeeRate;

    // Gas cost estimate for Arbitrum
    const gasEstimateUsd = this.estimateGasCostUsd();

    // Slippage estimate (simple model: 0.1% for small trades, scales with size)
    const slippageEstimateUsd = this.estimateSlippage(tradeSizeIdos, tradeValueUsd);

    const totalFeesUsd = kucoinFeeUsd + gasEstimateUsd + slippageEstimateUsd;
    // Note: uniswapPoolFeeUsd is NOT added to total because it's already included in the quoted price

    return {
      kucoinFeeUsd,
      uniswapPoolFeeUsd,
      gasEstimateUsd,
      slippageEstimateUsd,
      totalFeesUsd,
    };
  }

  private estimateGasCostUsd(): number {
    if (this.currentGasPriceWei === 0n || this.ethPriceUsd === 0) {
      // Fallback: assume $0.05 gas on Arbitrum
      return 0.05;
    }

    const gasCostWei = ESTIMATED_SWAP_GAS * this.currentGasPriceWei;
    const gasCostEth = parseFloat(ethers.formatEther(gasCostWei));
    return gasCostEth * this.ethPriceUsd;
  }

  private estimateSlippage(tradeSizeIdos: number, tradeValueUsd: number): number {
    // Simple linear slippage model:
    // Base slippage of 0.05% + 0.01% per $100 of trade value
    const baseSlippagePct = 0.05;
    const sizeSlippagePct = (tradeValueUsd / 100) * 0.01;
    const totalSlippagePct = Math.min(baseSlippagePct + sizeSlippagePct, config.trading.maxSlippagePct);
    return tradeValueUsd * (totalSlippagePct / 100);
  }

  getMinimumSpreadRequired(feeTier: FeeTier): number {
    // Returns minimum spread % needed to break even
    // KuCoin fee (both legs for CEX-DEX would be one KuCoin leg)
    const kucoinFee = config.kucoin.tradingFeeRate * 100; // 0.1%
    const gasFeeApprox = 0.05; // approximate % for gas
    const slippageApprox = 0.05; // approximate %
    // Uniswap fee is already in the quoted price, no need to add here
    return kucoinFee + gasFeeApprox + slippageApprox;
  }
}
