/* Private Note Capital — trilingual runtime (EN / ES / RU) for a static site.
 *
 * Static copy carries data-i18n / data-i18n-ph attributes; this file swaps them on
 * language change. Dynamic, JS-built pieces (the yield model options, the guidelines
 * ledger, the file-of-the-week card) read window.PNC.lang + window.PNC.DYN templates and
 * re-render through subscribers. Language is remembered in localStorage and reflected on
 * <html lang>. Owner-editable data values (deal county/type/notes from data/deals.json)
 * stay as authored — the owner edits those in the CMS; only the surrounding UI localizes.
 */
(function () {
  var LANGS = ['en', 'es', 'ru'];
  var LABEL = { en: 'EN', es: 'ES', ru: 'RU' };
  var KEY = 'pnc_lang';

  // ── Dictionary: key → { en, es, ru }. Values may contain inline HTML. ──────────
  var DICT = {
    'doc.title': {
      en: 'Private Note Capital — Private credit, secured by real estate',
      es: 'Private Note Capital — Crédito privado, garantizado por bienes raíces',
      ru: 'Private Note Capital — частный кредит под залог недвижимости',
    },
    'doc.desc': {
      en: 'A private, access-controlled platform for investing in first-lien mortgage notes secured by California real estate. Model your target yield, understand the structure, and request access to reviewed opportunities.',
      es: 'Una plataforma privada y de acceso controlado para invertir en pagarés hipotecarios de primer gravamen garantizados por bienes raíces en California. Modela tu rendimiento objetivo, entiende la estructura y solicita acceso a oportunidades revisadas.',
      ru: 'Частная платформа с доступом по заявке для инвестиций в ипотечные ноты первого залога под недвижимость Калифорнии. Смоделируйте целевую доходность, разберитесь в структуре и запросите доступ к проверенным сделкам.',
    },

    'nav.opportunities': { en: 'Opportunities', es: 'Oportunidades', ru: 'Сделки' },
    'nav.guidelines': { en: 'Guidelines', es: 'Criterios', ru: 'Критерии' },
    'nav.security': { en: 'Security', es: 'Garantía', ru: 'Обеспечение' },
    'nav.people': { en: 'Who we are', es: 'Quiénes somos', ru: 'О нас' },

    'btn.requestAccess': { en: 'Request access', es: 'Solicitar acceso', ru: 'Запросить доступ' },
    'btn.howSecured': { en: 'How it’s secured', es: 'Cómo se garantiza', ru: 'Чем обеспечено' },
    'btn.requestLikeThis': { en: 'Request access to opportunities like this', es: 'Solicitar acceso a oportunidades como esta', ru: 'Запросить доступ к таким сделкам' },
    'btn.joinFirstLook': { en: 'Join the first-look list', es: 'Unirme a la lista de acceso prioritario', ru: 'В список приоритетного доступа' },
    'btn.orCall': { en: 'Or call (310) 686-5053', es: 'O llama al (310) 686-5053', ru: 'Или позвоните (310) 686-5053' },
    'btn.submitScenario': { en: 'Submit a scenario', es: 'Enviar un escenario', ru: 'Прислать сценарий' },
    'btn.callBeforeInvest': { en: 'Call before you invest', es: 'Llama antes de invertir', ru: 'Позвоните до инвестиции' },
    'btn.submitRequest': { en: 'Submit request', es: 'Enviar solicitud', ru: 'Отправить заявку' },

    'hero.kicker': { en: 'Private Note Capital · access by request · California', es: 'Private Note Capital · acceso por solicitud · California', ru: 'Private Note Capital · доступ по заявке · Калифорния' },
    'hero.h1': {
      en: 'private credit,<br><span class="lt">properly papered.</span>',
      es: 'crédito privado,<br><span class="lt">debidamente documentado.</span>',
      ru: 'частный кредит,<br><span class="lt">правильно оформленный.</span>',
    },
    'hero.lede': {
      en: 'Qualified investors earn fixed monthly income from first-lien mortgage notes secured by California real estate. Every note is backed by a recorded deed of trust, underwritten to conservative loan-to-value, and serviced under license.',
      es: 'Los inversionistas calificados obtienen ingresos mensuales fijos de pagarés hipotecarios de primer gravamen garantizados por bienes raíces en California. Cada pagaré está respaldado por una escritura de fideicomiso registrada, evaluado con un loan-to-value conservador y administrado bajo licencia.',
      ru: 'Квалифицированные инвесторы получают фиксированный ежемесячный доход от ипотечных нот первого залога под недвижимость Калифорнии. Каждая нота обеспечена зарегистрированной доверительной закладной (deed of trust), выдана при консервативном LTV и обслуживается по лицензии.',
    },
    'hero.fineline1': { en: 'For qualified investors. Access is granted by review, not by signup.', es: 'Para inversionistas calificados. El acceso se otorga por revisión, no por registro.', ru: 'Для квалифицированных инвесторов. Доступ — по результату проверки, а не по регистрации.' },
    'hero.lic': { en: 'Operated by West Coast Capital Mortgage Inc. · Licensed in California · NMLS #2817729 · CA DRE #01385024 · A real person answers.', es: 'Operado por West Coast Capital Mortgage Inc. · Con licencia en California · NMLS #2817729 · CA DRE #01385024 · Contesta una persona real.', ru: 'Управляется West Coast Capital Mortgage Inc. · Лицензия Калифорнии · NMLS #2817729 · CA DRE #01385024 · Отвечает живой человек.' },

    'calc.modelTag': { en: 'Model · illustrative', es: 'Modelo · ilustrativo', ru: 'Модель · пример' },
    'calc.targetYieldStatus': { en: 'Target yield', es: 'Rendimiento objetivo', ru: 'Целевая доходность' },
    'calc.amountLabel': { en: 'Amount invested', es: 'Monto invertido', ru: 'Сумма инвестиций' },
    'calc.profileLabel': { en: 'Note profile — our guidelines', es: 'Perfil del pagaré — nuestros criterios', ru: 'Профиль ноты — наши критерии' },
    'calc.targetAnnual': { en: 'Target annual yield', es: 'Rendimiento anual objetivo', ru: 'Целевая годовая доходность' },
    'calc.monthly': { en: 'Monthly income', es: 'Ingreso mensual', ru: 'Доход в месяц' },
    'calc.annual': { en: 'Annual income', es: 'Ingreso anual', ru: 'Доход в год' },
    'calc.atTerm': { en: 'At term', es: 'Al vencimiento', ru: 'К концу срока' },
    'calc.fineline': {
      en: 'Illustrative only. Target yields reflect current program guidelines, are not guaranteed, and vary by opportunity. Notes are interest-only; principal is returned at payoff. This is not an offer.',
      es: 'Solo ilustrativo. Los rendimientos objetivo reflejan los criterios actuales del programa, no están garantizados y varían según la oportunidad. Los pagarés son solo de interés; el capital se devuelve al pago final. Esto no es una oferta.',
      ru: 'Только для примера. Целевая доходность отражает текущие критерии программы, не гарантирована и зависит от сделки. Ноты — только проценты; тело возвращается при погашении. Это не оферта.',
    },

    'secured.kicker': { en: 'The structure', es: 'La estructura', ru: 'Структура' },
    'secured.h2': { en: 'What actually stands behind your capital.', es: 'Qué respalda realmente tu capital.', ru: 'Что на самом деле стоит за вашим капиталом.' },
    'secured.lede': {
      en: 'You are not lending on a promise. You are lending against a specific property, in first position, with the paper recorded in the county. Four things do the work.',
      es: 'No prestas sobre una promesa. Prestas contra una propiedad específica, en primera posición, con la documentación registrada en el condado. Cuatro cosas hacen el trabajo.',
      ru: 'Вы кредитуете не под обещание. Вы кредитуете под конкретный объект, в первой позиции, с документами, зарегистрированными в округе. Работают четыре вещи.',
    },
    'secured.01.h': { en: 'The promissory note', es: 'El pagaré', ru: 'Простой вексель (promissory note)' },
    'secured.01.p': {
      en: 'The borrower’s written, legally binding promise to repay a set amount at a set rate. This is the instrument you own, and the source of your monthly interest.',
      es: 'La promesa escrita y legalmente vinculante del prestatario de devolver un monto fijo a una tasa fija. Es el instrumento que posees y la fuente de tu interés mensual.',
      ru: 'Письменное юридически обязывающее обещание заёмщика вернуть определённую сумму под определённую ставку. Это тот инструмент, которым вы владеете, и источник вашего ежемесячного процента.',
    },
    'secured.02.h': { en: 'The deed of trust', es: 'La escritura de fideicomiso', ru: 'Доверительная закладная (deed of trust)' },
    'secured.02.p': {
      en: 'Recorded against the property in the county. It is the enforcement mechanism: if the note isn’t paid, the deed of trust is what lets the loan be satisfied out of the real estate.',
      es: 'Registrada contra la propiedad en el condado. Es el mecanismo de ejecución: si el pagaré no se paga, la escritura de fideicomiso permite recuperar el préstamo con el inmueble.',
      ru: 'Регистрируется против объекта в округе. Это механизм принуждения: если нота не оплачивается, именно deed of trust позволяет погасить заём за счёт недвижимости.',
    },
    'secured.03.h': { en: 'First-lien position', es: 'Posición de primer gravamen', ru: 'Позиция первого залога' },
    'secured.03.p': {
      en: 'You are first in line. Before any junior lender, and before the owner sees a dollar of equity, proceeds from the property go to the first lien — you. Position is priority.',
      es: 'Eres el primero en la fila. Antes de cualquier prestamista secundario y antes de que el dueño vea un dólar de plusvalía, lo recaudado por la propiedad va al primer gravamen — a ti. La posición es prioridad.',
      ru: 'Вы первый в очереди. Раньше любого младшего кредитора и раньше, чем владелец увидит хоть доллар капитала, поступления от объекта идут держателю первого залога — вам. Позиция — это приоритет.',
    },
    'secured.04.h': { en: 'Loan-to-value — your margin of safety', es: 'Loan-to-value — tu margen de seguridad', ru: 'Loan-to-value — ваш запас прочности' },
    'secured.04.p': {
      en: 'A note at 65% LTV means the loan is 65% of the property’s value. The property would have to lose more than <strong>35%</strong> of its value before your principal is mathematically at risk. Lower LTV, thicker cushion.',
      es: 'Un pagaré al 65% de LTV significa que el préstamo es el 65% del valor de la propiedad. La propiedad tendría que perder más del <strong>35%</strong> de su valor antes de que tu capital esté matemáticamente en riesgo. Menor LTV, mayor colchón.',
      ru: 'Нота при LTV 65% означает, что заём составляет 65% стоимости объекта. Объект должен потерять более <strong>35%</strong> стоимости, прежде чем ваше тело окажется под математическим риском. Ниже LTV — толще подушка.',
    },

    'gl.kicker': { en: 'Our guidelines', es: 'Nuestros criterios', ru: 'Наши критерии' },
    'gl.h2': { en: 'The lines we lend inside.', es: 'Los límites dentro de los que prestamos.', ru: 'Рамки, внутри которых мы кредитуем.' },
    'gl.lede': {
      en: 'Every opportunity we prepare fits one of these profiles. The discipline is in the box — first lien, conservative LTV, short term, monthly interest. We don’t chase yield by loosening the collateral.',
      es: 'Cada oportunidad que preparamos encaja en uno de estos perfiles. La disciplina está en la caja — primer gravamen, LTV conservador, plazo corto, interés mensual. No perseguimos rendimiento aflojando la garantía.',
      ru: 'Каждая сделка, которую мы готовим, вписывается в один из этих профилей. Дисциплина — в рамках: первый залог, консервативный LTV, короткий срок, ежемесячный процент. Мы не гонимся за доходностью, ослабляя обеспечение.',
    },
    'gl.h.profile': { en: 'Profile', es: 'Perfil', ru: 'Профиль' },
    'gl.h.lien': { en: 'Lien', es: 'Gravamen', ru: 'Залог' },
    'gl.h.maxltv': { en: 'Max LTV', es: 'LTV máx.', ru: 'Макс. LTV' },
    'gl.h.yield': { en: 'Target yield', es: 'Rend. objetivo', ru: 'Целевая дох.' },
    'gl.h.term': { en: 'Term', es: 'Plazo', ru: 'Срок' },
    'gl.h.min': { en: 'Minimum', es: 'Mínimo', ru: 'Минимум' },
    'gl.fineline': {
      en: 'Guidelines describe the box we work within; specific terms are set per opportunity and disclosed in full inside the deal room. Target yields are not guaranteed. All investments involve risk, including loss of principal.',
      es: 'Los criterios describen la caja en la que trabajamos; los términos específicos se fijan por oportunidad y se revelan por completo dentro del deal room. Los rendimientos objetivo no están garantizados. Toda inversión implica riesgo, incluida la pérdida de capital.',
      ru: 'Критерии описывают рамки нашей работы; конкретные условия задаются по каждой сделке и полностью раскрываются в deal room. Целевая доходность не гарантирована. Любые инвестиции связаны с риском, включая потерю тела.',
    },

    'opps.kicker': { en: 'This week · access by request', es: 'Esta semana · acceso por solicitud', ru: 'На этой неделе · доступ по заявке' },
    'opps.h2': { en: 'What we’re funding now.', es: 'Lo que estamos financiando ahora.', ru: 'Что мы финансируем сейчас.' },
    'opps.lede': {
      en: 'Real files move fast — they’re shown to a small number of investors and often fill within days of release. You don’t chase a single deal here; you get <strong>first look at the flow</strong>. Below is the kind of file open this week. The live file, with address and numbers, opens in the deal room once you’re approved.',
      es: 'Los expedientes reales se mueven rápido — se muestran a un número reducido de inversionistas y suelen llenarse a los pocos días de publicarse. Aquí no persigues una sola operación; obtienes <strong>acceso prioritario al flujo</strong>. Abajo está el tipo de expediente abierto esta semana. El expediente real, con dirección y números, se abre en el deal room una vez aprobado.',
      ru: 'Реальные файлы уходят быстро — их показывают небольшому числу инвесторов, и они часто закрываются за считанные дни. Здесь вы не гоняетесь за одной сделкой; вы получаете <strong>приоритетный доступ к потоку</strong>. Ниже — пример файла, открытого на этой неделе. Реальный файл, с адресом и цифрами, открывается в deal room после одобрения.',
    },
    'opps.dwLienIO': { en: '1st lien · interest-only', es: '1er gravamen · solo interés', ru: '1-й залог · только проценты' },
    'opps.stampOpen': { en: 'Open', es: 'Abierto', ru: 'Открыт' },
    'opps.dwStatus': { en: 'Accepting review', es: 'Aceptando revisión', ru: 'Принимает заявки' },
    'dw.type': { en: 'Type', es: 'Tipo', ru: 'Тип' },
    'dw.location': { en: 'Location', es: 'Ubicación', ru: 'Локация' },
    'dw.amount': { en: 'Loan amount', es: 'Monto del préstamo', ru: 'Сумма займа' },
    'dw.ltv': { en: 'LTV', es: 'LTV', ru: 'LTV' },
    'dw.yield': { en: 'Target yield', es: 'Rendimiento objetivo', ru: 'Целевая доходность' },
    'dw.term': { en: 'Term', es: 'Plazo', ru: 'Срок' },
    'dw.notes': { en: 'Notes', es: 'Notas', ru: 'Заметки' },
    'dw.docsLabel': { en: 'Full file in the deal room', es: 'Expediente completo en el deal room', ru: 'Полный файл — в deal room' },
    'doc.note': { en: 'Promissory note', es: 'Pagaré', ru: 'Вексель' },
    'doc.deed': { en: 'Deed of trust', es: 'Escritura de fideicomiso', ru: 'Закладная' },
    'doc.title': { en: 'Title & appraisal', es: 'Título y avalúo', ru: 'Титул и оценка' },
    'doc.servicing': { en: 'Servicing terms', es: 'Términos de administración', ru: 'Условия обслуживания' },
    'firstlook.title': { en: 'Get first look at the flow', es: 'Obtén acceso prioritario al flujo', ru: 'Приоритетный доступ к потоку' },
    'firstlook.p': {
      en: 'Approved investors see each week’s file <strong>before</strong> it’s shown widely. When one fills, the next is already coming — first-look means you’re never watching from outside.',
      es: 'Los inversionistas aprobados ven el expediente de cada semana <strong>antes</strong> de que se muestre ampliamente. Cuando uno se llena, el siguiente ya viene — el acceso prioritario significa que nunca miras desde afuera.',
      ru: 'Одобренные инвесторы видят файл недели <strong>раньше</strong>, чем его покажут широко. Когда один закрывается, следующий уже на подходе — приоритетный доступ значит, что вы никогда не наблюдаете со стороны.',
    },
    'pipeline.label': { en: 'Pipeline this week', es: 'Flujo esta semana', ru: 'Поток на этой неделе' },
    'pipeline.files': { en: 'files in review', es: 'expedientes en revisión', ru: 'файлов на проверке' },
    'pipeline.seeking': { en: 'seeking', es: 'buscando', ru: 'ищут финансирование' },
    'pipeline.ltv': { en: 'avg LTV · 1st lien', es: 'LTV prom. · 1er gravamen', ru: 'средн. LTV · 1-й залог' },
    'opps.fineline': {
      en: 'Representative of current pipeline; not a specific offer. Trust-deed investments are arranged through West Coast Capital Mortgage Inc. (CA DRE #01385024); approved investors receive full written disclosures before funding any note. Offered privately to qualified investors only.',
      es: 'Representativo del flujo actual; no es una oferta específica. Las inversiones en escrituras de fideicomiso se gestionan a través de West Coast Capital Mortgage Inc. (CA DRE #01385024); los inversionistas aprobados reciben divulgaciones escritas completas antes de financiar cualquier pagaré. Ofrecido de forma privada solo a inversionistas calificados.',
      ru: 'Отражает текущий поток; не является конкретной офертой. Инвестиции в трастовые закладные оформляются через West Coast Capital Mortgage Inc. (CA DRE #01385024); одобренные инвесторы получают полное письменное раскрытие до финансирования любой ноты. Предлагается частно только квалифицированным инвесторам.',
    },
    'otherside': {
      en: '<strong>On the other side — need capital for a project?</strong> We fund fix &amp; flip, bridge, cash-out, and ground-up construction against California real estate. Bring us the scenario; strong files become next week’s opportunity.',
      es: '<strong>Del otro lado — ¿necesitas capital para un proyecto?</strong> Financiamos fix &amp; flip, préstamos puente, cash-out y construcción desde cero contra bienes raíces en California. Tráenos el escenario; los expedientes sólidos se convierten en la oportunidad de la próxima semana.',
      ru: '<strong>С другой стороны — нужен капитал под проект?</strong> Мы финансируем fix &amp; flip, бридж, cash-out и строительство с нуля под недвижимость Калифорнии. Принесите сценарий; сильные файлы становятся сделкой следующей недели.',
    },

    'not.line': {
      en: '<strong>This is not a marketplace.</strong> Not crowdfunding, not a pooled fund, not a yield promise. One note, one property, one file at a time — shown to a small number of qualified investors, and only after it clears review.',
      es: '<strong>Esto no es un marketplace.</strong> No es crowdfunding, no es un fondo mancomunado, no es una promesa de rendimiento. Un pagaré, una propiedad, un expediente a la vez — mostrado a un número reducido de inversionistas calificados, y solo después de pasar la revisión.',
      ru: '<strong>Это не маркетплейс.</strong> Не краудфандинг, не пул-фонд, не обещание доходности. Одна нота, один объект, один файл за раз — показывается небольшому числу квалифицированных инвесторов и только после прохождения проверки.',
    },

    'process.kicker': { en: 'Process', es: 'Proceso', ru: 'Процесс' },
    'process.h2': { en: 'How capital works here.', es: 'Cómo funciona el capital aquí.', ru: 'Как здесь работает капитал.' },
    'process.lede': {
      en: 'Five stages, in order. No stage is skipped, and no file moves forward without the previous stage on paper.',
      es: 'Cinco etapas, en orden. No se salta ninguna etapa, y ningún expediente avanza sin la etapa anterior por escrito.',
      ru: 'Пять этапов, по порядку. Ни один этап не пропускается, и ни один файл не движется дальше без предыдущего этапа на бумаге.',
    },
    'step.01.h': { en: 'Scenario is reviewed', es: 'Se revisa el escenario', ru: 'Сценарий проверяется' },
    'step.01.p': {
      en: 'The borrower, the purpose of the loan, and the exit — how they pay you back — are vetted before anything else is discussed. A loan without a credible exit doesn’t get written.',
      es: 'El prestatario, el propósito del préstamo y la salida — cómo te devuelven el dinero — se examinan antes de discutir cualquier otra cosa. Un préstamo sin una salida creíble no se otorga.',
      ru: 'Заёмщик, цель займа и «выход» — как вам вернут деньги — проверяются раньше всего остального. Заём без правдоподобного выхода не оформляется.',
    },
    'step.02.h': { en: 'Collateral is analyzed', es: 'Se analiza la garantía', ru: 'Анализируется обеспечение' },
    'step.02.p': {
      en: 'Independent valuation, lien position, title condition, and market context. The property, not the borrower’s optimism, has to carry the note — and carry it with room to spare.',
      es: 'Avalúo independiente, posición del gravamen, estado del título y contexto de mercado. La propiedad, no el optimismo del prestatario, debe sostener el pagaré — y sostenerlo con holgura.',
      ru: 'Независимая оценка, позиция залога, состояние титула и рыночный контекст. Ноту должен нести объект, а не оптимизм заёмщика — и нести с запасом.',
    },
    'step.03.h': { en: 'Note package is prepared', es: 'Se prepara el paquete del pagaré', ru: 'Готовится пакет ноты' },
    'step.03.p': {
      en: 'Promissory note, deed of trust, title policy, insurance, and servicing agreement are drafted and assembled into one complete file — the same file you’ll read before you commit.',
      es: 'El pagaré, la escritura de fideicomiso, la póliza de título, el seguro y el acuerdo de administración se redactan y se reúnen en un expediente completo — el mismo que leerás antes de comprometerte.',
      ru: 'Вексель, закладная, полис титула, страховка и договор обслуживания составляются и собираются в один полный файл — тот самый, который вы прочтёте до принятия решения.',
    },
    'step.04.h': { en: 'Investor reviews the opportunity', es: 'El inversionista revisa la oportunidad', ru: 'Инвестор изучает сделку' },
    'step.04.p': {
      en: 'The full file opens in the deal room. You read the documents, see the numbers, ask questions, and decide on your own timeline. Nothing auto-invests; nothing is rushed.',
      es: 'El expediente completo se abre en el deal room. Lees los documentos, ves los números, haces preguntas y decides a tu propio ritmo. Nada se invierte automáticamente; nada se apresura.',
      ru: 'Полный файл открывается в deal room. Вы читаете документы, видите цифры, задаёте вопросы и решаете в своём темпе. Ничего не инвестируется автоматически; никто не торопит.',
    },
    'step.05.h': { en: 'Servicing tracks every payment', es: 'La administración rastrea cada pago', ru: 'Обслуживание отслеживает каждый платёж' },
    'step.05.p': {
      en: 'After funding, licensed servicing handles collections, statements, escrow of taxes and insurance, and reporting. You receive income and records — you don’t chase a borrower.',
      es: 'Tras el financiamiento, la administración con licencia maneja cobros, estados de cuenta, escrow de impuestos y seguros, e informes. Recibes ingresos y registros — no persigues a un prestatario.',
      ru: 'После финансирования лицензированное обслуживание ведёт сбор платежей, выписки, эскроу налогов и страховки и отчётность. Вы получаете доход и документы — а не гоняетесь за заёмщиком.',
    },

    'risk.kicker': { en: 'The honest part', es: 'La parte honesta', ru: 'Честная часть' },
    'risk.h2': { en: 'If a borrower doesn’t pay.', es: 'Si un prestatario no paga.', ru: 'Если заёмщик не платит.' },
    'risk.lede': {
      en: 'Trust is built by explaining the downside plainly, before you ask about the upside. Here is exactly what stands between a missed payment and your principal.',
      es: 'La confianza se construye explicando el riesgo con claridad, antes de preguntar por la ganancia. Esto es exactamente lo que hay entre un pago perdido y tu capital.',
      ru: 'Доверие строится на честном объяснении рисков — до разговора о выгоде. Вот что именно стоит между пропущенным платежом и вашим телом.',
    },
    'risk.1': {
      en: '<strong>Servicing works the borrower first.</strong> Contact, cure, and default interest and late fees begin accruing — to you.',
      es: '<strong>La administración trabaja primero con el prestatario.</strong> Contacto, regularización, e intereses por mora y recargos comienzan a acumularse — a tu favor.',
      ru: '<strong>Сначала обслуживание работает с заёмщиком.</strong> Контакт, устранение просрочки, а штрафные проценты и пени начинают начисляться — в вашу пользу.',
    },
    'risk.2': {
      en: '<strong>The deed of trust is enforced.</strong> If it isn’t cured, first-lien position lets the collateral be sold to recover principal and accrued interest.',
      es: '<strong>Se ejecuta la escritura de fideicomiso.</strong> Si no se regulariza, la posición de primer gravamen permite vender la garantía para recuperar el capital y el interés acumulado.',
      ru: '<strong>Приводится в действие закладная.</strong> Если просрочка не устранена, позиция первого залога позволяет продать обеспечение и вернуть тело и накопленные проценты.',
    },
    'risk.3': {
      en: '<strong>Conservative LTV is the cushion.</strong> Lending at 60–70% of value means there is equity between your loan and the property’s worth to absorb costs and time.',
      es: '<strong>El LTV conservador es el colchón.</strong> Prestar al 60–70% del valor significa que hay plusvalía entre tu préstamo y el valor de la propiedad para absorber costos y tiempo.',
      ru: '<strong>Консервативный LTV — это подушка.</strong> Кредитование под 60–70% стоимости означает, что между вашим займом и ценой объекта есть капитал, поглощающий издержки и время.',
    },
    'risk.4': {
      en: '<strong>The risk is still real.</strong> Real estate can decline, recovery takes time, and loss of principal is possible. Collateral reduces risk; it does not remove it.',
      es: '<strong>El riesgo sigue siendo real.</strong> Los bienes raíces pueden bajar, la recuperación toma tiempo y es posible perder capital. La garantía reduce el riesgo; no lo elimina.',
      ru: '<strong>Риск всё равно реален.</strong> Недвижимость может дешеветь, взыскание занимает время, и потеря тела возможна. Обеспечение снижает риск, но не устраняет его.',
    },

    'terms.kicker': { en: 'Plain English', es: 'En palabras simples', ru: 'Простым языком' },
    'terms.h2': { en: 'The terms, decoded.', es: 'Los términos, explicados.', ru: 'Термины, разобранные.' },
    'terms.lede': {
      en: 'The vocabulary of note investing, without the mystique. If a document uses a word we haven’t explained, that’s on us.',
      es: 'El vocabulario de la inversión en pagarés, sin el misterio. Si un documento usa una palabra que no explicamos, es culpa nuestra.',
      ru: 'Словарь инвестиций в ноты — без мистики. Если в документе есть слово, которое мы не объяснили, это наша недоработка.',
    },
    'gl1.t': { en: 'Loan-to-value (LTV)', es: 'Loan-to-value (LTV)', ru: 'Loan-to-value (LTV)' },
    'gl1.d': { en: 'The loan as a percentage of the property’s value. Lower is safer — it’s the cushion before principal is at risk.', es: 'El préstamo como porcentaje del valor de la propiedad. Menor es más seguro — es el colchón antes de que el capital esté en riesgo.', ru: 'Заём как процент от стоимости объекта. Чем ниже, тем безопаснее — это подушка до того, как тело окажется под риском.' },
    'gl2.t': { en: 'Lien position', es: 'Posición del gravamen', ru: 'Позиция залога' },
    'gl2.d': { en: 'Your place in line for repayment from the property. First lien is paid before all juniors and before owner equity.', es: 'Tu lugar en la fila para el pago desde la propiedad. El primer gravamen se paga antes que todos los secundarios y antes que la plusvalía del dueño.', ru: 'Ваше место в очереди на выплату из объекта. Первый залог гасится раньше всех младших и раньше капитала владельца.' },
    'gl3.t': { en: 'Promissory note', es: 'Pagaré', ru: 'Вексель (promissory note)' },
    'gl3.d': { en: 'The borrower’s binding promise to repay at a stated rate and term. The asset you actually own.', es: 'La promesa vinculante del prestatario de pagar a una tasa y plazo establecidos. El activo que realmente posees.', ru: 'Обязывающее обещание заёмщика платить по заявленной ставке и сроку. Актив, которым вы реально владеете.' },
    'gl4.t': { en: 'Deed of trust', es: 'Escritura de fideicomiso', ru: 'Закладная (deed of trust)' },
    'gl4.d': { en: 'The recorded document that ties the note to the property and allows enforcement if the note isn’t paid.', es: 'El documento registrado que vincula el pagaré con la propiedad y permite la ejecución si el pagaré no se paga.', ru: 'Зарегистрированный документ, связывающий ноту с объектом и позволяющий взыскание, если нота не оплачивается.' },
    'gl5.t': { en: 'Servicing', es: 'Administración (servicing)', ru: 'Обслуживание (servicing)' },
    'gl5.d': { en: 'Licensed collection of payments, escrows, statements, and reporting — so you receive income, not a second job.', es: 'Cobro con licencia de pagos, escrows, estados de cuenta e informes — para que recibas ingresos, no un segundo empleo.', ru: 'Лицензированный сбор платежей, эскроу, выписки и отчётность — чтобы вы получали доход, а не вторую работу.' },
    'gl6.t': { en: 'Exit / takeout', es: 'Salida / takeout', ru: 'Выход / takeout' },
    'gl6.d': { en: 'How the borrower repays you: a sale, a refinance, or completed business plan. A credible exit is required.', es: 'Cómo te devuelve el prestatario: una venta, un refinanciamiento o un plan de negocio completado. Se requiere una salida creíble.', ru: 'Как заёмщик возвращает вам деньги: продажа, рефинансирование или завершённый бизнес-план. Правдоподобный выход обязателен.' },
    'gl7.t': { en: 'Interest-only', es: 'Solo interés', ru: 'Только проценты' },
    'gl7.d': { en: 'The borrower pays interest monthly; the full principal is returned at payoff. It’s what keeps your income level.', es: 'El prestatario paga interés mensual; el capital completo se devuelve al pago final. Es lo que mantiene nivelado tu ingreso.', ru: 'Заёмщик платит проценты ежемесячно; всё тело возвращается при погашении. Именно это держит ваш доход ровным.' },
    'gl8.t': { en: 'Title policy', es: 'Póliza de título', ru: 'Полис титула' },
    'gl8.d': { en: 'Insurance confirming the lien is valid and in the position promised, with no undisclosed claims ahead of you.', es: 'Seguro que confirma que el gravamen es válido y está en la posición prometida, sin reclamos ocultos por delante de ti.', ru: 'Страховка, подтверждающая, что залог действителен и находится в обещанной позиции, без скрытых претензий впереди вас.' },
    'gl9.t': { en: 'Reserve', es: 'Reserva', ru: 'Резерв' },
    'gl9.d': { en: 'Cash set aside — by the borrower or the structure — to cover payments or taxes if timing slips.', es: 'Efectivo apartado — por el prestatario o la estructura — para cubrir pagos o impuestos si los tiempos se retrasan.', ru: 'Отложенные средства — заёмщиком или структурой — на покрытие платежей или налогов, если сроки сдвинутся.' },
    'gl10.t': { en: 'Seasoning', es: 'Seasoning (historial)', ru: 'Seasoning (история платежей)' },
    'gl10.d': { en: 'The track record of on-time payments a note has already made. More seasoning, more evidence.', es: 'El historial de pagos puntuales que un pagaré ya ha realizado. Más seasoning, más evidencia.', ru: 'История своевременных платежей, которые нота уже совершила. Больше seasoning — больше доказательств.' },

    'working.kicker': { en: 'The relationship', es: 'La relación', ru: 'Отношения' },
    'working.h2': { en: 'What working with us means.', es: 'Qué significa trabajar con nosotros.', ru: 'Что значит работать с нами.' },
    'work.1.h': { en: 'We originate under license', es: 'Originamos bajo licencia', ru: 'Мы выдаём под лицензией' },
    'work.1.p': { en: 'Files are underwritten and prepared under licensed mortgage origination and servicing oversight — not resold from a borrower’s self-report.', es: 'Los expedientes se evalúan y preparan bajo supervisión con licencia de originación y administración hipotecaria — no se revenden a partir del auto-reporte del prestatario.', ru: 'Файлы андеррайтятся и готовятся под лицензированным надзором за выдачей и обслуживанием ипотеки — а не перепродаются со слов заёмщика.' },
    'work.2.h': { en: 'We service, so you don’t', es: 'Administramos, para que tú no lo hagas', ru: 'Мы обслуживаем — чтобы вам не пришлось' },
    'work.2.p': { en: 'Collections, escrows, statements, and reporting are handled for you. Your job is to read the file and decide; ours is everything after.', es: 'Los cobros, escrows, estados de cuenta e informes se manejan por ti. Tu trabajo es leer el expediente y decidir; el nuestro es todo lo demás.', ru: 'Сбор платежей, эскроу, выписки и отчётность ведём мы. Ваша задача — прочитать файл и решить; наша — всё остальное.' },
    'work.3.h': { en: 'We disclose in full', es: 'Divulgamos por completo', ru: 'Мы раскрываем всё' },
    'work.3.p': { en: 'Collateral, LTV, lien, title, and the complete document package are open before you commit. No summary stands in for the paper.', es: 'La garantía, el LTV, el gravamen, el título y el paquete completo de documentos están abiertos antes de que te comprometas. Ningún resumen sustituye a los papeles.', ru: 'Обеспечение, LTV, залог, титул и полный пакет документов открыты до вашего решения. Никакое резюме не заменяет сами документы.' },
    'work.4.h': { en: 'We keep the room small', es: 'Mantenemos el grupo pequeño', ru: 'Мы держим круг узким' },
    'work.4.p': { en: 'Limited opportunities, reviewed access, one file at a time. Discipline is easier to keep when the room isn’t crowded.', es: 'Oportunidades limitadas, acceso revisado, un expediente a la vez. La disciplina es más fácil de mantener cuando el grupo no está saturado.', ru: 'Ограниченные сделки, доступ по проверке, по одному файлу за раз. Дисциплину легче держать, когда круг не переполнен.' },

    'people.kicker': { en: 'Who’s behind the paper', es: 'Quién está detrás del papel', ru: 'Кто стоит за бумагами' },
    'people.h2': { en: 'Real company. Real licenses.<br>A real phone number.', es: 'Empresa real. Licencias reales.<br>Un teléfono real.', ru: 'Реальная компания. Реальные лицензии.<br>Реальный телефон.' },
    'people.lede': {
      en: 'Private Note Capital is operated by <strong>West Coast Capital Mortgage Inc.</strong> — a licensed California mortgage company that originates and services these loans itself. You can look up the license, read the whole file, and talk to a person before you commit a single dollar. Comfort, for us, means nothing about us is hard to check.',
      es: 'Private Note Capital es operado por <strong>West Coast Capital Mortgage Inc.</strong> — una empresa hipotecaria con licencia en California que origina y administra estos préstamos ella misma. Puedes verificar la licencia, leer todo el expediente y hablar con una persona antes de comprometer un solo dólar. Para nosotros, comodidad significa que nada sobre nosotros sea difícil de verificar.',
      ru: 'Private Note Capital управляется <strong>West Coast Capital Mortgage Inc.</strong> — лицензированной ипотечной компанией Калифорнии, которая сама выдаёт и обслуживает эти займы. Вы можете проверить лицензию, прочитать весь файл и поговорить с человеком, прежде чем вложить хоть доллар. Комфорт для нас — это когда о нас всё легко проверить.',
    },
    'people.li1': { en: 'Licensed origination and servicing — regulated, not a marketplace middleman', es: 'Originación y administración con licencia — regulada, no un intermediario de marketplace', ru: 'Лицензированные выдача и обслуживание — под регулированием, а не посредник маркетплейса' },
    'people.li2': { en: 'Every access request is read and answered by a person, usually same day', es: 'Cada solicitud de acceso la lee y responde una persona, normalmente el mismo día', ru: 'Каждую заявку читает и отвечает человек, обычно в тот же день' },
    'people.li3': { en: 'Call, ask the hard questions, take your time — no funnel, no pressure', es: 'Llama, haz las preguntas difíciles, tómate tu tiempo — sin embudo, sin presión', ru: 'Звоните, задавайте сложные вопросы, не спешите — без воронки и давления' },
    'people.lede2': {
      en: 'The same team runs <a href="https://westccmortgage.com" target="_blank" rel="noopener">westccmortgage.com</a> and <a href="https://californiamtg.com" target="_blank" rel="noopener">californiamtg.com</a> — an established, licensed operation you can see for yourself.',
      es: 'El mismo equipo dirige <a href="https://westccmortgage.com" target="_blank" rel="noopener">westccmortgage.com</a> y <a href="https://californiamtg.com" target="_blank" rel="noopener">californiamtg.com</a> — una operación establecida y con licencia que puedes ver por ti mismo.',
      ru: 'Та же команда ведёт <a href="https://westccmortgage.com" target="_blank" rel="noopener">westccmortgage.com</a> и <a href="https://californiamtg.com" target="_blank" rel="noopener">californiamtg.com</a> — устоявшийся лицензированный бизнес, который вы можете проверить сами.',
    },
    'cred.title': { en: 'West Coast Capital Mortgage Inc.', es: 'West Coast Capital Mortgage Inc.', ru: 'West Coast Capital Mortgage Inc.' },
    'cred.nmls': { en: 'NMLS', es: 'NMLS', ru: 'NMLS' },
    'cred.dre': { en: 'CA DRE', es: 'CA DRE', ru: 'CA DRE' },
    'cred.founder': { en: 'Founder', es: 'Fundador', ru: 'Основатель' },
    'cred.experience': { en: 'Experience', es: 'Experiencia', ru: 'Опыт' },
    'cred.experienceVal': { en: 'Decades in CA real estate & mortgage', es: 'Décadas en bienes raíces e hipotecas en CA', ru: 'Десятилетия в недвижимости и ипотеке Калифорнии' },
    'cred.direct': { en: 'Direct', es: 'Directo', ru: 'Прямой' },
    'cred.note': { en: 'Equal Housing Opportunity. A licensed professional reviews every request personally.', es: 'Igualdad de oportunidades de vivienda. Un profesional con licencia revisa cada solicitud personalmente.', ru: 'Равные возможности в жилье. Каждую заявку лично рассматривает лицензированный специалист.' },

    'access.kicker': { en: 'Access', es: 'Acceso', ru: 'Доступ' },
    'access.h2': { en: 'Request access to the deal room.', es: 'Solicita acceso al deal room.', ru: 'Запросите доступ к deal room.' },
    'access.lede': {
      en: 'Tell us who you are and how you invest. Requests are reviewed personally — expect a reply, not an automated onboarding funnel.',
      es: 'Cuéntanos quién eres y cómo inviertes. Las solicitudes se revisan personalmente — espera una respuesta, no un embudo de registro automatizado.',
      ru: 'Расскажите, кто вы и как инвестируете. Заявки рассматриваются лично — ждите ответа, а не автоматической воронки.',
    },
    'form.name': { en: 'Full name', es: 'Nombre completo', ru: 'Полное имя' },
    'form.email': { en: 'Email', es: 'Correo electrónico', ru: 'Эл. почта' },
    'form.investingAs': { en: 'Investing as', es: 'Invierto como', ru: 'Инвестирую как' },
    'form.typicalAmount': { en: 'Typical amount', es: 'Monto típico', ru: 'Обычная сумма' },
    'form.anything': { en: 'Anything we should know <span class="dim">(optional)</span>', es: 'Algo que debamos saber <span class="dim">(opcional)</span>', ru: 'Что нам стоит знать <span class="dim">(необязательно)</span>' },
    'opt.individual': { en: 'Individual', es: 'Individual', ru: 'Физлицо' },
    'opt.entity': { en: 'Entity / LLC', es: 'Entidad / LLC', ru: 'Компания / LLC' },
    'opt.ira': { en: 'Self-directed IRA', es: 'IRA autodirigida', ru: 'Самоуправляемый IRA' },
    'opt.family': { en: 'Family office', es: 'Family office', ru: 'Семейный офис' },
    'opt.exploring': { en: 'Exploring', es: 'Explorando', ru: 'Присматриваюсь' },
    'form.notePlaceholder': { en: 'Experience with notes or trust deeds, questions, timing…', es: 'Experiencia con pagarés o escrituras de fideicomiso, preguntas, plazos…', ru: 'Опыт с нотами или трастовыми закладными, вопросы, сроки…' },
    'form.firstlook': {
      en: 'Put me on the first-look list — I want to see each week’s file before it’s shown widely.',
      es: 'Ponme en la lista de acceso prioritario — quiero ver el expediente de cada semana antes de que se muestre ampliamente.',
      ru: 'Добавьте меня в список приоритетного доступа — хочу видеть файл недели раньше, чем его покажут широко.',
    },
    'access.fineline': {
      en: 'Submitting a request does not create an account and does not obligate you to invest.',
      es: 'Enviar una solicitud no crea una cuenta y no te obliga a invertir.',
      ru: 'Отправка заявки не создаёт аккаунт и не обязывает вас инвестировать.',
    },

    'foot.disclosure': {
      en: 'Private Note Capital is operated by West Coast Capital Mortgage Inc., a licensed California mortgage company (NMLS #2817729, CA DRE #01385024). Equal Housing Opportunity. It provides access to information about investments in promissory notes secured by real estate. Nothing on this site is an offer to sell, or a solicitation of an offer to buy, any security, and nothing here is investment, legal, or tax advice. Figures, target yields, and examples are illustrative, are not guaranteed, and do not represent the performance of any specific investment. Opportunities, where available, are offered privately to qualified investors only. All investments involve risk, including the possible loss of principal. Real estate collateral can decline in value, borrowers may default, recovery can take time, and past performance does not guarantee future results.',
      es: 'Private Note Capital es operado por West Coast Capital Mortgage Inc., una empresa hipotecaria con licencia en California (NMLS #2817729, CA DRE #01385024). Igualdad de oportunidades de vivienda. Proporciona acceso a información sobre inversiones en pagarés garantizados por bienes raíces. Nada en este sitio es una oferta de venta, ni una solicitud de oferta de compra, de ningún valor, y nada aquí es asesoría de inversión, legal o fiscal. Las cifras, rendimientos objetivo y ejemplos son ilustrativos, no están garantizados y no representan el desempeño de ninguna inversión específica. Las oportunidades, cuando estén disponibles, se ofrecen de forma privada solo a inversionistas calificados. Toda inversión implica riesgo, incluida la posible pérdida de capital. La garantía inmobiliaria puede perder valor, los prestatarios pueden incumplir, la recuperación puede tomar tiempo, y el desempeño pasado no garantiza resultados futuros.',
      ru: 'Private Note Capital управляется West Coast Capital Mortgage Inc. — лицензированной ипотечной компанией Калифорнии (NMLS #2817729, CA DRE #01385024). Равные возможности в жилье. Компания предоставляет доступ к информации об инвестициях в векселя, обеспеченные недвижимостью. Ничто на этом сайте не является офертой на продажу или предложением купить какую-либо ценную бумагу, и ничто здесь не является инвестиционной, юридической или налоговой консультацией. Цифры, целевая доходность и примеры носят иллюстративный характер, не гарантированы и не отражают результаты какой-либо конкретной инвестиции. Сделки, если они доступны, предлагаются частно только квалифицированным инвесторам. Любые инвестиции связаны с риском, включая возможную потерю тела. Залоговая недвижимость может дешеветь, заёмщики могут допускать дефолт, взыскание может занять время, а прошлые результаты не гарантируют будущих.',
    },
    'foot.line2': {
      en: 'A West Coast Capital Mortgage company · Buying or refinancing a home? <a href="https://ourmtg.com" target="_blank" rel="noopener">OurMTG →</a>',
      es: 'Una empresa de West Coast Capital Mortgage · ¿Comprando o refinanciando una casa? <a href="https://ourmtg.com" target="_blank" rel="noopener">OurMTG →</a>',
      ru: 'Компания группы West Coast Capital Mortgage · Покупаете или рефинансируете жильё? <a href="https://ourmtg.com" target="_blank" rel="noopener">OurMTG →</a>',
    },

    'ticker.text': {
      en: '&nbsp;<b>09:12</b> may payment received — note 011 current · <b>08:47</b> title policy verified — file 014 · <b>08:15</b> appraisal reviewed — riverside county · <b>07:52</b> servicing report issued — q2 · <b>07:30</b> deed of trust recorded — file 012 ·',
      es: '&nbsp;<b>09:12</b> pago de mayo recibido — nota 011 al corriente · <b>08:47</b> póliza de título verificada — expediente 014 · <b>08:15</b> avalúo revisado — condado de riverside · <b>07:52</b> informe de administración emitido — t2 · <b>07:30</b> escritura de fideicomiso registrada — expediente 012 ·',
      ru: '&nbsp;<b>09:12</b> майский платёж получен — нота 011 в норме · <b>08:47</b> полис титула проверен — файл 014 · <b>08:15</b> оценка проверена — округ риверсайд · <b>07:52</b> отчёт по обслуживанию выпущен — 2 кв. · <b>07:30</b> закладная зарегистрирована — файл 012 ·',
    },

    'lang.label': { en: 'Language', es: 'Idioma', ru: 'Язык' },
  };

  // ── Dynamic templates for JS-built pieces (yield model, ledger, deal week). ────
  var PROFILE = {
    conservative: { en: 'Conservative', es: 'Conservador', ru: 'Консервативный' },
    core: { en: 'Core', es: 'Núcleo', ru: 'Основной' },
    balanced: { en: 'Balanced', es: 'Balanceado', ru: 'Сбалансированный' },
  };
  var FIRST_SHORT = { en: '1st lien', es: '1er gravamen', ru: '1-й залог' };
  var FIRST_LONG = { en: 'First lien', es: 'Primer gravamen', ru: 'Первый залог' };
  var LIEN_FIRST = { en: 'First', es: 'Primero', ru: 'Первый' };

  var DYN = {
    profileLabel: function (lang, g) {
      var p = PROFILE[g.key];
      return p ? (p[lang] || p.en) : g.label;
    },
    firstShort: function (lang) { return FIRST_SHORT[lang] || FIRST_SHORT.en; },
    lienValue: function (lang, lien) {
      // deals/guidelines store 'First'; localize that token, pass others through.
      if (String(lien).toLowerCase() === 'first') return LIEN_FIRST[lang] || LIEN_FIRST.en;
      return lien;
    },
    termLabel: function (lang, label) {
      if (lang === 'es') return String(label).replace(/\bmo\b/g, 'meses');
      if (lang === 'ru') return String(label).replace(/\bmo\b/g, 'мес.');
      return label;
    },
    // Yield-model terms line.
    terms: function (lang, p, money) {
      var ltv = p.ltv, term = p.term, min = money(p.min);
      if (lang === 'es') return FIRST_LONG.es + ' · ≤' + ltv + '% LTV · solo interés · pago mensual · plazo de ' + term + ' meses · mín. ' + min;
      if (lang === 'ru') return FIRST_LONG.ru + ' · ≤' + ltv + '% LTV · только проценты · выплата ежемесячно · срок ' + term + ' мес. · мин. ' + min;
      return FIRST_LONG.en + ' · ≤' + ltv + '% LTV · interest-only · paid monthly · ' + term + '-month term · min ' + min;
    },
    ledgerHeaders: function (lang) {
      return [T('gl.h.profile', lang), T('gl.h.lien', lang), T('gl.h.maxltv', lang), T('gl.h.yield', lang), T('gl.h.term', lang), T('gl.h.min', lang)];
    },
    fileOfWeek: { en: 'FILE OF THE WEEK', es: 'EXPEDIENTE DE LA SEMANA', ru: 'ФАЙЛ НЕДЕЛИ' },
    dwTerm: function (lang, months) {
      if (lang === 'es') return months + ' meses · servicing mensual';
      if (lang === 'ru') return months + ' мес. · ежемесячное обслуживание';
      return months + ' months · monthly servicing';
    },
  };

  function T(key, lang) {
    var e = DICT[key];
    if (!e) return key;
    return e[lang] || e.en || key;
  }

  function detect() {
    try {
      var s = localStorage.getItem(KEY);
      if (s && LANGS.indexOf(s) >= 0) return s;
      var n = (navigator.language || 'en').slice(0, 2).toLowerCase();
      if (LANGS.indexOf(n) >= 0) return n;
    } catch (e) {}
    return 'en';
  }

  var subs = [];
  var PNC = {
    lang: detect(),
    DYN: DYN,
    t: function (key) { return T(key, PNC.lang); },
    tl: T,
    subscribe: function (fn) { subs.push(fn); },
    setLang: function (lang) {
      if (LANGS.indexOf(lang) < 0) return;
      PNC.lang = lang;
      try { localStorage.setItem(KEY, lang); } catch (e) {}
      try { document.documentElement.lang = lang; } catch (e) {}
      applyStatic(lang);
      syncSwitch(lang);
      for (var i = 0; i < subs.length; i++) { try { subs[i](lang); } catch (e) {} }
    },
  };
  window.PNC = PNC;

  // Swap all static [data-i18n] / [data-i18n-ph] nodes + document meta.
  function applyStatic(lang) {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var k = nodes[i].getAttribute('data-i18n');
      if (DICT[k]) nodes[i].innerHTML = DICT[k][lang] || DICT[k].en;
    }
    var ph = document.querySelectorAll('[data-i18n-ph]');
    for (var j = 0; j < ph.length; j++) {
      var pk = ph[j].getAttribute('data-i18n-ph');
      if (DICT[pk]) ph[j].setAttribute('placeholder', (DICT[pk][lang] || DICT[pk].en).replace(/<[^>]+>/g, ''));
    }
    try {
      document.title = T('doc.title', lang);
      var md = document.querySelector('meta[name="description"]');
      if (md) md.setAttribute('content', T('doc.desc', lang));
    } catch (e) {}
  }

  // Build + wire the EN/ES/RU switcher into its header slot.
  function syncSwitch(lang) {
    var btns = document.querySelectorAll('.langswitch .langbtn');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-lang') === lang;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  function mountSwitch() {
    var slot = document.getElementById('pnc-lang');
    if (!slot) return;
    var html = '';
    for (var i = 0; i < LANGS.length; i++) {
      html += '<button type="button" class="langbtn" data-lang="' + LANGS[i] + '">' + LABEL[LANGS[i]] + '</button>';
    }
    slot.className = 'langswitch';
    slot.setAttribute('role', 'group');
    slot.setAttribute('aria-label', T('lang.label', PNC.lang));
    slot.innerHTML = html;
    slot.addEventListener('click', function (e) {
      var b = e.target.closest('.langbtn');
      if (b) PNC.setLang(b.getAttribute('data-lang'));
    });
  }

  function init() {
    try { document.documentElement.lang = PNC.lang; } catch (e) {}
    mountSwitch();
    applyStatic(PNC.lang);
    syncSwitch(PNC.lang);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
