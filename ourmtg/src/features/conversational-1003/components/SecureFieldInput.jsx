// Conversational 1003 — the masked secure control (§15).
//
// The only place an SSN or account number is ever typed. It is deliberately NOT part of the
// chat composer: the value goes straight to application-secure-field and never touches the
// transcript, the model, or any log.
//
// Rules enforced here (the server enforces them again — this is the UX half):
//   • autoComplete off, no spellcheck, no name attribute a password manager would harvest
//   • the value lives only in component state, never in localStorage or a URL
//   • it is cleared from memory the moment it is submitted
//   • only the last four are ever displayed back

import { useEffect, useRef, useState } from 'react'

const COPY = {
  ssnLabel: { en: 'Social Security number', es: 'Número de Seguro Social', ru: 'Номер социального страхования' },
  acctLabel: { en: 'Account number', es: 'Número de cuenta', ru: 'Номер счёта' },
  why: {
    en: 'This goes straight into secure storage. It is never shown in the chat and never sent to the assistant.',
    es: 'Esto va directo a almacenamiento seguro. Nunca aparece en el chat ni se envía al asistente.',
    ru: 'Данные идут напрямую в защищённое хранилище. Они не появляются в чате и не передаются ассистенту.',
  },
  save: { en: 'Save securely', es: 'Guardar de forma segura', ru: 'Сохранить безопасно' },
  saved: { en: 'Saved', es: 'Guardado', ru: 'Сохранено' },
  incomplete: {
    en: 'That does not look complete. Please check the digits and try again.',
    es: 'No parece completo. Verifique los dígitos e intente de nuevo.',
    ru: 'Похоже, введено не полностью. Проверьте цифры и попробуйте снова.',
  },
  neverAsk: {
    en: 'We will never ask for your online banking username, password, or a one-time code.',
    es: 'Nunca le pediremos su usuario, contraseña bancaria ni un código de un solo uso.',
    ru: 'Мы никогда не запрашиваем логин, пароль от онлайн-банка или одноразовый код.',
  },
}
const t = (k, locale) => COPY[k][locale] || COPY[k].en

export default function SecureFieldInput({ fieldPath, type = 'ssn', locale = 'en', onSubmit, busy = false, error = '' }) {
  const [value, setValue] = useState('')
  const [savedMask, setSavedMask] = useState('')
  const inputRef = useRef(null)

  // Belt and braces: wipe the buffer if the component unmounts while it still holds digits.
  useEffect(() => () => setValue(''), [])

  const digits = value.replace(/\D/g, '')
  const formatted = type === 'ssn'
    ? digits.replace(/^(\d{0,3})(\d{0,2})(\d{0,4}).*$/, (_, a, b, c) => [a, b, c].filter(Boolean).join('-'))
    : digits
  const complete = type === 'ssn' ? digits.length === 9 : digits.length >= 4

  async function submit(e) {
    e.preventDefault()
    if (!complete || busy) return
    const last4 = digits.slice(-4)
    const ok = await onSubmit(digits)
    // Cleared immediately either way — a failed attempt must not leave the number in memory.
    setValue('')
    if (ok) setSavedMask(type === 'ssn' ? `•••-••-${last4}` : `••••${last4}`)
  }

  if (savedMask) {
    return (
      <div className="secure-field secure-field--saved">
        <span aria-hidden="true">🔒</span> {t('saved', locale)}: <strong>{savedMask}</strong>
      </div>
    )
  }

  return (
    <form className="secure-field" onSubmit={submit}>
      <label htmlFor={`secure-${fieldPath}`}>
        🔒 {type === 'ssn' ? t('ssnLabel', locale) : t('acctLabel', locale)}
      </label>
      <input
        id={`secure-${fieldPath}`}
        ref={inputRef}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-lpignore="true"
        value={formatted}
        onChange={(e) => setValue(e.target.value)}
        maxLength={type === 'ssn' ? 11 : 17}
        aria-describedby={`secure-why-${fieldPath}`}
      />
      <p id={`secure-why-${fieldPath}`} className="muted" style={{ fontSize: 13 }}>{t('why', locale)}</p>
      <p className="muted" style={{ fontSize: 12 }}>{t('neverAsk', locale)}</p>
      {error && <p className="error-text">{error === 'incomplete' ? t('incomplete', locale) : error}</p>}
      <button className="btn btn-primary" disabled={!complete || busy}>
        {busy ? '…' : t('save', locale)}
      </button>
    </form>
  )
}
