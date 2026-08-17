/**
 * Time Service
 * Handles IST time conversions and validates the trading hours constraint (8:45 AM - 10:15 AM IST).
 * Supports simulated time machine operations.
 */

import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

let simulatedTime = null;

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
 * Check if current IST time falls within the 8:45 AM - 10:15 AM IST active window.
 */
export const isActiveWindow = () => {
  const time = getActiveISTTime();
  const hours = time.getHours();
  const minutes = time.getMinutes();
  const totalMinutes = hours * 60 + minutes;
  
  // 8:45 AM to 10:15 AM IST
  return totalMinutes >= (8 * 60 + 45) && totalMinutes < (10 * 60 + 15);
};

/**
 * Check if current IST time falls within the 9:00 AM - 9:30 AM IST scanning window.
 */
export const isScanningWindow = () => {
  const time = getActiveISTTime();
  const hours = time.getHours();
  const minutes = time.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  // 9:00 AM to 9:30 AM IST
  return totalMinutes >= (9 * 60) && totalMinutes < (9 * 60 + 30);
};

/**
 * Check if trade is active (9:30 AM - 9:45 AM IST)
 */
export const isTradeActiveWindow = () => {
  const time = getActiveISTTime();
  const hours = time.getHours();
  const minutes = time.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  // 9:30 AM to 9:45 AM IST
  return totalMinutes >= (9 * 60 + 30) && totalMinutes < (9 * 60 + 45);
};

// Keep for compatibility
export const isWithinTradingWindow = () => {
  return isActiveWindow();
};
