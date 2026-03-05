import { ethers } from 'ethers';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TradeResult, SwapResult, Direction, FeeTier, PoolToken } from '../types';
import { UNISWAP_V3_SWAP_ROUTER_ABI, UNISWAP_V3_POOL_ABI, ERC20_ABI } from '../utils/abis';

// Interface for Swap event decoding
const poolIface = new ethers.Interface(UNISWAP_V3_POOL_ABI);

export class UniswapTrader {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private signer: ethers.Signer;
  private router: ethers.Contract;
  private approvedTokens = new Set<string>();
  private nonceMutex = Promise.resolve(); // Sequential nonce guard
  private ethPriceUsd: number = 0;

  constructor(provider: ethers.JsonRpcProvider) {
    this.provider = provider;

    // Use private/MEV-protected RPC for sending transactions if configured
    let txProvider: ethers.JsonRpcProvider;
    if (config.mev.usePrivateRpc && config.mev.privateRpcUrl) {
      logger.info('Using private RPC for transaction submission (MEV protection)');
      txProvider = new ethers.JsonRpcProvider(config.mev.privateRpcUrl);
    } else {
      txProvider = provider;
    }

    this.wallet = new ethers.Wallet(config.arbitrum.privateKey, txProvider);
    // Wrap wallet with NonceManager to handle concurrent sends
    this.signer = new ethers.NonceManager(this.wallet);
    this.router = new ethers.Contract(
      config.uniswap.swapRouter,
      UNISWAP_V3_SWAP_ROUTER_ABI,
      this.signer,
    );
  }

  updateEthPrice(ethPriceUsd: number): void {
    this.ethPriceUsd = ethPriceUsd;
  }

  private getGasFeeUsd(gasCostEth: number): number {
    // Use tracked ETH price, not IDOS price
    return gasCostEth * this.ethPriceUsd;
  }

