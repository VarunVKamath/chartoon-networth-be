/**
 * Order Service
 * Manages the full trade lifecycle:
 * - Execute BUY at 9:15 AM (if strategy selects)
 * - Real-time monitoring for Stop Loss (0.75%) and Target (1.5%)
 * - Auto SELL at 10:00 AM or on SL/Target hit
 * - Records full trade history and PnL
 * - Paper trading safe by default
 */

import { 
  placeOrder, 
  getQuotes, 
  getCurrentPaperPosition, 
  clearPaperPosition 
} from './kiteService.js';
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PERCENT) || 0.75;
const TARGET_PCT = parseFloat(process.env.TARGET_PERCENT) || 1.5;
const POSITION_SIZE = 50; // Number of shares. TODO: Make configurable per stock/risk

// In-memory state (production: persist to DB/file)
let currentTrade = null;        // Active position
let tradeHistory = [];          // All past trades
let lastTradeDate = null;       // Prevent multiple trades same day
let monitorInterval = null;     // For SL/Target checking

const addLog = (message, level = 'info') => {
  const logEntry = { time: new Date().toISOString(), message, level };
  // In real app, push to a global logs array exposed via API
  if (!global.liveLogs) global.liveLogs = [];
  global.liveLogs.push(logEntry);
  if (global.liveLogs.length > 100) global.liveLogs.shift(); // Keep last 100
  logger[level](message);
};

/**
 * Check if we already traded today (prevents multiple entries)
 */
export const canTradeToday = () => {
  const today = new Date().toISOString().split('T')[0];
  return lastTradeDate !== today;
};

/**
 * Execute BUY order for the selected stock.
 * Stores entry details and starts SL/Target monitor.
 */
export const executeBuy = async (bestStock) => {
  if (!bestStock.bypassTradeCheck && !canTradeToday()) {
    addLog('Trade already executed today. Skipping.', 'warn');
    return { success: false, reason: 'Already traded today' };
  }

  const { symbol, lastPrice, openPrice } = bestStock;
  const entryPrice = lastPrice || openPrice;

  if (!entryPrice || entryPrice <= 0) {
    addLog(`Invalid entry price for ${symbol}`, 'error');
    return { success: false, reason: 'Invalid price' };
  }

  const quantity = bestStock.quantity || POSITION_SIZE;

  try {
    const orderResult = await placeOrder({
      tradingsymbol: symbol,
      transaction_type: 'BUY',
      quantity,
      order_type: 'MARKET',
      product: 'MIS'
    });

    // Update entry price from actual fill if available (paper uses lastPrice)
    const actualEntry = orderResult.average_price > 0 ? orderResult.average_price : entryPrice;

    currentTrade = {
      symbol,
      entryPrice: actualEntry,
      quantity,
      buyTime: new Date().toISOString(),
      orderId: orderResult.order_id,
      status: 'ACTIVE',
      stopLossPrice: actualEntry * (1 - STOP_LOSS_PCT / 100),
      targetPrice: actualEntry * (1 + TARGET_PCT / 100),
      isPaper: orderResult.is_paper || false
    };

    lastTradeDate = new Date().toISOString().split('T')[0];

    addLog(`BUY executed: ${symbol} @ ₹${actualEntry.toFixed(2)} | Qty: ${quantity} | SL: ₹${currentTrade.stopLossPrice.toFixed(2)} | Target: ₹${currentTrade.targetPrice.toFixed(2)}`);

    // Start monitoring for SL/Target
    startPositionMonitor();

    return { 
      success: true, 
      trade: currentTrade,
      order: orderResult 
    };
  } catch (error) {
    addLog(`BUY failed for ${symbol}: ${error.message}`, 'error');
    return { success: false, reason: error.message };
  }
};

/**
 * Start periodic price checking for SL/Target hit.
 * Runs every 15 seconds while trade is active.
 */
