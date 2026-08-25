import type { EncryptedPayload, GroupId, GroupKdf, SecretId } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_ITERATIONS = 250_000;
const VERIFIER_TEXT = "siyuan-secret-vault/group-verifier/v1";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomBase64(byteLength: number): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function createKdf(): GroupKdf {
  return {
    algorithm: "PBKDF2",
    hash: "SHA-256",
    iterations: DEFAULT_ITERATIONS,
    salt: randomBase64(16),
  };
}

export async function deriveGroupKey(password: string, kdf: GroupKdf): Promise<CryptoKey> {
  if (!password) throw new Error("口令不能为空");

  const passwordMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: fromBase64(kdf.salt),
      iterations: kdf.iterations,
      hash: kdf.hash,
    },
    passwordMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptText(
  key: CryptoKey,
  plaintext: string,
  additionalAuthenticatedData: string,
): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(additionalAuthenticatedData),
      tagLength: 128,
    },
    key,
    encoder.encode(plaintext),
  );

  return {
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted)),
  };
}

async function decryptText(
  key: CryptoKey,
  payload: EncryptedPayload,
  additionalAuthenticatedData: string,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(payload.iv),
      additionalData: encoder.encode(additionalAuthenticatedData),
      tagLength: 128,
    },
    key,
    fromBase64(payload.ciphertext),
  );

  return decoder.decode(plaintext);
}

function verifierAad(groupId: GroupId): string {
  return `siyuan-secret-vault:v1:group:${groupId}:verifier`;
}

function secretAad(groupId: GroupId, secretId: SecretId): string {
  return `siyuan-secret-vault:v1:group:${groupId}:secret:${secretId}`;
}

export function createVerifier(
  key: CryptoKey,
  groupId: GroupId,
): Promise<EncryptedPayload> {
  return encryptText(key, VERIFIER_TEXT, verifierAad(groupId));
}

export async function verifyGroupKey(
  key: CryptoKey,
  groupId: GroupId,
  verifier: EncryptedPayload,
): Promise<boolean> {
  try {
    return (await decryptText(key, verifier, verifierAad(groupId))) === VERIFIER_TEXT;
  } catch {
    return false;
  }
}

export function encryptSecretContent(
  key: CryptoKey,
  groupId: GroupId,
  secretId: SecretId,
  content: string,
): Promise<EncryptedPayload> {
  return encryptText(key, content, secretAad(groupId, secretId));
}

export function decryptSecretContent(
  key: CryptoKey,
  groupId: GroupId,
  secretId: SecretId,
  payload: EncryptedPayload,
): Promise<string> {
  return decryptText(key, payload, secretAad(groupId, secretId));
}
