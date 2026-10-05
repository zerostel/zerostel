// Literal credentials that show up in configs, commands and tool output.
// Patterns favour precision: a false "secret found" erodes trust fast.

export interface SecretPattern {
  id: string;
  name: string;
  re: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { id: 'anthropic', name: 'Anthropic API key', re: /\bsk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai', name: 'OpenAI API key', re: /\bsk-(?:proj-|svcacct-|admin-)?(?!ant-)[A-Za-z0-9_-]{20,120}T3BlbkFJ[A-Za-z0-9_-]{20,}|\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g },
  { id: 'github', name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g },
  { id: 'aws', name: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'google', name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack', name: 'Slack token', re: /\bxox[abprse]-[A-Za-z0-9-]{10,}/g },
  { id: 'slack-webhook', name: 'Slack webhook URL', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g },
  { id: 'stripe', name: 'Stripe secret key', re: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  { id: 'gitlab', name: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: 'npm', name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'pypi', name: 'PyPI token', re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g },
  { id: 'huggingface', name: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{34,}\b/g },
  { id: 'groq', name: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{48,}\b/g },
  { id: 'xai', name: 'xAI API key', re: /\bxai-[A-Za-z0-9]{70,}\b/g },
  { id: 'replicate', name: 'Replicate token', re: /\br8_[A-Za-z0-9]{37,}\b/g },
  { id: 'sendgrid', name: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: 'telegram', name: 'Telegram bot token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { id: 'discord-webhook', name: 'Discord webhook URL', re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{30,}/g },
  { id: 'private-key', name: 'Private key', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'jwt', name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,1000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,}/g },
];

export interface SecretHit {
  id: string;
  name: string;
  value: string;
  index: number;
}

export function findSecrets(text: string, limit = 20): SecretHit[] {
  const hits: SecretHit[] = [];
  if (!text) return hits;
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      if (isPlaceholder(m[0])) continue;
      if (hits.some((h) => h.index <= m.index! && m.index! < h.index + h.value.length)) continue;
      hits.push({ id: p.id, name: p.name, value: m[0], index: m.index! });
      if (hits.length >= limit) return hits;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function mask(value: string): string {
  if (value.startsWith('-----BEGIN')) return '-----BEGIN … PRIVATE KEY----- [redacted]';
  const keep = Math.min(8, Math.floor(value.length / 4));
  return `${value.slice(0, keep)}…[redacted]`;
}

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const h of findSecrets(text, 200).reverse()) {
    out = out.slice(0, h.index) + mask(h.value) + out.slice(h.index + h.value.length);
  }
  const keep = (all: string, pre: string, val: string) => (isPlaceholder(val) || val.includes('[redacted]') ? all : pre + mask(val));
  // key=value style secrets the patterns above don't know about
  out = out.replace(/((?:api[_-]?key|secret|token|auth)[A-Za-z0-9_]{0,40}["']?\s{0,4}[:=]\s{0,4}["']?)([^\s"'&]{12,})/gi, keep);
  // passwords are often short
  out = out.replace(/((?:passw(?:or)?d|pwd)[A-Za-z0-9_]{0,40}["']?\s{0,4}[:=]\s{0,4}["']?)([^\s"'&]{4,})/gi, keep);
  out = out.replace(/(--?(?:password|passwd|pwd)[ =])([^\s"'-][^\s"']{3,})/gi, keep);
  // Authorization: Bearer/Basic/Token <anything>
  out = out.replace(/(authorization["']?\s{0,4}[:=]\s{0,4}["']?(?:bearer|basic|token)\s{1,4})([^\s"']{6,})/gi, keep);
  out = out.replace(/(\b(?:bearer)\s{1,4})([A-Za-z0-9._~+/=-]{16,})/g, keep);
  // credentials in URLs: scheme://user:password@host
  out = out.replace(/(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@"']{1,256}:)([^\s@/"']{3,256})(?=@)/gi, keep);
  return out;
}

// a whole value that stands for a secret rather than being one
const PLACEHOLDER = /^(?:<.*>|\$\{?[A-Z_][A-Z0-9_]*\}?|\{\{.*\}\}|%[A-Z_]+%|\.\.\.)$/i;
const FILLER = /your|my|example|sample|placeholder|changeme|change|dummy|redacted|fake|test|api|key|token|secret|here|value|insert|x{3,}/gi;

/**
 * Example values in docs and configs (`your-api-key-here`, `sk-xxxxxxxxxxxx`,
 * `${API_KEY}`, a truncated `sk-ant-a…`) aren't worth masking. A real value
 * that merely contains one of those words is: only values made of them count.
 */
export function isPlaceholder(value: string): boolean {
  if (PLACEHOLDER.test(value) || value.includes('…') || value.endsWith('...')) return true;
  const alnum = value.replace(/[^A-Za-z0-9]/g, '');
  // mostly x's: sk-xxxxxxxxxxxxxxxx
  if (/x{6,}/i.test(value) && (value.match(/x/gi)?.length ?? 0) * 2 >= alnum.length) return true;
  // nothing but filler words: your-api-key-here, example_token, changeme
  if (/your|example|sample|placeholder|changeme|dummy|redacted|fake/i.test(value)) return value.replace(FILLER, '').replace(/[^A-Za-z0-9]/g, '').length <= 3;
  return false;
}

const SECRET_ENV_NAME = /(?:^|_)(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PAT|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH)(?:_|$)/i;

/**
 * Env var / header that looks like it carries a credential, e.g. GITHUB_TOKEN=abc...
 * Returns the reason or null. Values that reference another variable are fine.
 */
export function secretEnvValue(name: string, value: string): string | null {
  if (typeof value !== 'string' || value.length < 8) return null;
  if (isPlaceholder(value) || /^\$\{?|^%|^\{\{|^env:|^op:\/\/|^keychain:/i.test(value)) return null;
  const known = findSecrets(value, 1)[0];
  if (known) return known.name;
  if (SECRET_ENV_NAME.test(name) && !/^(true|false|\d+|https?:\/\/[^@]*)$/i.test(value) && value.length >= 16) {
    return `credential in ${name}`;
  }
  if (/^authorization$/i.test(name) && /^(bearer|basic|token)\s+\S{12,}/i.test(value)) return 'Authorization header';
  return null;
}
