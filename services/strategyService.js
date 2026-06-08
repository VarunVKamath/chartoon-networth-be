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
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

const SCORE_THRESHOLD = parseFloat(process.env.SCORE_THRESHOLD) || 65;
const MIN_VOLUME = 50000; // Minimum volume to consider (adjust based on stock)

// Default stock universe (configurable via API later)
export let STOCK_UNIVERSE = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK",
  "SBIN", "LT", "AXISBANK", "ITC", "BHARTIARTL"
];

export const updateStockUniverse = (newStocks) => {
  if (!Array.isArray(newStocks) || newStocks.length !== 10) {
    throw new Error('Exactly 10 stocks required');
  }
  // Basic validation: uppercase, no spaces
  const cleaned = newStocks.map(s => s.trim().toUpperCase());
  STOCK_UNIVERSE = cleaned;
  logger.info('Stock universe updated', { stocks: STOCK_UNIVERSE });
  return STOCK_UNIVERSE;
};

export const getStockUniverse = () => [...STOCK_UNIVERSE];

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
  const ranked = await scanAndRankStocks();
  
  if (!ranked || ranked.length === 0) {
    return { bestStock: null, shouldTrade: false, reason: 'No stocks scanned' };
  }

  const best = ranked[0];
  
  // Strict filters for quality trade
  const hasPositiveGap = best.gapPercent > 0;
  const hasPositiveMomentum = best.momentumPercent > 0;
  const hasDecentVolume = best.rawVolume > MIN_VOLUME;

  let shouldTrade = false;
  let reason = '';

  if (!hasPositiveGap) {
    reason = `Gap negative (${best.gapPercent.toFixed(2)}%). No trade.`;
  } else if (!hasPositiveMomentum) {
    reason = `Momentum negative from open (${best.momentumPercent.toFixed(2)}%). No trade.`;
  } else if (!hasDecentVolume) {
    reason = `Volume too low (${best.rawVolume}). No trade.`;
  } else if (best.finalScore < SCORE_THRESHOLD) {
    reason = `Best score ${best.finalScore} below threshold ${SCORE_THRESHOLD}. No trade.`;
  } else {
    shouldTrade = true;
    reason = `Selected ${best.symbol} with score ${best.finalScore}`;
  }

  logger.info('Trade decision', { symbol: best.symbol, shouldTrade, reason, score: best.finalScore });

  return {
    bestStock: best,
    rankedStocks: ranked, // full list for dashboard
    shouldTrade,
    reason
  };
};
