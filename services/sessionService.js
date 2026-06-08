/**
 * Session Service
 * Handles persistence, loading, clearing, and connection checks for the Kite session.
 * Stores tokens locally in `storage/session.json`.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORAGE_DIR = path.join(__dirname, '../storage');
const SESSION_FILE = path.join(STORAGE_DIR, 'session.json');

let inMemorySession = {
  accessToken: null,
  publicToken: null,
  userId: null,
  userName: null,
  loginTime: null
};

// Ensure storage directory exists
try {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
} catch (error) {
  console.error(`[SessionService] Failed to create storage directory: ${error.message}`);
}

export const sessionService = {
  /**
   * Save the session details locally and update memory
   * @param {Object} data - Session details from KiteConnect
   */
  saveSession(data) {
    inMemorySession = {
      accessToken: data.accessToken || data.access_token || null,
      publicToken: data.publicToken || data.public_token || null,
      userId: data.userId || data.user_id || null,
      userName: data.userName || data.user_name || null,
      loginTime: data.loginTime || new Date().toISOString()
    };

    try {
      fs.writeFileSync(SESSION_FILE, JSON.stringify(inMemorySession, null, 2), 'utf-8');
      console.log('[SessionService] Session saved successfully');
    } catch (error) {
      console.error(`[SessionService] Failed to save session: ${error.message}`);
    }
  },

  /**
   * Retrieve the current access token
   * @returns {string|null} Access token
   */
  getAccessToken() {
    return inMemorySession.accessToken;
  },

  /**
   * Retrieve the current full session structure
   * @returns {Object} Full session object
   */
  getSession() {
    return { ...inMemorySession };
  },

  /**
   * Check connection status
   * @returns {boolean} True if access token is loaded
   */
  isConnected() {
    return !!inMemorySession.accessToken;
  },

  /**
   * Clear session from memory and delete the session file
   */
  clearSession() {
    inMemorySession = {
      accessToken: null,
      publicToken: null,
      userId: null,
      userName: null,
      loginTime: null
    };

    try {
      if (fs.existsSync(SESSION_FILE)) {
        fs.unlinkSync(SESSION_FILE);
      }
      console.log('[SessionService] Session cleared successfully');
    } catch (error) {
      console.error(`[SessionService] Failed to delete session file: ${error.message}`);
    }
  },

  /**
   * Load the session on startup. Handles corrupt/invalid JSON gracefully.
   * @returns {Object|null} The session details, or null if loading failed.
   */
  loadSession() {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const rawData = fs.readFileSync(SESSION_FILE, 'utf-8').trim();
        if (!rawData) {
          console.warn('[SessionService] Session file is empty. Clearing session.');
          this.clearSession();
          return null;
        }

        const data = JSON.parse(rawData);
        if (data && typeof data === 'object') {
          inMemorySession = {
            accessToken: data.accessToken || null,
            publicToken: data.publicToken || null,
            userId: data.userId || null,
            userName: data.userName || null,
            loginTime: data.loginTime || null
          };
          console.log(`[SessionService] Session loaded for user: ${inMemorySession.userName || 'Unknown'}`);
          return inMemorySession;
        }
      }
    } catch (error) {
      console.error(`[SessionService] Failed to parse session.json. Data is likely corrupt. Clearing session. Error: ${error.message}`);
      this.clearSession();
    }
    return null;
  }
};
