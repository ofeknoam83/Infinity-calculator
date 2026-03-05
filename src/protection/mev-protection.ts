import { ethers } from 'ethers';
import { config } from '../config';
import { logger } from '../utils/logger';

export class MevProtection {
  private provider: ethers.JsonRpcProvider;
  private privateProvider: ethers.JsonRpcProvider | null = null;

  constructor(provider: ethers.JsonRpcProvider) {
    this.provider = provider;

    if (config.mev.usePrivateRpc && config.mev.privateRpcUrl) {
      this.privateProvider = new ethers.JsonRpcProvider(config.mev.privateRpcUrl);
      logger.info('MEV protection: using private RPC', { url: config.mev.privateRpcUrl });
    } else {
      logger.info('MEV protection: using standard Arbitrum sequencer (inherent MEV resistance)');
    }
  }

  getProvider(): ethers.JsonRpcProvider {
    return this.privateProvider || this.provider;
  }

  calculateDeadline(bufferSeconds: number = 60): number {
    return Math.floor(Date.now() / 1000) + bufferSeconds;
  }

  calculateMinOutput(expectedOutput: bigint, maxSlippagePct: number): bigint {
    // Apply slippage tolerance: minOutput = expected * (1 - slippage)
    const slippageBps = BigInt(Math.floor(maxSlippagePct * 100)); // Convert % to bps
    const bpsBase = 10000n;
    return (expectedOutput * (bpsBase - slippageBps)) / bpsBase;
  }

  calculateMaxInput(expectedInput: bigint, maxSlippagePct: number): bigint {
    // Apply slippage tolerance: maxInput = expected * (1 + slippage)
    const slippageBps = BigInt(Math.floor(maxSlippagePct * 100));
    const bpsBase = 10000n;
    return (expectedInput * (bpsBase + slippageBps)) / bpsBase;
  }

  async isPriceFresh(
    currentPrice: number,
    quotedPrice: number,
    maxDeviationPct: number = 0.5,
  ): Promise<boolean> {
    const deviation = Math.abs((currentPrice - quotedPrice) / quotedPrice) * 100;
    if (deviation > maxDeviationPct) {
      logger.warn('Price staleness detected — aborting trade', {
        currentPrice,
        quotedPrice,
        deviation: `${deviation.toFixed(3)}%`,
        maxAllowed: `${maxDeviationPct}%`,
      });
      return false;
    }
    return true;
  }
}
