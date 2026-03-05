import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  // KuCoin
  kucoin: {
    apiKey: requireEnv('KUCOIN_API_KEY'),
    apiSecret: requireEnv('KUCOIN_API_SECRET'),
    apiPassphrase: requireEnv('KUCOIN_API_PASSPHRASE'),
    tradingPair: 'IDOS-USDT',
    tradingFeeRate: 0.001, // 0.1%
  },

  // Arbitrum
  arbitrum: {
    privateKey: requireEnv('ARBITRUM_PRIVATE_KEY'),
    rpcUrl: requireEnv('ARBITRUM_RPC_URL'),
    chainId: 42161,
  },

  // Token addresses on Arbitrum
  tokens: {
    IDOS: '0x68731d6f14b827bbcffbebb62b19daa18de1d79c',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },

  // Uniswap V3 contracts on Arbitrum
  uniswap: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    feeTiers: [3000, 10000] as const, // 0.3% and 1%
  },

  // Trading parameters
  trading: {
    minProfitUsd: parseFloat(optionalEnv('MIN_PROFIT_USD', '0.50')),
    minProfitPct: parseFloat(optionalEnv('MIN_PROFIT_PCT', '0.5')),
    maxTradeSizeIdos: parseFloat(optionalEnv('MAX_TRADE_SIZE_IDOS', '10000')),
    cooldownMs: parseInt(optionalEnv('TRADE_COOLDOWN_MS', '5000')),
    maxSlippagePct: parseFloat(optionalEnv('MAX_SLIPPAGE_PCT', '1.0')),
    executionTimeoutMs: 5000,
  },

  // MEV protection
  mev: {
    usePrivateRpc: optionalEnv('USE_PRIVATE_RPC', 'false') === 'true',
    flashbotsRpcUrl: process.env['FLASHBOTS_RPC_URL'] || '',
  },

  // Dashboard
  dashboard: {
    port: parseInt(optionalEnv('DASHBOARD_PORT', '3000')),
    apiKey: process.env['DASHBOARD_API_KEY'] || '',
  },

  // Recovery
  recovery: {
    strategy: optionalEnv('RECOVERY_STRATEGY', 'unwind') as 'unwind' | 'retry' | 'hold',
    maxLossUsd: parseFloat(optionalEnv('MAX_LOSS_USD', '5.00')),
  },

  // Logging
  logLevel: optionalEnv('LOG_LEVEL', 'info'),

  // Polling intervals
  intervals: {
    uniswapPollMs: 2000,    // Poll Uniswap prices every 2s
    balancePollMs: 30000,   // Poll balances every 30s
    gasPricePollMs: 10000,  // Poll gas price every 10s
  },
} as const;
