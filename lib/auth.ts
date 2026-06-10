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

function getDerivedEncryptionKey(secret: string, salt: string): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      "sha256",
      secret,
      salt,
      `Auth.js Generated Encryption Key (${salt})`,
      32
    )
  );
}

export async function verifySocketToken(token: string): Promise<string | null> {
  if (!SECRET) return null;
  try {
    const key = getDerivedEncryptionKey(SECRET, COOKIE_NAME);
    const { payload } = await jwtDecrypt(token, key, {
      clockTolerance: 15,
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM", "A256CBC-HS512"],
    });
    return (payload.sub as string) ?? null;
  } catch {
    return null;
  }
}
