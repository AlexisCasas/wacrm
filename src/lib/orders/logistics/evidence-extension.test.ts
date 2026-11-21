import { describe, expect, it } from 'vitest'

import { isAllowedExtension } from '@/lib/orders/logistics/evidence'

describe('isAllowedExtension (declared name only; the real type is always sniffed from the bytes)', () => {
  it.each(['foto.jpg', 'FOTO.JPG', 'a.b.png', 'x.jpeg', 'x.webp', 'embalaje.pdf', 'C:\\fakepath\\foto.png', 'IMG_0001', '.hidden', 'foto.'])('accepts %s', (name) => {
    expect(isAllowedExtension(name)).toBe(true)
  })

  it.each(['foto.exe', 'x.svg', 'x.html', 'x.js', 'x.gif', 'x.heic', 'script.php', 'archivo.zip', 'foto.jpg.exe'])('refuses %s', (name) => {
    expect(isAllowedExtension(name)).toBe(false)
  })
})
