/**
 * Main Express Application
 * Production-ready setup with:
 * - CORS for React frontend
 * - JSON body parsing
 * - Centralized error handling
 * - Winston logging
 * - Automatic scheduler startup
 * - Kite initialization
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import winston from 'winston';
import apiRoutes from './routes/index.js';
import { initializeKite, restoreAndValidateSession } from './services/kiteService.js';
import { startSchedulers } from './jobs/scheduler.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    // Production: add daily rotate file transport here
  ]
});

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173'], // Vite default + CRA
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, { 
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// API Routes
app.use('/api', apiRoutes);

// Root health check
app.get('/', (req, res) => {
  res.json({
    message: 'Zerodha Kite Auto Trader Backend',
    version: '1.0.0',
    mode: process.env.REAL_TRADING === 'true' ? 'REAL_TRADING_WARNING' : 'PAPER_TRADING_SAFE',
    docs: '/api/health'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { 
    error: err.message, 
    stack: err.stack,
    path: req.path 
  });
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Initialize everything
const startServer = async () => {
  try {
    // Initialize Kite (even if no token yet)
    initializeKite();
    logger.info('KiteConnect initialized');

    // Restore and validate persistent session
    try {
      await restoreAndValidateSession();
    } catch (sessionErr) {
      logger.error('Error during startup session restore', { error: sessionErr.message });
    }

    // Start the cron schedulers
    startSchedulers();

    app.listen(PORT, () => {
      logger.info(`🚀 Backend server running on http://localhost:${PORT}`);
      logger.info(`📊 Dashboard should connect to this API`);
      logger.info(`⚠️  Trading Mode: ${process.env.REAL_TRADING === 'true' ? 'REAL (DANGEROUS)' : 'PAPER (SAFE)'}`);
      logger.info(`📈 Strategy will auto-run at 9:15 AM IST`);
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
};

startServer();

export default app;
