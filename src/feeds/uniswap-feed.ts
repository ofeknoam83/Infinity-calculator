import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../utils/logger';
import { PriceQuote, PoolToken, FeeTier } from '../types';
import {
  UNISWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POOL_ABI,
  UNISWAP_V3_QUOTER_V2_ABI,
  ERC20_ABI,
} from '../utils/abis';

interface PoolInfo {
  address: string;
  token0: string;
  token1: string;
  fee: FeeTier;
  quoteToken: PoolToken;
  idosIsToken0: boolean;
  quoteDecimals: number;
  idosDecimals: number;
}

export class UniswapFeed extends EventEmitter {
  private provider: ethers.JsonRpcProvider;
  private factory: ethers.Contract;
  private quoter: ethers.Contract;
  private pools: PoolInfo[] = [];
  private latestQuotes = new Map<string, PriceQuote>();
  private pollTimer: NodeJS.Timeout | null = null;
  private gasPrice: bigint = 0n;
  private gasPriceTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.provider = new ethers.JsonRpcProvider(config.arbitrum.rpcUrl);
    this.factory = new ethers.Contract(
      config.uniswap.factory,
      UNISWAP_V3_FACTORY_ABI,
      this.provider,
    );
    this.quoter = new ethers.Contract(
      config.uniswap.quoterV2,
      UNISWAP_V3_QUOTER_V2_ABI,
      this.provider,
    );
  }

  async start(): Promise<void> {
    logger.info('Starting Uniswap V3 price feed');

    // Discover pools
    await this.discoverPools();

    if (this.pools.length === 0) {
      logger.warn('No Uniswap V3 pools found for IDOS. Feed will poll but return no data.');
    }

    // Start polling prices
    await this.pollPrices();
    this.pollTimer = setInterval(() => this.pollPrices(), config.intervals.uniswapPollMs);

    // Start polling gas price
    await this.updateGasPrice();
    this.gasPriceTimer = setInterval(() => this.updateGasPrice(), config.intervals.gasPricePollMs);
  }

  private async discoverPools(): Promise<void> {
    const quoteTokens: { address: string; symbol: PoolToken; decimals: number }[] = [
      { address: config.tokens.USDC, symbol: 'USDC', decimals: 6 },
      { address: config.tokens.WETH, symbol: 'WETH', decimals: 18 },
    ];

    // Get IDOS decimals
    const idosContract = new ethers.Contract(config.tokens.IDOS, ERC20_ABI, this.provider);
    let idosDecimals = 18;
    try {
      idosDecimals = Number(await idosContract.decimals());
    } catch {
      logger.warn('Could not fetch IDOS decimals, assuming 18');
    }

    for (const qt of quoteTokens) {
      for (const fee of config.uniswap.feeTiers) {
        try {
          const poolAddress = await this.factory.getPool(
            config.tokens.IDOS,
            qt.address,
            fee,
          );

          if (poolAddress === ethers.ZeroAddress) {
            logger.debug(`No pool found: IDOS/${qt.symbol} fee=${fee}`);
            continue;
          }

          // Determine token order
          const poolContract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, this.provider);
          const token0 = (await poolContract.token0()).toLowerCase();
          const idosIsToken0 = token0 === config.tokens.IDOS.toLowerCase();

          const poolInfo: PoolInfo = {
            address: poolAddress,
            token0,
            token1: (await poolContract.token1()).toLowerCase(),
            fee: fee as FeeTier,
            quoteToken: qt.symbol,
            idosIsToken0,
            quoteDecimals: qt.decimals,
            idosDecimals,
          };

          this.pools.push(poolInfo);
          logger.info(`Discovered pool: IDOS/${qt.symbol} fee=${fee / 10000}%`, {
            pool: poolAddress,
            idosIsToken0,
          });
        } catch (err) {
          logger.error(`Error discovering pool IDOS/${qt.symbol} fee=${fee}`, {
            error: String(err),
          });
        }
      }
    }

    logger.info(`Discovered ${this.pools.length} Uniswap V3 IDOS pools`);

    // Also discover WETH/USDC pools (used as 3rd leg in triangular arb)
    await this.discoverThirdLegPools();
  }

  /**
   * Discover which WETH/USDC fee tiers exist (for triangular 3rd leg).
   * We only need to know they exist — we don't poll prices for them.
   */
  private availableThirdLegFeeTiers: FeeTier[] = [];

  private async discoverThirdLegPools(): Promise<void> {
    for (const fee of config.uniswap.feeTiers) {
      try {
        const poolAddress = await this.factory.getPool(
          config.tokens.WETH,
          config.tokens.USDC,
          fee,
        );
        if (poolAddress !== ethers.ZeroAddress) {
          this.availableThirdLegFeeTiers.push(fee as FeeTier);
          logger.info(`Discovered WETH/USDC pool fee=${fee / 10000}%`, { pool: poolAddress });
        } else {
          logger.debug(`No WETH/USDC pool found: fee=${fee}`);
        }
      } catch (err) {
        logger.error(`Error discovering WETH/USDC pool fee=${fee}`, { error: String(err) });
      }
    }
    logger.info(`Available WETH/USDC 3rd-leg fee tiers: ${this.availableThirdLegFeeTiers.join(', ') || 'none'}`);
  }

  getAvailableThirdLegFeeTiers(): FeeTier[] {
    return [...this.availableThirdLegFeeTiers];
  }

  private async pollPrices(): Promise<void> {
    for (const pool of this.pools) {
      try {
        const quote = await this.getPoolQuote(pool);
        if (quote) {
          const key = `${pool.quoteToken}_${pool.fee}`;
          this.latestQuotes.set(key, quote);
          this.emit('price', quote);
        }
      } catch (err) {
        logger.error(`Error polling pool IDOS/${pool.quoteToken} fee=${pool.fee}`, {
          error: String(err),
        });
      }
    }
  }

  private async getPoolQuote(pool: PoolInfo): Promise<PriceQuote | null> {
    // Quote at the max trade size to get realistic pricing with actual price impact
    const tradeSize = config.trading.maxTradeSizeIdos;
    const idosAmount = ethers.parseUnits(
      tradeSize.toFixed(pool.idosDecimals),
      pool.idosDecimals,
    );
    const quoteTokenAddress = pool.quoteToken === 'USDC' ? config.tokens.USDC : config.tokens.WETH;

    try {
      // Sell IDOS → get quote token (this gives us the "bid" - what we receive)
      const sellResult = await this.quoter.quoteExactInputSingle.staticCall({
        tokenIn: config.tokens.IDOS,
        tokenOut: quoteTokenAddress,
        amountIn: idosAmount,
        fee: pool.fee,
        sqrtPriceLimitX96: 0,
      });
      const sellAmountOut = sellResult.amountOut;
      const sellQuoteAmount = parseFloat(
        ethers.formatUnits(sellAmountOut, pool.quoteDecimals),
      );
      const bidPrice = sellQuoteAmount / tradeSize; // Price per IDOS including impact

      // Buy IDOS → spend quote token (this gives us the "ask" - what we pay)
      const buyResult = await this.quoter.quoteExactOutputSingle.staticCall({
        tokenIn: quoteTokenAddress,
        tokenOut: config.tokens.IDOS,
        amount: idosAmount,
        fee: pool.fee,
        sqrtPriceLimitX96: 0,
      });
      const buyAmountIn = buyResult.amountIn;
      const buyQuoteAmount = parseFloat(
        ethers.formatUnits(buyAmountIn, pool.quoteDecimals),
      );
      const askPrice = buyQuoteAmount / tradeSize; // Price per IDOS including impact

      // Estimate tradeable depth using the quoter:
      // If the full-size quote succeeds, the pool can handle maxTradeSizeIdos.
      // The gasEstimate returned by the quoter indicates ticks crossed — more ticks = less depth.
      // Use the gasEstimate as a heuristic: if it's very high, reduce available size.
      const sellGas = Number(sellResult.gasEstimate);
      const buyGas = Number(buyResult.gasEstimate);
      // Each initialized tick crossing costs ~100k gas; base swap is ~130k
      // If gas > 500k, the trade is crossing many ticks (thin liquidity)
      const depthFactor = Math.min(1, 300_000 / Math.max(sellGas, buyGas, 1));
      const estimatedDepthIdos = tradeSize * depthFactor;

      const priceQuote: PriceQuote = {
        venue: 'uniswap_v3',
        pair: `IDOS/${pool.quoteToken}`,
        bidPrice,
        askPrice,
        bidSizeIdos: Math.min(estimatedDepthIdos, config.trading.maxTradeSizeIdos),
        askSizeIdos: Math.min(estimatedDepthIdos, config.trading.maxTradeSizeIdos),
        timestamp: Date.now(),
        feeTier: pool.fee,
        quoteToken: pool.quoteToken,
      };

      logger.debug(`Uniswap IDOS/${pool.quoteToken} fee=${pool.fee / 10000}%`, {
        bid: bidPrice.toFixed(6),
        ask: askPrice.toFixed(6),
        depthIdos: estimatedDepthIdos.toFixed(0),
      });

      return priceQuote;
    } catch (err) {
      // If the full-size quote reverts, try a smaller size to still get pricing
      try {
        return await this.getPoolQuoteFallback(pool);
      } catch {
        logger.error(`QuoterV2 error for IDOS/${pool.quoteToken}`, { error: String(err) });
        return null;
      }
    }
  }

  /**
   * Fallback: quote at 1/10th trade size when full-size quote reverts (insufficient liquidity).
   */
  private async getPoolQuoteFallback(pool: PoolInfo): Promise<PriceQuote | null> {
    const fallbackSize = config.trading.maxTradeSizeIdos / 10;
    const idosAmount = ethers.parseUnits(
      fallbackSize.toFixed(pool.idosDecimals),
      pool.idosDecimals,
    );
    const quoteTokenAddress = pool.quoteToken === 'USDC' ? config.tokens.USDC : config.tokens.WETH;

    const sellResult = await this.quoter.quoteExactInputSingle.staticCall({
      tokenIn: config.tokens.IDOS,
      tokenOut: quoteTokenAddress,
      amountIn: idosAmount,
      fee: pool.fee,
      sqrtPriceLimitX96: 0,
    });
    const bidPrice = parseFloat(
      ethers.formatUnits(sellResult.amountOut, pool.quoteDecimals),
    ) / fallbackSize;

    const buyResult = await this.quoter.quoteExactOutputSingle.staticCall({
      tokenIn: quoteTokenAddress,
      tokenOut: config.tokens.IDOS,
      amount: idosAmount,
      fee: pool.fee,
      sqrtPriceLimitX96: 0,
    });
    const askPrice = parseFloat(
      ethers.formatUnits(buyResult.amountIn, pool.quoteDecimals),
    ) / fallbackSize;

    logger.debug(`Uniswap IDOS/${pool.quoteToken} fee=${pool.fee / 10000}% (fallback size)`, {
      bid: bidPrice.toFixed(6),
      ask: askPrice.toFixed(6),
      depthIdos: fallbackSize,
    });

    return {
      venue: 'uniswap_v3',
      pair: `IDOS/${pool.quoteToken}`,
      bidPrice,
      askPrice,
      bidSizeIdos: fallbackSize,
      askSizeIdos: fallbackSize,
      timestamp: Date.now(),
      feeTier: pool.fee,
      quoteToken: pool.quoteToken,
    };
  }

  private async updateGasPrice(): Promise<void> {
    try {
      const feeData = await this.provider.getFeeData();
      this.gasPrice = feeData.gasPrice || 0n;
    } catch (err) {
      logger.error('Error fetching gas price', { error: String(err) });
    }
  }

  getLatestQuotes(): PriceQuote[] {
    return Array.from(this.latestQuotes.values());
  }

  getQuote(quoteToken: PoolToken, feeTier: FeeTier): PriceQuote | undefined {
    return this.latestQuotes.get(`${quoteToken}_${feeTier}`);
  }

  getGasPrice(): bigint {
    return this.gasPrice;
  }

  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }

  getDiscoveredPools(): PoolInfo[] {
    return [...this.pools];
  }

  async stop(): Promise<void> {
    logger.info('Stopping Uniswap V3 price feed');
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.gasPriceTimer) clearInterval(this.gasPriceTimer);
  }
}
