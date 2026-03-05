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

    logger.info(`Discovered ${this.pools.length} Uniswap V3 pools`);
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
    // Use a representative trade size to get realistic pricing
    // Quote for buying IDOS (input is quote token, output is IDOS)
    // and selling IDOS (input is IDOS, output is quote token)

    const idosAmount = ethers.parseUnits('100', pool.idosDecimals); // 100 IDOS

    try {
      // Sell IDOS → get quote token (this gives us the "bid" - what we receive)
      const sellResult = await this.quoter.quoteExactInputSingle.staticCall({
        tokenIn: config.tokens.IDOS,
        tokenOut: pool.quoteToken === 'USDC' ? config.tokens.USDC : config.tokens.WETH,
        amountIn: idosAmount,
        fee: pool.fee,
        sqrtPriceLimitX96: 0,
      });
      const sellAmountOut = sellResult.amountOut;
      const sellQuoteAmount = parseFloat(
        ethers.formatUnits(sellAmountOut, pool.quoteDecimals),
      );
      const bidPrice = sellQuoteAmount / 100; // Price per IDOS

      // Buy IDOS → spend quote token (this gives us the "ask" - what we pay)
      const buyResult = await this.quoter.quoteExactOutputSingle.staticCall({
        tokenIn: pool.quoteToken === 'USDC' ? config.tokens.USDC : config.tokens.WETH,
        tokenOut: config.tokens.IDOS,
        amount: idosAmount,
        fee: pool.fee,
        sqrtPriceLimitX96: 0,
      });
      const buyAmountIn = buyResult.amountIn;
      const buyQuoteAmount = parseFloat(
        ethers.formatUnits(buyAmountIn, pool.quoteDecimals),
      );
      const askPrice = buyQuoteAmount / 100; // Price per IDOS

      // Read pool liquidity for size estimation
      const poolContract = new ethers.Contract(pool.address, UNISWAP_V3_POOL_ABI, this.provider);
      const liquidity = await poolContract.liquidity();
      const liquidityFloat = parseFloat(ethers.formatUnits(liquidity, pool.idosDecimals));

      const priceQuote: PriceQuote = {
        venue: 'uniswap_v3',
        pair: `IDOS/${pool.quoteToken}`,
        bidPrice,
        askPrice,
        bidSizeIdos: Math.min(liquidityFloat, config.trading.maxTradeSizeIdos),
        askSizeIdos: Math.min(liquidityFloat, config.trading.maxTradeSizeIdos),
        timestamp: Date.now(),
        feeTier: pool.fee,
        quoteToken: pool.quoteToken,
      };

      logger.debug(`Uniswap IDOS/${pool.quoteToken} fee=${pool.fee / 10000}%`, {
        bid: bidPrice.toFixed(6),
        ask: askPrice.toFixed(6),
      });

      return priceQuote;
    } catch (err) {
      logger.error(`QuoterV2 error for IDOS/${pool.quoteToken}`, { error: String(err) });
      return null;
    }
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
