import { ethers } from 'ethers';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TradeResult, SwapResult, Direction, FeeTier, PoolToken } from '../types';
import { UNISWAP_V3_SWAP_ROUTER_ABI, ERC20_ABI } from '../utils/abis';

export class UniswapTrader {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private router: ethers.Contract;
  private approvedTokens = new Set<string>();

  constructor(provider: ethers.JsonRpcProvider) {
    this.provider = provider;
    this.wallet = new ethers.Wallet(config.arbitrum.privateKey, provider);
    this.router = new ethers.Contract(
      config.uniswap.swapRouter,
      UNISWAP_V3_SWAP_ROUTER_ABI,
      this.wallet,
    );
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
    const idosDecimals = 18; // Assume 18, updated in start

    try {
      if (direction === 'sell') {
        // Selling IDOS → receiving quote token
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
        // Buying IDOS → spending quote token
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

    // Ensure approval
    await this.ensureApproval(config.tokens.IDOS, amountIn);

    // Calculate minimum output with slippage protection
    const expectedOutput = amountIdos * expectedPriceUsd;
    const slippageFactor = 1 - (config.trading.maxSlippagePct / 100);
    const minAmountOut = ethers.parseUnits(
      (expectedOutput * slippageFactor).toFixed(quoteDecimals),
      quoteDecimals,
    );

    const deadline = Math.floor(Date.now() / 1000) + 60; // 60 second deadline

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
    const gasUsed = receipt.gasUsed;
    const gasPrice = receipt.gasPrice || 0n;
    const gasCostEth = parseFloat(ethers.formatEther(gasUsed * gasPrice));

    logger.info('Uniswap sell IDOS confirmed', {
      txHash: receipt.hash,
      gasUsed: gasUsed.toString(),
      gasCostEth,
      latencyMs: Date.now() - startTime,
    });

    return {
      success: true,
      venue: 'uniswap_v3',
      direction: 'sell',
      amountIdos,
      priceUsd: expectedPriceUsd,
      totalUsd: amountIdos * expectedPriceUsd,
      feeUsd: gasCostEth * expectedPriceUsd, // Approximate
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

    // Calculate max input with slippage
    const expectedInput = amountIdos * expectedPriceUsd;
    const slippageFactor = 1 + (config.trading.maxSlippagePct / 100);
    const maxAmountIn = ethers.parseUnits(
      (expectedInput * slippageFactor).toFixed(quoteDecimals),
      quoteDecimals,
    );

    // Ensure approval
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
    const gasUsed = receipt.gasUsed;
    const gasPrice = receipt.gasPrice || 0n;
    const gasCostEth = parseFloat(ethers.formatEther(gasUsed * gasPrice));

    logger.info('Uniswap buy IDOS confirmed', {
      txHash: receipt.hash,
      gasUsed: gasUsed.toString(),
      gasCostEth,
      latencyMs: Date.now() - startTime,
    });

    return {
      success: true,
      venue: 'uniswap_v3',
      direction: 'buy',
      amountIdos,
      priceUsd: expectedPriceUsd,
      totalUsd: amountIdos * expectedPriceUsd,
      feeUsd: gasCostEth * expectedPriceUsd,
      txHash: receipt.hash,
      timestamp: Date.now(),
    };
  }

  /**
   * Direct token-to-token swap (for triangular arb 3rd leg: e.g. WETH→USDC or USDC→WETH)
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

      // Estimate output: for WETH→USDC, output ≈ amountIn * ethPrice
      // For USDC→WETH, output ≈ amountIn / ethPrice
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
      const gasUsed = receipt.gasUsed;
      const gasPrice = receipt.gasPrice || 0n;
      const gasCostEth = parseFloat(ethers.formatEther(gasUsed * gasPrice));

      logger.info(`Swap ${tokenIn}→${tokenOut} confirmed`, {
        txHash: receipt.hash,
        gasUsed: gasUsed.toString(),
        gasCostEth,
        latencyMs: Date.now() - startTime,
      });

      return {
        success: true,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: expectedOutput, // Approximate; exact value from logs would be better
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

  private async ensureApproval(tokenAddress: string, amount: bigint): Promise<void> {
    const key = `${tokenAddress}_${config.uniswap.swapRouter}`;
    if (this.approvedTokens.has(key)) return;

    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);
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
