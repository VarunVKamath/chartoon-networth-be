/**
 * Scheduler (node-cron)
 * Runs the automated strategy at precise market times.
 * - 09:15 AM IST → Stock scan + auto BUY if qualifies
 * - 10:00 AM IST → Force SELL (time-based exit)
 * 
 * Only one trade per day enforced in orderService.
 * Timezone set to Asia/Kolkata via env or cron options.
 */

import cron from 'node-cron';
import { selectBestStock } from '../services/strategyService.js';
import { 
  executeBuy, 
  executeSell, 
  resetDailyState,
  canTradeToday 
} from '../services/orderService.js';
import { sessionService } from '../services/sessionService.js';
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

  // 9:15 AM IST - Market Open Scanner + Auto Buy
  const morningJob = cron.schedule('15 9 * * *', async () => {
    logger.info('=== 9:15 AM JOB TRIGGERED: Starting stock scan ===');
    
    if (!sessionService.isConnected()) {
      logger.error('Strategy execution disabled: Zerodha session is not active.');
      if (!global.liveLogs) global.liveLogs = [];
      global.liveLogs.push({
        time: new Date().toISOString(),
        message: 'Strategy execution failed: Zerodha session is not active. Please reconnect.',
        level: 'error'
      });
      return;
    }

    if (!canTradeToday()) {
      logger.info('Trade already done today. Skipping morning scan.');
      return;
    }

    try {
      const decision = await selectBestStock();
      
      // Log top 3 for dashboard visibility
      if (decision.rankedStocks) {
        decision.rankedStocks.slice(0, 3).forEach((stock, idx) => {
          logger.info(`Rank #${idx + 1}: ${stock.symbol} | Score: ${stock.finalScore} | Gap: ${stock.gapPercent.toFixed(2)}% | Momentum: ${stock.momentumPercent.toFixed(2)}%`);
        });
      }

      if (decision.shouldTrade && decision.bestStock) {
        logger.info(`Selected ${decision.bestStock.symbol} for auto BUY`);
        const buyResult = await executeBuy(decision.bestStock);
        
        if (buyResult.success) {
          logger.info('Auto BUY successful', { trade: buyResult.trade });
        } else {
          logger.warn('Auto BUY failed', { reason: buyResult.reason });
        }
      } else {
        logger.info(`No trade today. Reason: ${decision.reason}`);
      }
    } catch (error) {
      logger.error('Morning job failed', { error: error.message });
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  // 10:00 AM IST - Force Exit (Time-based square off)
  const exitJob = cron.schedule('0 10 * * *', async () => {
    logger.info('=== 10:00 AM JOB TRIGGERED: Time-based exit ===');
    
    try {
      // executeSell will do nothing if no active position
      const sellResult = await executeSell('TIME_EXIT_10AM');
      if (sellResult.success) {
        logger.info('Auto SELL at 10AM completed', { pnl: sellResult.trade?.pnl });
      }
    } catch (error) {
      logger.error('Exit job failed', { error: error.message });
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  // Optional: Reset daily state at 00:30 AM (helps if app runs 24/7)
  const midnightReset = cron.schedule('30 0 * * *', () => {
    logger.info('Midnight reset triggered');
    resetDailyState();
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  jobsStarted = true;
  logger.info('All cron jobs scheduled successfully (9:15 AM, 10:00 AM, Midnight reset)');

  // Return for testing/manual trigger if needed
  return { morningJob, exitJob, midnightReset };
};

export const stopSchedulers = () => {
  // In production you would store job references and .stop() them
  logger.info('Schedulers stopped (restart app to re-enable)');
};
