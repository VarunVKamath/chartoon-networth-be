import { encrypt } from '../services/cryptoService.js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const text = process.argv[2];
const password = process.argv[3] || process.env.ENCRYPTION_KEY;
const salt = process.argv[4] || process.env.ENCRYPTION_SALT || 'chartoon-networth-default-salt';

if (!text) {
  console.log('\nUsage: npm run encrypt "<text_to_encrypt>" [password] [salt]');
  console.log('Example: npm run encrypt "my_kite_secret" "my_secret_password"\n');
  process.exit(1);
}

if (!password) {
  console.error('\nError: Please provide an encryption password as the second argument,');
  console.error('or define ENCRYPTION_KEY in your backend .env file.\n');
  process.exit(1);
}

try {
  const encryptedText = encrypt(text, password, salt);
  console.log('\n=========================================');
  console.log('🔐 CREDENTIALS ENCRYPTION SUCCESSFUL!');
  console.log('=========================================');
  console.log('Plain Text:');
  console.log(`  ${text}`);
  console.log('\nEncrypted String (prefixed with enc:):');
  console.log(`  enc:${encryptedText}`);
  console.log('\nInstructions:');
  console.log('  1. Copy the "enc:..." line above.');
  console.log('  2. Paste it in your .env file as KITE_API_KEY or KITE_API_SECRET.');
  console.log('  3. Make sure ENCRYPTION_KEY is set to your password in your runtime environment.');
  console.log('=========================================\n');
} catch (error) {
  console.error('Encryption failed:', error.message);
  process.exit(1);
}
