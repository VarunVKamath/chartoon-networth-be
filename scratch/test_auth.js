/**
 * Unit Test Script for Zerodha Kite Authentication System
 * Tests:
 * - Session Service (save, load, clear, corruption handling)
 * - Session Restoration and Validation on Startup
 * - Order Safety Checks (blocking orders when session is expired)
 * - Token Expiry Detection & Recovery
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define storage paths for testing
const storageDir = path.join(__dirname, '../storage');
const sessionFile = path.join(storageDir, 'session.json');

// Mock dependencies and environment variables
process.env.KITE_API_KEY = 'mock_api_key_12345';
process.env.KITE_API_SECRET = 'mock_api_secret_67890';
process.env.REAL_TRADING = 'false';

import { sessionService } from '../services/sessionService.js';
import * as kiteService from '../services/kiteService.js';

// Setup global logs array if not present
global.liveLogs = [];

const runTests = async () => {
  console.log('=== RUNNING AUTHENTICATION MODULE TESTS ===');

  try {
    // ----------------------------------------------------
    // TEST 1: Session persistence and directory creation
    // ----------------------------------------------------
    console.log('\n--- Test 1: Save & Load Session ---');
    sessionService.clearSession();
    assert.strictEqual(sessionService.isConnected(), false, 'Session should be empty on start');

    const dummySession = {
      accessToken: 'dummy_access_token_abc123',
      publicToken: 'dummy_public_token_def456',
      userId: 'USER123',
      userName: 'John Doe',
      loginTime: new Date().toISOString()
    };

    sessionService.saveSession(dummySession);
    assert.strictEqual(sessionService.isConnected(), true, 'Session should be connected after save');
    assert.strictEqual(sessionService.getAccessToken(), 'dummy_access_token_abc123', 'Access token should match');

    const loaded = sessionService.loadSession();
    assert.ok(loaded, 'Loaded session should not be null');
    assert.strictEqual(loaded.userId, 'USER123', 'User ID should persist');
    assert.strictEqual(loaded.userName, 'John Doe', 'User Name should persist');
    console.log('✅ Test 1 Passed: Session successfully saved, loaded and persisted');

    // ----------------------------------------------------
    // TEST 2: Graceful handling of corrupt file
    // ----------------------------------------------------
    console.log('\n--- Test 2: Corruption Recovery ---');
    // Write corrupt content to session.json
    fs.writeFileSync(sessionFile, '{ invalid json: "no closed quote }', 'utf-8');

    const corruptLoad = sessionService.loadSession();
    assert.strictEqual(corruptLoad, null, 'Corrupt session load should return null');
    assert.strictEqual(sessionService.isConnected(), false, 'Session should be cleared on corruption');
    console.log('✅ Test 2 Passed: Gracefully handled and repaired corrupt session file');

    // ----------------------------------------------------
    // TEST 3: Order Safety Checks (Paper Trading Mode)
    // ----------------------------------------------------
    console.log('\n--- Test 3: Order Safety block when disconnected ---');
    sessionService.clearSession();
    
    await assert.rejects(
      async () => {
        await kiteService.placeOrder({
          tradingsymbol: 'RELIANCE',
          transaction_type: 'BUY',
          quantity: 10
        });
      },
      /Zerodha session expired/,
      'Should block orders when session is missing'
    );
    console.log('✅ Test 3 Passed: Order blocked successfully when session is disconnected');

    // ----------------------------------------------------
    // TEST 4: Order Safety checks with active session
    // ----------------------------------------------------
    console.log('\n--- Test 4: Order succeeds in Paper Mode with active session ---');
    sessionService.saveSession(dummySession);
    
    // In paper mode, order validation should pass if session is connected
    const result = await kiteService.placeOrder({
      tradingsymbol: 'TCS',
      transaction_type: 'BUY',
      quantity: 5
    });

    assert.ok(result.order_id, 'Simulated order should return an order ID');
    assert.strictEqual(result.status, 'COMPLETE', 'Simulated status should be COMPLETE');
    assert.strictEqual(result.is_paper, true, 'Should be marked as paper trade');
    console.log('✅ Test 4 Passed: Paper order processed with active session');

    // ----------------------------------------------------
    // TEST 5: Startup Restoration
    // ----------------------------------------------------
    console.log('\n--- Test 5: Session Restoration on Startup ---');
    // Mock getProfile to succeed
    kiteService.initializeKite();
    
    // We mock kiteInstance.getProfile to return successfully
    const mockKite = kiteService.getKiteInstance();
    mockKite.getProfile = async () => {
      return { user_name: 'John Doe', user_id: 'USER123' };
    };

    const restored = await kiteService.restoreAndValidateSession();
    assert.strictEqual(restored, true, 'Should successfully restore a valid session');
    assert.strictEqual(sessionService.isConnected(), true, 'Session should remain active');
    console.log('✅ Test 5 Passed: Persistent session validated and restored on startup');

    // ----------------------------------------------------
    // TEST 6: Startup Restoration with invalid token
    // ----------------------------------------------------
    console.log('\n--- Test 6: Restoration fails with invalid token ---');
    // Mock getProfile to fail (simulating expired credentials)
    mockKite.getProfile = async () => {
      const err = new Error('Token is invalid');
      err.status_code = 403;
      throw err;
    };

    const restoredFail = await kiteService.restoreAndValidateSession();
    assert.strictEqual(restoredFail, false, 'Should fail restoration with invalid token');
    assert.strictEqual(sessionService.isConnected(), false, 'Session should be cleared');
    
    // Verify critical error log was pushed to live logs
    assert.ok(global.liveLogs.some(log => log.level === 'error' && log.message.includes('expired')), 'Should add error notification to liveLogs');
    console.log('✅ Test 6 Passed: Expired persistent session cleared on boot and logged');

    console.log('\n🎉 ALL TESTS COMPLETED SUCCESSFULLY! 🎉');
  } catch (err) {
    console.error('\n❌ TEST RUN FAILED:', err);
    process.exit(1);
  }
};

runTests();
