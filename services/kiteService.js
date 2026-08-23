/**
 * Kite Connect Service
 * Handles all interactions with Zerodha Kite API.
 * Supports both Paper Trading (simulation) and Real Trading modes.
 * Access token is persisted using sessionService.
 */

import { KiteConnect } from 'kiteconnect';
import dotenv from 'dotenv';
import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sessionService } from './sessionService.js';
import { decryptIfNeeded } from './cryptoService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORAGE_DIR = path.join(__dirname, '../storage');
const MODE_FILE = path.join(STORAGE_DIR, 'mode.json');

dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
  ]
});

let kiteInstance = null;

const loadTradingMode = () => {
  try {
    if (fs.existsSync(MODE_FILE)) {
      const data = JSON.parse(fs.readFileSync(MODE_FILE, 'utf-8'));
      return !!data.isRealTrading;
    }
  } catch (error) {
    console.error(`[KiteService] Failed to load trading mode: ${error.message}`);
  }
  return process.env.REAL_TRADING === 'true';
};

const saveTradingMode = (isReal) => {
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
    fs.writeFileSync(MODE_FILE, JSON.stringify({ isRealTrading: isReal }, null, 2), 'utf-8');
  } catch (error) {
    console.error(`[KiteService] Failed to save trading mode to file: ${error.message}`);
  }
};

let isRealTrading = loadTradingMode();

export const getRealTradingMode = () => isRealTrading;

// In-memory current position for paper trading simulation
let paperPosition = null;

/**
 * Initialize Kite Connect SDK client
 */
export const initializeKite = (apiKey = process.env.KITE_API_KEY || process.env.API_KEY) => {
  const decryptedKey = decryptIfNeeded(apiKey);
  if (!decryptedKey) {
    logger.warn('[KiteService] API_KEY / KITE_API_KEY is not defined. Kite initialization pending credentials.');
    return null;
  }
  kiteInstance = new KiteConnect({ api_key: decryptedKey });
  logger.info('KiteConnect instance initialized', { apiKey: decryptedKey.substring(0, 6) + '...' });
  return kiteInstance;
};

/**
 * Handle Token Expiry
 * 1. Disable strategy execution (by clearing the active session status)
 * 2. Prevent order placement (by clearing the stored credentials)
 * 3. Log errors and push a critical notification to UI live logs
 */
export const handleTokenExpiry = () => {
  logger.error('[KiteService] Zerodha session expired or token is invalid.');
  
  sessionService.clearSession();
  if (kiteInstance) {
    kiteInstance.setAccessToken(null);
  }

  // Push critical notification to UI logs
  if (!global.liveLogs) {
    global.liveLogs = [];
  }
  global.liveLogs.push({
    time: new Date().toISOString(),
    message: 'CRITICAL ERROR: Zerodha session expired. Strategy execution disabled. Please reconnect.',
    level: 'error'
  });
};

/**
 * Load persisted session from storage and validate with Zerodha
 */
export const restoreAndValidateSession = async () => {
  if (!kiteInstance) {
    initializeKite();
  }
  if (!kiteInstance) {
    logger.warn('[KiteService] Cannot restore session: KiteConnect is not initialized.');
    return false;
  }

  const session = sessionService.loadSession();
  if (session && session.accessToken) {
    logger.info('[KiteService] Persisted session found. Validating credentials with Zerodha...');
    kiteInstance.setAccessToken(session.accessToken);
    try {
      const profile = await kiteInstance.getProfile();
      logger.info(`[KiteService] Session successfully restored for user: ${profile.user_name} (${profile.user_id})`);
      return true;
    } catch (err) {
      logger.error(`[KiteService] Persisted session token is invalid: ${err.message}. Clearing stored session.`);
      handleTokenExpiry();
      return false;
    }
  }
  return false;
};

/**
 * Generate login redirect URL
 */
export const getLoginURL = () => {
  if (!kiteInstance) {
    initializeKite();
  }
  if (!kiteInstance) {
    throw new Error('KiteConnect not initialized. Please verify your KITE_API_KEY/API_KEY.');
  }
  return kiteInstance.getLoginURL();
};

/**
 * Handle request token exchange and generate session
 */
export const generateSession = async (requestToken) => {
  if (!kiteInstance) {
    initializeKite();
  }
  if (!kiteInstance) {
    throw new Error('KiteConnect not initialized.');
  }
  try {
    const apiSecret = decryptIfNeeded(process.env.KITE_API_SECRET || process.env.API_SECRET);
    if (!apiSecret) {
      throw new Error('KITE_API_SECRET / API_SECRET is required but not configured.');
    }

    const session = await kiteInstance.generateSession(requestToken, apiSecret);
    
    // Save to persistence
    sessionService.saveSession({
      accessToken: session.access_token,
      publicToken: session.public_token,
      userId: session.user_id,
      userName: session.user_name
    });

    kiteInstance.setAccessToken(session.access_token);
    
    logger.info('Kite session generated successfully', { 
      user_id: session.user_id,
      access_token_preview: session.access_token.substring(0, 10) + '...'
    });
    
    return {
      success: true,
      accessToken: session.access_token,
      userId: session.user_id,
      userName: session.user_name
    };
  } catch (error) {
    logger.error('Failed to generate Kite session', { error: error.message });
    throw new Error(`Session generation failed: ${error.message}`);
  }
};

/**
 * Get configured Kite Connect SDK client instance
 */