const startPositionMonitor = () => {
  if (monitorInterval) clearInterval(monitorInterval);

  monitorInterval = setInterval(async () => {
    if (!currentTrade || currentTrade.status !== 'ACTIVE') {
      clearInterval(monitorInterval);
      monitorInterval = null;
      return;
    }

    try {
      const instrument = `NSE:${currentTrade.symbol}`;
      const quotes = await getQuotes([instrument]);
      const quote = quotes[instrument];
      
      if (!quote || !quote.last_price) return;

      const currentPrice = quote.last_price;
      const { stopLossPrice, targetPrice, entryPrice, quantity, symbol } = currentTrade;

      let exitReason = null;

      if (currentPrice <= stopLossPrice) {
        exitReason = 'STOP_LOSS_HIT';
      } else if (currentPrice >= targetPrice) {
        exitReason = 'TARGET_HIT';
      }

      if (exitReason) {
        addLog(`${exitReason}: ${symbol} @ ₹${currentPrice.toFixed(2)}`);
        await executeSell(exitReason, currentPrice);
      } else {
        // Update live PnL for dashboard
        currentTrade.currentPrice = currentPrice;
        currentTrade.unrealizedPnl = (currentPrice - entryPrice) * quantity;
      }
    } catch (err) {
      logger.error('Monitor error', { error: err.message });
    }
  }, 15000); // Check every 15 seconds

  addLog('Position monitor started (every 15s)');
};

/**
 * Execute SELL (exit) order.
 * Can be called by scheduler at 10:00 AM or by monitor on SL/Target.
 */
export const executeSell = async (reason = 'TIME_EXIT', exitPriceOverride = null) => {
  if (!currentTrade || currentTrade.status !== 'ACTIVE') {
    addLog('No active position to sell', 'warn');
    return { success: false, reason: 'No active trade' };
  }

  const { symbol, quantity, entryPrice, buyTime } = currentTrade;

  try {
    let exitPrice = exitPriceOverride;

    if (!exitPrice) {
      // Fetch latest price for market sell
      const quotes = await getQuotes([`NSE:${symbol}`]);
      exitPrice = quotes[`NSE:${symbol}`]?.last_price || entryPrice;
    }

    const orderResult = await placeOrder({
      tradingsymbol: symbol,
      transaction_type: 'SELL',
      quantity,
      order_type: 'MARKET',
      product: 'MIS'
    });

    const actualExit = orderResult.average_price > 0 ? orderResult.average_price : exitPrice;

    const pnl = (actualExit - entryPrice) * quantity;
    const pnlPercent = ((actualExit - entryPrice) / entryPrice) * 100;

    const completedTrade = {
      ...currentTrade,
      exitPrice: actualExit,
      sellTime: new Date().toISOString(),
      pnl: parseFloat(pnl.toFixed(2)),
      pnlPercent: parseFloat(pnlPercent.toFixed(2)),
      exitReason: reason,
      status: 'CLOSED',
      sellOrderId: orderResult.order_id
    };

    tradeHistory.unshift(completedTrade); // Latest first
    if (tradeHistory.length > 50) tradeHistory.pop(); // Keep last 50

    addLog(`SELL executed (${reason}): ${symbol} @ ₹${actualExit.toFixed(2)} | PnL: ₹${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);

    // Cleanup
    currentTrade = null;
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
    clearPaperPosition();

    return { success: true, trade: completedTrade };
  } catch (error) {
    addLog(`SELL failed: ${error.message}`, 'error');
    return { success: false, reason: error.message };
  }
};

/**
 * Force exit (Emergency Square Off button)
 */
export const emergencySquareOff = async () => {
  if (!currentTrade) {
    return { success: false, message: 'No active position' };
  }
  addLog('EMERGENCY SQUARE OFF triggered by user');
  return await executeSell('EMERGENCY_SQUARE_OFF');
};

/**
 * Get current active trade status (for dashboard polling)
 */
export const getCurrentTrade = () => {
  if (!currentTrade) return null;
  
  // Attach live PnL if monitor running
  return {
    ...currentTrade,
    isMonitoring: !!monitorInterval
  };
};

/**
 * Get trade history
 */
export const getTradeHistory = () => [...tradeHistory];

/**
 * Get live logs (last 50)
 */
export const getLiveLogs = () => {
  return global.liveLogs ? [...global.liveLogs].reverse() : [];
};

/**
 * Reset for new day (called by scheduler at midnight or on demand)
 */
export const resetDailyState = () => {
  if (monitorInterval) clearInterval(monitorInterval);
  currentTrade = null;
  lastTradeDate = null;
  addLog('Daily state reset. Ready for new trading day.');
};

/**
 * Manual buy for testing (respects paper mode)
 */
export const manualBuy = async (symbol, quantity, bypassTradeCheck = false) => {
  // Simulate bestStock object
  const fakeBest = {
    symbol: symbol.toUpperCase(),
    lastPrice: 1000, // Will be overwritten by real quote in executeBuy
    openPrice: 1000,
    quantity,
    bypassTradeCheck
  };
  return executeBuy(fakeBest);
};