  async executeTrade(
    direction: Direction,
    amountIdos: number,
    expectedPriceUsd: number,
    quoteToken: PoolToken,
    feeTier: FeeTier,
  ): Promise<TradeResult> {
    const startTime = Date.now();
    const quoteTokenAddress = quoteToken === 'USDC' ? config.tokens.USDC : config.tokens.WETH;
    const quoteDecimals = quoteToken === 'USDC' ? 6 : 18;
    const idosDecimals = 18;

    try {
      if (direction === 'sell') {
        return await this.sellIdos(
          amountIdos,
          expectedPriceUsd,
          quoteTokenAddress,
          quoteDecimals,
          idosDecimals,
          feeTier,
          startTime,
        );
      } else {
        return await this.buyIdos(
          amountIdos,
          expectedPriceUsd,
          quoteTokenAddress,
          quoteDecimals,
          idosDecimals,
          feeTier,
          startTime,
        );
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Uniswap ${direction} failed`, {
        error: errorMsg,
        amount: amountIdos,
        quoteToken,
        feeTier,
        latencyMs: Date.now() - startTime,
      });

      return {
        success: false,
        venue: 'uniswap_v3',
        direction,
        amountIdos,
        priceUsd: expectedPriceUsd,
        totalUsd: amountIdos * expectedPriceUsd,
        feeUsd: 0,
        error: errorMsg,
        timestamp: Date.now(),
      };
    }
  }

  private async sellIdos(
    amountIdos: number,
    expectedPriceUsd: number,
    quoteTokenAddress: string,
    quoteDecimals: number,
    idosDecimals: number,
    feeTier: FeeTier,
    startTime: number,
  ): Promise<TradeResult> {
    const amountIn = ethers.parseUnits(amountIdos.toFixed(idosDecimals), idosDecimals);

    await this.ensureApproval(config.tokens.IDOS, amountIn);

    const expectedOutput = amountIdos * expectedPriceUsd;
    const slippageFactor = 1 - (config.trading.maxSlippagePct / 100);
    const minAmountOut = ethers.parseUnits(
      (expectedOutput * slippageFactor).toFixed(quoteDecimals),
      quoteDecimals,
    );

    const deadline = Math.floor(Date.now() / 1000) + 60;

    logger.info('Uniswap sell IDOS', {
      amountIn: amountIdos,
      minAmountOut: ethers.formatUnits(minAmountOut, quoteDecimals),
      feeTier,
      deadline,
    });

    const tx = await this.router.exactInputSingle({
      tokenIn: config.tokens.IDOS,
      tokenOut: quoteTokenAddress,
      fee: feeTier,
      recipient: this.wallet.address,
      deadline,
      amountIn,
      amountOutMinimum: minAmountOut,
      sqrtPriceLimitX96: 0,
    });

    const receipt = await tx.wait();
    const gasCostEth = this.extractGasCostEth(receipt);
    const actualAmountOut = this.decodeSwapOutput(receipt, quoteTokenAddress, quoteDecimals);

    logger.info('Uniswap sell IDOS confirmed', {
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
      gasCostEth,
      actualAmountOut,
      latencyMs: Date.now() - startTime,
    });

    // Use actual output if decoded, otherwise fall back to estimate
    const totalUsd = actualAmountOut > 0 ? actualAmountOut : amountIdos * expectedPriceUsd;
    const effectivePrice = totalUsd / amountIdos;

    return {
      success: true,
      venue: 'uniswap_v3',
      direction: 'sell',
      amountIdos,
      priceUsd: effectivePrice,
      totalUsd,
      feeUsd: this.getGasFeeUsd(gasCostEth),
      txHash: receipt.hash,
      timestamp: Date.now(),
    };
  }

  private async buyIdos(
    amountIdos: number,
    expectedPriceUsd: number,
    quoteTokenAddress: string,
    quoteDecimals: number,
    idosDecimals: number,
    feeTier: FeeTier,
    startTime: number,
  ): Promise<TradeResult> {
    const amountOut = ethers.parseUnits(amountIdos.toFixed(idosDecimals), idosDecimals);

    const expectedInput = amountIdos * expectedPriceUsd;
    const slippageFactor = 1 + (config.trading.maxSlippagePct / 100);
    const maxAmountIn = ethers.parseUnits(
      (expectedInput * slippageFactor).toFixed(quoteDecimals),
      quoteDecimals,
    );

    await this.ensureApproval(quoteTokenAddress, maxAmountIn);

    const deadline = Math.floor(Date.now() / 1000) + 60;

    logger.info('Uniswap buy IDOS', {
      amountOut: amountIdos,
      maxAmountIn: ethers.formatUnits(maxAmountIn, quoteDecimals),
      feeTier,
      deadline,
    });

    const tx = await this.router.exactOutputSingle({
      tokenIn: quoteTokenAddress,
      tokenOut: config.tokens.IDOS,
      fee: feeTier,
      recipient: this.wallet.address,
      deadline,
      amountOut,
      amountInMaximum: maxAmountIn,
      sqrtPriceLimitX96: 0,
    });

    const receipt = await tx.wait();
    const gasCostEth = this.extractGasCostEth(receipt);
    // For buy (exactOutput), decode how much quote token was actually spent
    const actualAmountSpent = this.decodeSwapInput(receipt, quoteTokenAddress, quoteDecimals);

    logger.info('Uniswap buy IDOS confirmed', {
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
      gasCostEth,
      actualAmountSpent,
      latencyMs: Date.now() - startTime,
    });

    const totalUsd = actualAmountSpent > 0 ? actualAmountSpent : amountIdos * expectedPriceUsd;
    const effectivePrice = totalUsd / amountIdos;

    return {
      success: true,
      venue: 'uniswap_v3',
      direction: 'buy',
      amountIdos,
      priceUsd: effectivePrice,
      totalUsd,
      feeUsd: this.getGasFeeUsd(gasCostEth),
      txHash: receipt.hash,
      timestamp: Date.now(),
    };
  }

  /**
   * Direct token-to-token swap (for triangular arb 3rd leg: e.g. WETH→USDC or USDC→WETH).
   * Returns actual output amount decoded from Swap event logs.
   */
  async swapTokens(
    tokenIn: PoolToken,
    tokenOut: PoolToken,
    amountIn: number,
    feeTier: FeeTier,
    ethPriceUsd: number,
  ): Promise<SwapResult> {
    const startTime = Date.now();
    const tokenInAddress = tokenIn === 'USDC' ? config.tokens.USDC : config.tokens.WETH;
    const tokenOutAddress = tokenOut === 'USDC' ? config.tokens.USDC : config.tokens.WETH;
    const tokenInDecimals = tokenIn === 'USDC' ? 6 : 18;
    const tokenOutDecimals = tokenOut === 'USDC' ? 6 : 18;

    try {
      const amountInWei = ethers.parseUnits(amountIn.toFixed(tokenInDecimals), tokenInDecimals);

      await this.ensureApproval(tokenInAddress, amountInWei);

      // Estimate output for slippage protection
      const expectedOutput = tokenIn === 'WETH'
        ? amountIn * ethPriceUsd
        : amountIn / ethPriceUsd;

      const slippageFactor = 1 - (config.trading.maxSlippagePct / 100);
      const minAmountOut = ethers.parseUnits(
        (expectedOutput * slippageFactor).toFixed(tokenOutDecimals),
        tokenOutDecimals,
      );

      const deadline = Math.floor(Date.now() / 1000) + 60;

      logger.info(`Swap ${tokenIn}→${tokenOut}`, {
        amountIn,
        expectedOutput,
        minAmountOut: ethers.formatUnits(minAmountOut, tokenOutDecimals),
        feeTier,
      });

      const tx = await this.router.exactInputSingle({
        tokenIn: tokenInAddress,
        tokenOut: tokenOutAddress,
        fee: feeTier,
        recipient: this.wallet.address,
        deadline,
        amountIn: amountInWei,
        amountOutMinimum: minAmountOut,
        sqrtPriceLimitX96: 0,
      });

      const receipt = await tx.wait();
      const gasCostEth = this.extractGasCostEth(receipt);
      const actualAmountOut = this.decodeSwapOutput(receipt, tokenOutAddress, tokenOutDecimals);

      logger.info(`Swap ${tokenIn}→${tokenOut} confirmed`, {
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
        gasCostEth,
        actualAmountOut,
        latencyMs: Date.now() - startTime,
      });

      return {
        success: true,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: actualAmountOut > 0 ? actualAmountOut : expectedOutput,
        txHash: receipt.hash,
        feeUsd: gasCostEth * ethPriceUsd,
        timestamp: Date.now(),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Swap ${tokenIn}→${tokenOut} failed`, {
        error: errorMsg,
        amountIn,
        latencyMs: Date.now() - startTime,
      });

      return {
        success: false,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: 0,
        feeUsd: 0,
        error: errorMsg,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Extract gas cost in ETH from a transaction receipt.
   */
  private extractGasCostEth(receipt: ethers.TransactionReceipt): number {
    const gasUsed = receipt.gasUsed;
    const gasPrice = receipt.gasPrice || 0n;
    return parseFloat(ethers.formatEther(gasUsed * gasPrice));
  }

  /**
   * Decode the actual output amount from Uniswap V3 Swap event logs.
   * The Swap event emits amount0 and amount1 — one is negative (token out), one is positive (token in).
   * We find the output token and return its absolute value.
   */
  private decodeSwapOutput(
    receipt: ethers.TransactionReceipt,
    outputTokenAddress: string,
    outputDecimals: number,
  ): number {
    try {
      for (const log of receipt.logs) {
        try {
          const parsed = poolIface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed && parsed.name === 'Swap') {
            const amount0 = parsed.args.amount0 as bigint;
            const amount1 = parsed.args.amount1 as bigint;

            // In Uniswap V3 Swap events: negative = token leaving pool (= received by user)
            // We need to figure out which token is token0/token1 in this pool
            // The simpler approach: return the absolute value of the negative amount
            // using the output token's decimals
            const negativeAmount = amount0 < 0n ? amount0 : amount1;
            const absAmount = negativeAmount < 0n ? -negativeAmount : negativeAmount;
            return parseFloat(ethers.formatUnits(absAmount, outputDecimals));
          }
        } catch {
          // Not a Swap event from this interface, skip
        }
      }
    } catch (err) {
      logger.debug('Could not decode Swap event', { error: String(err) });
    }
    return 0; // Fallback: caller uses estimate
  }

  /**
   * Decode the actual input amount spent from Swap event (for exactOutput swaps).
   */
  private decodeSwapInput(
    receipt: ethers.TransactionReceipt,
    inputTokenAddress: string,
    inputDecimals: number,
  ): number {
    try {
      for (const log of receipt.logs) {
        try {
          const parsed = poolIface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed && parsed.name === 'Swap') {
            const amount0 = parsed.args.amount0 as bigint;
            const amount1 = parsed.args.amount1 as bigint;

            // Positive amount = token going into the pool (= spent by user)
            const positiveAmount = amount0 > 0n ? amount0 : amount1;
            return parseFloat(ethers.formatUnits(positiveAmount, inputDecimals));
          }
        } catch {
          // Skip non-Swap logs
        }
      }
    } catch (err) {
      logger.debug('Could not decode Swap input', { error: String(err) });
    }
    return 0;
  }

  private async ensureApproval(tokenAddress: string, amount: bigint): Promise<void> {
    const key = `${tokenAddress.toLowerCase()}_${config.uniswap.swapRouter.toLowerCase()}`;
    if (this.approvedTokens.has(key)) return;

    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.signer);
    const currentAllowance = await token.allowance(
      this.wallet.address,
      config.uniswap.swapRouter,
    );

    if (currentAllowance < amount) {
      logger.info('Approving token for Uniswap Router', {
        token: tokenAddress,
        amount: ethers.MaxUint256.toString(),
      });
      const tx = await token.approve(config.uniswap.swapRouter, ethers.MaxUint256);
      await tx.wait();
      logger.info('Token approved', { token: tokenAddress });
    }

    this.approvedTokens.add(key);
  }

