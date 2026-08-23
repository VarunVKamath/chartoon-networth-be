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
  clearPaperPosition,
  getAvailableCash,
  getRealTradingMode
} from './kiteService.js';
import { isWithinTradingWindow, isActiveWindow } from './timeService.js';
import winston from 'winston';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORAGE_DIR = path.join(__dirname, '../storage');
const SETTINGS_FILE = path.join(STORAGE_DIR, 'early_edge_settings.json');
const WHAT_IF_FILE = path.join(STORAGE_DIR, 'what_if_analysis.json');

// Configurable Settings with persistence
let earlyEdgeSettings = {
  operatingMode: 'TEST',       // 'TEST' or 'PROD'
  stopLossPct: 0.75,          // mandatory stop loss %
  targetPct: 1.5,             // target move (1.5%)
  capitalPool: 10000,         // starting mock capital pool
  maxCapitalRisk: 500,        // max capital at risk per trade
  dailyMaxLossLimit: 2.0,     // daily maximum loss limit % (2% of capital)
  slippagePct: 0.2,           // slippage buffer % (0.2% by default)
  minLiquidityVolume: 100000, // minimum volume required in 9:15-9:30 range
  maxTradesPerDay: 1          // strict trade count limit per day
};

const loadSettings = () => {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      earlyEdgeSettings = { ...earlyEdgeSettings, ...data };
      logger.info('Loaded early edge settings from file', earlyEdgeSettings);
    }
  } catch (err) {
    logger.error('Failed to load settings', err);
  }
};
loadSettings();

const saveSettings = () => {
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(earlyEdgeSettings, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save settings', err);
  }
};

let whatIfData = null;

const loadWhatIfData = () => {
  try {
    if (fs.existsSync(WHAT_IF_FILE)) {
      whatIfData = JSON.parse(fs.readFileSync(WHAT_IF_FILE, 'utf-8'));
    }
  } catch (err) {
    logger.error('Failed to load what-if data', err);
  }
};
loadWhatIfData();

export const getWhatIfData = () => whatIfData;

