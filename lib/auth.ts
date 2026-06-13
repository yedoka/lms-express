import { jwtDecrypt } from "jose";
import { hkdfSync } from "crypto";

// auth.js v5 uses AUTH_SECRET; NEXTAUTH_SECRET kept as fallback
const SECRET = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;

// auth.js v5 derives the encryption key using the cookie name as both salt and
// part of the info string. The cookie name differs by environment.
const COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";

// Key length must match the `enc` declared in the JWE header:
// Auth.js v5 encrypts with A256CBC-HS512 (64-byte key); A256GCM uses 32.
function getDerivedEncryptionKey(
  enc: string,
  secret: string,
  salt: string
): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      "sha256",
      secret,
      salt,
      `Auth.js Generated Encryption Key (${salt})`,
      enc === "A256CBC-HS512" ? 64 : 32
    )
  );
}

export interface SocketIdentity {
  userId: string;
  role: string;
}

export async function verifySocketToken(
  token: string
): Promise<SocketIdentity | null> {
  if (!SECRET) return null;
  try {
    const { payload } = await jwtDecrypt(
      token,
      ({ enc }) => getDerivedEncryptionKey(enc ?? "", SECRET, COOKIE_NAME),
      {
        clockTolerance: 15,
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM", "A256CBC-HS512"],
      }
    );
    const userId = (payload.sub as string) ?? null;
    if (!userId) return null;
    return { userId, role: (payload.role as string) ?? "STUDENT" };
  } catch {
    return null;
  }
}
