/**
 * Removes secrets from prompt text before it leaves the machine or is written to disk.
 *
 * Scrubbing runs before truncation, so a secret that straddles the cut cannot survive as a
 * fragment. Pattern set follows fstandhartinger/auto-model-router's `scrub()` (MIT).
 * This lowers the risk of leaking a pasted key; it is not a guarantee.
 */

/** Longest prompt sent to Jev, after scrubbing. */
export const MAX_PROMPT_CHARS = 6000;

const REDACTED = "[REDACTED]";

const PATTERNS = [
  // PEM blocks: private keys, certificates.
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
  // Authorization header values.
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Provider key shapes.
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

// `API_KEY=...`, `token: ...`, `"password": "..."`: keep the name, drop the value.
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential|private[_-]?key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)[^\s"',;]{6,}\3/gi;

// `scheme://user:password@host`.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi;

const CREDENTIAL_NAME = /(?:key|secret|token|passw(?:or)?d|pwd|credential|auth)/i;

/** Literal values of credential-like environment variables, longest first. */
function envSecrets(env) {
  return Object.entries(env)
    .filter(([name, value]) => CREDENTIAL_NAME.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

/** Prompt text with secrets replaced by `[REDACTED]`. */
export function scrub(text, env = process.env) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const value of envSecrets(env)) out = out.split(value).join(REDACTED);
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(ASSIGNMENT, (_, name, sep, quote) => `${name}${sep}${quote}${REDACTED}${quote}`);
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  return out;
}

/** Scrubbed, then capped at `MAX_PROMPT_CHARS`: the only form of a prompt sent to Jev or stored. */
export function scrubPrompt(text, env = process.env) {
  const clean = scrub(text, env);
  return typeof clean === "string" && clean.length > MAX_PROMPT_CHARS ? clean.slice(0, MAX_PROMPT_CHARS) : clean;
}
