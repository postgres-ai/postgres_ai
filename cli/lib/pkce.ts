import * as crypto from "crypto";

/**
 * PKCE parameters for OAuth 2.0 Authorization Code Flow with PKCE
 */
export interface PKCEParams {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state: string;
}

/**
 * Generate a cryptographically random string for PKCE
 * @param length - Length of the string (43-128 characters per RFC 7636)
 * @returns Base64URL-encoded random string
 */
function generateRandomString(length: number = 64): string {
  const bytes = crypto.randomBytes(length);
  return base64URLEncode(bytes);
}

/**
 * Base64URL encode (without padding)
 * @param buffer - Buffer to encode
 * @returns Base64URL-encoded string
 */
function base64URLEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Generate PKCE code verifier
 * @returns Random code verifier (43-128 characters)
 */
export function generateCodeVerifier(): string {
  return generateRandomString(32); // 32 bytes = 43 chars after base64url encoding
}

/**
 * Generate PKCE code challenge from verifier
 * Uses S256 method (SHA256)
 * @param verifier - Code verifier string
 * @returns Base64URL-encoded SHA256 hash of verifier
 */
export function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return base64URLEncode(hash);
}

/**
 * Generate random state for CSRF protection
 * @returns Random state string
 */
export function generateState(): string {
  return generateRandomString(16); // 16 bytes = 22 chars
}

/**
 * Generate complete PKCE parameters
 * @returns Object with verifier, challenge, challengeMethod, and state
 */
export function generatePKCEParams(): PKCEParams {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();

  return {
    codeVerifier: verifier,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state: state,
  };
}

