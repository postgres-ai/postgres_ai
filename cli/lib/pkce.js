"use strict";

const crypto = require("crypto");

/**
 * Generate a cryptographically random string for PKCE
 * @param {number} length - Length of the string (43-128 characters per RFC 7636)
 * @returns {string} Base64URL-encoded random string
 */
function generateRandomString(length = 64) {
  const bytes = crypto.randomBytes(length);
  return base64URLEncode(bytes);
}

/**
 * Base64URL encode (without padding)
 * @param {Buffer} buffer - Buffer to encode
 * @returns {string} Base64URL-encoded string
 */
function base64URLEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Generate PKCE code verifier
 * @returns {string} Random code verifier (43-128 characters)
 */
function generateCodeVerifier() {
  return generateRandomString(32); // 32 bytes = 43 chars after base64url encoding
}

/**
 * Generate PKCE code challenge from verifier
 * Uses S256 method (SHA256)
 * @param {string} verifier - Code verifier string
 * @returns {string} Base64URL-encoded SHA256 hash of verifier
 */
function generateCodeChallenge(verifier) {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return base64URLEncode(hash);
}

/**
 * Generate random state for CSRF protection
 * @returns {string} Random state string
 */
function generateState() {
  return generateRandomString(16); // 16 bytes = 22 chars
}

/**
 * Generate complete PKCE parameters
 * @returns {Object} Object with verifier, challenge, challengeMethod, and state
 */
function generatePKCEParams() {
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

module.exports = {
  generateRandomString,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  generatePKCEParams,
};

