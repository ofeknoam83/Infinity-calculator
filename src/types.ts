export type Venue = 'kucoin' | 'uniswap_v3';
export type Direction = 'buy' | 'sell';
export type PoolToken = 'USDC' | 'WETH';
export type FeeTier = 500 | 3000 | 10000;
export type RecoveryStrategy = 'unwind' | 'retry' | 'hold';
export type PathType = 'cex_dex' | 'cross_dex' | 'triangular';

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
  pathType: PathType;
  buyVenue: Venue;
  sellVenue: Venue;
  buyPair: string;
  sellPair: string;
  buyFeeTier?: FeeTier;
  sellFeeTier?: FeeTier;
  buyQuoteToken?: PoolToken;
  sellQuoteToken?: PoolToken;
  // Triangular arb: 3rd leg swaps the sell-side quote token back to the buy-side quote token
  // e.g. USDC→IDOS(pool1)→WETH(pool2)→USDC(weth/usdc pool) — thirdLeg swaps WETH→USDC
  thirdLegTokenIn?: PoolToken;   // Token received from sell leg (e.g. WETH)
  thirdLegTokenOut?: PoolToken;  // Token needed by buy leg (e.g. USDC)
  thirdLegFeeTier?: FeeTier;     // Fee tier for the 3rd leg swap (WETH/USDC pool)
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
  // Triangular-specific: amount of quote token in/out for the cycle
  triangularAmountIn?: number;   // Starting amount (e.g. USDC spent)
  triangularAmountOut?: number;  // Ending amount (e.g. USDC received after full cycle)
}

export interface FeeBreakdown {
  kucoinFeeUsd: number;
  uniswapPoolFeeUsd: number;
  gasEstimateUsd: number;
  slippageEstimateUsd: number;
  totalFeesUsd: number;
  thirdLegFeeUsd?: number; // Extra fee for triangular 3rd leg
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

export interface SwapResult {
  success: boolean;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  amountOut: number;
  txHash?: string;
  feeUsd: number;
  error?: string;
  timestamp: number;
}

export interface ExecutionResult {
  opportunity: ArbOpportunity;
  buyLeg: TradeResult;
  sellLeg: TradeResult;
  thirdLeg?: SwapResult;   // Only for triangular arb
  netProfitUsd: number;
  status: 'success' | 'partial_buy' | 'partial_sell' | 'partial_third' | 'both_failed' | 'all_failed';
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
  tradeHistory: TradeRecord[];
}

export interface TradeRecord {
  id: string;
  execution: ExecutionResult;
  timestamp: number;
}
