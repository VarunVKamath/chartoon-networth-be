/**
 * Early Edge Service
 * Implements the early-morning intraday momentum strategy (9:15 - 10:00 AM IST).
 * - Calculates Opening Range (OR) High/Low using first 15 candles (9:15 - 9:30).
 * - Computes VWAP, ATR, and Nifty relative strength.
 * - Computes a 5-factor Probability Score (0-100) to find high-probability continuation moves.
 * - Emits Socket.io events for real-time dashboard updates.
 * - Supports live Kite historical API and deterministic mock candles for development.
 */

import { getQuotes } from './kiteService.js';
import { getISTTime } from './timeService.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

// Personal watchlist in-memory store (defaults to stock universe)
let customWatchlist = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "LT", "TATAMOTORS", "TATASTEEL", "WIPRO"];

// Simulated time (if null, uses actual time)
let simulatedTime = null;

// Lock store for Opening Range to avoid recalculating once locked at 9:30 AM
const openingRangeLockStore = new Map(); // Key: 'YYYY-MM-DD:SYMBOL', Value: { high, low, locked: true }

/**
 * Configure Watchlist
 */
export const getWatchlist = () => [...customWatchlist];

export const updateWatchlist = (stocks) => {
  if (!Array.isArray(stocks) || stocks.length === 0) {
    throw new Error('Watchlist must be a non-empty array of symbols.');
  }
  customWatchlist = stocks.map(s => s.trim().toUpperCase());
  logger.info('EarlyEdge Watchlist updated', { watchlist: customWatchlist });
  return customWatchlist;
};

/**
 * Set Simulated Time (HH:MM:SS) or null to use live time
 */
