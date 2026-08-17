/**
 * Scheduler (node-cron)
 * Runs the automated early-morning strategy at precise market times.
 * - 08:45 AM IST → Reset daily state
 * - 09:00 AM - 09:30 AM IST → Run continuous stock scanner (every 2 minutes)
 * - 09:30 AM IST → Auto BUY selected top ranked stock
 * - 09:45 AM IST → Force exit / square off active position
 * 
 * Timezone set to Asia/Kolkata.
 */

import cron from 'node-cron';
import { runScanner } from '../services/earlyEdgeService.js';
import { 
  executeSell, 
  resetDailyState,
  executeMorningTrade,
  canTradeToday 
} from '../services/orderService.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

let jobsStarted = false;

export const startSchedulers = () => {
  if (jobsStarted) {
    logger.warn('Schedulers already running');
    return;
  }

  logger.info('[Scheduler] Starting early morning trading schedulers...');

  // 1. Reset Daily State at 08:45 AM IST
  const resetJob = cron.schedule('45 8 * * *', () => {
    logger.info('=== 08:45 AM Reset: Clearing daily state ===');
    resetDailyState();
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  // 2. Continuous Scanner: 9:00 AM to 9:30 AM IST (every 2 minutes)
  const scannerJob = cron.schedule('*/2 9 * * *', async () => {
    const now = new Date();
    // Gating for exact 9:00 to 9:30 window
    const minutes = now.getMinutes();
    if (minutes > 30) {
      return;
    }

    logger.info(`=== ${now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' })} Scanner Triggered ===`);
    try {
      const results = await runScanner();
      logger.info(`Scanner completed. Ranked ${results.length} stocks.`);
    } catch (error) {
      logger.error('Continuous scanner job failed', { error: error.message });
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  // 3. Purchase Execution at 09:30 AM IST
  const buyJob = cron.schedule('30 9 * * *', async () => {
    logger.info('=== 09:30 AM Execution Job Triggered ===');
    try {
      // Run scanner one final time to get the latest 9:30 AM quotes/ranks
      const rankedStocks = await runScanner();
      
      if (rankedStocks && rankedStocks.length > 0) {
        const tradeResult = await executeMorningTrade(rankedStocks);
        if (tradeResult.success) {
          logger.info('Morning trade successfully executed', tradeResult);
        } else {
          logger.warn('Morning trade execution failed or skipped', { reason: tradeResult.reason });
        }
      } else {
        logger.warn('No ranked stocks available at 9:30 AM.');
      }
    } catch (error) {
      logger.error('Morning purchase job failed', { error: error.message });
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  // 4. Force Sell / Square-Off at 09:45 AM IST
  const exitJob = cron.schedule('45 9 * * *', async () => {
    logger.info('=== 09:45 AM Exit Job Triggered: Squaring off position ===');
    try {
      const sellResult = await executeSell('TIME_EXIT_0945AM');
      if (sellResult.success) {
        logger.info('Auto Sell/Square-Off completed', { pnl: sellResult.trade?.pnl });
      } else {
        logger.info('No active position to square off at 9:45 AM.');
      }
    } catch (error) {
      logger.error('Morning exit job failed', { error: error.message });
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  jobsStarted = true;
  logger.info('All morning trading cron jobs scheduled (8:45 AM Reset, 9:00-9:30 AM Scans, 9:30 AM Buy, 9:45 AM Exit)');

  return { resetJob, scannerJob, buyJob, exitJob };
};

export const stopSchedulers = () => {
  logger.info('Schedulers stopped');
  jobsStarted = false;
};

