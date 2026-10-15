// PKCE (RFC 7636) ja satunnaiset tunnisteet Web Cryptolla. Ei `server-only`: testattavissa.

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Satunnainen URL-turvallinen merkkijono (oletuksena 32 tavua = 43 merkkiä). */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** code_challenge = BASE64URL(SHA-256(verifier)), menetelmä S256. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}
