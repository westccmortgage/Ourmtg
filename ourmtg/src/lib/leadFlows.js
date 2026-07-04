// Lead-flow definitions. Each flow posts the shared lead shape to GRCRM's lead-inbound
// webhook with a `source`/tag so routing + automations can branch (spec §I.1, §E.4).
// The webhook dedupes by email/phone and arms the correct workflow.
//
// TRILINGUAL: every borrower-facing string is a { en, es, ru } object, resolved at render
// time via pickLang()/usePick() from i18n. Language-independent keys (path, source, tag,
// field `name`, option canonical `v`) stay plain strings so routing and the CRM payload
// are identical regardless of the visitor's language.

export const LOAN_TYPES = ['Conventional', 'FHA', 'VA', 'Jumbo', 'USDA', 'Non-QM', 'DSCR']
export const PURPOSES = ['Purchase', 'Rate-Term Refi', 'Cash-out Refi', 'HELOC']

// Exact consent disclosure captured with the lead (TCPA/CAN-SPAM — spec §M).
// English is the canonical record stored in the CRM; the translated versions are what
// the borrower actually reads and agrees to on screen.
export const SMS_CONSENT_TEXT =
  'By checking this box, I agree to receive calls and text messages (including via automated ' +
  'technology) and emails from West Coast Capital Mortgage at the number and address provided, ' +
  'including about my loan inquiry. Consent is not a condition of any purchase. Message and data ' +
  'rates may apply. Reply STOP to opt out of texts at any time.'

export const SMS_CONSENT = {
  en: SMS_CONSENT_TEXT,
  es:
    'Al marcar esta casilla, acepto recibir llamadas y mensajes de texto (incluso mediante ' +
    'tecnología automatizada) y correos electrónicos de West Coast Capital Mortgage al número y ' +
    'la dirección proporcionados, incluso sobre mi solicitud de préstamo. El consentimiento no es ' +
    'condición para ninguna compra. Pueden aplicar tarifas de mensajes y datos. Responde STOP para ' +
    'cancelar los textos en cualquier momento.',
  ru:
    'Отмечая это поле, я соглашаюсь получать звонки и текстовые сообщения (в том числе через ' +
    'автоматические системы) и письма от West Coast Capital Mortgage на указанные номер и адрес, ' +
    'в том числе по моей заявке на кредит. Согласие не является условием какой-либо покупки. Могут ' +
    'применяться тарифы на сообщения и данные. Ответьте STOP, чтобы в любой момент отказаться от текстов.',
}

// Build the lead-inbound payload from a borrower intake form.
export function borrowerLeadPayload(form) {
  return {
    source: 'ourmtg_intake',
    tags: ['OurMTG', 'Borrower intake', form.loanType, form.purpose].filter(Boolean),
    firstName: form.firstName,
    lastName: form.lastName,
    name: [form.firstName, form.lastName].filter(Boolean).join(' '),
    email: form.email,
    phone: form.phone,
    loanType: form.loanType,
    purpose: form.purpose,
    message: form.message || null,
    consent: {
      sms: !!form.consent,
      email: !!form.consent,
      text: SMS_CONSENT_TEXT,
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
    },
  }
}

