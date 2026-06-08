import { encrypt, decrypt, decryptIfNeeded } from '../services/cryptoService.js';
import dotenv from 'dotenv';

dotenv.config();

console.log('--- STARTING CRYPTO VERIFICATION TESTS ---');

const password = 'TestSuperSecretPassword123!';
const salt = 'test-salt-value';
const originalValue = '3xocdwcvyuyp241k';

console.log(`Original Plain Text: "${originalValue}"`);

// Test 1: Successful encrypt and decrypt
const encrypted = encrypt(originalValue, password, salt);
console.log(`Encrypted Value:    "${encrypted}"`);

const decrypted = decrypt(encrypted, password, salt);
console.log(`Decrypted Value:    "${decrypted}"`);

if (originalValue === decrypted) {
  console.log('✅ Test 1 Passed: Encrypt and decrypt match!');
} else {
  console.error('❌ Test 1 Failed: Decrypted text does not match original!');
  process.exit(1);
}

// Test 2: Mismatching password (failure)
console.log('\nTesting decryption with incorrect password...');
const decryptedWrong = decrypt(encrypted, 'WrongPassword', salt);
console.log(`Wrong Password Output: "${decryptedWrong}"`);
if (decryptedWrong === null) {
  console.log('✅ Test 2 Passed: Decryption correctly returned null on wrong password!');
} else {
  console.error('❌ Test 2 Failed: Decryption did not fail with wrong password!');
  process.exit(1);
}

// Test 3: decryptIfNeeded function behavior
console.log('\nTesting decryptIfNeeded...');
process.env.ENCRYPTION_KEY = password;
process.env.ENCRYPTION_SALT = salt;

const formattedEncrypted = `enc:${encrypted}`;
const decryptedAuto = decryptIfNeeded(formattedEncrypted);
console.log(`decryptIfNeeded output: "${decryptedAuto}"`);

if (decryptedAuto === originalValue) {
  console.log('✅ Test 3 Passed: decryptIfNeeded auto-decrypted the enc: prefixed string!');
} else {
  console.error('❌ Test 3 Failed: decryptIfNeeded failed to decrypt!');
  process.exit(1);
}

// Test 4: decryptIfNeeded plain text bypass
const rawInput = 'plain_text_credentials';
const bypassResult = decryptIfNeeded(rawInput);
if (bypassResult === rawInput) {
  console.log('✅ Test 4 Passed: Plain credentials passed through untouched!');
} else {
  console.error('❌ Test 4 Failed: Plain credentials were modified!');
  process.exit(1);
}

console.log('\n🎉 ALL CRYPTO TESTS PASSED SUCCESSFULLY! 🎉');
