// Lightweight i18n for the public borrower funnel. Three languages: English (default),
// Spanish, Russian. The choice is remembered in localStorage and reflected on
// <html lang>. Marketing copy for the lead flows lives in leadFlows.js as { en, es, ru }
// objects; short UI chrome (nav, footer, buttons, form labels) lives in the UI dict below.
//
// Two ways to translate:
//   • useT()   → t('key')            for the fixed UI strings in the UI dictionary
//   • pick(v)  → pick({en,es,ru})    for inline per-language values (flow content)
import { createContext, useContext, useEffect, useState } from 'react'

export const LANGS = ['en', 'es', 'ru']
export const LANG_LABELS = { en: 'EN', es: 'ES', ru: 'RU' }
const STORAGE_KEY = 'ourmtg_lang'

function detect() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && LANGS.includes(saved)) return saved
    const n = (navigator.language || 'en').slice(0, 2).toLowerCase()
    if (LANGS.includes(n)) return n
  } catch { /* SSR / privacy mode */ }
  return 'en'
}

const LangContext = createContext({ lang: 'en', setLang: () => {} })

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(detect)
  const setLang = (l) => {
    if (!LANGS.includes(l)) return
    setLangState(l)
    try { localStorage.setItem(STORAGE_KEY, l) } catch { /* ignore */ }
  }
  useEffect(() => { try { document.documentElement.lang = lang } catch { /* ignore */ } }, [lang])
  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>
}

export function useLang() { return useContext(LangContext) }

// Resolve a per-language value. Accepts a plain string (returned as-is) or a
// { en, es, ru } object. Falls back to English, then to the raw value.
export function pickLang(v, lang) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v[lang] ?? v.en ?? ''
  return v
}

// Hook form: `const pick = usePick()` then `pick(flow.sub)`.
export function usePick() {
  const { lang } = useLang()
  return (v) => pickLang(v, lang)
}

