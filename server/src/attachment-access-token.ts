import { createHmac, timingSafeEqual } from "node:crypto";
import { resolvePaperclipInstanceId } from "./home-paths.js";

// Closes AUR-412: in `local_trusted` deployments every unauthenticated
// request is mapped to a full-admin implicit board actor (see
// `actorMiddleware`/`hasCompanyAccess` "local_implicit" branch), which is the
// correct trust model for most routes in a single-operator local instance —
// but it means the attachment content route had no secret at all gating it,
// only the unguessable attachment UUID. This token adds that missing secret
// specifically for the implicit/anonymous path, without touching the
// instance-wide deployment mode.
const DEFAULT_TTL_SECONDS = 5 * 60;

function masterSecret(): string | null {
  const secret =
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim();
  return secret || null;
}

// Domain-separated from the agent-JWT signing key derivation in
// agent-auth-jwt.ts (`jwt:` prefix) so the shared master secret can back both
// without key reuse across purposes.
function deriveAttachmentSigningKey(
  secret: string,
  companyId: string,
  instanceId: string,
): string {
  return createHmac("sha256", secret)
    .update(`attachment:${instanceId}:${companyId}`)
    .digest("hex");
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(secret: string, input: string) {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Mint a short-lived token scoped to one attachment and one company. Returns
 * null when no signing secret is configured for this instance (callers must
 * then refuse anonymous access rather than fall back to an unsigned link).
 */
export function signAttachmentAccessToken(
  attachmentId: string,
  companyId: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string | null {
  const secret = masterSecret();
  if (!secret) return null;

  const instanceId = resolvePaperclipInstanceId();
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payloadB64 = base64UrlEncode(
    JSON.stringify({ a: attachmentId, c: companyId, e: exp }),
  );
  const signingKey = deriveAttachmentSigningKey(secret, companyId, instanceId);
  const signature = sign(signingKey, payloadB64);
  return `${payloadB64}.${signature}`;
}

/**
 * Verify a token minted by `signAttachmentAccessToken` against the exact
 * attachment and company it is being presented for. Rejects expired tokens,
 * bad signatures, and tokens scoped to a different attachment/company.
 */
export function verifyAttachmentAccessToken(
  token: string | undefined | null,
  attachmentId: string,
  companyId: string,
): boolean {
  if (!token) return false;
  const secret = masterSecret();
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, signature] = parts;

  const instanceId = resolvePaperclipInstanceId();
  const signingKey = deriveAttachmentSigningKey(secret, companyId, instanceId);
  const expectedSignature = sign(signingKey, payloadB64);
  if (!safeCompare(signature, expectedSignature)) return false;

  let payload: { a?: unknown; c?: unknown; e?: unknown };
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return false;
  }

  if (payload.a !== attachmentId || payload.c !== companyId) return false;
  if (typeof payload.e !== "number") return false;
  return payload.e >= Math.floor(Date.now() / 1000);
}
