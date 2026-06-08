import { sessionService } from '../services/sessionService.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_FILE = path.join(__dirname, '../storage/session.json');

const runTests = () => {
  console.log('--- STARTING SESSION SERVICE TESTS ---');

  // Test 1: Clear existing session (if any) to start clean
  console.log('\nTest 1: Clearing existing session...');
  sessionService.clearSession();
  if (fs.existsSync(SESSION_FILE)) {
    console.error('❌ Test 1 Failed: session.json still exists after clearSession!');
    process.exit(1);
  }
  if (sessionService.isConnected()) {
    console.error('❌ Test 1 Failed: isConnected() returned true after clearSession!');
    process.exit(1);
  }
  console.log('✅ Test 1 Passed: clearSession() works.');

  // Test 2: Save session
  console.log('\nTest 2: Saving session...');
  const testSession = {
    accessToken: 'mock_access_token_123456',
    publicToken: 'mock_public_token_123456',
    userId: 'USER123',
    userName: 'John Doe',
    loginTime: new Date().toISOString()
  };
  sessionService.saveSession(testSession);
  if (!fs.existsSync(SESSION_FILE)) {
    console.error('❌ Test 2 Failed: session.json was not created!');
    process.exit(1);
  }
  if (!sessionService.isConnected()) {
    console.error('❌ Test 2 Failed: isConnected() returned false after saveSession!');
    process.exit(1);
  }
  const savedData = sessionService.getSession();
  if (savedData.accessToken !== testSession.accessToken || savedData.userId !== testSession.userId) {
    console.error('❌ Test 2 Failed: saved session details do not match!');
    process.exit(1);
  }
  console.log('✅ Test 2 Passed: saveSession() and isConnected() work.');

  // Test 3: Load session
  console.log('\nTest 3: Loading session...');
  const loadedData = sessionService.loadSession();
  if (!loadedData || loadedData.accessToken !== testSession.accessToken) {
    console.error('❌ Test 3 Failed: loadSession() returned invalid data!');
    process.exit(1);
  }
  console.log('✅ Test 3 Passed: loadSession() works.');

  // Test 4: Handling Corrupt JSON File
  console.log('\nTest 4: Simulating corrupted/invalid session.json file...');
  fs.writeFileSync(SESSION_FILE, '{{invalid json content}', 'utf-8');
  console.log('Attempting to load corrupt session file...');
  const corruptedLoad = sessionService.loadSession();
  if (corruptedLoad !== null) {
    console.error('❌ Test 4 Failed: loadSession() should return null for corrupt data!');
    process.exit(1);
  }
  if (sessionService.isConnected()) {
    console.error('❌ Test 4 Failed: isConnected() should be false after corruption load!');
    process.exit(1);
  }
  if (fs.existsSync(SESSION_FILE)) {
    console.error('❌ Test 4 Failed: corrupt file should have been deleted by loadSession() error handler!');
    process.exit(1);
  }
  console.log('✅ Test 4 Passed: sessionService handles corrupt JSON gracefully and auto-clears.');

  console.log('\n--- ALL SESSION SERVICE TESTS PASSED SUCCESSFULLY! ---');
  process.exit(0);
};

runTests();
