/**
 * API Routes
 * All REST endpoints for the React dashboard to consume.
 * - Auth (Kite login flow)
 * - Strategy config & status
 * - Manual controls (buy/sell/emergency)
 * - Data polling (current trade, history, logs, ranking)
 */

import express from 'express';
import { 
  initializeKite, 
  getLoginURL, 
  generateSession, 
  isSessionActive 
} from '../services/kiteService.js';
import { sessionService } from '../services/sessionService.js';
import { 
  selectBestStock, 
  getStockUniverse, 
  updateStockUniverse 
} from '../services/strategyService.js';
import { 
  executeBuy, 
  executeSell, 
  emergencySquareOff, 
  getCurrentTrade, 
  getTradeHistory, 
  getLiveLogs,
  manualBuy,
  resetDailyState
} from '../services/orderService.js';

const router = express.Router();

// === HEALTH & STATUS ===
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    kiteSessionActive: isSessionActive(),
    tradingMode: process.env.REAL_TRADING === 'true' ? 'REAL' : 'PAPER'
  });
});

// === AUTH / KITE LOGIN FLOW ===
router.get('/auth/login-url', (req, res) => {
  try {
    const loginUrl = getLoginURL();
    res.json({ loginUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/auth/generate-session', async (req, res) => {
  try {
    const { request_token } = req.body;
    if (!request_token) {
      return res.status(400).json({ error: 'request_token is required' });
    }
    const result = await generateSession(request_token);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/auth/login', (req, res) => {
  try {
    const loginUrl = getLoginURL();
    res.json({ loginUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/auth/callback', async (req, res) => {
  try {
    const { requestToken, request_token } = req.body;
    const token = requestToken || request_token;
    if (!token) {
      return res.status(400).json({ error: 'requestToken is required' });
    }
    const result = await generateSession(token);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/auth/status', (req, res) => {
  const session = sessionService.getSession();
  res.json({ 
    connected: sessionService.isConnected(),
    userName: session.userName,
    userId: session.userId,
    loginTime: session.loginTime,
    mode: process.env.REAL_TRADING === 'true' ? 'REAL_TRADING' : 'PAPER_TRADING'
  });
});

router.post('/auth/logout', (req, res) => {
  try {
    sessionService.clearSession();
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === STRATEGY & STOCK CONFIG ===
router.get('/strategy/stocks', (req, res) => {
  res.json({ stocks: getStockUniverse() });
});

router.post('/strategy/stocks', (req, res) => {
  try {
    const { stocks } = req.body;
    const updated = updateStockUniverse(stocks);
    res.json({ success: true, stocks: updated });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/strategy/scan', async (req, res) => {
  try {
    const decision = await selectBestStock();
    res.json(decision);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === TRADE CONTROL ===
router.post('/trade/buy', async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    
    const result = await manualBuy(symbol);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/trade/sell', async (req, res) => {
  try {
    const result = await executeSell('MANUAL_SELL');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/trade/emergency-square-off', async (req, res) => {
  try {
    const result = await emergencySquareOff();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/trade/current', (req, res) => {
  const trade = getCurrentTrade();
  res.json({ 
    active: !!trade, 
    trade: trade || null 
  });
});

router.get('/trade/history', (req, res) => {
  res.json({ history: getTradeHistory() });
});

// === DASHBOARD DATA ===
router.get('/dashboard/status', (req, res) => {
  const trade = getCurrentTrade();
  let status = 'WAITING_FOR_MARKET';
  
  if (trade) {
    status = trade.status === 'ACTIVE' ? 'TRADE_ACTIVE' : 'POSITION_CLOSED';
  } else if (new Date().getHours() >= 9 && new Date().getHours() < 10) {
    status = 'SCANNING_STOCKS';
  }
  
  res.json({
    status,
    currentTrade: trade,
    mode: process.env.REAL_TRADING === 'true' ? 'REAL' : 'PAPER',
    lastUpdated: new Date().toISOString()
  });
});

router.get('/dashboard/logs', (req, res) => {
  res.json({ logs: getLiveLogs() });
});

router.post('/dashboard/reset', (req, res) => {
  resetDailyState();
  res.json({ success: true, message: 'Daily state reset' });
});

// === TEST MODE / DIAGNOSTICS ===
router.post('/test/trigger-idea-buy', async (req, res) => {
  try {
    if (!isSessionActive()) {
      return res.status(400).json({ error: 'Kite session is not active. Please connect Zerodha first.' });
    }

    const delaySeconds = req.body.delaySeconds !== undefined ? parseInt(req.body.delaySeconds, 10) : 60;
    if (isNaN(delaySeconds) || delaySeconds < 0) {
      return res.status(400).json({ error: 'Invalid delaySeconds' });
    }

    const pushLiveLog = (message, level = 'info') => {
      if (!global.liveLogs) global.liveLogs = [];
      global.liveLogs.push({
        time: new Date().toISOString(),
        message,
        level
      });
      if (global.liveLogs.length > 100) global.liveLogs.shift();
    };

    pushLiveLog(`[TEST MODE] Scheduled buy of 1 share of IDEA in ${delaySeconds} seconds.`, 'info');

    setTimeout(async () => {
      try {
        if (!isSessionActive()) {
          pushLiveLog(`[TEST MODE] Scheduled buy of IDEA failed: Kite session is no longer active.`, 'error');
          return;
        }

        pushLiveLog(`[TEST MODE] Triggering scheduled buy of 1 share of IDEA.`, 'info');
        const result = await manualBuy('IDEA', 1, true);
        
        if (result.success) {
          pushLiveLog(`[TEST MODE] Scheduled buy of 1 share of IDEA executed successfully! Order ID: ${result.order?.order_id || 'N/A'}.`, 'info');
        } else {
          pushLiveLog(`[TEST MODE] Scheduled buy of 1 share of IDEA failed: ${result.reason}`, 'error');
        }
      } catch (err) {
        pushLiveLog(`[TEST MODE] Error executing scheduled buy: ${err.message}`, 'error');
      }
    }, delaySeconds * 1000);

    res.json({
      success: true,
      message: `Scheduled buy of 1 share of IDEA in ${delaySeconds} seconds`
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
