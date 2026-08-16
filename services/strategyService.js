/**
 * Strategy Service
 * Implements the stock selection logic at 9:15 AM.
 * - Fetches live data via Kite
 * - Calculates Gap %, Momentum, Volume Strength
 * - Computes weighted Final Score (40% Momentum + 30% Gap + 30% Volume)
 * - Applies filters: Gap > 0, Momentum > 0, decent volume
 * - Selects the single best stock if it meets threshold
 */

import { getQuotes } from './kiteService.js';
import { isWithinTradingWindow } from './timeService.js';
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

const SCORE_THRESHOLD = parseFloat(process.env.SCORE_THRESHOLD) || 65;
const MIN_VOLUME = 100000; // Increased minimum volume to 100,000 for safety

// Expanded universe for better opportunities (25 high momentum/volatile NSE stocks)
export let STOCK_UNIVERSE = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "LT", 
  "AXISBANK", "ITC", "BHARTIARTL", "KOTAKBANK", "BAJFINANCE", "SUNPHARMA",
  "HINDUNILVR", "MARUTI", "TATAMOTORS", "POWERGRID", "NTPC", "ONGC",
  "COALINDIA", "TATASTEEL", "JSWSTEEL", "GRASIM", "TECHM", "WIPRO"
];

export const updateStockUniverse = (newStocks) => {
  if (!Array.isArray(newStocks) || newStocks.length < 10 || newStocks.length > 30) {
    throw new Error('Stock universe must be between 10 and 30 stocks');
  }
  // Basic validation: uppercase, no spaces
  const cleaned = newStocks.map(s => s.trim().toUpperCase());
  STOCK_UNIVERSE = cleaned;
  logger.info('Stock universe updated', { stocks: STOCK_UNIVERSE });
  return STOCK_UNIVERSE;
};

export const getStockUniverse = () => [...STOCK_UNIVERSE];

let latestScanDecision = null;
export const getLatestScanDecision = () => latestScanDecision;

/**
 * Normalize a value to 0-100 scale based on array min/max
 */
const normalizeToScore = (value, min, max) => {
  if (max === min) return 50;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
};

/**
 * Core function: Scan all stocks and return ranked list with scores.
 * Called at exactly 9:15 AM by scheduler.
 */
export const scanAndRankStocks = async () => {
  if (!isWithinTradingWindow()) {
    throw new Error('Trading operations and scans are restricted to 9:00 AM - 11:00 AM IST.');
  }

  const instruments = STOCK_UNIVERSE.map(symbol => `NSE:${symbol}`);
  
  logger.info('Scanning stocks at market open...', { count: STOCK_UNIVERSE.length });
  
  let quotes;
  try {
    quotes = await getQuotes(instruments);
  } catch (error) {
    logger.error('Failed to fetch quotes for ranking', { error: error.message });
    throw new Error('Unable to fetch market data. Check Kite session.');
  }

  const stockData = [];
  const gaps = [];
  const momentums = [];
  const volumes = [];

  // First pass: collect raw metrics
  for (const symbol of STOCK_UNIVERSE) {
    const instrumentKey = `NSE:${symbol}`;
    const quote = quotes[instrumentKey];
    
    if (!quote || !quote.ohlc) {
      logger.warn(`No quote data for ${symbol}`);
      continue;
    }

    const prevClose = quote.ohlc.close || 0;
    const openPrice = quote.ohlc.open || 0;
    const lastPrice = quote.last_price || openPrice;
    const volume = quote.volume || 0;

    if (prevClose === 0 || openPrice === 0) continue;

    const gapPercent = ((openPrice - prevClose) / prevClose) * 100;
    const momentumPercent = ((lastPrice - openPrice) / openPrice) * 100;

    gaps.push(gapPercent);
    momentums.push(momentumPercent);
    volumes.push(volume);

    stockData.push({
      symbol,
      prevClose,
      openPrice,
      lastPrice,
      volume,
      gapPercent,
      momentumPercent,
      rawVolume: volume
    });
  }

  if (stockData.length === 0) {
    throw new Error('No valid stock data fetched');
  }

  // Calculate min/max for normalization
  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);
  const minMomentum = Math.min(...momentums);
  const maxMomentum = Math.max(...momentums);
  const minVolume = Math.min(...volumes);
  const maxVolume = Math.max(...volumes);

  // Second pass: compute normalized scores and final weighted score
  const rankedStocks = stockData.map(stock => {
    // Gap Strength (0-100): positive gaps preferred
    const gapScore = normalizeToScore(stock.gapPercent, minGap, maxGap);
    
    // Momentum Score (0-100)
    const momentumScore = normalizeToScore(stock.momentumPercent, minMomentum, maxMomentum);
    
    // Volume Strength (0-100) - log scale helps with outliers
    const volumeScore = stock.rawVolume > MIN_VOLUME 
      ? normalizeToScore(Math.log10(stock.rawVolume + 1), Math.log10(minVolume + 1), Math.log10(maxVolume + 1))
      : 10; // low score if volume too low

    // Final Score: 40% Momentum + 30% Gap + 30% Volume
    const finalScore = (
      (momentumScore * 0.40) +
      (gapScore * 0.30) +
      (volumeScore * 0.30)
    );

    return {
      ...stock,
      gapScore: parseFloat(gapScore.toFixed(2)),
      momentumScore: parseFloat(momentumScore.toFixed(2)),
      volumeScore: parseFloat(volumeScore.toFixed(2)),
      finalScore: parseFloat(finalScore.toFixed(2))
    };
  });

  // Sort by finalScore descending
  rankedStocks.sort((a, b) => b.finalScore - a.finalScore);

  logger.info('Stock ranking complete', {
    topStock: rankedStocks[0]?.symbol,
    topScore: rankedStocks[0]?.finalScore,
    totalScanned: rankedStocks.length
  });

  return rankedStocks;
};