// ── Lead-engine flows (spec §E.4) ─────────────────────────────────────────────
// Each landing page LEADS with a plain-English (or Spanish/Russian) explainer of the
// program, then ends with the qualifier + contact form. `sections` render before the
// form. Block shapes: { p } paragraph, { ul } bullet list, { rows: [{ t, d }] } ledger
// rows, { note } caveat — each translatable value is { en, es, ru }.
export const FLOWS = {
  dpa: {
    path: '/dpa', source: 'dpa_check', tag: 'DPA check',
    eyebrow: {
      en: 'down payment assistance · california',
      es: 'ayuda para el enganche · california',
      ru: 'помощь с первым взносом · калифорния',
    },
    title: {
      en: ['own sooner,', 'with help on the down.'],
      es: ['compra antes,', 'con ayuda en el enganche.'],
      ru: ['купите раньше —', 'с помощью на взнос.'],
    },
    sub: {
      en: 'The down payment is the wall most first buyers hit. California has real programs that help you over it — here is how they actually work, and how to tell which ones are worth using.',
      es: 'El enganche es el muro con el que choca la mayoría de los primeros compradores. California tiene programas reales que te ayudan a superarlo — aquí te explicamos cómo funcionan de verdad y cómo saber cuáles valen la pena.',
      ru: 'Первый взнос — это стена, о которую спотыкается большинство начинающих покупателей. В Калифорнии есть реальные программы, которые помогают её преодолеть. Вот как они работают на самом деле и как понять, какие из них стоит использовать.',
    },
    cta: { en: 'Check my DPA options', es: 'Ver mis opciones de ayuda', ru: 'Проверить мои варианты помощи' },
    formIntro: {
      en: 'Three quick questions. No credit pull, no commitment — we check what is currently open for your county and income and tell you what fits.',
      es: 'Tres preguntas rápidas. Sin consulta de crédito y sin compromiso — revisamos qué hay disponible ahora para tu condado e ingresos y te decimos qué te conviene.',
      ru: 'Три быстрых вопроса. Без запроса кредитной истории и без обязательств — мы проверим, что сейчас доступно для вашего округа и дохода, и подскажем, что подходит.',
    },
    disclaimer: {
      en: 'Program availability, funding, and eligibility change and are subject to program guidelines.',
      es: 'La disponibilidad de programas, el financiamiento y la elegibilidad cambian y están sujetos a las pautas del programa.',
      ru: 'Доступность программ, финансирование и право на участие меняются и регулируются условиями программ.',
    },
    sections: [
      {
        h: { en: 'What down-payment assistance really is', es: 'Qué es realmente la ayuda para el enganche', ru: 'Что такое помощь с первым взносом на самом деле' },
        blocks: [
          { p: {
            en: 'Down-payment assistance (DPA) is help — usually a second loan or a grant — that covers some or all of your down payment, and sometimes closing costs too. You still get a normal first mortgage; the assistance sits quietly behind it. It does not replace your loan, it lowers the cash you need to bring to the table.',
            es: 'La ayuda para el enganche (DPA) es apoyo — normalmente un segundo préstamo o una subvención — que cubre parte o todo tu enganche, y a veces también los costos de cierre. Igual obtienes una primera hipoteca normal; la ayuda queda detrás de ella. No reemplaza tu préstamo, reduce el efectivo que necesitas aportar.',
            ru: 'Помощь с первым взносом (DPA) — это поддержка, обычно в виде второго займа или гранта, которая покрывает часть или весь первый взнос, а иногда и расходы на оформление. Вы всё равно получаете обычную первую ипотеку; помощь просто стоит «за ней». Она не заменяет ваш кредит, а уменьшает сумму наличных, которую нужно внести.',
          } },
          { p: {
            en: 'That is the whole idea: get you into the home years sooner than saving the full down payment would allow, without draining every dollar you have.',
            es: 'Esa es toda la idea: entrar a tu casa años antes de lo que permitiría ahorrar el enganche completo, sin vaciar hasta el último dólar que tienes.',
            ru: 'В этом весь смысл: заселиться в дом на годы раньше, чем если копить весь взнос самостоятельно, и не потратить при этом все свои сбережения до копейки.',
          } },
        ],
      },
      {
        h: { en: 'The main California programs', es: 'Los principales programas de California', ru: 'Основные программы Калифорнии' },
        blocks: [
          { rows: [
            { t: { en: 'CalHFA MyHome', es: 'CalHFA MyHome', ru: 'CalHFA MyHome' }, d: {
              en: 'A deferred second loan for the down payment and/or closing costs. You make no monthly payment on it — it is repaid when you sell, refinance, or pay off the first mortgage.',
              es: 'Un segundo préstamo diferido para el enganche y/o los costos de cierre. No pagas mensualidad — se paga cuando vendes, refinancias o liquidas la primera hipoteca.',
              ru: 'Отложенный второй заём на первый взнос и/или расходы по оформлению. Ежемесячных платежей по нему нет — он возвращается, когда вы продаёте, рефинансируете или полностью погашаете первую ипотеку.',
            } },
            { t: { en: 'CalHFA first mortgages', es: 'Primeras hipotecas CalHFA', ru: 'Первые ипотеки CalHFA' }, d: {
              en: 'A standard conventional or FHA first loan built to pair cleanly with CalHFA assistance so the two work together.',
              es: 'Un primer préstamo convencional o FHA estándar, diseñado para combinarse sin problemas con la ayuda de CalHFA.',
              ru: 'Обычная первая ипотека (conventional или FHA), рассчитанная на аккуратное сочетание с помощью CalHFA, чтобы обе работали вместе.',
            } },
            { t: { en: 'GSFA & city/county programs', es: 'Programas GSFA y de ciudad/condado', ru: 'Программы GSFA и города/округа' }, d: {
              en: 'Down-payment grants and forgivable seconds tied to income and area. Some are true grants — no repayment — and some forgive over a set number of years.',
              es: 'Subvenciones para el enganche y segundos préstamos condonables según ingresos y zona. Algunos son subvenciones reales — sin devolución — y otros se condonan tras cierto número de años.',
              ru: 'Гранты на первый взнос и «прощаемые» вторые займы в зависимости от дохода и района. Некоторые — настоящие гранты (возвращать не нужно), другие списываются через определённое число лет.',
            } },
          ] },
          { note: {
            en: 'Funding is limited and can pause mid-year when money runs out, then reopen. Timing genuinely matters — this is a big reason to check now rather than later.',
            es: 'El financiamiento es limitado y puede pausarse a mitad de año cuando se acaba el dinero, y luego reabrir. El momento importa de verdad — es una gran razón para revisar ahora y no después.',
            ru: 'Финансирование ограничено: деньги могут закончиться в середине года, программа приостанавливается, а потом снова открывается. Время действительно важно — это веская причина проверить сейчас, а не потом.',
          } },
        ],
      },
      {
        h: { en: 'Who usually qualifies', es: 'Quién suele calificar', ru: 'Кто обычно проходит' },
        blocks: [
          { ul: {
            en: [
              'First-time buyer — often defined as not having owned a home in the last three years (some programs waive this).',
              'Household income at or under your county’s program limit.',
              'A minimum credit score, commonly around 640–660.',
              'Completion of a short homebuyer-education course (online, a few hours).',
              'You’ll live in the home as your primary residence.',
            ],
            es: [
              'Comprador por primera vez — a menudo se define como no haber sido dueño de una vivienda en los últimos tres años (algunos programas lo omiten).',
              'Ingreso del hogar igual o menor al límite del programa para tu condado.',
              'Un puntaje de crédito mínimo, comúnmente alrededor de 640–660.',
              'Completar un curso corto de educación para compradores (en línea, unas horas).',
              'Vivirás en la casa como tu residencia principal.',
            ],
            ru: [
              'Покупаете жильё впервые — часто это значит «не владели домом последние три года» (некоторые программы это условие не требуют).',
              'Доход семьи не выше лимита программы для вашего округа.',
              'Минимальный кредитный рейтинг, обычно около 640–660.',
              'Прохождение короткого курса для покупателей жилья (онлайн, несколько часов).',
              'Вы будете жить в этом доме как в основном жилье.',
            ],
          } },
        ],
      },
      {
        h: { en: 'The honest trade-offs', es: 'Las desventajas honestas', ru: 'Честные компромиссы' },
        blocks: [
          { ul: {
            en: [
              'Most assistance is a second loan you repay later — not always free money. Read whether it’s deferred, forgivable, or a true grant.',
              'Income limits can exclude higher earners entirely.',
              'Layering assistance can slightly narrow which first mortgages and rates you can pair with.',
            ],
            es: [
              'La mayoría de la ayuda es un segundo préstamo que devuelves después — no siempre es dinero gratis. Fíjate si es diferido, condonable o una subvención real.',
              'Los límites de ingreso pueden excluir por completo a quienes ganan más.',
              'Sumar ayuda puede reducir un poco las primeras hipotecas y tasas con las que puedes combinarla.',
            ],
            ru: [
              'Чаще всего помощь — это второй заём, который позже придётся вернуть; не всегда это «бесплатные деньги». Уточняйте: он отложенный, прощаемый или это настоящий грант.',
              'Лимиты по доходу могут полностью исключить тех, кто зарабатывает больше.',
              'Добавление помощи может немного сузить выбор первых ипотек и ставок, с которыми её можно сочетать.',
            ],
          } },
          { p: {
            en: 'None of that makes DPA a bad deal — for the right buyer it’s the difference between owning now and owning in five years. It just means the right program depends on your numbers.',
            es: 'Nada de eso hace que la ayuda sea mala — para el comprador adecuado es la diferencia entre comprar ahora y comprar en cinco años. Solo significa que el programa correcto depende de tus números.',
            ru: 'Ничего из этого не делает DPA плохим вариантом — для подходящего покупателя это разница между «купить сейчас» и «купить через пять лет». Просто правильная программа зависит от ваших цифр.',
          } },
        ],
      },
    ],
    fields: [
      { name: 'First-time buyer', type: 'select',
        label: { en: 'First-time buyer', es: 'Comprador por primera vez', ru: 'Покупаете впервые' },
        options: [
          { v: 'Yes', en: 'Yes', es: 'Sí', ru: 'Да' },
          { v: 'No', en: 'No', es: 'No', ru: 'Нет' },
        ] },
      { name: 'Household income (yearly)', type: 'text',
        label: { en: 'Household income (yearly)', es: 'Ingreso del hogar (anual)', ru: 'Доход семьи (в год)' },
        placeholder: { en: '$95,000', es: '$95,000', ru: '$95,000' } },
      { name: 'Target county', type: 'text',
        label: { en: 'Target county', es: 'Condado objetivo', ru: 'Округ' },
        placeholder: { en: 'Los Angeles', es: 'Los Angeles', ru: 'Los Angeles' } },
    ],
  },

  fha: {
    path: '/fha', source: 'fha_qualification', tag: 'FHA qualification',
    eyebrow: { en: 'fha loans · 3.5% down', es: 'préstamos fha · 3.5% de enganche', ru: 'кредиты fha · 3,5% взноса' },
    title: {
      en: ['first home?', 'fha was built for you.'],
      es: ['¿primera casa?', 'fha fue hecho para ti.'],
      ru: ['первое жильё?', 'fha создан для вас.'],
    },
    sub: {
      en: 'FHA is the loan the government designed for buyers who don’t have a huge down payment or a spotless credit history. Here’s exactly how it works and where it wins — and where a conventional loan might beat it.',
      es: 'FHA es el préstamo que el gobierno diseñó para compradores que no tienen un enganche enorme ni un historial de crédito impecable. Aquí te explicamos exactamente cómo funciona y dónde gana — y dónde un préstamo convencional podría superarlo.',
      ru: 'FHA — это кредит, который государство создало для покупателей без крупного взноса и без идеальной кредитной истории. Вот как именно он работает и где он выигрывает — а где обычный кредит может оказаться выгоднее.',
    },
    cta: { en: 'See if I qualify', es: 'Ver si califico', ru: 'Узнать, прохожу ли я' },
    formIntro: {
      en: 'Two quick questions and your contact info. We’ll model FHA against a conventional loan so you see the real monthly and long-run cost, not just the down payment.',
      es: 'Dos preguntas rápidas y tus datos de contacto. Compararemos FHA con un préstamo convencional para que veas el costo real mensual y a largo plazo, no solo el enganche.',
      ru: 'Два быстрых вопроса и ваши контакты. Мы сравним FHA с обычным кредитом, чтобы вы видели реальную стоимость — ежемесячную и на длинной дистанции, а не только взнос.',
    },
    sections: [
      {
        h: { en: 'What an FHA loan is', es: 'Qué es un préstamo FHA', ru: 'Что такое кредит FHA' },
        blocks: [
          { p: {
            en: 'An FHA loan is insured by the Federal Housing Administration. That insurance protects the lender if a loan goes bad, which is what lets us approve buyers with lower down payments and less-than-perfect credit than a conventional loan would allow. It’s a government-backed on-ramp to ownership — not a lesser loan.',
            es: 'Un préstamo FHA está asegurado por la Administración Federal de Vivienda. Ese seguro protege al prestamista si el préstamo falla, y por eso podemos aprobar a compradores con enganches más bajos y crédito menos que perfecto de lo que permitiría un préstamo convencional. Es una entrada a la propiedad respaldada por el gobierno — no un préstamo inferior.',
            ru: 'Кредит FHA застрахован Федеральной жилищной администрацией. Эта страховка защищает кредитора, если заём окажется проблемным, — именно поэтому мы можем одобрять покупателей с меньшим взносом и не идеальной кредитной историей, чем допускает обычный кредит. Это поддержанный государством вход в собственность, а не «кредит второго сорта».',
          } },
        ],
      },
      {
        h: { en: 'The numbers that matter', es: 'Los números que importan', ru: 'Цифры, которые важны' },
        blocks: [
          { rows: [
            { t: { en: '3.5% down', es: '3.5% de enganche', ru: '3,5% взноса' }, d: {
              en: 'With a credit score of 580 or higher. Between 500–579 the minimum is 10% down.',
              es: 'Con un puntaje de crédito de 580 o más. Entre 500–579 el mínimo es 10% de enganche.',
              ru: 'При кредитном рейтинге 580 и выше. При 500–579 минимум — 10% взноса.',
            } },
            { t: { en: 'Mortgage insurance', es: 'Seguro hipotecario', ru: 'Ипотечная страховка' }, d: {
              en: 'An upfront premium (financed into the loan) plus a monthly premium. This is the trade you make for the low down payment.',
              es: 'Una prima inicial (financiada dentro del préstamo) más una prima mensual. Es el precio que pagas por el enganche bajo.',
              ru: 'Единовременная премия (включается в сумму кредита) плюс ежемесячная. Это плата за низкий первый взнос.',
            } },
            { t: { en: 'County loan limits', es: 'Límites de préstamo por condado', ru: 'Лимиты кредита по округу' }, d: {
              en: 'FHA caps how much you can borrow, and the cap varies by county. High-cost California counties have higher limits.',
              es: 'FHA limita cuánto puedes pedir prestado, y el tope varía por condado. Los condados caros de California tienen límites más altos.',
              ru: 'FHA ограничивает сумму займа, и лимит зависит от округа. В дорогих округах Калифорнии лимиты выше.',
            } },
            { t: { en: 'Flexible ratios', es: 'Ratios flexibles', ru: 'Гибкие соотношения' }, d: {
              en: 'FHA often allows a higher debt-to-income ratio than conventional, with compensating factors like reserves or a strong payment history.',
              es: 'FHA suele permitir una relación deuda-ingreso más alta que la convencional, con factores compensatorios como reservas o un buen historial de pagos.',
              ru: 'FHA часто допускает более высокое соотношение долга к доходу, чем обычный кредит, при компенсирующих факторах — резервах или хорошей истории платежей.',
            } },
          ] },
        ],
      },
      {
        h: { en: 'FHA vs. conventional — the honest comparison', es: 'FHA vs. convencional — la comparación honesta', ru: 'FHA против обычного — честное сравнение' },
        blocks: [
          { ul: {
            en: [
              'FHA: easier credit, lower down — but the mortgage insurance usually stays for the life of the loan unless you later refinance out of it.',
              'Conventional: needs stronger credit, but the mortgage insurance drops off automatically once you reach about 20% equity.',
              'For many buyers FHA is the right first move, then a refinance to conventional later once credit and equity improve. We’ll tell you if that’s your path.',
            ],
            es: [
              'FHA: crédito más fácil, enganche más bajo — pero el seguro hipotecario normalmente dura toda la vida del préstamo, a menos que después refinancies para quitarlo.',
              'Convencional: exige mejor crédito, pero el seguro hipotecario desaparece automáticamente al llegar a cerca del 20% de plusvalía.',
              'Para muchos compradores FHA es el primer paso correcto, y luego un refinanciamiento a convencional cuando mejoran el crédito y la plusvalía. Te diremos si ese es tu camino.',
            ],
            ru: [
              'FHA: проще с кредитом, ниже взнос — но страховка обычно остаётся на весь срок кредита, пока вы позже не рефинансируете и не уберёте её.',
              'Обычный: нужен более сильный кредит, зато страховка отпадает автоматически, когда вы достигаете примерно 20% собственного капитала.',
              'Для многих покупателей FHA — верный первый шаг, а затем рефинансирование в обычный кредит, когда улучшатся кредит и капитал. Мы подскажем, ваш ли это путь.',
            ],
          } },
        ],
      },
      {
        h: { en: 'FHA is usually a strong fit if', es: 'FHA suele encajar bien si', ru: 'FHA обычно хорошо подходит, если' },
        blocks: [
          { ul: {
            en: [
              'Your credit is roughly in the 580–680 range.',
              'Your down payment is limited.',
              'You’ve had a past credit bump — a late stretch, a collection, a thin file.',
              'This is your first home and you want the lowest barrier to entry.',
            ],
            es: [
              'Tu crédito está más o menos entre 580 y 680.',
              'Tu enganche es limitado.',
              'Has tenido un tropiezo de crédito — pagos tardíos, una cuenta en cobranza, un historial delgado.',
              'Es tu primera casa y quieres la barrera de entrada más baja.',
            ],
            ru: [
              'Ваш кредитный рейтинг примерно в диапазоне 580–680.',
              'Первый взнос ограничен.',
              'В прошлом были проблемы с кредитом — просрочки, счёт в коллекторах, «тонкая» история.',
              'Это ваше первое жильё и вам нужен самый низкий порог входа.',
            ],
          } },
        ],
      },
    ],
    fields: [
      { name: 'Credit score range', type: 'select',
        label: { en: 'Credit score range', es: 'Rango de puntaje de crédito', ru: 'Диапазон кредитного рейтинга' },
        options: [
          { v: '740+', en: '740+', es: '740+', ru: '740+' },
          { v: '680–739', en: '680–739', es: '680–739', ru: '680–739' },
          { v: '620–679', en: '620–679', es: '620–679', ru: '620–679' },
          { v: 'Below 620', en: 'Below 620', es: 'Menos de 620', ru: 'Ниже 620' },
          { v: 'Not sure', en: 'Not sure', es: 'No estoy seguro', ru: 'Не уверен(а)' },
        ] },
      { name: 'Down payment saved', type: 'text',
        label: { en: 'Down payment saved', es: 'Enganche ahorrado', ru: 'Накоплено на взнос' },
        placeholder: { en: '$15,000', es: '$15,000', ru: '$15,000' } },
    ],
  },

  va: {
    path: '/va', source: 'va_eligibility', tag: 'VA eligibility',
    eyebrow: {
      en: 'va loans · $0 down · thank you for your service',
      es: 'préstamos va · $0 de enganche · gracias por tu servicio',
      ru: 'кредиты va · $0 взноса · спасибо за вашу службу',
    },
    title: {
      en: ['you served.', 'the zero-down loan is yours.'],
      es: ['usted sirvió.', 'el préstamo sin enganche es suyo.'],
      ru: ['вы служили.', 'кредит без взноса — ваш.'],
    },
    sub: {
      en: 'The VA loan is one of the strongest mortgages in the country — and you earned it. Here’s everything it does, what the funding fee is, and how we confirm your eligibility.',
      es: 'El préstamo VA es una de las hipotecas más fuertes del país — y usted se lo ganó. Aquí está todo lo que hace, qué es la cuota de financiamiento y cómo confirmamos su elegibilidad.',
      ru: 'Кредит VA — одна из самых сильных ипотек в стране, и вы её заслужили. Вот всё, что он даёт, что такое funding fee и как мы подтверждаем ваше право на него.',
    },
    cta: { en: 'Confirm my eligibility', es: 'Confirmar mi elegibilidad', ru: 'Подтвердить моё право' },
    formIntro: {
      en: 'Two quick questions and your contact info. We’ll confirm eligibility and help you pull your Certificate of Eligibility (COE).',
      es: 'Dos preguntas rápidas y sus datos de contacto. Confirmaremos su elegibilidad y le ayudaremos a obtener su Certificado de Elegibilidad (COE).',
      ru: 'Два быстрых вопроса и ваши контакты. Мы подтвердим право и поможем получить ваш сертификат соответствия (COE).',
    },
    sections: [
      {
        h: { en: 'What a VA loan is', es: 'Qué es un préstamo VA', ru: 'Что такое кредит VA' },
        blocks: [
          { p: {
            en: 'The VA loan is backed by the U.S. Department of Veterans Affairs and available to eligible active-duty service members, veterans, National Guard and Reserve members, and certain surviving spouses. The VA doesn’t lend the money — it guarantees part of the loan, which lets us offer terms no other program can match.',
            es: 'El préstamo VA está respaldado por el Departamento de Asuntos de Veteranos de EE. UU. y está disponible para militares en servicio activo, veteranos, miembros de la Guardia Nacional y la Reserva, y ciertos cónyuges sobrevivientes que sean elegibles. El VA no presta el dinero — garantiza parte del préstamo, y eso nos permite ofrecer condiciones que ningún otro programa iguala.',
            ru: 'Кредит VA поддерживается Министерством по делам ветеранов США и доступен подходящим военнослужащим действующей службы, ветеранам, членам Национальной гвардии и резерва, а также некоторым вдовам/вдовцам. VA не выдаёт деньги — оно гарантирует часть займа, и это позволяет нам предлагать условия, которых нет ни у одной другой программы.',
          } },
        ],
      },
      {
        h: { en: 'Why it’s so strong', es: 'Por qué es tan fuerte', ru: 'Почему он такой выгодный' },
        blocks: [
          { rows: [
            { t: { en: '$0 down', es: '$0 de enganche', ru: '$0 взноса' }, d: {
              en: 'On most purchases — no down payment required at all, on a primary residence.',
              es: 'En la mayoría de las compras — no se requiere enganche, en una residencia principal.',
              ru: 'В большинстве покупок первый взнос вообще не нужен — для основного жилья.',
            } },
            { t: { en: 'No monthly mortgage insurance', es: 'Sin seguro hipotecario mensual', ru: 'Без ежемесячной ипотечной страховки' }, d: {
              en: 'FHA and low-down conventional loans both charge it every month. VA doesn’t. That’s real money saved on every payment.',
              es: 'FHA y los convencionales con enganche bajo lo cobran cada mes. VA no. Es dinero real ahorrado en cada pago.',
              ru: 'FHA и обычные кредиты с малым взносом берут её каждый месяц. VA — нет. Это реальная экономия на каждом платеже.',
            } },
            { t: { en: 'Competitive rates', es: 'Tasas competitivas', ru: 'Конкурентные ставки' }, d: {
              en: 'VA rates are typically among the lowest available, and some closing costs are limited or must be paid by the seller or lender.',
              es: 'Las tasas VA suelen estar entre las más bajas, y algunos costos de cierre son limitados o los debe pagar el vendedor o el prestamista.',
              ru: 'Ставки VA обычно одни из самых низких, а часть расходов по оформлению ограничена или должна оплачиваться продавцом либо кредитором.',
            } },
            { t: { en: 'Reusable', es: 'Reutilizable', ru: 'Можно использовать снова' }, d: {
              en: 'This is not a one-time benefit. You can use it again, and in some cases have more than one VA loan at once.',
              es: 'No es un beneficio de una sola vez. Puede usarlo de nuevo y, en algunos casos, tener más de un préstamo VA a la vez.',
              ru: 'Это не разовая льгота. Ею можно воспользоваться снова, а в некоторых случаях иметь сразу несколько кредитов VA.',
            } },
          ] },
        ],
      },
      {
        h: { en: 'The VA funding fee', es: 'La cuota de financiamiento VA', ru: 'Сбор VA (funding fee)' },
        blocks: [
          { p: {
            en: 'In place of monthly mortgage insurance, VA charges a one-time funding fee that can be financed into the loan. First-time use is a lower percentage than later uses, and a larger down payment reduces it further.',
            es: 'En lugar del seguro hipotecario mensual, VA cobra una cuota de financiamiento única que puede incluirse en el préstamo. El primer uso tiene un porcentaje menor que los siguientes, y un enganche mayor la reduce aún más.',
            ru: 'Вместо ежемесячной страховки VA берёт единовременный сбор, который можно включить в сумму кредита. При первом использовании процент ниже, чем при последующих, а больший взнос уменьшает его ещё сильнее.',
          } },
          { note: {
            en: 'Veterans receiving compensation for a service-connected disability are generally exempt from the funding fee entirely.',
            es: 'Los veteranos que reciben compensación por una discapacidad relacionada con el servicio suelen estar totalmente exentos de la cuota de financiamiento.',
            ru: 'Ветераны, получающие компенсацию за инвалидность, связанную со службой, как правило, полностью освобождаются от этого сбора.',
          } },
        ],
      },
      {
        h: { en: 'What you’ll need', es: 'Lo que necesitará', ru: 'Что понадобится' },
        blocks: [
          { ul: {
            en: [
              'Your Certificate of Eligibility (COE) — we help you pull it; it confirms your entitlement to the VA benefit.',
              'Proof of service — typically the DD-214 for veterans, or a statement of service for active duty.',
              'The home must be your primary residence — VA is not for pure investment property.',
            ],
            es: [
              'Su Certificado de Elegibilidad (COE) — le ayudamos a obtenerlo; confirma su derecho al beneficio VA.',
              'Prueba de servicio — normalmente el DD-214 para veteranos, o una constancia de servicio para servicio activo.',
              'La vivienda debe ser su residencia principal — VA no es para propiedad de pura inversión.',
            ],
            ru: [
              'Ваш сертификат соответствия (COE) — мы поможем его получить; он подтверждает право на льготу VA.',
              'Подтверждение службы — обычно DD-214 для ветеранов или справка о службе для действующих военных.',
              'Жильё должно быть вашим основным — VA не для чисто инвестиционной недвижимости.',
            ],
          } },
        ],
      },
    ],
    fields: [
      { name: 'Service status', type: 'select',
        label: { en: 'Service status', es: 'Estatus de servicio', ru: 'Статус службы' },
        options: [
          { v: 'Veteran', en: 'Veteran', es: 'Veterano', ru: 'Ветеран' },
          { v: 'Active duty', en: 'Active duty', es: 'Servicio activo', ru: 'Действующая служба' },
          { v: 'Reserves / Guard', en: 'Reserves / Guard', es: 'Reserva / Guardia', ru: 'Резерв / Гвардия' },
          { v: 'Surviving spouse', en: 'Surviving spouse', es: 'Cónyuge sobreviviente', ru: 'Вдова / вдовец' },
        ] },
      { name: 'Used VA benefit before', type: 'select',
        label: { en: 'Used VA benefit before', es: '¿Usó el beneficio VA antes?', ru: 'Пользовались льготой VA ранее' },
        options: [
          { v: 'No', en: 'No', es: 'No', ru: 'Нет' },
          { v: 'Yes', en: 'Yes', es: 'Sí', ru: 'Да' },
          { v: 'Not sure', en: 'Not sure', es: 'No estoy seguro', ru: 'Не уверен(а)' },
        ] },
    ],
  },

  selfEmployed: {
    path: '/self-employed', source: 'self_employed_review', tag: 'Self-employed review',
    eyebrow: { en: 'bank-statement loans · non-qm', es: 'préstamos con estados de cuenta · non-qm', ru: 'кредиты по банковским выпискам · non-qm' },
    title: {
      en: ['self-employed?', 'your bank statements are your W-2.'],
      es: ['¿trabajas por tu cuenta?', 'tus estados de cuenta son tu W-2.'],
      ru: ['работаете на себя?', 'ваши выписки — это ваш W-2.'],
    },
    sub: {
      en: 'If you write off enough to keep your taxes low, your tax returns make you look like you barely earn a living — and traditional lenders believe the returns. Bank-statement loans qualify you on the money that actually moves through your accounts instead.',
      es: 'Si deduces lo suficiente para pagar pocos impuestos, tus declaraciones te hacen ver como si apenas ganaras para vivir — y los prestamistas tradicionales les creen. Los préstamos con estados de cuenta te califican con el dinero que realmente pasa por tus cuentas.',
      ru: 'Если вы списываете достаточно расходов, чтобы платить меньше налогов, ваши декларации выглядят так, будто вы едва сводите концы с концами, — и обычные банки верят декларациям. Кредиты по банковским выпискам одобряют вас по деньгам, которые реально проходят через ваши счета.',
    },
    cta: { en: 'Review my scenario', es: 'Revisar mi caso', ru: 'Разобрать мою ситуацию' },
    formIntro: {
      en: 'Two quick questions and your contact info. We’ll map your income the way an underwriter will and tell you what you can realistically qualify for.',
      es: 'Dos preguntas rápidas y tus datos de contacto. Analizaremos tus ingresos como lo haría un evaluador y te diremos para qué puedes calificar de verdad.',
      ru: 'Два быстрых вопроса и ваши контакты. Мы посчитаем ваш доход так, как это сделает андеррайтер, и скажем, на что вы реально проходите.',
    },
    sections: [
      {
        h: { en: 'Why self-employed buyers get stuck', es: 'Por qué los trabajadores independientes se atoran', ru: 'Почему самозанятым отказывают' },
        blocks: [
          { p: {
            en: 'Tax returns are written to minimize taxable income — that’s smart accounting. But a conventional lender qualifies you on that same low number, so a business owner who nets plenty of real cash can look, on paper, like they can barely afford a small loan. Bank-statement and other Non-QM loans fix this by looking at your actual cash flow.',
            es: 'Las declaraciones de impuestos se hacen para minimizar el ingreso gravable — eso es buena contabilidad. Pero un prestamista convencional te califica con ese mismo número bajo, así que un dueño de negocio que gana mucho en efectivo real puede parecer, en papel, que apenas alcanza para un préstamo pequeño. Los préstamos con estados de cuenta y otros Non-QM lo resuelven mirando tu flujo de efectivo real.',
            ru: 'Налоговые декларации составляют так, чтобы уменьшить облагаемый доход, — это грамотная бухгалтерия. Но обычный банк оценивает вас именно по этой заниженной цифре, поэтому владелец бизнеса с хорошим реальным доходом на бумаге выглядит так, будто едва потянет маленький кредит. Кредиты по выпискам и другие Non-QM решают это, глядя на ваш фактический денежный поток.',
          } },
        ],
      },
      {
        h: { en: 'How a bank-statement loan works', es: 'Cómo funciona un préstamo con estados de cuenta', ru: 'Как работает кредит по выпискам' },
        blocks: [
          { rows: [
            { t: { en: '12–24 months of statements', es: '12–24 meses de estados de cuenta', ru: '12–24 месяца выписок' }, d: {
              en: 'Personal or business bank statements stand in for tax returns as proof of income.',
              es: 'Los estados de cuenta personales o de negocio sustituyen a las declaraciones como prueba de ingresos.',
              ru: 'Личные или бизнес-выписки заменяют налоговые декларации как подтверждение дохода.',
            } },
            { t: { en: 'Income from real deposits', es: 'Ingreso de depósitos reales', ru: 'Доход по реальным поступлениям' }, d: {
              en: 'We calculate qualifying income from the deposits that actually land in your accounts, applying an expense factor — no tax returns required.',
              es: 'Calculamos el ingreso calificable a partir de los depósitos que realmente entran a tus cuentas, aplicando un factor de gastos — sin declaraciones de impuestos.',
              ru: 'Мы считаем доход по поступлениям, которые реально приходят на ваши счета, применяя коэффициент расходов — налоговые декларации не нужны.',
            } },
            { t: { en: 'Usually 2 years in business', es: 'Normalmente 2 años en el negocio', ru: 'Обычно 2 года в деле' }, d: {
              en: 'Most programs want a two-year track record and a somewhat larger down payment (often 10–20%).',
              es: 'La mayoría de los programas quieren dos años de trayectoria y un enganche algo mayor (a menudo 10–20%).',
              ru: 'Большинство программ хотят двухлетний стаж и чуть больший взнос (часто 10–20%).',
            } },
            { t: { en: 'Slightly higher rate', es: 'Tasa un poco más alta', ru: 'Немного выше ставка' }, d: {
              en: 'The rate typically runs a bit above conventional — that’s the trade for flexible documentation. Often well worth it to qualify at all.',
              es: 'La tasa suele estar un poco por encima de la convencional — ese es el precio de la documentación flexible. Muchas veces vale la pena con tal de calificar.',
              ru: 'Ставка обычно чуть выше обычной — это плата за гибкие требования к документам. Часто оно того стоит, чтобы вообще пройти одобрение.',
            } },
          ] },
        ],
      },
      {
        h: { en: 'Who this fits', es: 'A quién le sirve', ru: 'Кому это подходит' },
        blocks: [
          { ul: {
            en: [
              'Business owners and the self-employed whose write-offs hide their true income.',
              '1099 contractors and gig workers.',
              'Real-estate agents, consultants, and commission earners.',
              'Anyone told “no” by a bank because their tax returns don’t reflect what they really make.',
            ],
            es: [
              'Dueños de negocio y trabajadores independientes cuyas deducciones ocultan su ingreso real.',
              'Contratistas 1099 y trabajadores de la economía informal.',
              'Agentes inmobiliarios, consultores y quienes ganan por comisión.',
              'Cualquiera a quien un banco le dijo “no” porque sus declaraciones no reflejan lo que realmente gana.',
            ],
            ru: [
              'Владельцы бизнеса и самозанятые, у которых списания скрывают реальный доход.',
              'Подрядчики на 1099 и работники подработок.',
              'Риелторы, консультанты и те, кто получает комиссионные.',
              'Все, кому банк сказал «нет», потому что декларации не отражают реальный заработок.',
            ],
          } },
        ],
      },
      {
        h: { en: 'Other doors we can open', es: 'Otras puertas que podemos abrir', ru: 'Другие двери, которые мы можем открыть' },
        blocks: [
          { ul: {
            en: [
              'Profit-and-loss-only programs (a CPA-prepared P&L in place of statements).',
              'Asset-depletion loans that qualify you off your savings and investments.',
              '1099-only programs for straightforward contractor income.',
            ],
            es: [
              'Programas solo con estado de resultados (un P&L preparado por un contador en lugar de estados de cuenta).',
              'Préstamos por agotamiento de activos que te califican con tus ahorros e inversiones.',
              'Programas solo con 1099 para ingresos de contratista sencillos.',
            ],
            ru: [
              'Программы только по отчёту о прибылях и убытках (P&L от бухгалтера вместо выписок).',
              'Кредиты по «истощению активов» — одобрение по вашим сбережениям и инвестициям.',
              'Программы только по 1099 для простого подрядного дохода.',
            ],
          } },
        ],
      },
    ],
    fields: [
      { name: 'Years self-employed', type: 'select',
        label: { en: 'Years self-employed', es: 'Años por cuenta propia', ru: 'Лет работы на себя' },
        options: [
          { v: '2+', en: '2+', es: '2+', ru: '2+' },
          { v: '1–2', en: '1–2', es: '1–2', ru: '1–2' },
          { v: 'Under 1', en: 'Under 1', es: 'Menos de 1', ru: 'Меньше 1' },
        ] },
      { name: 'Business type', type: 'text',
        label: { en: 'Business type', es: 'Tipo de negocio', ru: 'Тип бизнеса' },
        placeholder: { en: 'Contractor, salon, trucking…', es: 'Contratista, salón, transporte…', ru: 'Подрядчик, салон, перевозки…' } },
    ],
  },

  jumbo: {
    path: '/jumbo', source: 'jumbo_readiness', tag: 'Jumbo readiness',
    eyebrow: { en: 'jumbo · above county limits', es: 'jumbo · por encima del límite del condado', ru: 'jumbo · выше лимитов округа' },
    title: {
      en: ['bigger loan.', 'same calm process.'],
      es: ['préstamo más grande.', 'el mismo proceso tranquilo.'],
      ru: ['крупнее заём.', 'тот же спокойный процесс.'],
    },
    sub: {
      en: 'A jumbo loan is bigger than the limits Fannie Mae and Freddie Mac will buy, so it’s underwritten by hand to stricter standards. The buyers who win in escrow are the ones whose file was packaged right before they ever wrote an offer. Here’s what that takes.',
      es: 'Un préstamo jumbo es más grande que los límites que Fannie Mae y Freddie Mac compran, así que se evalúa a mano con estándares más estrictos. Los compradores que ganan en el cierre son los que armaron bien su expediente antes de hacer una oferta. Esto es lo que hace falta.',
      ru: 'Кредит jumbo больше лимитов, которые выкупают Fannie Mae и Freddie Mac, поэтому его андеррайтят вручную по более строгим правилам. В сделке выигрывают те покупатели, чьё дело было правильно собрано ещё до подачи оффера. Вот что для этого нужно.',
    },
    cta: { en: 'Test my readiness', es: 'Evaluar mi preparación', ru: 'Проверить мою готовность' },
    formIntro: {
      en: 'Two quick questions and your contact info. We’ll pressure-test your file against jumbo standards and flag anything that needs shoring up before you offer.',
      es: 'Dos preguntas rápidas y tus datos de contacto. Someteremos tu expediente a los estándares jumbo y señalaremos lo que haya que reforzar antes de que ofertes.',
      ru: 'Два быстрых вопроса и ваши контакты. Мы проверим ваше дело на прочность по стандартам jumbo и укажем, что нужно усилить до подачи оффера.',
    },
    sections: [
      {
        h: { en: 'What makes a loan “jumbo”', es: 'Qué hace “jumbo” a un préstamo', ru: 'Что делает заём «jumbo»' },
        blocks: [
          { p: {
            en: 'Every county has a conforming loan limit — the most Fannie Mae and Freddie Mac will back. Borrow above it and your loan is “jumbo”: it can’t be sold to those agencies, so a lender (or its investors) holds the risk directly. That means hand underwriting and tighter standards, judged on the strength of the whole file.',
            es: 'Cada condado tiene un límite de préstamo conforme — lo máximo que respaldan Fannie Mae y Freddie Mac. Si pides más, tu préstamo es “jumbo”: no se puede vender a esas agencias, así que el prestamista (o sus inversionistas) asume el riesgo directamente. Eso implica evaluación manual y estándares más estrictos, juzgando la fuerza de todo el expediente.',
            ru: 'В каждом округе есть лимит «conforming» — максимум, который поддержат Fannie Mae и Freddie Mac. Если занять больше, заём становится «jumbo»: его нельзя продать этим агентствам, поэтому риск напрямую несёт кредитор (или его инвесторы). Значит — ручной андеррайтинг и более жёсткие требования, где оценивают силу всего дела целиком.',
          } },
        ],
      },
      {
        h: { en: 'What underwriters look at harder', es: 'Lo que los evaluadores miran con más rigor', ru: 'На что андеррайтеры смотрят строже' },
        blocks: [
          { rows: [
            { t: { en: 'Reserves', es: 'Reservas', ru: 'Резервы' }, d: {
              en: 'Months of mortgage payments still in the bank after closing. Jumbo files want to see a real cushion — this is often the make-or-break factor.',
              es: 'Meses de pagos de hipoteca que quedan en el banco después del cierre. Los expedientes jumbo quieren ver un colchón real — a menudo es el factor decisivo.',
              ru: 'Сколько месячных ипотечных платежей остаётся на счёте после сделки. Для jumbo важен реальный запас — часто это решающий фактор.',
            } },
            { t: { en: 'Down payment', es: 'Enganche', ru: 'Первый взнос' }, d: {
              en: 'Commonly 10–20% or more, depending on the loan size and property.',
              es: 'Comúnmente 10–20% o más, según el tamaño del préstamo y la propiedad.',
              ru: 'Обычно 10–20% или больше, в зависимости от суммы кредита и объекта.',
            } },
            { t: { en: 'Credit', es: 'Crédito', ru: 'Кредит' }, d: {
              en: 'Usually 700+, with a clean recent history.',
              es: 'Normalmente 700+, con un historial reciente limpio.',
              ru: 'Обычно 700+ при чистой недавней истории.',
            } },
            { t: { en: 'Documentation', es: 'Documentación', ru: 'Документы' }, d: {
              en: 'Complete, current, and fully sourced. Every large deposit must be explained and traced.',
              es: 'Completa, actual y con origen comprobado. Cada depósito grande debe explicarse y rastrearse.',
              ru: 'Полные, свежие и с подтверждённым происхождением. Каждое крупное поступление нужно объяснить и проследить.',
            } },
          ] },
        ],
      },
      {
        h: { en: 'Why packaging is everything', es: 'Por qué el armado lo es todo', ru: 'Почему подготовка дела решает всё' },
        blocks: [
          { p: {
            en: 'A jumbo file is judged as one story, not a checklist. A missing statement, an unexplained transfer, or a thin reserve picture can sink an otherwise strong buyer. We assemble and pressure-test the file before you’re in contract, so an underwriter sees a clean, complete picture — and you’re not scrambling in the middle of escrow with the clock running.',
            es: 'Un expediente jumbo se juzga como una sola historia, no como una lista. Un estado de cuenta faltante, una transferencia sin explicar o pocas reservas pueden hundir a un comprador por lo demás fuerte. Armamos y probamos el expediente antes de que estés en contrato, para que el evaluador vea un panorama limpio y completo — y no andes corriendo en pleno cierre con el reloj en contra.',
            ru: 'Дело jumbo оценивают как единую историю, а не как галочки в списке. Недостающая выписка, необъяснённый перевод или слабые резервы могут потопить в остальном сильного покупателя. Мы собираем и проверяем дело до того, как вы в контракте, чтобы андеррайтер видел чистую и полную картину — а вы не метались в разгар сделки под тикающие часы.',
          } },
        ],
      },
    ],
    fields: [
      { name: 'Target price range', type: 'text',
        label: { en: 'Target price range', es: 'Rango de precio objetivo', ru: 'Ориентир по цене' },
        placeholder: { en: '$1.2M–$1.5M', es: '$1.2M–$1.5M', ru: '$1.2M–$1.5M' } },
      { name: 'Down payment %', type: 'select',
        label: { en: 'Down payment %', es: '% de enganche', ru: '% первого взноса' },
        options: [
          { v: '20%+', en: '20%+', es: '20%+', ru: '20%+' },
          { v: '10–20%', en: '10–20%', es: '10–20%', ru: '10–20%' },
          { v: 'Under 10%', en: 'Under 10%', es: 'Menos de 10%', ru: 'Меньше 10%' },
        ] },
    ],
  },

  refi: {
    path: '/refi', source: 'refinance_review', tag: 'Refinance review',
    eyebrow: { en: 'refinance · rate-term · cash-out · heloc', es: 'refinanciar · tasa-plazo · retiro de efectivo · heloc', ru: 'рефинансирование · ставка-срок · вывод наличных · heloc' },
    title: {
      en: ['your rate is not', 'a life sentence.'],
      es: ['tu tasa no es', 'una cadena perpetua.'],
      ru: ['ваша ставка —', 'не пожизненный приговор.'],
    },
    sub: {
      en: 'Refinancing can save you real money — or quietly cost you money while feeling like a win. The only honest question is whether it pays for you, after costs. Here’s exactly how to tell, and when the answer is no.',
      es: 'Refinanciar puede ahorrarte dinero real — o costarte dinero en silencio mientras parece una victoria. La única pregunta honesta es si te conviene, después de los costos. Aquí te decimos exactamente cómo saberlo, y cuándo la respuesta es no.',
      ru: 'Рефинансирование может сэкономить реальные деньги — или незаметно обойтись вам дороже, при этом ощущаясь как победа. Единственный честный вопрос: выгодно ли это лично вам после всех расходов. Вот как это точно понять и когда ответ — «нет».',
    },
    cta: { en: 'Review my loan', es: 'Revisar mi préstamo', ru: 'Проверить мой кредит' },
    formIntro: {
      en: 'Two quick questions and your contact info. We’ll run your break-even honestly and tell you whether refinancing pays — and if it doesn’t, we’ll say so.',
      es: 'Dos preguntas rápidas y tus datos de contacto. Calcularemos tu punto de equilibrio con honestidad y te diremos si refinanciar conviene — y si no, te lo diremos.',
      ru: 'Два быстрых вопроса и ваши контакты. Мы честно посчитаем вашу точку окупаемости и скажем, выгодно ли рефинансирование, — а если нет, так и скажем.',
    },
    sections: [
      {
        h: { en: 'The three reasons people refinance', es: 'Las tres razones para refinanciar', ru: 'Три причины рефинансировать' },
        blocks: [
          { rows: [
            { t: { en: 'Lower the rate or payment', es: 'Bajar la tasa o el pago', ru: 'Снизить ставку или платёж' }, d: {
              en: 'Replace your loan with a cheaper one. Worth it when the monthly savings pays back the closing costs within a reasonable time.',
              es: 'Cambiar tu préstamo por uno más barato. Conviene cuando el ahorro mensual recupera los costos de cierre en un tiempo razonable.',
              ru: 'Заменить кредит на более дешёвый. Выгодно, когда ежемесячная экономия окупает расходы по оформлению за разумный срок.',
            } },
            { t: { en: 'Cash out equity', es: 'Retirar plusvalía', ru: 'Вывести собственный капитал' }, d: {
              en: 'Borrow against the value you’ve built for a renovation, debt payoff, or investment — trading a bit of equity for cash in hand.',
              es: 'Pedir prestado contra el valor que has creado para una remodelación, pagar deudas o invertir — cambiando algo de plusvalía por efectivo en mano.',
              ru: 'Занять под накопленную стоимость на ремонт, погашение долгов или инвестиции — обменяв часть капитала на наличные.',
            } },
            { t: { en: 'Change the loan itself', es: 'Cambiar el préstamo en sí', ru: 'Изменить сам кредит' }, d: {
              en: 'Drop mortgage insurance, shorten the term to pay off faster, or move off an adjustable rate onto a fixed one.',
              es: 'Quitar el seguro hipotecario, acortar el plazo para pagar más rápido, o pasar de una tasa ajustable a una fija.',
              ru: 'Убрать ипотечную страховку, сократить срок ради более быстрой выплаты или уйти с плавающей ставки на фиксированную.',
            } },
          ] },
        ],
      },
      {
        h: { en: 'The break-even math', es: 'La cuenta del punto de equilibrio', ru: 'Математика окупаемости' },
        blocks: [
          { p: {
            en: 'It’s one simple calculation: closing costs ÷ monthly savings = the number of months to break even. If you’ll keep the home past that point, the refinance pays. If you might sell or refinance again before then, it doesn’t — no matter how good the new rate looks.',
            es: 'Es un cálculo simple: costos de cierre ÷ ahorro mensual = los meses para llegar al punto de equilibrio. Si conservarás la casa más allá de ese punto, refinanciar conviene. Si podrías vender o refinanciar de nuevo antes, no conviene — por muy buena que se vea la nueva tasa.',
            ru: 'Расчёт простой: расходы по оформлению ÷ ежемесячная экономия = число месяцев до окупаемости. Если вы оставите дом дольше этого срока — рефинансирование окупается. Если можете продать или снова рефинансировать раньше — нет, какой бы хорошей ни казалась новая ставка.',
          } },
          { note: {
            en: 'A lower rate on a fresh 30-year term can still raise your total interest if it restarts the clock. We look at lifetime cost, not just the monthly number.',
            es: 'Una tasa más baja en un nuevo plazo de 30 años puede aumentar tu interés total si reinicia el reloj. Miramos el costo de por vida, no solo el número mensual.',
            ru: 'Более низкая ставка на новом 30-летнем сроке всё равно может увеличить общую переплату, если счётчик обнуляется. Мы смотрим на стоимость за весь срок, а не только на месячную цифру.',
          } },
        ],
      },
      {
        h: { en: 'When NOT to refinance', es: 'Cuándo NO refinanciar', ru: 'Когда рефинансировать НЕ стоит' },
        blocks: [
          { ul: {
            en: [
              'You expect to move or sell before you reach break-even.',
              'The rate improvement is too small to cover the costs.',
              'You’d erase years of progress by restarting a 30-year clock with no offsetting benefit.',
            ],
            es: [
              'Esperas mudarte o vender antes de llegar al punto de equilibrio.',
              'La mejora de tasa es demasiado pequeña para cubrir los costos.',
              'Borrarías años de avance al reiniciar un reloj de 30 años sin un beneficio que lo compense.',
            ],
            ru: [
              'Вы планируете переезд или продажу до точки окупаемости.',
              'Улучшение ставки слишком мало, чтобы покрыть расходы.',
              'Вы сотрёте годы выплат, обнулив 30-летний срок без компенсирующей выгоды.',
            ],
          } },
          { p: {
            en: 'We’ll tell you plainly when staying put is the smarter move. A refinance that doesn’t help you isn’t a deal we want to write.',
            es: 'Te diremos con claridad cuándo lo más inteligente es quedarte como estás. Un refinanciamiento que no te ayuda no es un trato que queramos hacer.',
            ru: 'Мы прямо скажем, когда умнее ничего не менять. Рефинансирование, которое вам не помогает, — не та сделка, которую мы хотим оформлять.',
          } },
        ],
      },
    ],
    fields: [
      { name: 'Current rate', type: 'text',
        label: { en: 'Current rate', es: 'Tasa actual', ru: 'Текущая ставка' },
        placeholder: { en: '7.25%', es: '7.25%', ru: '7.25%' } },
      { name: 'Goal', type: 'select',
        label: { en: 'Goal', es: 'Objetivo', ru: 'Цель' },
        options: [
          { v: 'Lower payment', en: 'Lower payment', es: 'Bajar el pago', ru: 'Снизить платёж' },
          { v: 'Cash out', en: 'Cash out', es: 'Retirar efectivo', ru: 'Вывести наличные' },
          { v: 'Pay off faster', en: 'Pay off faster', es: 'Pagar más rápido', ru: 'Быстрее выплатить' },
          { v: 'Drop MI', en: 'Drop MI', es: 'Quitar el seguro (MI)', ru: 'Убрать страховку (MI)' },
        ] },
    ],
  },
}