  async getBalances(): Promise<{ idos: number; usdc: number; weth: number; eth: number }> {
    try {
      const idosContract = new ethers.Contract(config.tokens.IDOS, ERC20_ABI, this.provider);
      const usdcContract = new ethers.Contract(config.tokens.USDC, ERC20_ABI, this.provider);
      const wethContract = new ethers.Contract(config.tokens.WETH, ERC20_ABI, this.provider);

      const [idosBal, usdcBal, wethBal, ethBal] = await Promise.all([
        idosContract.balanceOf(this.wallet.address),
        usdcContract.balanceOf(this.wallet.address),
        wethContract.balanceOf(this.wallet.address),
        this.provider.getBalance(this.wallet.address),
      ]);

      return {
        idos: parseFloat(ethers.formatUnits(idosBal, 18)),
        usdc: parseFloat(ethers.formatUnits(usdcBal, 6)),
        weth: parseFloat(ethers.formatEther(wethBal)),
        eth: parseFloat(ethers.formatEther(ethBal)),
      };
    } catch (err) {
      logger.error('Error fetching Arbitrum balances', { error: String(err) });
      return { idos: 0, usdc: 0, weth: 0, eth: 0 };
    }
  }

  getWalletAddress(): string {
    return this.wallet.address;
  }
}
