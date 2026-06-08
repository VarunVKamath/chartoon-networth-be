import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';

/**
 * Derives a 32-byte key from password and salt using PBKDF2
 * @param {string} password 
 * @param {string} salt 
 * @returns {Buffer}
 */
const deriveKey = (password, salt) => {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
};

/**
 * Encrypts plain text to an IV and cipher text block
 * @param {string} text - The plain text to encrypt
 * @param {string} password - Encryption key/password
 * @param {string} salt - Salt for key derivation
 * @returns {string} iv_hex:encrypted_hex
 */
export const encrypt = (text, password, salt) => {
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
};

/**
 * Decrypts IV and cipher text block back to plain text
 * @param {string} encryptedText - iv_hex:encrypted_hex
 * @param {string} password - Decryption key/password
 * @param {string} salt - Salt for key derivation
 * @returns {string|null} Decrypted string or null if failed
 */
export const decrypt = (encryptedText, password, salt) => {
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return null;
    const [ivHex, encrypted] = parts;
    const key = deriveKey(password, salt);
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('[CryptoService] Decryption failed:', error.message);
    return null;
  }
};

/**
 * Decrypts a credential string if it has the 'enc:' prefix.
 * Otherwise, returns the value as is.
 * @param {string} value - Credential string
 * @returns {string} Decrypted or raw credential value
 */
export const decryptIfNeeded = (value) => {
  if (!value) return value;
  if (value.startsWith('enc:')) {
    const encryptedText = value.slice(4);
    const password = process.env.ENCRYPTION_KEY;
    if (!password) {
      throw new Error("Credential is encrypted (starts with 'enc:'), but ENCRYPTION_KEY is not defined in the environment.");
    }
    const salt = process.env.ENCRYPTION_SALT || 'chartoon-networth-default-salt';
    const decrypted = decrypt(encryptedText, password, salt);
    if (!decrypted) {
      throw new Error("Decryption failed. Check if ENCRYPTION_KEY matches the one used to encrypt.");
    }
    return decrypted;
  }
  return value;
};