// Compose the lead payload for a flow landing: qualifier answers travel in `message`.
// Answers are keyed by the language-independent field `name` and hold the canonical
// English option value, so the CRM record reads the same regardless of site language.
export function flowLeadPayload(flow, contact, answers) {
  const lines = [`OurMTG · ${flow.tag}`]
  for (const f of flow.fields) {
    const v = answers[f.name]
    if (v) lines.push(`${f.name}: ${v}`)
  }
  return {
    source: flow.source,
    tags: ['OurMTG', flow.tag],
    firstName: contact.firstName,
    lastName: contact.lastName,
    name: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
    email: contact.email,
    phone: contact.phone,
    message: lines.join('\n'),
    consent: {
      sms: !!contact.consent,
      email: !!contact.consent,
      text: SMS_CONSENT_TEXT,
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
    },
  }
}

// Build the lead-inbound payload for a realtor buyer referral (spec §K.8, workflow #21).
export function realtorLeadPayload(form, partner) {
  return {
    source: 'realtor_referral',
    tags: ['OurMTG', 'Realtor referral'],
    firstName: form.firstName,
    lastName: form.lastName,
    name: [form.firstName, form.lastName].filter(Boolean).join(' '),
    email: form.email,
    phone: form.phone,
    priceRange: form.priceRange || null,
    message: form.notes || null,
    referredBy: partner
      ? { name: partner.name || null, email: partner.email || null }
      : null,
  }
}
