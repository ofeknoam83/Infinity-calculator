export type Venue = 'kucoin' | 'uniswap_v3';
export type Direction = 'buy' | 'sell';
export type PoolToken = 'USDC' | 'WETH';
export type FeeTier = 3000 | 10000;
export type RecoveryStrategy = 'unwind' | 'retry' | 'hold';

export interface PriceQuote {
  venue: Venue;
  pair: string;           // e.g. "IDOS/USDT" or "IDOS/USDC"
  bidPrice: number;       // Best bid (sell price)
  askPrice: number;       // Best ask (buy price)
  bidSizeIdos: number;    // Available size at bid
  askSizeIdos: number;    // Available size at ask
  timestamp: number;
  feeTier?: FeeTier;      // For Uniswap pools
  quoteToken?: PoolToken; // For Uniswap pools
}

export interface NormalizedPrice {
  venue: Venue;
  pair: string;
  buyPriceUsd: number;    // Cost to buy 1 IDOS in USD
  sellPriceUsd: number;   // Revenue from selling 1 IDOS in USD
  maxBuySizeIdos: number;
  maxSellSizeIdos: number;
  feeTier?: FeeTier;
  quoteToken?: PoolToken;
  timestamp: number;
}

export interface ArbPath {
  id: string;
  buyVenue: Venue;
  sellVenue: Venue;
  buyPair: string;
  sellPair: string;
  buyFeeTier?: FeeTier;
  sellFeeTier?: FeeTier;
  buyQuoteToken?: PoolToken;
  sellQuoteToken?: PoolToken;
}

export interface ArbOpportunity {
  path: ArbPath;
  buyPriceUsd: number;
  sellPriceUsd: number;
  spreadPct: number;       // Raw spread percentage
  tradeSizeIdos: number;   // Optimal trade size
  estimatedFees: FeeBreakdown;
  netProfitUsd: number;
  netProfitPct: number;
  timestamp: number;
}

export interface FeeBreakdown {
  kucoinFeeUsd: number;
  uniswapPoolFeeUsd: number;
  gasEstimateUsd: number;
  slippageEstimateUsd: number;
  totalFeesUsd: number;
}

export interface TradeResult {
  success: boolean;
  venue: Venue;
  direction: Direction;
  amountIdos: number;
  priceUsd: number;
  totalUsd: number;
  feeUsd: number;
  orderId?: string;
  txHash?: string;
  error?: string;
  timestamp: number;
}

export interface ExecutionResult {
  opportunity: ArbOpportunity;
  buyLeg: TradeResult;
  sellLeg: TradeResult;
  netProfitUsd: number;
  status: 'success' | 'partial_buy' | 'partial_sell' | 'both_failed';
  recoveryAction?: string;
  timestamp: number;
}

export interface Balances {
  kucoin: {
    idos: number;
    usdt: number;
  };
  arbitrum: {
    idos: number;
    usdc: number;
    weth: number;
    eth: number; // For gas
  };
}

export interface BotStatus {
  running: boolean;
  uptime: number;
  startedAt: number;
  lastTradeAt: number | null;
  totalTrades: number;
  successfulTrades: number;
  totalProfitUsd: number;
  balances: Balances;
  currentPrices: NormalizedPrice[];
  currentSpread: { pathId: string; spreadPct: number }[];
  errors: { message: string; timestamp: number }[];
}

export interface TradeRecord {
  id: string;
  execution: ExecutionResult;
  timestamp: number;
}
