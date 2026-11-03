import { Keypair, Transaction } from '@solana/web3.js';
import { invariant } from '../../../shared/config';

// One embedded wallet per browser profile; a recovery file moves it to another browser.
const DB_NAME = 'bankroll-wallet-v1';
const HINT = 'bankroll.wallet.address';
const LOCKED = 'bankroll.wallet.locked';
interface StoredWallet { version: 1; publicKey: string; key: CryptoKey; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('wallet');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Wallet storage is unavailable. Enable browser storage to continue.'));
  });
}
async function readStored(): Promise<StoredWallet | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('wallet').objectStore('wallet').get('primary');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
async function storeWallet(wallet: Keypair) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(wallet.secretKey));
  const stored: StoredWallet = { version: 1, publicKey: wallet.publicKey.toBase58(), key, iv, ciphertext };
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('wallet', 'readwrite');
      transaction.objectStore('wallet').put(stored, 'primary');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
  localStorage.setItem(HINT, wallet.publicKey.toBase58());
}

export const walletExists = () => Boolean(localStorage.getItem(HINT));
export const walletWasLocked = () => localStorage.getItem(LOCKED) === 'true';
export const lockWallet = () => localStorage.setItem(LOCKED, 'true');

async function openOrCreate() {
  invariant(window.isSecureContext && crypto.subtle, 'Use HTTPS or localhost for the in-app wallet.');
  const stored = await readStored();
  let wallet: Keypair;
  if (stored) {
    invariant(stored.version === 1, 'Unsupported wallet backup version.');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, stored.key, stored.ciphertext);
    wallet = Keypair.fromSecretKey(new Uint8Array(plaintext));
    invariant(wallet.publicKey.toBase58() === stored.publicKey, 'Wallet storage is damaged. Restore your recovery file.');
  } else {
    invariant(!walletExists(), 'Your browser wallet data is missing. Restore your recovery file before creating another wallet.');
    wallet = Keypair.generate();
    await storeWallet(wallet);
  }
  localStorage.setItem(LOCKED, 'false');
  return wallet;
}
export async function openWallet() {
  return navigator.locks ? navigator.locks.request('bankroll-wallet-create', openOrCreate) : openOrCreate();
}
async function restoreStoredWallet(file: File) {
  invariant(window.isSecureContext && crypto.subtle, 'Use HTTPS or localhost for the in-app wallet.');
  invariant(file.size < 4096, 'This is not a wallet recovery file.');
  invariant(!(await readStored()), 'A wallet already exists in this browser. Restore in a different browser profile.');
  const value = JSON.parse(await file.text());
  const secret = Array.isArray(value) ? value : value.secretKey;
  invariant(Array.isArray(secret) && secret.length === 64 && secret.every(item => Number.isInteger(item) && item >= 0 && item <= 255), 'Invalid recovery key.');
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secret));
  await storeWallet(wallet);
  localStorage.setItem(LOCKED, 'false');
  return wallet;
}
export async function restoreWallet(file: File) {
  return navigator.locks ? navigator.locks.request('bankroll-wallet-create', () => restoreStoredWallet(file)) : restoreStoredWallet(file);
}
export function exportWallet(wallet: Keypair) {
  const file = new Blob([JSON.stringify({ format: 'bankroll-devnet-wallet-v1', publicKey: wallet.publicKey.toBase58(), secretKey: Array.from(wallet.secretKey) })], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url; link.download = `bankroll-devnet-${wallet.publicKey.toBase58().slice(0, 8)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function signMessage(wallet: Keypair, message: Uint8Array) {
  const pkcs8 = new Uint8Array(48);
  pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  pkcs8.set(wallet.secretKey.subarray(0, 32), 16);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('Ed25519', key, new Uint8Array(message)));
}
export function signTransaction(wallet: Keypair, transaction: Transaction) {
  const message = transaction.serializeMessage();
  const previous = transaction.signatures.filter(item => item.signature).map(item => ({ owner: item.publicKey, signature: Buffer.from(item.signature!) }));
  transaction.partialSign(wallet);
  invariant(transaction.serializeMessage().equals(message) && previous.every(item => transaction.signatures.find(next => next.publicKey.equals(item.owner))?.signature?.equals(item.signature)), 'Signing changed the transaction.');
  invariant(transaction.verifySignatures(), 'The transaction is missing a valid signature.');
  return transaction;
}