export const setSimulatedTime = (timeStr) => {
  if (!timeStr) {
    simulatedTime = null;
    logger.info('Simulated time cleared. Using live time.');
    return { success: true, simulatedTime: null };
  }
  // Validate format HH:MM:SS or HH:MM
  if (!/^([0-9]|0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/.test(timeStr)) {
    throw new Error('Invalid time format. Must be HH:MM:SS or HH:MM');
  }
  simulatedTime = timeStr;
  logger.info(`Simulated time set to ${simulatedTime}`);
  return { success: true, simulatedTime };
};

export const getSimulatedTime = () => simulatedTime;

/**
 * Get Current Active Time in IST (taking simulation into account)
 */
export const getActiveISTTime = () => {
  const now = getISTTime();
  if (simulatedTime) {
    const parts = simulatedTime.split(':');
    const simDate = new Date(now);
    simDate.setHours(parseInt(parts[0], 10));
    simDate.setMinutes(parseInt(parts[1], 10));
    simDate.setSeconds(parts[2] ? parseInt(parts[2], 10) : 0);
    simDate.setMilliseconds(0);
    return simDate;
  }
  return now;
};

/**
 * Deterministic Pseudo-Random Number Generator (PRNG)
 * Used to generate stable mock candles based on symbol and date.
 */
class SeededRandom {
  constructor(seedString) {
    let hash = 0;
    for (let i = 0; i < seedString.length; i++) {
      hash = seedString.charCodeAt(i) + ((hash << 5) - hash);
    }
    this.seed = Math.abs(hash);
  }

  // Returns number between 0 and 1
  next() {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }

  // Returns number between min and max
  nextRange(min, max) {
    return min + this.next() * (max - min);
  }
}

// Preset attributes to give mock stocks distinctive behaviors
const MOCK_STOCK_BEHAVIORS = {
  RELIANCE: { basePrice: 2500, volatility: 0.0012, bias: 0.0001, volumeBase: 15000 },
  TCS: { basePrice: 3800, volatility: 0.0010, bias: 0.00015, volumeBase: 8000 },
  INFY: { basePrice: 1450, volatility: 0.0015, bias: -0.00005, volumeBase: 12000 },
  HDFCBANK: { basePrice: 1650, volatility: 0.0008, bias: -0.0001, volumeBase: 20000 },
  ICICIBANK: { basePrice: 1100, volatility: 0.0011, bias: 0.00005, volumeBase: 14000 },
  SBIN: { basePrice: 820, volatility: 0.0016, bias: 0.0002, volumeBase: 18000 },
  LT: { basePrice: 3400, volatility: 0.0013, bias: 0.00005, volumeBase: 5000 },
  TATAMOTORS: { basePrice: 950, volatility: 0.0022, bias: 0.0005, volumeBase: 35000 }, // High momentum outperformer
  TATASTEEL: { basePrice: 150, volatility: 0.0025, bias: 0.0001, volumeBase: 50000 },
  WIPRO: { basePrice: 480, volatility: 0.0014, bias: -0.00008, volumeBase: 15000 },
  NIFTY50: { basePrice: 24500, volatility: 0.0004, bias: 0.00005, volumeBase: 500000 }
};

/**
 * Generate Deterministic Mock Candles for a Stock on a Specific Date
 * Generates 1-minute candles from 09:15 to 10:00 (45 candles max)
 */
export const generateMockCandles = (symbol, dateStr, upToTime) => {
  const behavior = MOCK_STOCK_BEHAVIORS[symbol] || { basePrice: 1000, volatility: 0.0015, bias: 0.0001, volumeBase: 10000 };
  const rng = new SeededRandom(`${dateStr}-${symbol}`);

  const candles = [];
  let currentPrice = behavior.basePrice;

  // Generate for up to 46 minutes (09:15 to 10:00)
  for (let i = 0; i <= 45; i++) {
    const candleTime = new Date(upToTime);
    candleTime.setHours(9);
    candleTime.setMinutes(15 + i);
    candleTime.setSeconds(0);
    candleTime.setMilliseconds(0);

    // If candle is in the future relative to upToTime, stop
    if (candleTime > upToTime) {
      break;
    }

    // Deterministic random walk
    const changePct = rng.nextRange(-behavior.volatility, behavior.volatility) + behavior.bias;
    
    // Simulate volume surge around 9:30 AM (breakout timing)
    let volMultiplier = rng.nextRange(0.6, 1.4);
    if (i < 5) {
      volMultiplier *= 2.5; // High open volume (9:15 - 9:20)
    } else if (i >= 15 && i <= 18 && (symbol === 'TATAMOTORS' || symbol === 'TCS' || symbol === 'SBIN')) {
      volMultiplier *= 3.8; // Breakout volume surge at 9:30 - 9:33
      currentPrice += behavior.basePrice * rng.nextRange(0.001, 0.003); // Breakout price pump
    }

    const open = currentPrice;
    const close = currentPrice * (1 + changePct);
    
    // Simulate high/low
    const minVal = Math.min(open, close);
    const maxVal = Math.max(open, close);
    const high = maxVal + behavior.basePrice * rng.nextRange(0, behavior.volatility * 0.5);
    const low = minVal - behavior.basePrice * rng.nextRange(0, behavior.volatility * 0.5);
    
    const volume = Math.round(behavior.volumeBase * volMultiplier);

    candles.push({
      date: candleTime,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume: volume
    });

    currentPrice = close;
  }

  return candles;
};

/**
 * Aggregates 1-Minute Candles to 3-Minute Candles
 */
export const aggregateTo3Min = (candles1m) => {
  const candles3m = [];
  for (let i = 0; i < candles1m.length; i += 3) {
    const chunk = candles1m.slice(i, i + 3);
    if (chunk.length === 0) continue;

    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    const high = Math.max(...chunk.map(c => c.high));
    const low = Math.min(...chunk.map(c => c.low));
    const volume = chunk.reduce((sum, c) => sum + c.volume, 0);

    candles3m.push({
      date: first.date,
      open: first.open,
      high: high,
      low: low,
      close: last.close,
      volume: volume
    });
  }
  return candles3m;
};

/**
 * Calculate VWAP (Volume Weighted Average Price) overlay
 */
export const calculateVWAP = (candles) => {
  let cumTypicalVolume = 0;
  let cumVolume = 0;

  return candles.map(c => {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumTypicalVolume += typicalPrice * c.volume;
    cumVolume += c.volume;
    const vwap = cumVolume > 0 ? cumTypicalVolume / cumVolume : c.close;
    return {
      ...c,
      vwap: parseFloat(vwap.toFixed(2))
    };
  });
};

/**
 * Calculate ATR (Average True Range) over a period (e.g. 14)
 */
export const calculateATR = (candles, period = 14) => {
  if (candles.length === 0) return 0;
  
  const trueRanges = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      trueRanges.push(c.high - c.low);
    } else {
      const prev = candles[i - 1];
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close)
      );
      trueRanges.push(tr);
    }
  }

  // Calculate Simple Average of TR for the period
  const slice = trueRanges.slice(-period);
  const sum = slice.reduce((acc, val) => acc + val, 0);
  return sum / slice.length;
};

/**
 * Get Candles (Live from Zerodha or Deterministic Mock)
 */
