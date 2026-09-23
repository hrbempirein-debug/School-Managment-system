import { hash, verify } from '@node-rs/argon2';

// NOTE: the library's default algorithm is Argon2id (see @node-rs/argon2 docs).
const ARGON2_OPTIONS = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(storedHash: string, candidate: string): Promise<boolean> {
  try {
    return await verify(storedHash, candidate);
  } catch {
    return false;
  }
}