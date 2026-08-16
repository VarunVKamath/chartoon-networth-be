/**
 * Time Service
 * Handles IST time conversions and validates the trading hours constraint (9:00 AM - 11:00 AM IST).
 */

import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

/**
 * Get current time converted to IST (UTC + 5:30)
 * Works reliably regardless of host machine timezone.
 */
export const getISTTime = () => {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istOffset = 5.5 * 3600000;
  return new Date(utc + istOffset);
};

/**
 * Check if current IST time falls within the 9:00 AM - 11:00 AM IST trading window.
 */
export const isWithinTradingWindow = () => {
  const istNow = getISTTime();
  const hours = istNow.getHours();
  const minutes = istNow.getMinutes();
  const seconds = istNow.getSeconds();
  
  // 9:00:00 AM <= IST < 11:00:00 AM
  const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
  const startSeconds = 9 * 3600;       // 09:00 AM
  const endSeconds = 11 * 3600;        // 11:00 AM
  
  const inWindow = totalSeconds >= startSeconds && totalSeconds < endSeconds;
  
  logger.info('Trading window check', {
    istTime: istNow.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' }),
    hours,
    minutes,
    inWindow
  });
  
  return inWindow;
};