export const getCandleData = async (symbol, upToTime, useMock = true) => {
  const dateStr = upToTime.toISOString().split('T')[0];
  
  if (useMock) {
    const candles1m = generateMockCandles(symbol, dateStr, upToTime);
    return calculateVWAP(candles1m);
  }

  // Live Mode:
  try {
    const quotes = await getQuotes([`NSE:${symbol}`]);
    const quote = quotes[`NSE:${symbol}`];
    if (!quote || !quote.instrument_token) {
      throw new Error('Instrument token not found');
    }

    const kite = getKiteInstance();
    const fromDate = new Date(upToTime);
    fromDate.setHours(9, 15, 0, 0);

    const liveCandles = await kite.getHistoricalData(
      quote.instrument_token,
      'minute',
      fromDate,
      upToTime
    );

    // Format to match structure
    const formatted = liveCandles.map(c => ({
      date: new Date(c.date),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume
    }));

    return calculateVWAP(formatted);
  } catch (error) {
    logger.warn(`Failed to fetch live candles for ${symbol}, falling back to mock`, { error: error.message });
    const candles1m = generateMockCandles(symbol, dateStr, upToTime);
    return calculateVWAP(candles1m);
  }
};

/**
 * Calculate Opening Range (High & Low) using the first 15 candles (9:15 - 9:30)
 */
export const getOpeningRange = (candles1m, dateStr, symbol) => {
  const lockKey = `${dateStr}:${symbol}`;
  
  // Check if we already have it locked and stored
  if (openingRangeLockStore.has(lockKey)) {
    return openingRangeLockStore.get(lockKey);
  }

  // Filter candles that belong to the opening range (9:15 to 9:30 AM)
  const orCandles = candles1m.filter(c => {
    const h = c.date.getHours();
    const m = c.date.getMinutes();
    return (h === 9 && m >= 15 && m < 30);
  });

  if (orCandles.length === 0) {
    return { high: null, low: null, locked: false };
  }

  const high = Math.max(...orCandles.map(c => c.high));
  const low = Math.min(...orCandles.map(c => c.low));

  const isLocked = candles1m.some(c => {
    const h = c.date.getHours();
    const m = c.date.getMinutes();
    return (h > 9 || (h === 9 && m >= 30));
  });

  const range = {
    high: parseFloat(high.toFixed(2)),
    low: parseFloat(low.toFixed(2)),
    locked: isLocked
  };

  if (isLocked) {
    openingRangeLockStore.set(lockKey, range);
    // Emit opening_range_ready event
    if (global.io) {
      global.io.emit('opening_range_ready', { symbol, range });
    }
    logger.info(`Opening Range locked for ${symbol}`, range);
  }

  return range;
};

/**
 * Calculate 9:30 - 9:45 Momentum Probability Score
 */
