// Cifrado del estado en D1 con WebCrypto: AES-GCM con claves derivadas de STATE_KEY por HKDF.
//
// Por qué HKDF y no PBKDF2 (el formato anterior, con 200.000 iteraciones): STATE_KEY es una clave aleatoria
// larga, no una contraseña, así que no necesita estirarse; y PBKDF2 con 200.000 iteraciones supera el CPU de un
// Worker gratuito (se midió: la invocación falla). HKDF cuesta ~0 ms.
//
// Formato: "v1." + base64(iv(12) || ciphertext+tag). El texto cifrado va atado a su fila (AAD = tabla:hash),
// así no se puede copiar el blob de una fila a otra. Funciona igual en Workers y en Node 20+ (scripts de migración).
const enc = new TextEncoder();
const dec = new TextDecoder();
const SALT = enc.encode('epm-state-v1');

export const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
};
export const unb64 = (s) => {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

const cache = new Map(); // STATE_KEY -> bóveda (se deriva una vez por aislado)

export async function makeVault(stateKey) {
  if (typeof stateKey !== 'string' || stateKey.length < 16) throw new Error('STATE_KEY ausente o demasiado corta');
  if (cache.has(stateKey)) return cache.get(stateKey);
  const base = await crypto.subtle.importKey('raw', enc.encode(stateKey), 'HKDF', false, ['deriveKey']);
  const derive = (info, algo, usages) =>
    crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) }, base, algo, false, usages);
  const [aes, mac, backup] = await Promise.all([
    derive('aes-gcm-v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    derive('chat-hash-v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
    derive('backup-v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
  ]);

  const seal = async (key, aad, bytes) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return 'v1.' + b64(out);
  };
  const open = async (key, aad, text) => {
    if (typeof text !== 'string' || !text.startsWith('v1.')) throw new Error('formato cifrado no reconocido');
    const raw = unb64(text.slice(3));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(aad) }, key, raw.slice(12));
    return new Uint8Array(pt);
  };

  const vault = {
    // Identificador estable y no reversible de un chat (HMAC): sirve de clave de fila sin guardar el chat id en claro.
    async chatHash(chatId) {
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', mac, enc.encode(String(chatId))));
      return hex(sig.slice(0, 16));
    },
    async seal(table, hash, obj) {
      return seal(aes, `${table}:${hash}`, enc.encode(JSON.stringify(obj)));
    },
    async open(table, hash, text) {
      return JSON.parse(dec.decode(await open(aes, `${table}:${hash}`, text)));
    },
    // Copias de seguridad: se cifra el archivo completo.
    async sealBackup(obj) {
      return seal(backup, 'backup', enc.encode(JSON.stringify(obj)));
    },
    async openBackup(text) {
      return JSON.parse(dec.decode(await open(backup, 'backup', text)));
    },
  };
  cache.set(stateKey, vault);
  return vault;
}

// Comparación en tiempo constante (compara los hashes SHA-256, que siempre miden lo mismo).
export async function sameSecret(a, b) {
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