export const saveWhatIfData = (data) => {
  whatIfData = data;
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
    fs.writeFileSync(WHAT_IF_FILE, JSON.stringify(whatIfData, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save what-if data', err);
  }
};

const STOP_LOSS_PCT = earlyEdgeSettings.stopLossPct;
const TARGET_PCT = earlyEdgeSettings.targetPct;
const CAPITAL_POOL = earlyEdgeSettings.capitalPool;
const MAX_RISK_PCT = 0.5; // risk fallback
const MAX_DAILY_LOSS_PCT = earlyEdgeSettings.dailyMaxLossLimit;

// In-memory state (production: persist to DB/file)
let currentTrade = null;        // Active position
let tradeHistory = [];          // All past trades
let lastTradeDate = null;       // Prevent multiple trades same day
let monitorInterval = null;     // For SL/Target checking

const getDailyLossPercent = () => {
  const today = new Date().toISOString().split('T')[0];
  const todaysTrades = tradeHistory.filter(t => t.sellTime && t.sellTime.startsWith(today));
  const totalPnL = todaysTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  return (totalPnL < 0) ? (Math.abs(totalPnL) / CAPITAL_POOL) * 100 : 0;
};

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
  if (!isActiveWindow() && bestStock.variety !== 'amo') {
    addLog('BUY rejected: Outside 8:45 AM - 10:15 AM IST active trading window.', 'warn');
    return { success: false, reason: 'Outside trading hours' };
  }

  if (!bestStock.bypassTradeCheck && !canTradeToday()) {
    addLog('Trade already executed today. Skipping.', 'warn');
    return { success: false, reason: 'Already traded today' };
  }

  const dailyLossPct = getDailyLossPercent();
  if (dailyLossPct >= earlyEdgeSettings.dailyMaxLossLimit) {
    addLog(`BUY rejected: Maximum daily loss limit exceeded (${dailyLossPct.toFixed(2)}% >= ${earlyEdgeSettings.dailyMaxLossLimit}%).`, 'warn');
    return { success: false, reason: 'Max daily loss limit exceeded' };
  }

  const { symbol, lastPrice, openPrice } = bestStock;
  const entryPrice = lastPrice || openPrice;

  if (!entryPrice || entryPrice <= 0) {
    addLog(`Invalid entry price for ${symbol}`, 'error');
    return { success: false, reason: 'Invalid price' };
  }

  let quantity = bestStock.quantity;
  if (getRealTradingMode()) {
    quantity = 1; // Force 1 share for real trading as per user safety requirement
    addLog(`[Live Safety] Forcing order quantity to 1 share for live trading.`);
  } else if (!quantity) {
    // Dynamic position sizing based on risk
    const stopLossDistance = entryPrice * (earlyEdgeSettings.stopLossPct / 100);
    const maxRiskAmount = CAPITAL_POOL * (MAX_RISK_PCT / 100);
    quantity = Math.floor(maxRiskAmount / stopLossDistance);
    
    // Cap position size to stay within available capital
    const maxBuyable = Math.floor(CAPITAL_POOL / entryPrice);
    quantity = Math.min(quantity, maxBuyable);
    
    if (quantity <= 0) {
      quantity = 1;
    }
  }

  try {
    const orderType = bestStock.variety === 'amo' ? 'LIMIT' : 'MARKET';
    
    // Apply slippage buffer to the order price if limit order
    const orderPrice = orderType === 'LIMIT' ? entryPrice * (1 + earlyEdgeSettings.slippagePct / 100) : undefined;

    const orderResult = await placeOrder({
      tradingsymbol: symbol,
      transaction_type: 'BUY',
      quantity,
      order_type: orderType,
      product: 'MIS',
      variety: bestStock.variety || 'regular',
      price: orderPrice
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
      stopLossPrice: actualEntry * (1 - earlyEdgeSettings.stopLossPct / 100),
      targetPrice: actualEntry * (1 + earlyEdgeSettings.targetPct / 100),
      isPaper: orderResult.is_paper || false
    };

    lastTradeDate = new Date().toISOString().split('T')[0];

    addLog(`[Audit Log] BUY executed: ${symbol} @ ₹${actualEntry.toFixed(2)} | Qty: ${quantity} | SL: ₹${currentTrade.stopLossPrice.toFixed(2)} | Target: ₹${currentTrade.targetPrice.toFixed(2)}`);

    // Start monitoring for SL/Target
    startPositionMonitor();

    return { 
      success: true, 
      trade: currentTrade,
      order: orderResult 
    };
  } catch (error) {
    addLog(`[Audit Log] BUY failed for ${symbol}: ${error.message}`, 'error');
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

    // Safety: Force exit if trading window has closed (passed 11:00 AM IST)
    if (!isWithinTradingWindow()) {
      addLog('Trading window closed. Forcing auto-exit of active position.', 'warn');
      await executeSell('WINDOW_CLOSE_FORCE_EXIT');
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

    addLog(`[Audit Log] SELL executed (${reason}): ${symbol} @ ₹${actualExit.toFixed(2)} | PnL: ₹${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);

    // Update What-If hypothetical trades exit prices if they exist
    if (whatIfData && whatIfData.hypotheticalTrades) {
      try {
        const symbolsToFetch = whatIfData.hypotheticalTrades.map(t => `NSE:${t.symbol}`);
        if (symbolsToFetch.length > 0) {
          const quotes = await getQuotes(symbolsToFetch);
          whatIfData.hypotheticalTrades = whatIfData.hypotheticalTrades.map(cand => {
            const quote = quotes[`NSE:${cand.symbol}`];
            const exitP = quote?.last_price || cand.entryPrice;
            const hypPnL = (exitP - cand.entryPrice) * cand.quantity;
            const hypPnLPercent = ((exitP - cand.entryPrice) / cand.entryPrice) * 100;
            return {
              ...cand,
              exitPrice: parseFloat(exitP.toFixed(2)),
              pnl: parseFloat(hypPnL.toFixed(2)),
              pnlPercent: parseFloat(hypPnLPercent.toFixed(2))
            };
          });
          
          if (whatIfData.actualTrade && whatIfData.actualTrade.symbol === symbol) {
            whatIfData.actualTrade.exitPrice = actualExit;
            whatIfData.actualTrade.pnl = completedTrade.pnl;
            whatIfData.actualTrade.pnlPercent = completedTrade.pnlPercent;
          }
          
          saveWhatIfData(whatIfData);
          addLog(`[Audit Log] What-If analysis updated for completed trade on ${symbol}.`);
        }
      } catch (err) {
        logger.error('Failed to update what-if exit prices', err);
      }
    }

    // Cleanup
    currentTrade = null;
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
    clearPaperPosition();

    return { success: true, trade: completedTrade };
  } catch (error) {
    addLog(`[Audit Log] SELL failed: ${error.message}`, 'error');
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
export const manualBuy = async (symbol, quantity, bypassTradeCheck = false, variety = 'regular') => {
  let price = 1000;
  try {
    const quotes = await getQuotes([`NSE:${symbol.toUpperCase()}`]);
    price = quotes[`NSE:${symbol.toUpperCase()}`]?.last_price || 1000;
  } catch (err) {
    logger.warn(`Failed to fetch quote for ${symbol}, using default 1000`, { error: err.message });
  }

  // Simulate bestStock object
  const fakeBest = {
    symbol: symbol.toUpperCase(),
    lastPrice: price,
    openPrice: price,
    quantity,
    bypassTradeCheck,
    variety
  };
  return executeBuy(fakeBest);
};

export const getOperatingMode = () => earlyEdgeSettings.operatingMode;
export const setOperatingMode = (mode) => {
  if (mode !== 'TEST' && mode !== 'PROD') {
    throw new Error('Mode must be TEST or PROD');
  }
  earlyEdgeSettings.operatingMode = mode;
  saveSettings();
  addLog(`Operating mode switched to ${mode}`);
  return earlyEdgeSettings.operatingMode;
};

export const getEarlyEdgeSettings = () => ({ ...earlyEdgeSettings });
export const updateEarlyEdgeSettings = (newSettings) => {
  earlyEdgeSettings = { ...earlyEdgeSettings, ...newSettings };
  saveSettings();
  addLog(`Early edge settings updated`);
  return earlyEdgeSettings;
};

/**
 * Execute early-morning trade from ranked scanner list
 */
export const executeMorningTrade = async (rankedStocks) => {
  if (!isActiveWindow()) {
    addLog('[Audit Log] Execute morning trade rejected: Outside 8:45 AM - 10:15 AM active window.', 'warn');
    return { success: false, reason: 'Outside active trading hours' };
  }
  if (!canTradeToday()) {
    addLog('[Audit Log] Execute morning trade skipped: Trade already executed today.');
    return { success: false, reason: 'Already traded today' };
  }

  const dailyLossPct = getDailyLossPercent();
  if (dailyLossPct >= earlyEdgeSettings.dailyMaxLossLimit) {
    addLog(`[Audit Log] Morning trade rejected: Daily loss limit hit (${dailyLossPct.toFixed(2)}%).`);
    return { success: false, reason: 'Daily loss limit hit' };
  }

  // Get available cash
  const availableCash = await getAvailableCash();
  addLog(`[Audit Log] Starting 9:30 AM execution. Available cash: ₹${availableCash.toFixed(2)} | Mode: ${earlyEdgeSettings.operatingMode}`);

  let purchasedStock = null;
  let purchasedQty = 0;
  let purchasePrice = 0;
  let errorReason = '';

  for (const stock of rankedStocks) {
    const symbol = stock.symbol;
    const price = stock.price || stock.lastPrice;

    if (!price || price <= 0) {
      addLog(`[Audit Log] Skipping ${symbol}: Invalid price (₹${price})`, 'warn');
      continue;
    }

    // Liquidity check: Minimum volume filter
    if (stock.volume && stock.volume < earlyEdgeSettings.minLiquidityVolume) {
      addLog(`[Audit Log] Risk Check: Skipping ${symbol} | Low liquidity (volume ${stock.volume} < ${earlyEdgeSettings.minLiquidityVolume}).`);
      continue;
    }

    // Circuit limit check: Avoid stocks up/down >= 9.0% from open/prevClose
    const changePct = stock.gapPercent || 0;
    if (Math.abs(changePct) >= 9.0) {
      addLog(`[Audit Log] Risk Check: Skipping ${symbol} | Near circuit limit (change ${changePct.toFixed(2)}% >= 9.0%).`);
      continue;
    }

    // Quantity logic based on mode
    let qty = 0;
    if (earlyEdgeSettings.operatingMode === 'TEST') {
      qty = 1;
    } else {
      // Prod Mode: Usually buys max shares possible, but restricted to 1 share per user instructions for safety
      qty = 1;
    }

    if (qty <= 0) {
      addLog(`[Audit Log] Affordability Check: Skipping ${symbol} | Cost (₹${price.toFixed(2)}) exceeds available cash (₹${availableCash.toFixed(2)}).`);
      continue;
    }

    const priceWithSlippage = price * (1 + earlyEdgeSettings.slippagePct / 100);
    const totalCost = qty * priceWithSlippage;

    if (totalCost > availableCash) {
      addLog(`[Audit Log] Affordability Check: Skipping ${symbol} | Total cost (₹${totalCost.toFixed(2)}) exceeds available cash (₹${availableCash.toFixed(2)}).`);
      continue;
    }

    // Attempt purchase
    addLog(`[Audit Log] Executing buy for ${symbol} | Qty: ${qty} | Estimated price (with slippage): ₹${priceWithSlippage.toFixed(2)}`);
    
    const buyResult = await executeBuy({
      symbol,
      lastPrice: price,
      openPrice: price,
      quantity: qty,
      bypassTradeCheck: true
    });

    if (buyResult.success) {
      purchasedStock = symbol;
      purchasedQty = qty;
      purchasePrice = buyResult.trade.entryPrice;
      
      // Store What-If Candidates (next 4 ranked stocks)
      const startIndex = rankedStocks.findIndex(s => s.symbol === symbol) + 1;
      const candidates = rankedStocks.slice(startIndex, startIndex + 4);
      const whatIfCandidates = [];
      
      for (const cand of candidates) {
        const candPrice = cand.price || cand.lastPrice;
        let candQty = 1;
        if (earlyEdgeSettings.operatingMode === 'PROD') {
          candQty = Math.floor(availableCash / (candPrice * (1 + earlyEdgeSettings.slippagePct / 100)));
        }
        whatIfCandidates.push({
          symbol: cand.symbol,
          entryPrice: candPrice,
          quantity: candQty,
          exitPrice: null,
          pnl: null,
          pnlPercent: null
        });
      }

      saveWhatIfData({
        tradeDate: new Date().toISOString().split('T')[0],
        actualTrade: {
          symbol: symbol,
          entryPrice: purchasePrice,
          quantity: qty,
          exitPrice: null,
          pnl: null,
          pnlPercent: null
        },
        hypotheticalTrades: whatIfCandidates
      });

      break; // Successfully placed 1 trade for the day
    } else {
      errorReason = buyResult.reason;
      addLog(`[Audit Log] Order execution failed for ${symbol}: ${buyResult.reason}. Cascading to next ranked stock...`, 'error');
    }
  }

  if (purchasedStock) {
    return { success: true, symbol: purchasedStock, qty: purchasedQty, price: purchasePrice };
  } else {
    const finalReason = errorReason || 'No affordable compliant stock found';
    addLog(`[Audit Log] Morning trade execution ended. No trade placed. Reason: ${finalReason}`, 'warn');
    return { success: false, reason: finalReason };
  }
};
