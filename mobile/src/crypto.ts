/**
 * THE WEB CRYPTO PIECES SIGN-IN NEEDS, supplied where the phone lacks them.
 *
 * PKCE sign-in (see `viaGoogle` in `api-client/auth.ts`) makes a random secret,
 * the verifier, and sends Google only its SHA-256 hash. A browser has
 * `crypto.getRandomValues` and `crypto.subtle.digest` built in. Hermes, React
 * Native's JavaScript engine, may not. Without them the auth library falls
 * back quietly: a verifier from `Math.random` and the "plain" method, which
 * sends the secret itself instead of its hash. expo-crypto has native versions
 * of both, so they are installed under the browser's names wherever they are
 * missing. Nothing is replaced that already exists.
 */

import { CryptoDigestAlgorithm, digest, getRandomValues } from "expo-crypto";

const g = globalThis as { crypto?: Partial<Crypto> };
const crypto = (g.crypto ??= {}) as { getRandomValues?: unknown; subtle?: { digest?: unknown } };

crypto.getRandomValues ??= getRandomValues;

if (!crypto.subtle?.digest) {
  crypto.subtle = {
    ...crypto.subtle,
    // The auth library only ever asks for SHA-256.
    digest: (algorithm: string, data: BufferSource) => {
      if (algorithm !== "SHA-256") throw new Error(`digest: ${algorithm} is not supported here`);
      return digest(CryptoDigestAlgorithm.SHA256, data);
    },
  };
}