// Fixed UI strings shared across pages.
export const UI = {
  signIn:        { en: 'Sign in',            es: 'Iniciar sesión',        ru: 'Войти' },
  signOut:       { en: 'Sign out',           es: 'Cerrar sesión',         ru: 'Выйти' },
  myPortal:      { en: 'My portal',          es: 'Mi portal',             ru: 'Мой портал' },
  backHome:      { en: '← Home',             es: '← Inicio',              ru: '← На главную' },
  backToHome:    { en: 'Back to home',       es: 'Volver al inicio',      ru: 'На главную' },
  language:      { en: 'Language',           es: 'Idioma',                ru: 'Язык' },

  // Home
  homeCtaBuild:  { en: 'Build my file — 60 sec', es: 'Arma mi expediente — 60 s', ru: 'Собрать моё дело — 60 сек' },
  homeCtaRealtor:{ en: 'I’m a Realtor',      es: 'Soy agente inmobiliario', ru: 'Я риелтор' },
  homeNoQ:       { en: 'No questions, just the form?', es: '¿Sin preguntas, solo el formulario?', ru: 'Без вопросов, сразу форма?' },
  homeStartApp:  { en: 'Start an application', es: 'Iniciar una solicitud', ru: 'Начать заявку' },
  homeHavePortal:{ en: 'Already have a portal?', es: '¿Ya tienes un portal?', ru: 'Уже есть портал?' },

  homeDocsT:     { en: 'Documents that collect themselves', es: 'Documentos que se recopilan solos', ru: 'Документы, которые собираются сами' },
  homeDocsS:     { en: 'A checklist for your exact loan type. Snap a photo — filed, encrypted, done.', es: 'Una lista para tu tipo de préstamo exacto. Toma una foto — archivado, cifrado, listo.', ru: 'Чек-лист под ваш тип кредита. Сфотографируйте — файл сохранён, зашифрован, готово.' },
  homeStatusT:   { en: 'Status without texting anyone', es: 'Estado sin escribirle a nadie', ru: 'Статус, никому не написав' },
  homeStatusS:   { en: 'Seven stages, one moving dot. You’ll know before you think to ask.', es: 'Siete etapas, un punto que avanza. Lo sabrás antes de preguntar.', ru: 'Семь этапов, одна движущаяся точка. Вы узнаете раньше, чем спросите.' },
  homePrivateT:  { en: 'Your file stays yours', es: 'Tu expediente sigue siendo tuyo', ru: 'Ваше дело остаётся вашим' },
  homePrivateS:  { en: 'Financial documents live in a private vault — never public, never emailed around.', es: 'Los documentos financieros viven en una bóveda privada — nunca públicos, nunca enviados por correo.', ru: 'Финансовые документы хранятся в приватном хранилище — никогда не публично и не по почте.' },

  findYourPath:  { en: 'Find your path',     es: 'Encuentra tu camino',   ru: 'Найдите свой путь' },
  chipDocs:      { en: 'docs',               es: 'docs',                  ru: 'док-ты' },
  chipStatus:    { en: 'status',             es: 'estado',                ru: 'статус' },
  chipPrivate:   { en: 'private',            es: 'privado',               ru: 'приватно' },

  // Path row labels + subs (Home "Find your path")
  pathDpa:       { en: 'Down payment assistance →', es: 'Ayuda para el enganche →', ru: 'Помощь с первым взносом →' },
  pathDpaS:      { en: 'Check what California will help you with.', es: 'Mira con qué te ayuda California.', ru: 'Узнайте, чем поможет Калифорния.' },
  pathFha:       { en: 'FHA — first home →', es: 'FHA — primera vivienda →', ru: 'FHA — первое жильё →' },
  pathFhaS:      { en: '3.5% down, friendlier credit.', es: '3.5% de enganche, crédito más flexible.', ru: '3,5% взноса, мягче требования к кредиту.' },
  pathVa:        { en: 'VA — you served →', es: 'VA — usted sirvió →', ru: 'VA — вы служили →' },
  pathVaS:       { en: '$0 down, no monthly mortgage insurance.', es: '$0 de enganche, sin seguro hipotecario mensual.', ru: '$0 взноса, без ежемесячной ипотечной страховки.' },
  pathSelf:      { en: 'Self-employed →',    es: 'Trabajo por cuenta propia →', ru: 'Самозанятый / ИП →' },
  pathSelfS:     { en: 'Qualify on bank statements, not tax returns.', es: 'Califica con estados de cuenta, no con declaraciones de impuestos.', ru: 'Одобрение по выпискам со счёта, а не по налоговым декларациям.' },
  pathJumbo:     { en: 'Jumbo →',            es: 'Jumbo →',               ru: 'Jumbo (крупный заём) →' },
  pathJumboS:    { en: 'Above county limits, done calmly.', es: 'Por encima del límite del condado, con calma.', ru: 'Выше лимитов округа — спокойно и без спешки.' },
  pathRefi:      { en: 'Refinance →',        es: 'Refinanciar →',         ru: 'Рефинансирование →' },
  pathRefiS:     { en: 'An honest answer on whether it pays.', es: 'Una respuesta honesta sobre si conviene.', ru: 'Честный ответ, выгодно ли это.' },
  pathCalc:      { en: 'Calculators →',      es: 'Calculadoras →',        ru: 'Калькуляторы →' },
  pathCalcS:     { en: 'Affordability and refi savings, no email required.', es: 'Capacidad de compra y ahorro al refinanciar, sin correo.', ru: 'Доступность и экономия при рефинансировании — без email.' },
  pathWho:       { en: 'Who sends what? →',  es: '¿Quién envía qué? →',   ru: 'Кто что присылает? →' },
  pathWhoS:      { en: 'Realtor forms vs. lender forms vs. inspector forms — decoded.', es: 'Formularios del agente vs. del prestamista vs. del inspector — explicados.', ru: 'Формы риелтора, кредитора и инспектора — разложено по полочкам.' },

  // LeadFlow chrome
  startHere:     { en: 'Start here',         es: 'Empieza aquí',          ru: 'Начните здесь' },
  chooseOpt:     { en: 'Choose…',            es: 'Elige…',                ru: 'Выберите…' },
  firstName:     { en: 'First name',         es: 'Nombre',                ru: 'Имя' },
  lastName:      { en: 'Last name',          es: 'Apellido',              ru: 'Фамилия' },
  email:         { en: 'Email',              es: 'Correo electrónico',    ru: 'Эл. почта' },
  mobilePhone:   { en: 'Mobile phone',       es: 'Teléfono móvil',        ru: 'Мобильный телефон' },
  sending:       { en: 'Sending…',           es: 'Enviando…',             ru: 'Отправка…' },
  consentNeeded: { en: 'Please agree to be contacted so we can follow up.', es: 'Acepta que te contactemos para poder dar seguimiento.', ru: 'Пожалуйста, согласитесь на контакт, чтобы мы могли ответить.' },
  genericError:  { en: 'Something went wrong. Please try again.', es: 'Algo salió mal. Inténtalo de nuevo.', ru: 'Что-то пошло не так. Попробуйте ещё раз.' },
  estimatesOnly: { en: 'Estimates only — not a loan offer, commitment to lend, or approval.', es: 'Solo estimaciones — no es una oferta de préstamo, compromiso de préstamo ni aprobación.', ru: 'Только оценки — не предложение кредита, не обязательство кредитовать и не одобрение.' },
  received:      { en: 'Received',           es: 'Recibido',              ru: 'Получено' },
  onIt:          { en: 'We’re on it.',       es: 'Estamos en ello.',      ru: 'Мы уже занимаемся.' },
  onItBody:      { en: 'Your answers are with the team. We’ll reach out shortly with what you qualify for and the exact next step.', es: 'Tus respuestas ya están con el equipo. Te contactaremos pronto con lo que calificas y el siguiente paso exacto.', ru: 'Ваши ответы у команды. Скоро свяжемся и расскажем, на что вы проходите, и точный следующий шаг.' },

  // Footer
  footerPrivacy: { en: 'Privacy Policy',     es: 'Política de privacidad', ru: 'Политика конфиденциальности' },
  footerTerms:   { en: 'Terms of Use',       es: 'Términos de uso',       ru: 'Условия использования' },
  footerEho:     { en: 'Equal Housing Opportunity', es: 'Igualdad de oportunidades de vivienda', ru: 'Равные возможности в жилье' },
  footerInvest:  { en: 'Investing in real-estate-secured notes?', es: '¿Invertir en pagarés respaldados por bienes raíces?', ru: 'Инвестируете в закладные под недвижимость?' },
  footerDisc:    { en: 'This is not a commitment to lend. All figures are estimates and subject to change. Program availability, funding, and eligibility change and are subject to program guidelines.', es: 'Esto no es un compromiso de préstamo. Todas las cifras son estimaciones y están sujetas a cambios. La disponibilidad de programas, el financiamiento y la elegibilidad cambian y están sujetos a las pautas del programa.', ru: 'Это не обязательство предоставить кредит. Все цифры — оценки и могут измениться. Доступность программ, финансирование и право на участие меняются и регулируются условиями программ.' },
}

export function useT() {
  const { lang } = useLang()
  return (key) => {
    const entry = UI[key]
    if (!entry) return key
    return entry[lang] ?? entry.en ?? key
  }
}

// Small inline EN / ES / RU switcher.
export function LangSwitch({ className = '' }) {
  const { lang, setLang } = useLang()
  return (
    <span className={`langswitch ${className}`} role="group" aria-label={UI.language[lang]}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          className={`langbtn${l === lang ? ' active' : ''}`}
          aria-pressed={l === lang}
          onClick={() => setLang(l)}
        >
          {LANG_LABELS[l]}
        </button>
      ))}
    </span>
  )
}
