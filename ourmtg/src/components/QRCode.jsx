// Renders a QR code for a URL (realtor open-house / co-branded link, spec §K.7).
// Uses the `qrcode` package to produce a data URL, drawn into an <img>.
import { useEffect, useState } from 'react'
import QR from 'qrcode'

export default function QRCode({ value, size = 200 }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let alive = true
    QR.toDataURL(value, { width: size, margin: 1, color: { dark: '#1e3a5f', light: '#ffffff' } })
      .then((url) => { if (alive) setSrc(url) })
      .catch(() => { if (alive) setSrc('') })
    return () => { alive = false }
  }, [value, size])
  if (!src) return <div className="spinner" />
  return <img src={src} width={size} height={size} alt="QR code" />
}