export const getKiteInstance = () => {
  if (!kiteInstance) {
    initializeKite();
  }
  const token = sessionService.getAccessToken();
  if (!kiteInstance || !token) {
    throw new Error('Kite session not active. Please complete login flow first.');
  }
  kiteInstance.setAccessToken(token);
  return kiteInstance;
};

/**
 * Check if the current session is connected/active
 */
export const isSessionActive = () => {
  return !!(kiteInstance && sessionService.isConnected());
};

/**
 * Helper to execute with automatic token expiry detection
 */
const executeKiteCall = async (apiCallFn) => {
  try {
    return await apiCallFn();
  } catch (error) {
    // 403 Forbidden is Zerodha's standard expired/invalid token status
    if (error.status_code === 403 || error.message?.includes('Token') || error.message?.includes('403')) {
      handleTokenExpiry();
    }
    throw error;
  }
};

/**
 * Fetch full quotes for given instruments.
 * @param {string[]} instruments - e.g. ['NSE:RELIANCE', 'NSE:TCS']
 */
export const getQuotes = async (instruments) => {
  return executeKiteCall(async () => {
    const kite = getKiteInstance();
    const quotes = await kite.getQuote(instruments);
    logger.info('Fetched quotes', { count: Object.keys(quotes).length });
    return quotes;
  });
};

/**
 * Fetch LTP (Last Traded Price) - lighter than full quote.
 */
export const getLTP = async (instruments) => {
  return executeKiteCall(async () => {
    const kite = getKiteInstance();
    return await kite.getLTP(instruments);
  });
};

/**
 * Place order (Market order by default for this strategy).
 * In paper mode: simulates and returns fake order details.
 */
export const placeOrder = async (orderParams) => {
  // Before EVERY order:
  if (!sessionService.isConnected()) {
    throw new Error("Zerodha session expired");
  }

  const {
    tradingsymbol,
    exchange = 'NSE',
    transaction_type,
    quantity,
    order_type = 'MARKET',
    product = 'MIS', // Intraday
    variety = 'regular',
    ...rest
  } = orderParams;

  if (!isRealTrading) {
    // === PAPER TRADING MODE ===
    const simulatedOrder = {
      order_id: `PAPER_${Date.now()}_${tradingsymbol}`,
      tradingsymbol,
      exchange,
      transaction_type,
      quantity,
      order_type,
      product,
      variety,
      status: 'COMPLETE',
      average_price: orderParams.price || 0,
      placed_at: new Date().toISOString(),
      is_paper: true
    };
    
    logger.info('[PAPER TRADING] Order simulated (NO REAL MONEY)', simulatedOrder);
    
    // Simulate position for paper mode
    if (transaction_type === 'BUY') {
      paperPosition = {
        tradingsymbol,
        quantity,
        average_price: 0, // updated later with real entry price from quote
        buy_time: new Date().toISOString(),
        order_id: simulatedOrder.order_id
      };
    } else if (transaction_type === 'SELL' && paperPosition) {
      paperPosition.exit_price = orderParams.price || 0;
      paperPosition.sell_time = new Date().toISOString();
      paperPosition.pnl = (paperPosition.exit_price - paperPosition.average_price) * quantity;
    }
    
    return simulatedOrder;
  }

  // === REAL TRADING ===
  // Additionally validate session before placing live orders:
  await executeKiteCall(async () => {
    const kite = getKiteInstance();
    await kite.getProfile();
  });

  return executeKiteCall(async () => {
    const kite = getKiteInstance();
    const orderResponse = await kite.placeOrder(variety, {
      tradingsymbol,
      exchange,
      transaction_type,
      quantity,
      order_type,
      product,
      ...rest
    });
    
    logger.info('REAL order placed successfully', { 
      order_id: orderResponse.order_id,
      symbol: tradingsymbol,
      type: transaction_type 
    });
    
    return orderResponse;
  });
};

export const getPositions = async () => {
  if (!isRealTrading) {
    // Return simulated paper position
    return paperPosition ? [paperPosition] : [];
  }
  return executeKiteCall(async () => {
    const kite = getKiteInstance();
    return await kite.getPositions();
  });
};

export const getHoldings = async () => {
  if (!isRealTrading) {
    return []; // Paper mode usually no holdings for MIS
  }
  return executeKiteCall(async () => {
    const kite = getKiteInstance();
    return await kite.getHoldings();
  });
};

/**
 * Square off / cancel if needed. For simplicity, we use market sell for exit.
 */
export const squareOffPosition = async (symbol, quantity) => {
  return placeOrder({
    tradingsymbol: symbol,
    transaction_type: 'SELL',
    quantity,
    order_type: 'MARKET',
    product: 'MIS'
  });
};

export const getCurrentPaperPosition = () => paperPosition;
export const clearPaperPosition = () => { paperPosition = null; };

export const getAvailableCash = async () => {
  if (!isSessionActive()) {
    return parseFloat(process.env.CAPITAL_POOL) || 10000;
  }
  try {
    const kite = getKiteInstance();
    const margins = await kite.getMargins();
    const cash = margins?.equity?.available?.cash || margins?.equity?.net;
    if (cash !== undefined && cash !== null) {
      return parseFloat(cash);
    }
    return parseFloat(process.env.CAPITAL_POOL) || 10000;
  } catch (error) {
    logger.warn('[KiteService] Failed to fetch margins from Zerodha, using fallback capital pool', { error: error.message });
    return parseFloat(process.env.CAPITAL_POOL) || 10000;
  }
};

export const setRealTradingMode = (enabled) => {
  isRealTrading = !!enabled;
  saveTradingMode(isRealTrading);
  logger.info(`[KiteService] Real trading mode set to: ${isRealTrading}`);
};