/**
 * Select the best stock and decide if we should trade.
 * Returns { bestStock, shouldTrade, reason }
 */
export const selectBestStock = async () => {
  if (!isWithinTradingWindow()) {
    latestScanDecision = {
      timestamp: new Date().toISOString(),
      shouldTrade: false,
      reason: 'Trading restricted: Outside 9:00 AM - 11:00 AM IST trading window.'
    };
    return {
      bestStocks: [],
      bestStock: null,
      rankedStocks: [],
      shouldTrade: false,
      reason: 'Trading restricted: Outside 9:00 AM - 11:00 AM IST trading window.'
    };
  }

  let niftyTrendSafe = true;
  let niftyReason = '';
  let changePercent = 0;
  try {
    const niftySymbol = 'NSE:NIFTY 50';
    const quotes = await getQuotes([niftySymbol]);
    const quote = quotes[niftySymbol];
    if (quote && quote.ohlc && quote.ohlc.close > 0) {
      const prevClose = quote.ohlc.close;
      const lastPrice = quote.last_price || prevClose;
      changePercent = ((lastPrice - prevClose) / prevClose) * 100;
      
      const threshold = parseFloat(process.env.NIFTY_TREND_THRESHOLD_PCT) || -0.5;
      if (changePercent < threshold) {
        niftyTrendSafe = false;
        niftyReason = `Market Downtrend safety check triggered: Nifty 50 is down ${changePercent.toFixed(2)}% (threshold ${threshold}%).`;
      }
    }
  } catch (err) {
    logger.warn('Failed to fetch Nifty 50 quote for safety check, continuing without check', { error: err.message });
  }

  const ranked = await scanAndRankStocks();
  
  if (!ranked || ranked.length === 0) {
    latestScanDecision = {
      timestamp: new Date().toISOString(),
      shouldTrade: false,
      reason: 'No stocks scanned',
      niftySafe: niftyTrendSafe,
      niftyChangePct: changePercent
    };
    return { bestStocks: [], shouldTrade: false, reason: 'No stocks scanned' };
  }

  // Select up to 2 best stocks for profit potential
  const topStocks = ranked.slice(0, 2);
  const best = topStocks[0];

  // Strict filters 
  const hasPositiveGap = best.gapPercent > 0;
  const hasPositiveMomentum = best.momentumPercent > 0;
  const hasDecentVolume = best.rawVolume >= MIN_VOLUME;

  let shouldTrade = false;
  let reason = '';

  if (!niftyTrendSafe) {
    reason = niftyReason;
  } else if (!hasPositiveGap) {
    reason = `Gap negative (${best.gapPercent.toFixed(2)}%). No trade.`;
  } else if (!hasPositiveMomentum) {
    reason = `Momentum negative from open (${best.momentumPercent.toFixed(2)}%). No trade.`;
  } else if (!hasDecentVolume) {
    reason = `Volume too low (${best.rawVolume} < ${MIN_VOLUME}). No trade.`;
  } else if (best.finalScore < SCORE_THRESHOLD) {
    reason = `Best score ${best.finalScore} below threshold ${SCORE_THRESHOLD}. No trade.`;
  } else {
    shouldTrade = true;
    reason = `Selected top ${topStocks.length} stocks for execution.`;
  }

  logger.info('Trade decision', { 
    topStocks: topStocks.map(s => s.symbol), 
    shouldTrade, 
    reason, 
    topScore: best.finalScore 
  });

  latestScanDecision = {
    timestamp: new Date().toISOString(),
    shouldTrade,
    reason,
    niftySafe: niftyTrendSafe,
    niftyChangePct: changePercent,
    niftyThreshold: parseFloat(process.env.NIFTY_TREND_THRESHOLD_PCT) || -0.5,
    bestStock: best || null,
    topStocks: topStocks || [],
    hasPositiveGap,
    hasPositiveMomentum,
    hasDecentVolume,
    volumeValue: best ? best.rawVolume : 0,
    volumeThreshold: MIN_VOLUME,
    finalScore: best ? best.finalScore : 0,
    scoreThreshold: SCORE_THRESHOLD
  };

  return {
    bestStocks: topStocks,   // Changed to support multi-stock
    bestStock: best,         // Keep for backward compatibility
    rankedStocks: ranked,
    shouldTrade,
    reason
  };
};