export const calculateMomentumScore = (symbol, candles1m, openingRange, niftyCandles) => {
  if (candles1m.length === 0) {
    return { score: 0, signal: 'Avoid', factors: {}, stopLoss: null, target: null };
  }

  const latestCandle = candles1m[candles1m.length - 1];
  const currentPrice = latestCandle.close;

  // --- FACTOR 1: Opening Range Breakout (30% weight) ---
  let breakoutScore = 0;
  let breakoutStatus = 'No Breakout';
  if (openingRange && openingRange.high) {
    if (currentPrice > openingRange.high) {
      breakoutScore = 30;
      breakoutStatus = 'Bullish Breakout';
    } else if (currentPrice > openingRange.high * 0.998) {
      breakoutScore = 15; // Near breakout
      breakoutStatus = 'Near Breakout';
    }
  }

  // --- FACTOR 2: Volume Surge (20% weight) ---
  let volumeScore = 0;
  let volumeStatus = 'Normal Volume';
  const orCandles = candles1m.filter(c => c.date.getHours() === 9 && c.date.getMinutes() >= 15 && c.date.getMinutes() < 30);
  if (orCandles.length > 0) {
    const avgOpeningVolume = orCandles.reduce((sum, c) => sum + c.volume, 0) / orCandles.length;
    const latestVolume = latestCandle.volume;
    const ratio = latestVolume / avgOpeningVolume;
    
    if (ratio >= 1.8) {
      volumeScore = 20;
      volumeStatus = `Surge Detected (${ratio.toFixed(1)}x)`;
    } else if (ratio >= 1.0) {
      volumeScore = Math.round(20 * (ratio - 1.0) / 0.8);
      volumeStatus = `Elevated (${ratio.toFixed(1)}x)`;
    } else {
      volumeStatus = `Low (${ratio.toFixed(1)}x)`;
    }
  }

  // --- FACTOR 3: Price vs VWAP (15% weight) ---
  let vwapScore = 0;
  let vwapStatus = 'Below VWAP';
  if (latestCandle.vwap && currentPrice > latestCandle.vwap) {
    vwapScore = 15;
    vwapStatus = 'Holding Above VWAP';
  }

  // --- FACTOR 4: Relative Strength vs Nifty 50 (20% weight) ---
  let relativeStrengthScore = 0;
  let rsStatus = 'Weaker than Nifty';
  if (niftyCandles && niftyCandles.length > 0) {
    const niftyOpen = niftyCandles[0].open;
    const niftyCurrent = niftyCandles[niftyCandles.length - 1].close;
    const niftyReturn = (niftyCurrent - niftyOpen) / niftyOpen;

    const stockOpen = candles1m[0].open;
    const stockReturn = (currentPrice - stockOpen) / stockOpen;

    const rs = stockReturn - niftyReturn;
    if (rs > 0.004) {
      relativeStrengthScore = 20;
      rsStatus = `Outperforming Nifty (+${(rs * 100).toFixed(2)}%)`;
    } else if (rs > 0) {
      relativeStrengthScore = Math.round(20 * (rs / 0.004));
      rsStatus = `Slightly Outperforming (+${(rs * 100).toFixed(2)}%)`;
    } else {
      rsStatus = `Underperforming (${(rs * 100).toFixed(2)}%)`;
    }
  }

  // --- FACTOR 5: Momentum / Candle Strength (15% weight) ---
  let candleStrengthScore = 0;
  let momentumStatus = 'Weak Momentum';
  if (candles1m.length >= 3) {
    const last3 = candles1m.slice(-3);
    const greenCount = last3.filter(c => c.close > c.open).length;
    const higherHighs = last3[2].high > last3[1].high && last3[1].high > last3[0].high;

    if (greenCount === 3 && higherHighs) {
      candleStrengthScore = 15;
      momentumStatus = 'Strong Bullish Trend (3 Green + Higher Highs)';
    } else if (greenCount >= 2) {
      candleStrengthScore = 10;
      momentumStatus = 'Moderate Bullish Trend (2 Green)';
    } else if (greenCount === 1) {
      candleStrengthScore = 5;
      momentumStatus = 'Weak Trend (1 Green)';
    }
  }

  const finalScore = breakoutScore + volumeScore + vwapScore + relativeStrengthScore + candleStrengthScore;
  
  let signal = 'Avoid';
  if (finalScore >= 70) signal = 'Strong Continuation';
  else if (finalScore >= 50) signal = 'Moderate';

  // Target & SL Calculations (using ATR and OR)
  const atr = calculateATR(candles1m);
  const atrValue = atr > 0 ? atr : currentPrice * 0.003;
  
  let stopLoss = currentPrice - (1.5 * atrValue);
  let target = currentPrice + (3.0 * atrValue);

  // If opening range is set, place SL below OR Low for safety
  if (openingRange && openingRange.low) {
    stopLoss = Math.min(stopLoss, openingRange.low);
  }

  return {
    score: finalScore,
    signal,
    stopLoss: parseFloat(stopLoss.toFixed(2)),
    target: parseFloat(target.toFixed(2)),
    factors: {
      breakout: { score: breakoutScore, status: breakoutStatus },
      volume: { score: volumeScore, status: volumeStatus },
      vwap: { score: vwapScore, status: vwapStatus },
      relativeStrength: { score: relativeStrengthScore, status: rsStatus },
      candleStrength: { score: candleStrengthScore, status: momentumStatus }
    }
  };
};

/**
 * Execute Scanner & Rank Stocks in Watched List
 */
export const runScanner = async (simTimeOverride = null) => {
  const activeTime = simTimeOverride ? new Date(simTimeOverride) : getActiveISTTime();
  const dateStr = activeTime.toISOString().split('T')[0];

  // We need Nifty index candles first for RS scoring
  const niftyCandles = await getCandleData('NIFTY50', activeTime, true);

  const scanResults = [];

  for (const symbol of customWatchlist) {
    try {
      const candles = await getCandleData(symbol, activeTime, true);
      if (candles.length === 0) continue;

      const openingRange = getOpeningRange(candles, dateStr, symbol);
      const scoreData = calculateMomentumScore(symbol, candles, openingRange, niftyCandles);
      const latestPrice = candles[candles.length - 1].close;

      scanResults.push({
        symbol,
        price: latestPrice,
        openingRange,
        ...scoreData
      });
    } catch (err) {
      logger.error(`Error scanning ${symbol}`, { error: err.message });
    }
  }

  // Sort by score descending
  scanResults.sort((a, b) => b.score - a.score);

  // Broadcast results via socket.io
  if (global.io) {
    global.io.emit('scanner_update', scanResults);
  }

  return scanResults;
};
