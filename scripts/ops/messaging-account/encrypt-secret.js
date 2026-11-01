/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS helper run with `node -e` inside the container; it is not part of the app bundle */
// Encrypts ONE secret read from stdin with the application's own ENCRYPTION_KEY (AES-256-GCM, iv:ciphertext:tag in hex: the format
// src/lib/whatsapp/encryption.ts reads) and prints the ciphertext. Run INSIDE the app container so the key never leaves it:
//   docker exec -i wacrm-app-1 node -e "$(cat encrypt-secret.js)" < /path/to/secret-file   (0600 file; the script itself is the -e argument)
// The plaintext is never printed or logged.
const crypto = require('crypto')
const secret = require('fs').readFileSync(0, 'utf8').replace(/\r?\n$/, '')
if (!secret) { console.error('empty input'); process.exit(1) }
const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex')
if (key.length !== 32) { console.error('ENCRYPTION_KEY is not a 64-hex-character key'); process.exit(1) }
const iv = crypto.randomBytes(12)
const c = crypto.createCipheriv('aes-256-gcm', key, iv)
const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()])
process.stdout.write(`${iv.toString('hex')}:${ct.toString('hex')}:${c.getAuthTag().toString('hex')}\n`)
