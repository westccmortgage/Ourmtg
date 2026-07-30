// Conversational 1003 — the canonical, versioned field catalog.
//
// THIS FILE IS THE ALLOWLIST. The language model may only propose field paths that resolve
// to an entry here; anything else is rejected by turnContract.js before it can reach storage.
// Adding a field is a deliberate, versioned act — see CONVERSATIONAL-1003-FIELD-COVERAGE.md.
//
// Path shape
//   Template paths use empty brackets for repeatable groups:
//       parties[].employment[].startDate
//   Instantiated paths carry indices:
//       parties[0].employment[1].startDate
//   `loan.*` paths are shared household/property facts (one per application, not per party).
//
// Official mapping
//   `urla` cites the section of the Uniform Residential Loan Application (Form 1003, 2021
//   redesign) the field comes from. `ulad`/`mismo` carry the ULAD/MISMO 3.4 term name WHERE
//   WE ARE CONFIDENT OF IT. Where we are not, the value is null and the coverage report lists
//   the field as "not yet mapped" — we do not invent official mappings (§5).

import {
  APPLICATION_SCHEMA_VERSION, CATALOG_VERSION, FIELD_TYPES, FREQUENCIES,
} from './types.js'

// Label helper. `es`/`ru` fall back to English at render time when a reviewed translation is
// not yet available (tracked in the coverage report, never silently machine-translated).
const L = (en, es, ru) => Object.freeze({ en, es: es || null, ru: ru || null })

const DEFAULTS = {
  scope: 'party',           // 'party' | 'loan'
  type: 'text',
  required: false,
  requiredWhen: null,       // rule id in applicationRules.js
  allowNotApplicable: false,
  allowUnknown: true,       // "I don't know yet" is usually allowed; secure/legal fields aren't
  allowDecline: false,      // only where refusal is legally/operationally permitted
  voiceAllowed: true,
  secureEntry: false,       // must use the masked control; never conversational (§15)
  confirmRequired: false,   // explicit borrower confirmation (§14)
  teamReview: false,
  highImpact: false,
  values: null,             // enum domain
  officialTextLocked: false, // legal wording the model may explain but never restate
  ulad: null,
  mismo: null,
  urla: null,
}

const defs = []
function f(entry) {
  if (!entry.path) throw new Error('catalog entry needs a path')
  if (!FIELD_TYPES.includes(entry.type || DEFAULTS.type)) {
    throw new Error(`catalog: bad type for ${entry.path}`)
  }
  defs.push(Object.freeze({ ...DEFAULTS, ...entry, version: CATALOG_VERSION }))
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Borrower identity — URLA §1a
// ─────────────────────────────────────────────────────────────────────────────
f({ path: 'parties[].legalFirstName', section: 'identity', type: 'name', required: true, confirmRequired: true, highImpact: true,
  label: L('Your legal first name', 'Su nombre legal', 'Ваше юридическое имя'),
  purpose: L('Your name has to match your government ID exactly, so the loan documents are valid.', 'Su nombre debe coincidir exactamente con su identificación oficial.', 'Имя должно точно совпадать с документом, удостоверяющим личность.'),
  urla: '1a', ulad: 'BorrowerFirstName', mismo: 'FirstName' })
f({ path: 'parties[].legalMiddleName', section: 'identity', type: 'name', allowNotApplicable: true,
  label: L('Middle name', 'Segundo nombre', 'Отчество / второе имя'),
  purpose: L('Only if it appears on your ID.', 'Solo si aparece en su identificación.', 'Только если указано в документе.'),
  urla: '1a', ulad: 'BorrowerMiddleName', mismo: 'MiddleName' })
f({ path: 'parties[].legalLastName', section: 'identity', type: 'name', required: true, confirmRequired: true, highImpact: true,
  label: L('Your legal last name', 'Su apellido legal', 'Ваша юридическая фамилия'),
  purpose: L('Must match your government ID exactly.', 'Debe coincidir con su identificación.', 'Должна совпадать с документом.'),
  urla: '1a', ulad: 'BorrowerLastName', mismo: 'LastName' })
f({ path: 'parties[].suffix', section: 'identity', type: 'text', allowNotApplicable: true,
  label: L('Suffix (Jr., Sr., III)', 'Sufijo (Jr., Sr., III)', 'Суффикс (Jr., Sr., III)'),
  purpose: L('Only if it appears on your ID.', 'Solo si aparece en su identificación.', 'Только если указано в документе.'),
  urla: '1a', ulad: 'BorrowerSuffixName', mismo: 'SuffixName' })
f({ path: 'parties[].alternateNames', section: 'identity', type: 'longtext', allowNotApplicable: true, requiredWhen: 'alternateNamesApply',
  label: L('Other names you have used', 'Otros nombres que ha usado', 'Другие использованные имена'),
  purpose: L('Credit and title records may still be under a previous name.', 'Los registros de crédito pueden estar bajo un nombre anterior.', 'Кредитная история может быть под прежним именем.'),
  urla: '1a', ulad: 'BorrowerAlternateName', mismo: 'AlternateName' })
f({ path: 'parties[].email', section: 'identity', type: 'email', required: true,
  label: L('Your email address', 'Su correo electrónico', 'Ваш адрес электронной почты'),
  purpose: L('How we send your disclosures and secure links.', 'Para enviarle sus divulgaciones y enlaces seguros.', 'Для отправки документов и защищённых ссылок.'),
  urla: '1a', ulad: 'BorrowerEmailAddress', mismo: 'EmailAddress' })
f({ path: 'parties[].phone', section: 'identity', type: 'phone', required: true,
  label: L('Your mobile phone number', 'Su número de teléfono móvil', 'Номер мобильного телефона'),
  purpose: L('So your loan team can reach you about time-sensitive items.', 'Para que su equipo pueda contactarle.', 'Чтобы кредитная команда могла связаться с вами.'),
  urla: '1a', ulad: 'BorrowerMobilePhoneNumber', mismo: 'PhoneNumber' })
f({ path: 'parties[].dateOfBirth', section: 'identity', type: 'date', required: true, confirmRequired: true, highImpact: true, allowUnknown: false,
  label: L('Your date of birth', 'Su fecha de nacimiento', 'Дата рождения'),
  purpose: L('Required to pull credit and to verify your identity.', 'Necesario para verificar su identidad y su crédito.', 'Требуется для проверки личности и кредитной истории.'),
  urla: '1a', ulad: 'BorrowerBirthDate', mismo: 'BirthDate' })
f({ path: 'parties[].ssn', section: 'identity', type: 'ssn', required: true, secureEntry: true, voiceAllowed: false,
  allowUnknown: false, teamReview: true,
  label: L('Social Security number', 'Número de Seguro Social', 'Номер социального страхования'),
  purpose: L('Required by law to pull your credit report. Enter it in the secure box — never type or say it in the chat.', 'Requerido por ley para su reporte de crédito. Ingréselo en el cuadro seguro.', 'Требуется по закону для кредитного отчёта. Вводится только в защищённое поле.'),
  urla: '1a', ulad: 'BorrowerSSNIdentifier', mismo: 'TaxpayerIdentifierValue' })
f({ path: 'parties[].citizenshipStatus', section: 'identity', type: 'enum', required: true, confirmRequired: true,
  values: ['us_citizen', 'permanent_resident', 'non_permanent_resident'], officialTextLocked: true,
  label: L('Citizenship or residency status', 'Estado de ciudadanía o residencia', 'Гражданство или статус резидента'),
  purpose: L('Loan programs have different documentation requirements by residency status. This is asked of every applicant.', 'Los programas requieren documentación distinta según el estado de residencia.', 'Программы кредитования различаются по требованиям к документам.'),
  urla: '1a', ulad: 'CitizenshipResidencyType', mismo: 'CitizenshipResidencyType' })
f({ path: 'parties[].maritalStatus', section: 'identity', type: 'enum', required: true,
  values: ['married', 'separated', 'unmarried'], officialTextLocked: true,
  label: L('Marital status', 'Estado civil', 'Семейное положение'),
  purpose: L('Property and title laws depend on it. Asked of every applicant in the same words.', 'Las leyes de propiedad y título dependen de esto.', 'От этого зависят правила собственности и титула.'),
  urla: '1a', ulad: 'MaritalStatusType', mismo: 'MaritalStatusType' })
f({ path: 'parties[].dependentsCount', section: 'identity', type: 'integer', required: true,
  label: L('How many dependents do you have?', '¿Cuántos dependientes tiene?', 'Сколько у вас иждивенцев?'),
  purpose: L('Used for household budgeting on some programs. Enter 0 if none.', 'Se usa para el presupuesto del hogar en algunos programas.', 'Используется для расчёта бюджета семьи.'),
  urla: '1a', ulad: 'DependentCount', mismo: 'DependentCount' })
f({ path: 'parties[].dependentsAges', section: 'identity', type: 'text', requiredWhen: 'hasDependents',
  label: L('Ages of your dependents', 'Edades de sus dependientes', 'Возраст иждивенцев'),
  purpose: L('Just the ages, separated by commas.', 'Solo las edades, separadas por comas.', 'Только возраст, через запятую.'),
  urla: '1a', ulad: 'DependentAgeYears', mismo: 'DependentAgeYears' })

// ─────────────────────────────────────────────────────────────────────────────
// B. Residence history — URLA §1b
// ─────────────────────────────────────────────────────────────────────────────
f({ path: 'parties[].residence[].street', section: 'residence', type: 'address', required: true, confirmRequired: true,
  label: L('Street address where you live', 'Dirección donde vive', 'Адрес проживания'),
  purpose: L('Lenders need a continuous two-year address history.', 'Se requiere un historial de dirección de dos años.', 'Требуется непрерывная история адресов за два года.'),
  urla: '1b', ulad: 'AddressLineText', mismo: 'AddressLineText' })
f({ path: 'parties[].residence[].unit', section: 'residence', type: 'text', allowNotApplicable: true,
  label: L('Apartment or unit number', 'Número de apartamento o unidad', 'Номер квартиры'),
  purpose: L('If you have one.', 'Si aplica.', 'Если есть.'), urla: '1b', ulad: 'AddressUnitIdentifier', mismo: 'AddressUnitIdentifier' })
f({ path: 'parties[].residence[].city', section: 'residence', type: 'text', required: true,
  label: L('City', 'Ciudad', 'Город'), purpose: L('Part of your address history.', 'Parte de su historial de dirección.', 'Часть истории адресов.'),
  urla: '1b', ulad: 'CityName', mismo: 'CityName' })
f({ path: 'parties[].residence[].state', section: 'residence', type: 'text', required: true,
  label: L('State', 'Estado', 'Штат'), purpose: L('Part of your address history.', 'Parte de su historial.', 'Часть истории адресов.'),
  urla: '1b', ulad: 'StateCode', mismo: 'StateCode' })
f({ path: 'parties[].residence[].postalCode', section: 'residence', type: 'text', required: true,
  label: L('ZIP code', 'Código postal', 'Почтовый индекс'), purpose: L('Part of your address history.', 'Parte de su historial.', 'Часть истории адресов.'),
  urla: '1b', ulad: 'PostalCode', mismo: 'PostalCode' })
f({ path: 'parties[].residence[].isCurrent', section: 'residence', type: 'boolean', required: true,
  label: L('Is this where you live now?', '¿Vive aquí actualmente?', 'Вы живёте здесь сейчас?'),
  purpose: L('Separates your current home from previous ones.', 'Separa su vivienda actual de las anteriores.', 'Отделяет текущее жильё от предыдущего.'),
  urla: '1b', ulad: 'BorrowerResidencyType', mismo: 'BorrowerResidencyType' })
f({ path: 'parties[].residence[].startDate', section: 'residence', type: 'month', required: true, confirmRequired: true, highImpact: true,
  label: L('When did you move in? (month and year)', '¿Cuándo se mudó? (mes y año)', 'Когда вы въехали? (месяц и год)'),
  purpose: L('We need the month and year — not how long — so the two-year history lines up with no gaps.', 'Necesitamos el mes y el año, no la duración.', 'Нужен месяц и год, а не срок проживания.'),
  urla: '1b', ulad: 'BorrowerResidencyStartDate', mismo: 'ResidencyStartDate' })
f({ path: 'parties[].residence[].endDate', section: 'residence', type: 'month', requiredWhen: 'residenceIsPrevious', confirmRequired: true,
  label: L('When did you move out? (month and year)', '¿Cuándo se mudó de allí? (mes y año)', 'Когда вы съехали? (месяц и год)'),
  purpose: L('Closes the gap between addresses.', 'Cierra el espacio entre direcciones.', 'Закрывает промежуток между адресами.'),
  urla: '1b', ulad: 'BorrowerResidencyEndDate', mismo: 'ResidencyEndDate' })
f({ path: 'parties[].residence[].occupancyBasis', section: 'residence', type: 'enum', required: true, confirmRequired: true,
  values: ['own', 'rent', 'live_rent_free'],
  label: L('Do you own, rent, or live there rent-free?', '¿Es propietario, alquila, o vive sin pagar renta?', 'Вы владелец, арендуете или живёте без оплаты?'),
  purpose: L('Determines whether we count a housing payment for this address.', 'Determina si contamos un pago de vivienda.', 'Определяет, учитывается ли платёж за жильё.'),
  urla: '1b', ulad: 'BorrowerResidencyBasisType', mismo: 'BorrowerResidencyBasisType' })
f({ path: 'parties[].residence[].monthlyHousingExpense', section: 'residence', type: 'amount', requiredWhen: 'housingExpenseApplies',
  confirmRequired: true, highImpact: true,
  label: L('How much do you pay for housing each month?', '¿Cuánto paga de vivienda al mes?', 'Сколько вы платите за жильё в месяц?'),
  purpose: L('Your rent or total mortgage payment — not property tax by itself.', 'Su renta o pago hipotecario total, no solo el impuesto.', 'Аренда или полный ипотечный платёж, не только налог.'),
  urla: '1b', ulad: 'BorrowerResidenceMonthlyRentAmount', mismo: 'MonthlyRentAmount' })
f({ path: 'parties[].mailingAddressSameAsCurrent', section: 'residence', type: 'boolean', required: true,
  label: L('Do you get mail at the address where you live?', '¿Recibe correo en la dirección donde vive?', 'Вы получаете почту по адресу проживания?'),
  purpose: L('Your mailing address can differ from where you live — they are separate questions.', 'La dirección postal puede ser distinta.', 'Почтовый адрес может отличаться.'),
  urla: '1b', ulad: 'BorrowerMailingAddressIndicator', mismo: null })
f({ path: 'parties[].mailingAddress', section: 'residence', type: 'address', requiredWhen: 'mailingAddressDiffers',
  label: L('Your mailing address', 'Su dirección postal', 'Почтовый адрес'),
  purpose: L('Where your documents should be mailed.', 'A dónde enviar sus documentos.', 'Куда отправлять документы.'),
  urla: '1b', ulad: 'MailingAddressLineText', mismo: 'AddressLineText' })

// ─────────────────────────────────────────────────────────────────────────────
// C. Employment history — URLA §1c/1d/1e
// ─────────────────────────────────────────────────────────────────────────────
f({ path: 'parties[].employment[].employerName', section: 'employment', type: 'text', required: true, confirmRequired: true, highImpact: true,
  label: L('Employer or business name', 'Nombre del empleador o negocio', 'Название работодателя или бизнеса'),
  purpose: L('The company that pays you — not your job title.', 'La empresa que le paga, no su puesto.', 'Компания, которая платит вам, а не должность.'),
  urla: '1c', ulad: 'EmployerName', mismo: 'FullName' })
f({ path: 'parties[].employment[].position', section: 'employment', type: 'text', required: true,
  label: L('Your job title or position', 'Su puesto o cargo', 'Ваша должность'),
  purpose: L('What you do there — for example "Site Supervisor".', 'Lo que hace allí.', 'Чем вы там занимаетесь.'),
  urla: '1c', ulad: 'EmploymentPositionDescription', mismo: 'EmploymentPositionDescription' })
f({ path: 'parties[].employment[].isCurrent', section: 'employment', type: 'boolean', required: true,
  label: L('Do you still work there?', '¿Todavía trabaja allí?', 'Вы всё ещё там работаете?'),
  purpose: L('Separates your current job from previous ones.', 'Separa su empleo actual del anterior.', 'Отделяет текущую работу от прежней.'),
  urla: '1c', ulad: 'EmploymentStatusType', mismo: 'EmploymentStatusType' })
f({ path: 'parties[].employment[].startDate', section: 'employment', type: 'month', required: true, confirmRequired: true, highImpact: true,
  label: L('What month and year did you start there?', '¿En qué mes y año empezó allí?', 'В каком месяце и году вы начали там работать?'),
  purpose: L('The date you began the job. This is a date — not how much you earned.', 'La fecha en que empezó, no cuánto ganó.', 'Дата начала работы, а не размер заработка.'),
  urla: '1c', ulad: 'EmploymentStartDate', mismo: 'EmploymentStartDate' })
f({ path: 'parties[].employment[].endDate', section: 'employment', type: 'month', requiredWhen: 'employmentIsPrevious', confirmRequired: true,
  label: L('What month and year did you leave?', '¿En qué mes y año terminó?', 'В каком месяце и году вы ушли?'),
  purpose: L('Closes the gap between jobs.', 'Cierra el espacio entre empleos.', 'Закрывает промежуток между работами.'),
  urla: '1d', ulad: 'EmploymentEndDate', mismo: 'EmploymentEndDate' })
f({ path: 'parties[].employment[].employmentType', section: 'employment', type: 'enum', required: true, confirmRequired: true,
  values: ['w2_employee', 'self_employed', 'contractor_1099', 'military', 'retired', 'other'],
  label: L('How are you paid there?', '¿Cómo le pagan allí?', 'Как вам там платят?'),
  purpose: L('W-2 employee, self-employed, 1099 contractor, or military — each needs different documents.', 'Cada tipo requiere documentos distintos.', 'Каждый тип требует разных документов.'),
  urla: '1c', ulad: 'EmploymentClassificationType', mismo: 'EmploymentClassificationType' })
f({ path: 'parties[].employment[].employerStreet', section: 'employment', type: 'address', requiredWhen: 'employerAddressRequired',
  label: L('Employer street address', 'Dirección del empleador', 'Адрес работодателя'),
  purpose: L('Required for verification of employment.', 'Necesario para verificar el empleo.', 'Нужен для подтверждения занятости.'),
  urla: '1c', ulad: 'EmployerAddressLineText', mismo: 'AddressLineText' })
f({ path: 'parties[].employment[].employerCity', section: 'employment', type: 'text', requiredWhen: 'employerAddressRequired',
  label: L('Employer city', 'Ciudad del empleador', 'Город работодателя'), purpose: L('Part of the employer address.', 'Parte de la dirección.', 'Часть адреса.'),
  urla: '1c', ulad: 'EmployerCityName', mismo: 'CityName' })
f({ path: 'parties[].employment[].employerState', section: 'employment', type: 'text', requiredWhen: 'employerAddressRequired',
  label: L('Employer state', 'Estado del empleador', 'Штат работодателя'), purpose: L('Part of the employer address.', 'Parte de la dirección.', 'Часть адреса.'),
  urla: '1c', ulad: 'EmployerStateCode', mismo: 'StateCode' })
f({ path: 'parties[].employment[].employerPostalCode', section: 'employment', type: 'text', requiredWhen: 'employerAddressRequired',
  label: L('Employer ZIP code', 'Código postal del empleador', 'Индекс работодателя'), purpose: L('Part of the employer address.', 'Parte de la dirección.', 'Часть адреса.'),
  urla: '1c', ulad: 'EmployerPostalCode', mismo: 'PostalCode' })
f({ path: 'parties[].employment[].employerPhone', section: 'employment', type: 'phone',
  label: L('Employer phone number', 'Teléfono del empleador', 'Телефон работодателя'),
  purpose: L('Used to verify employment.', 'Para verificar el empleo.', 'Для подтверждения занятости.'),
  urla: '1c', ulad: 'EmployerPhoneNumber', mismo: 'PhoneNumber' })
f({ path: 'parties[].employment[].isSelfEmployedOwner', section: 'employment', type: 'boolean', requiredWhen: 'employmentIsSelfEmployed',
  label: L('Do you own a share of this business?', '¿Es dueño de parte de este negocio?', 'Вы владеете долей этого бизнеса?'),
  purpose: L('Ownership changes which income documents are required.', 'La propiedad cambia los documentos requeridos.', 'Владение меняет требуемые документы.'),
  urla: '1c', ulad: 'EmploymentBorrowerSelfEmployedIndicator', mismo: 'SelfEmployedIndicator' })
f({ path: 'parties[].employment[].ownershipPct', section: 'employment', type: 'percent', requiredWhen: 'employmentIsSelfEmployed', confirmRequired: true,
  label: L('What percentage of the business do you own?', '¿Qué porcentaje del negocio posee?', 'Какой процент бизнеса вам принадлежит?'),
  purpose: L('25% or more changes the documentation the lender requires.', '25% o más cambia la documentación requerida.', '25% и более меняет требования к документам.'),
  urla: '1c', ulad: 'EmploymentOwnershipInterestType', mismo: 'OwnershipInterestType' })
f({ path: 'parties[].employment[].businessStartDate', section: 'employment', type: 'month', requiredWhen: 'employmentIsSelfEmployed',
  label: L('When did the business start?', '¿Cuándo comenzó el negocio?', 'Когда начался бизнес?'),
  purpose: L('Self-employment history is measured separately from your role.', 'El historial de negocio propio se mide aparte.', 'История самозанятости учитывается отдельно.'),
  urla: '1c', ulad: null, mismo: null })

// ─────────────────────────────────────────────────────────────────────────────
// D. Income — URLA §1c/1e/1f
// ─────────────────────────────────────────────────────────────────────────────
f({ path: 'parties[].income[].incomeType', section: 'income', type: 'enum', required: true, confirmRequired: true,
  values: ['base', 'overtime', 'bonus', 'commission', 'military', 'self_employment', 'rental',
    'retirement', 'social_security', 'other'],
  label: L('What kind of income is this?', '¿Qué tipo de ingreso es este?', 'Какой это вид дохода?'),
  purpose: L('Base pay, overtime, bonus, and commission are counted differently by lenders.', 'Cada tipo se calcula de forma distinta.', 'Разные виды дохода учитываются по-разному.'),
  urla: '1e', ulad: 'IncomeType', mismo: 'IncomeType' })
f({ path: 'parties[].income[].amount', section: 'income', type: 'amount', required: true, confirmRequired: true, highImpact: true,
  label: L('How much is it?', '¿De cuánto es?', 'Какая сумма?'),
  purpose: L('The gross amount before taxes — not your take-home pay.', 'El monto bruto antes de impuestos.', 'Сумма до вычета налогов.'),
  urla: '1e', ulad: 'IncomeAmount', mismo: 'CurrentIncomeMonthlyTotalAmount' })
f({ path: 'parties[].income[].frequency', section: 'income', type: 'frequency', required: true, confirmRequired: true, highImpact: true,
  values: [...FREQUENCIES],
  label: L('How often do you receive it?', '¿Con qué frecuencia lo recibe?', 'Как часто вы это получаете?'),
  purpose: L('Per hour, per week, per month, or per year — this changes the number completely.', 'Por hora, semana, mes o año.', 'В час, в неделю, в месяц или в год.'),
  urla: '1e', ulad: 'IncomePayFrequencyType', mismo: 'PayFrequencyType' })
f({ path: 'parties[].income[].hoursPerWeek', section: 'income', type: 'integer', requiredWhen: 'incomeIsHourly',
  label: L('How many hours a week do you usually work?', '¿Cuántas horas por semana trabaja?', 'Сколько часов в неделю вы работаете?'),
  purpose: L('Needed to turn an hourly rate into a monthly figure.', 'Necesario para convertir a mensual.', 'Нужно для пересчёта в месячный доход.'),
  urla: '1e', ulad: null, mismo: null })
f({ path: 'parties[].income[].employmentIndex', section: 'income', type: 'integer', requiredWhen: 'incomeIsEmploymentLinked',
  label: L('Which job is this income from?', '¿De qué empleo proviene?', 'От какой работы этот доход?'),
  purpose: L('Links the income to the right employer.', 'Vincula el ingreso al empleador correcto.', 'Связывает доход с работодателем.'),
  urla: '1e', ulad: null, mismo: null })
f({ path: 'parties[].income[].description', section: 'income', type: 'text', requiredWhen: 'incomeIsOther',
  label: L('Describe this income', 'Describa este ingreso', 'Опишите этот доход'),
  purpose: L('A short description so underwriting knows what it is.', 'Una descripción breve.', 'Краткое описание.'),
  urla: '1e', ulad: 'IncomeTypeOtherDescription', mismo: 'IncomeTypeOtherDescription' })
f({ path: 'parties[].income[].monthlyEquivalent', section: 'income', type: 'amount', teamReview: true,
  label: L('Monthly equivalent', 'Equivalente mensual', 'Эквивалент в месяц'),
  purpose: L('Calculated by the system from the amount and frequency — the loan team verifies it.', 'Calculado por el sistema.', 'Рассчитывается системой.'),
  urla: '1e', ulad: null, mismo: null })

// ─────────────────────────────────────────────────────────────────────────────
// E. Loan and property — URLA §4a/4b/5 (shared, not per party)
// ─────────────────────────────────────────────────────────────────────────────
f({ path: 'loan.purpose', scope: 'loan', section: 'loan', type: 'enum', required: true, confirmRequired: true, highImpact: true,
  values: ['purchase', 'refinance'],
  label: L('Are you buying a home or refinancing one you own?', '¿Está comprando o refinanciando?', 'Вы покупаете жильё или рефинансируете?'),
  purpose: L('This decides most of the rest of the application.', 'Esto determina el resto de la solicitud.', 'От этого зависит остальная часть заявки.'),
  urla: '4a', ulad: 'LoanPurposeType', mismo: 'LoanPurposeType' })
f({ path: 'loan.occupancy', scope: 'loan', section: 'loan', type: 'enum', required: true, confirmRequired: true, highImpact: true,
  values: ['primary_residence', 'second_home', 'investment'],
  label: L('How will you use this property?', '¿Cómo usará esta propiedad?', 'Как вы будете использовать недвижимость?'),
  purpose: L('Your main home, a second home, or a rental — the terms differ for each.', 'Vivienda principal, segunda casa, o inversión.', 'Основное жильё, второй дом или инвестиция.'),
  urla: '4a', ulad: 'PropertyUsageType', mismo: 'PropertyUsageType' })
f({ path: 'loan.propertyStreet', scope: 'loan', section: 'loan', type: 'address', requiredWhen: 'propertyAddressKnown', allowUnknown: true,
  label: L('Property street address', 'Dirección de la propiedad', 'Адрес недвижимости'),
  purpose: L('If you have not chosen a home yet, that is fine — say so and we will come back to it.', 'Si aún no eligió una casa, está bien.', 'Если жильё ещё не выбрано — это нормально.'),
  urla: '4a', ulad: 'PropertyAddressLineText', mismo: 'AddressLineText' })
f({ path: 'loan.propertyCity', scope: 'loan', section: 'loan', type: 'text', requiredWhen: 'propertyAddressKnown', allowUnknown: true,
  label: L('Property city', 'Ciudad de la propiedad', 'Город недвижимости'), purpose: L('Part of the property address.', 'Parte de la dirección.', 'Часть адреса.'),
  urla: '4a', ulad: 'PropertyCityName', mismo: 'CityName' })
f({ path: 'loan.propertyState', scope: 'loan', section: 'loan', type: 'text', requiredWhen: 'propertyAddressKnown', allowUnknown: true,
  label: L('Property state', 'Estado de la propiedad', 'Штат недвижимости'), purpose: L('Part of the property address.', 'Parte de la dirección.', 'Часть адреса.'),
  urla: '4a', ulad: 'PropertyStateCode', mismo: 'StateCode' })
f({ path: 'loan.propertyPostalCode', scope: 'loan', section: 'loan', type: 'text', requiredWhen: 'propertyAddressKnown', allowUnknown: true,
  label: L('Property ZIP code', 'Código postal de la propiedad', 'Индекс недвижимости'), purpose: L('Part of the property address.', 'Parte de la dirección.', 'Часть адреса.'),
  urla: '4a', ulad: 'PropertyPostalCode', mismo: 'PostalCode' })
f({ path: 'loan.propertyType', scope: 'loan', section: 'loan', type: 'enum', required: true,
  values: ['single_family', 'condominium', 'townhouse', 'two_to_four_unit', 'manufactured', 'pud'],
  label: L('What type of property is it?', '¿Qué tipo de propiedad es?', 'Какой тип недвижимости?'),
  purpose: L('Condos and multi-unit properties have different requirements.', 'Los condominios y multifamiliares tienen requisitos distintos.', 'Для кондо и многоквартирных домов условия отличаются.'),
  urla: '4a', ulad: 'AttachmentType', mismo: 'PropertyType' })
f({ path: 'loan.purchasePrice', scope: 'loan', section: 'loan', type: 'amount', requiredWhen: 'loanIsPurchase', confirmRequired: true, highImpact: true,
  label: L('Purchase price', 'Precio de compra', 'Цена покупки'),
  purpose: L('What you are paying for the home — not the loan amount.', 'Lo que paga por la casa, no el préstamo.', 'Стоимость дома, а не сумма кредита.'),
  urla: '4a', ulad: 'PurchasePriceAmount', mismo: 'PurchasePriceAmount' })
f({ path: 'loan.estimatedPropertyValue', scope: 'loan', section: 'loan', type: 'amount', requiredWhen: 'loanIsRefinance', confirmRequired: true, highImpact: true,
  label: L('Estimated value of the property', 'Valor estimado de la propiedad', 'Оценочная стоимость'),
  purpose: L('Your best estimate of what it is worth today — not what you owe on it.', 'Su mejor estimación del valor, no lo que debe.', 'Оценка стоимости, а не остаток долга.'),
  urla: '4a', ulad: 'PropertyEstimatedValueAmount', mismo: 'PropertyEstimatedValueAmount' })
f({ path: 'loan.requestedLoanAmount', scope: 'loan', section: 'loan', type: 'amount', required: true, confirmRequired: true, highImpact: true,
  label: L('How much do you want to borrow?', '¿Cuánto desea pedir prestado?', 'Какую сумму вы хотите взять в кредит?'),
  purpose: L('The mortgage amount — usually the price minus your down payment.', 'El monto de la hipoteca.', 'Сумма ипотеки.'),
  urla: '4a', ulad: 'LoanAmount', mismo: 'BaseLoanAmount' })
f({ path: 'loan.downPaymentAmount', scope: 'loan', section: 'loan', type: 'amount', requiredWhen: 'loanIsPurchase', confirmRequired: true,
  label: L('How much are you putting down?', '¿Cuánto dará de enganche?', 'Какой первоначальный взнос?'),
  purpose: L('Your down payment in dollars.', 'Su enganche en dólares.', 'Первоначальный взнос в долларах.'),
  urla: '4a', ulad: 'DownPaymentAmount', mismo: 'DownPaymentAmount' })
f({ path: 'loan.downPaymentSource', scope: 'loan', section: 'loan', type: 'enum', requiredWhen: 'loanIsPurchase',
  values: ['checking_savings', 'gift', 'grant', 'retirement', 'sale_of_property', 'other'],
  label: L('Where is the down payment coming from?', '¿De dónde viene el enganche?', 'Откуда первоначальный взнос?'),
  purpose: L('Gift and grant funds need extra paperwork, so we ask early.', 'Los regalos y subvenciones requieren papeleo adicional.', 'Подарки и гранты требуют дополнительных документов.'),
  urla: '4a', ulad: 'DownPaymentSourceType', mismo: 'FundsSourceType' })
f({ path: 'loan.refinancePurpose', scope: 'loan', section: 'loan', type: 'enum', requiredWhen: 'loanIsRefinance',
  values: ['rate_term', 'cash_out', 'limited_cash_out'],
  label: L('What is the goal of the refinance?', '¿Cuál es el objetivo del refinanciamiento?', 'Какова цель рефинансирования?'),
  purpose: L('Lowering the rate, or taking cash out.', 'Bajar la tasa, o sacar efectivo.', 'Снизить ставку или получить наличные.'),
  urla: '4a', ulad: 'RefinanceCashOutDeterminationType', mismo: 'RefinanceCashOutDeterminationType' })
f({ path: 'loan.existingLoanBalance', scope: 'loan', section: 'loan', type: 'amount', requiredWhen: 'loanIsRefinance', confirmRequired: true,
  label: L('How much do you still owe on the property?', '¿Cuánto debe todavía?', 'Сколько вы ещё должны?'),
  purpose: L('The current mortgage balance — different from the property value.', 'El saldo actual, distinto del valor.', 'Текущий остаток долга, не стоимость.'),
  urla: '4a', ulad: null, mismo: 'UPBAmount' })
f({ path: 'loan.cashOutAmount', scope: 'loan', section: 'loan', type: 'amount', requiredWhen: 'refinanceIsCashOut', confirmRequired: true,
  label: L('How much cash do you want to take out?', '¿Cuánto efectivo desea sacar?', 'Сколько наличных вы хотите получить?'),
  purpose: L('The amount above what you owe.', 'El monto por encima de lo que debe.', 'Сумма сверх остатка долга.'),
  urla: '4a', ulad: 'CashOutAmount', mismo: 'CashOutAmount' })
f({ path: 'loan.isUnderContract', scope: 'loan', section: 'loan', type: 'boolean', requiredWhen: 'loanIsPurchase',
  label: L('Have you already picked a home and signed a contract?', '¿Ya eligió una casa y firmó contrato?', 'Вы уже выбрали дом и подписали договор?'),
  purpose: L('If not, that is completely fine — we can pre-approve you first and add the address later.', 'Si no, podemos preaprobarle primero.', 'Если нет — можно сначала получить предварительное одобрение.'),
  urla: '4a', ulad: null, mismo: null })
f({ path: 'loan.estimatedClosingDate', scope: 'loan', section: 'loan', type: 'date',
  label: L('Target closing date', 'Fecha de cierre deseada', 'Желаемая дата закрытия'),
  purpose: L('If you have one — it helps us schedule.', 'Si tiene una fecha en mente.', 'Если есть, это помогает планированию.'),
  urla: '4a', ulad: null, mismo: null })
f({ path: 'loan.titleVestingIntent', scope: 'loan', section: 'loan', type: 'text', requiredWhen: 'titleVestingApplies',
  label: L('How do you want to hold title?', '¿Cómo desea tener el título?', 'Как оформить право собственности?'),
  purpose: L('Who will be on the deed. Your loan team and escrow will confirm the exact wording.', 'Quién estará en la escritura.', 'Кто будет указан в документе о собственности.'),
  urla: '4a', ulad: null, mismo: null })
f({ path: 'loan.mixedUseProperty', scope: 'loan', section: 'loan', type: 'boolean', required: true, officialTextLocked: true,
  label: L('Will you use any part of the property for business?', '¿Usará parte de la propiedad para un negocio?', 'Будете ли вы использовать часть недвижимости для бизнеса?'),
  purpose: L('A home office or a storefront changes how the property is classified.', 'Una oficina en casa cambia la clasificación.', 'Домашний офис меняет классификацию объекта.'),
  urla: '5', ulad: 'PropertyMixedUsageIndicator', mismo: 'PropertyMixedUsageIndicator' })

// ─────────────────────────────────────────────────────────────────────────────
// F. Assets — URLA §2a/2b
// ─────────────────────────────────────────────────────────────────────────────
f({ path: 'parties[].assets[].assetType', section: 'assets', type: 'enum', required: true, confirmRequired: true,
  values: ['checking', 'savings', 'money_market', 'certificate_of_deposit', 'mutual_fund', 'stocks',
    'bonds', 'retirement', 'trust', 'earnest_money', 'gift_cash', 'gift_equity', 'grant',
    'proceeds_from_sale', 'other'],
  label: L('What kind of account or asset is it?', '¿Qué tipo de cuenta o activo es?', 'Какой это тип счёта или актива?'),
  purpose: L('Checking, savings, investments, retirement, or gift funds.', 'Cheques, ahorros, inversiones, o regalos.', 'Текущий счёт, сбережения, инвестиции или подарок.'),
  urla: '2a', ulad: 'AssetType', mismo: 'AssetType' })
f({ path: 'parties[].assets[].institutionName', section: 'assets', type: 'text', requiredWhen: 'assetNeedsInstitution',
  label: L('Which bank or institution holds it?', '¿Qué banco o institución la tiene?', 'В каком банке или организации?'),
  purpose: L('The name only — we never ask for your online banking login.', 'Solo el nombre; nunca pedimos su acceso bancario.', 'Только название; мы не запрашиваем доступ к онлайн-банку.'),
  urla: '2a', ulad: 'AssetFinancialInstitutionName', mismo: 'FullName' })
f({ path: 'parties[].assets[].accountNumber', section: 'assets', type: 'account_number', secureEntry: true, voiceAllowed: false,
  allowUnknown: true, teamReview: true, requiredWhen: 'assetNeedsInstitution',
  label: L('Account number', 'Número de cuenta', 'Номер счёта'),
  purpose: L('Enter it in the secure box — never in the chat. We only ever show the last four digits back to you.', 'Ingréselo en el cuadro seguro, nunca en el chat.', 'Вводите только в защищённое поле, не в чат.'),
  urla: '2a', ulad: 'AssetAccountIdentifier', mismo: 'AccountIdentifier' })
f({ path: 'parties[].assets[].balance', section: 'assets', type: 'amount', required: true, confirmRequired: true, highImpact: true,
  label: L('What is the current balance or value?', '¿Cuál es el saldo o valor actual?', 'Какой текущий баланс или стоимость?'),
  purpose: L('The balance in the account — not income you receive.', 'El saldo, no un ingreso mensual.', 'Остаток на счёте, а не ежемесячный доход.'),
  urla: '2a', ulad: 'AssetCashOrMarketValueAmount', mismo: 'AssetCashOrMarketValueAmount' })
f({ path: 'parties[].assets[].giftSource', section: 'assets', type: 'enum', requiredWhen: 'assetIsGiftOrGrant',
  values: ['relative', 'employer', 'government_agency', 'nonprofit', 'other'],
  label: L('Who is the gift or grant coming from?', '¿De quién viene el regalo o subvención?', 'От кого подарок или грант?'),
  purpose: L('Gift funds need a letter from the donor.', 'Los regalos requieren una carta del donante.', 'Для подарка нужно письмо от дарителя.'),
  urla: '2b', ulad: 'FundsSourceType', mismo: 'FundsSourceType' })
f({ path: 'parties[].assets[].isDeposited', section: 'assets', type: 'boolean', requiredWhen: 'assetIsGiftOrGrant',
  label: L('Has it already been deposited?', '¿Ya fue depositado?', 'Уже зачислено на счёт?'),
  purpose: L('Deposited and not-yet-deposited gifts are documented differently.', 'Se documentan de forma distinta.', 'Документируется по-разному.'),
  urla: '2b', ulad: 'AssetDepositIndicator', mismo: null })

// ─────────────────────────────────────────────────────────────────────────────
// G. Liabilities — URLA §2c/2d.
// The section is gated by an explicit yes/no so "no debts" is a recorded answer rather than
// an empty section we cannot distinguish from an unfinished one (§10 no_vs_not_applicable).
// ─────────────────────────────────────────────────────────────────────────────
f({ path: 'parties[].hasAnyLiabilities', section: 'liabilities', type: 'boolean', required: true,
  label: L('Do you have any monthly debt payments?', '¿Tiene pagos de deudas mensuales?', 'У вас есть ежемесячные платежи по долгам?'),
  purpose: L('Car loans, credit cards, student loans, child support. Answer no only if you truly have none.', 'Autos, tarjetas, préstamos estudiantiles, manutención.', 'Автокредиты, карты, студенческие займы, алименты.'),
  urla: '2c', ulad: null, mismo: null })
f({ path: 'parties[].liabilities[].liabilityType', section: 'liabilities', type: 'enum', required: true, confirmRequired: true,
  values: ['mortgage', 'heloc', 'installment', 'revolving', 'lease', 'open_30_day',
    'alimony', 'child_support', 'separate_maintenance', 'job_related_expense', 'other'],
  label: L('What kind of debt or obligation is it?', '¿Qué tipo de deuda es?', 'Какой это вид долга?'),
  purpose: L('Car loan, credit card, student loan, or support payments.', 'Auto, tarjeta, préstamo estudiantil, o manutención.', 'Автокредит, карта, студенческий заём или алименты.'),
  urla: '2c', ulad: 'LiabilityType', mismo: 'LiabilityType' })
f({ path: 'parties[].liabilities[].creditorName', section: 'liabilities', type: 'text', required: true,
  label: L('Who do you owe it to?', '¿A quién le debe?', 'Кому вы должны?'),
  purpose: L('The lender or company name.', 'El nombre del acreedor.', 'Название кредитора.'),
  urla: '2c', ulad: 'LiabilityHolderName', mismo: 'FullName' })
f({ path: 'parties[].liabilities[].monthlyPayment', section: 'liabilities', type: 'amount', required: true, confirmRequired: true, highImpact: true,
  label: L('What is the monthly payment?', '¿Cuál es el pago mensual?', 'Каков ежемесячный платёж?'),
  purpose: L('The minimum you pay each month.', 'El mínimo que paga al mes.', 'Минимальный ежемесячный платёж.'),
  urla: '2c', ulad: 'LiabilityMonthlyPaymentAmount', mismo: 'LiabilityMonthlyPaymentAmount' })
f({ path: 'parties[].liabilities[].unpaidBalance', section: 'liabilities', type: 'amount', required: true, confirmRequired: true,
  label: L('How much is still owed?', '¿Cuánto se debe todavía?', 'Каков остаток долга?'),
  purpose: L('The remaining balance — different from the monthly payment.', 'El saldo restante, distinto del pago.', 'Остаток, отличается от платежа.'),
  urla: '2c', ulad: 'LiabilityUnpaidBalanceAmount', mismo: 'LiabilityUnpaidBalanceAmount' })
f({ path: 'parties[].liabilities[].accountNumber', section: 'liabilities', type: 'account_number', secureEntry: true, voiceAllowed: false, teamReview: true,
  label: L('Account number', 'Número de cuenta', 'Номер счёта'),
  purpose: L('Optional, and only through the secure box.', 'Opcional, solo en el cuadro seguro.', 'Необязательно, только через защищённое поле.'),
  urla: '2c', ulad: 'LiabilityAccountIdentifier', mismo: 'AccountIdentifier' })
f({ path: 'parties[].liabilities[].toBePaidOffAtClosing', section: 'liabilities', type: 'boolean', required: true,
  label: L('Will this be paid off before or at closing?', '¿Se pagará antes o al cierre?', 'Будет ли погашено до или при закрытии?'),
  purpose: L('Debts paid off at closing are treated differently in the calculation.', 'Se tratan distinto en el cálculo.', 'Учитывается иначе в расчёте.'),
  urla: '2c', ulad: 'LiabilityPayoffStatusIndicator', mismo: 'LiabilityPayoffStatusIndicator' })

// ─────────────────────────────────────────────────────────────────────────────
// H. Real estate owned — URLA §3. Also explicitly gated (see §G note).
// ─────────────────────────────────────────────────────────────────────────────
f({ path: 'parties[].ownsOtherRealEstate', section: 'reo', type: 'boolean', required: true,
  label: L('Do you own any other property?', '¿Posee alguna otra propiedad?', 'Владеете ли вы другой недвижимостью?'),
  purpose: L('Any real estate you own besides the one in this loan — including rentals and land.', 'Cualquier propiedad además de esta, incluidas rentas y terrenos.', 'Любая недвижимость помимо этой, включая аренду и землю.'),
  urla: '3', ulad: null, mismo: null })
f({ path: 'parties[].reo[].propertyAddress', section: 'reo', type: 'address', required: true, confirmRequired: true,
  label: L('Address of the property you own', 'Dirección de la propiedad que posee', 'Адрес принадлежащей вам недвижимости'),
  purpose: L('Every property you own, even if it is not part of this loan.', 'Cada propiedad que posee.', 'Каждый объект, которым вы владеете.'),
  urla: '3a', ulad: 'AddressLineText', mismo: 'AddressLineText' })
f({ path: 'parties[].reo[].propertyValue', section: 'reo', type: 'amount', required: true, confirmRequired: true, highImpact: true,
  label: L('What is it worth today?', '¿Cuánto vale hoy?', 'Сколько она стоит сегодня?'),
  purpose: L('Its market value — not the mortgage balance.', 'Su valor de mercado, no el saldo.', 'Рыночная стоимость, не остаток долга.'),
  urla: '3a', ulad: 'REOPropertyValueAmount', mismo: 'PropertyEstimatedValueAmount' })
f({ path: 'parties[].reo[].mortgageBalance', section: 'reo', type: 'amount', required: true, confirmRequired: true,
  label: L('How much is still owed on it?', '¿Cuánto se debe de la hipoteca?', 'Каков остаток по ипотеке?'),
  purpose: L('The mortgage balance — enter 0 if it is paid off.', 'El saldo de la hipoteca; 0 si está pagada.', 'Остаток по ипотеке; 0, если погашена.'),
  urla: '3a', ulad: 'REOMortgageUnpaidBalanceAmount', mismo: 'UPBAmount' })
f({ path: 'parties[].reo[].monthlyPayment', section: 'reo', type: 'amount', required: true,
  label: L('What is the monthly mortgage payment?', '¿Cuál es el pago mensual?', 'Каков ежемесячный платёж?'),
  purpose: L('Principal and interest. Enter 0 if there is no mortgage.', 'Capital e intereses; 0 si no hay hipoteca.', 'Основной долг и проценты; 0, если ипотеки нет.'),
  urla: '3a', ulad: 'REOMortgagePaymentAmount', mismo: 'LiabilityMonthlyPaymentAmount' })
f({ path: 'parties[].reo[].monthlyTaxesInsuranceHoa', section: 'reo', type: 'amount', required: true,
  label: L('Monthly taxes, insurance, and HOA dues', 'Impuestos, seguro y cuotas mensuales', 'Налоги, страховка и сборы в месяц'),
  purpose: L('The carrying costs beyond the mortgage payment.', 'Los costos además de la hipoteca.', 'Расходы помимо ипотечного платежа.'),
  urla: '3a', ulad: 'REOMaintenanceExpenseAmount', mismo: null })
f({ path: 'parties[].reo[].occupancy', section: 'reo', type: 'enum', required: true,
  values: ['primary_residence', 'second_home', 'investment'],
  label: L('How is that property used?', '¿Cómo se usa esa propiedad?', 'Как используется эта недвижимость?'),
  purpose: L('You live in it, use it seasonally, or rent it out.', 'Vive en ella, la usa a veces, o la renta.', 'Вы живёте там, используете сезонно или сдаёте.'),
  urla: '3a', ulad: 'REOPropertyUsageType', mismo: 'PropertyUsageType' })
f({ path: 'parties[].reo[].monthlyRentalIncome', section: 'reo', type: 'amount', requiredWhen: 'reoIsRental', confirmRequired: true,
  label: L('How much rent does it bring in each month?', '¿Cuánta renta genera al mes?', 'Какой ежемесячный доход от аренды?'),
  purpose: L('The gross rent you collect.', 'La renta bruta que recibe.', 'Валовая арендная плата.'),
  urla: '3a', ulad: 'REORentalIncomeGrossAmount', mismo: 'RentalIncomeGrossAmount' })
f({ path: 'parties[].reo[].dispositionIntent', section: 'reo', type: 'enum', required: true,
  values: ['retain', 'sell', 'pending_sale'],
  label: L('What will you do with it?', '¿Qué hará con ella?', 'Что вы с ней сделаете?'),
  purpose: L('Keep it, sell it, or it is already under contract to sell.', 'Conservarla, venderla, o ya está en contrato.', 'Оставить, продать или уже в процессе продажи.'),
  urla: '3a', ulad: 'REODispositionStatusType', mismo: 'DispositionStatusType' })
f({ path: 'parties[].reo[].ownershipPct', section: 'reo', type: 'percent',
  label: L('What share of it do you own?', '¿Qué parte posee?', 'Какой долей вы владеете?'),
  purpose: L('100% unless you own it with someone outside this application.', '100% salvo que la comparta.', '100%, если нет других владельцев.'),
  urla: '3a', ulad: null, mismo: null })

// ─────────────────────────────────────────────────────────────────────────────
// I. Declarations — URLA §5a/5b. Official wording is LOCKED: the assistant may explain a
// declaration in plain language but must never restate or soften the legal question (§26).
// ─────────────────────────────────────────────────────────────────────────────
const declaration = (key, urlaRef, en, plainEn, opts = {}) =>
  f({
    path: `parties[].declarations.${key}`, section: 'declarations', type: 'boolean', required: true,
    officialTextLocked: true, allowUnknown: false, confirmRequired: true,
    label: L(en, null, null), purpose: L(plainEn, null, null),
    urla: urlaRef, ulad: opts.ulad || null, mismo: opts.mismo || null, ...opts.extra,
  })

declaration('occupyAsPrimaryResidence', '5a.A',
  'Will you occupy the property as your primary residence?',
  'Whether this will be the home you actually live in most of the year.',
  { ulad: 'IntentToOccupyIndicator', mismo: 'IntentToOccupyType' })
declaration('ownershipInterestPastThreeYears', '5a.B',
  'Have you had an ownership interest in another property in the last three years?',
  'Whether you have owned any home in the past three years — even one you already sold.',
  { ulad: 'HomeownerPastThreeYearsIndicator', mismo: 'HomeownerPastThreeYearsType' })
declaration('familyRelationshipWithSeller', '5a.C',
  'Do you have a family relationship or business affiliation with the seller of the property?',
  'Whether you know the seller personally or through business. It does not disqualify you; it changes the paperwork.',
  { ulad: 'SpecialBorrowerSellerRelationshipIndicator', mismo: 'SpecialBorrowerSellerRelationshipIndicator' })
declaration('borrowingOtherMoney', '5a.D1',
  'Are you borrowing any money for this real estate transaction or obtaining any money from another party that you have not disclosed on this loan application?',
  'Whether any other money — a loan from a relative, a second loan — is coming into this deal.',
  { ulad: 'UndisclosedBorrowedFundsIndicator', mismo: 'UndisclosedBorrowedFundsIndicator' })
declaration('applyingOtherMortgage', '5a.D2',
  'Have you or will you be applying for a mortgage loan on another property on or before closing this loan that is not disclosed on this application?',
  'Whether you are also applying for a different mortgage right now.',
  { ulad: 'UndisclosedMortgageApplicationIndicator', mismo: 'UndisclosedMortgageApplicationIndicator' })
declaration('applyingNewCredit', '5a.D3',
  'Have you or will you be applying for any new credit on or before closing this loan that is not disclosed on this application?',
  'Whether you are opening any new credit before closing — a card, a car loan.',
  { ulad: 'UndisclosedCreditApplicationIndicator', mismo: 'UndisclosedCreditApplicationIndicator' })
declaration('propertySubjectToLien', '5a.D4',
  'Will this property be subject to a lien that could take priority over the first mortgage lien, such as a clean energy lien paid through your property taxes?',
  'Whether something like a PACE or solar assessment is attached to the property taxes.',
  { ulad: 'PropertyProposedCleanEnergyLienIndicator', mismo: 'PropertyProposedCleanEnergyLienIndicator' })
declaration('coSignerOrGuarantor', '5b.E',
  'Are you a co-signer or guarantor on any debt or loan that is not disclosed on this application?',
  'Whether you signed for someone else\'s loan — even if you never make the payment.',
  { ulad: 'UndisclosedComakerOfNoteIndicator', mismo: 'UndisclosedComakerOfNoteIndicator' })
declaration('outstandingJudgments', '5b.F',
  'Are there any outstanding judgments against you?',
  'A court judgment ordering you to pay someone that has not been satisfied.',
  { ulad: 'OutstandingJudgmentsIndicator', mismo: 'OutstandingJudgmentsIndicator' })
declaration('delinquentFederalDebt', '5b.G',
  'Are you currently delinquent or in default on a Federal debt?',
  'Behind on a federal student loan, federal tax debt, or similar.',
  { ulad: 'PresentlyDelinquentIndicator', mismo: 'PresentlyDelinquentIndicator' })
declaration('partyToLawsuit', '5b.H',
  'Are you a party to a lawsuit in which you potentially have any personal financial liability?',
  'An active lawsuit where you could personally owe money.',
  { ulad: 'PartyToLawsuitIndicator', mismo: 'PartyToLawsuitIndicator' })
declaration('conveyedTitleInLieu', '5b.I',
  'Have you conveyed title to any property in lieu of foreclosure in the past 7 years?',
  'Whether you handed a property back to a lender instead of going through foreclosure.',
  { ulad: 'PriorPropertyDeedInLieuConveyedIndicator', mismo: 'PriorPropertyDeedInLieuConveyedIndicator' })
declaration('preForeclosureShortSale', '5b.J',
  'Within the past 7 years, have you completed a pre-foreclosure sale or short sale, whereby the property was sold to a third party and the Lender agreed to accept a lesser amount than the balance due?',
  'A short sale, where the lender accepted less than what was owed.',
  { ulad: 'PriorPropertyShortSaleCompletedIndicator', mismo: 'PriorPropertyShortSaleCompletedIndicator' })
declaration('propertyForeclosed', '5b.K',
  'Have you had property foreclosed upon in the last 7 years?',
  'Whether a lender foreclosed on a property you owned.',
  { ulad: 'PriorPropertyForeclosureCompletedIndicator', mismo: 'PriorPropertyForeclosureCompletedIndicator' })
declaration('declaredBankruptcy', '5b.L',
  'Have you declared bankruptcy within the past 7 years?',
  'Any bankruptcy filing in the last seven years.',
  { ulad: 'BankruptcyIndicator', mismo: 'BankruptcyIndicator' })

f({ path: 'parties[].declarations.bankruptcyType', section: 'declarations', type: 'enum',
  values: ['chapter_7', 'chapter_11', 'chapter_12', 'chapter_13'], requiredWhen: 'declaredBankruptcy',
  officialTextLocked: true, allowUnknown: false,
  label: L('Identify the type(s) of bankruptcy', null, null),
  purpose: L('Which chapter you filed under. Your attorney or discharge papers will say.', null, null),
  urla: '5b.L', ulad: 'BankruptcyType', mismo: 'BankruptcyType' })
f({ path: 'parties[].declarations.explanation', section: 'declarations', type: 'longtext',
  requiredWhen: 'declarationNeedsExplanation', teamReview: true,
  label: L('Please explain', 'Por favor explique', 'Пожалуйста, поясните'),
  purpose: L('A short written explanation in your own words. Your loan team will review it with you.', 'Una breve explicación en sus palabras.', 'Краткое пояснение своими словами.'),
  urla: '5b', ulad: null, mismo: null })

// ─────────────────────────────────────────────────────────────────────────────
// K. Demographic information — URLA §7. AI MUST NEVER INFER ANY OF THIS (§26).
// Every field permits an explicit, unpenalized refusal.
// ─────────────────────────────────────────────────────────────────────────────
const demographic = (key, values, en) =>
  f({
    path: `parties[].demographics.${key}`, section: 'demographics', type: 'enum', values,
    required: false, allowDecline: true, allowNotApplicable: false, allowUnknown: false,
    voiceAllowed: false, officialTextLocked: true, aiInferenceForbidden: true,
    label: L(en, null, null),
    purpose: L('The government asks lenders to collect this to make sure everyone is treated fairly. You may decline to provide it, and declining does not affect your application in any way.', null, null),
    urla: '7', ulad: null, mismo: null,
  })

demographic('ethnicity', ['hispanic_or_latino', 'not_hispanic_or_latino', 'do_not_wish_to_provide'], 'Ethnicity')
demographic('race', ['american_indian_or_alaska_native', 'asian', 'black_or_african_american',
  'native_hawaiian_or_other_pacific_islander', 'white', 'do_not_wish_to_provide'], 'Race')
demographic('sex', ['female', 'male', 'do_not_wish_to_provide'], 'Sex')

// ─────────────────────────────────────────────────────────────────────────────
// L. Language preference — kept structurally SEPARATE from demographics so a language
// choice can never be read as, or inferred into, a demographic answer (§6.L, §26).
// ─────────────────────────────────────────────────────────────────────────────
// voiceAllowed is FALSE deliberately: inferring a language preference from how someone speaks
// is exactly the inference §26 forbids. It is only ever a controlled selection the borrower makes.
f({ path: 'parties[].languagePreference', section: 'supplemental', type: 'enum',
  values: ['en', 'es', 'ru', 'zh-Hans', 'other', 'do_not_wish_to_provide'],
  allowDecline: true, allowUnknown: false, aiInferenceForbidden: true, voiceAllowed: false,
  label: L('Preferred language (optional)', 'Idioma preferido (opcional)', 'Предпочитаемый язык (необязательно)'),
  purpose: L('Optional. Helps us communicate with you. It is not used to make any credit decision.', 'Opcional. No se usa para decisiones de crédito.', 'Необязательно. Не используется для решений по кредиту.'),
  urla: 'LPA', ulad: null, mismo: null })

// ─────────────────────────────────────────────────────────────────────────────
export const CATALOG = Object.freeze(defs)

// ── Lookup helpers ───────────────────────────────────────────────────────────
const templateOf = (path) => String(path).replace(/\[\d+\]/g, '[]')
const BY_TEMPLATE = new Map(CATALOG.map((d) => [d.path, d]))

/** Resolve an instantiated path ("parties[0].income[1].amount") to its catalog entry. */
export function getField(path) {
  return BY_TEMPLATE.get(templateOf(path)) || null
}
export function isKnownField(path) {
  return BY_TEMPLATE.has(templateOf(path))
}
export function templatePath(path) { return templateOf(path) }

/** Parse indices out of an instantiated path: parties[0].income[1].amount → [0, 1]. */
export function pathIndices(path) {
  return [...String(path).matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
}
/** The repeatable group an entry belongs to, e.g. 'employment' — null for scalar fields. */
export function groupOf(templateOrPath) {
  const t = templateOf(templateOrPath)
  const m = t.match(/\.(\w+)\[\]\.[^.]+$/)
  return m ? m[1] : null
}
/** Instantiate a template path with the given indices, in order. */
export function instantiate(template, ...indices) {
  let i = 0
  return template.replace(/\[\]/g, () => `[${indices[i++] ?? 0}]`)
}
/** Strip the trailing field name: parties[0].income[1].amount → parties[0].income[1] */
export function recordPrefix(path) {
  const idx = String(path).lastIndexOf('.')
  return idx === -1 ? '' : String(path).slice(0, idx)
}

// Catalog labels are written as QUESTIONS ("How much is it?"), which reads badly in a chip or
// in "I saved …". chipLabel produces a short noun phrase instead: income amount, employment
// start date, asset balance. Falls back to a humanized path leaf, so a newly added field is
// never label-less.
const SECTION_NOUN = {
  identity: { en: '', es: '', ru: '' },
  residence: { en: 'residence', es: 'residencia', ru: 'адрес' },
  employment: { en: 'employment', es: 'empleo', ru: 'работа' },
  income: { en: 'income', es: 'ingreso', ru: 'доход' },
  loan: { en: 'loan', es: 'préstamo', ru: 'кредит' },
  assets: { en: 'asset', es: 'activo', ru: 'актив' },
  liabilities: { en: 'debt', es: 'deuda', ru: 'долг' },
  reo: { en: 'property', es: 'propiedad', ru: 'недвижимость' },
  declarations: { en: 'declaration', es: 'declaración', ru: 'декларация' },
  demographics: { en: '', es: '', ru: '' },
  supplemental: { en: '', es: '', ru: '' },
}
// Leaf names that only make sense with their section noun in front.
const GENERIC_LEAVES = new Set([
  'amount', 'balance', 'startDate', 'endDate', 'frequency', 'monthlyPayment', 'unpaidBalance',
  'type', 'occupancy', 'street', 'city', 'state', 'postalCode', 'ownershipPct', 'description',
])

const humanizeLeaf = (leaf) => leaf
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/^is /, '')
  .toLowerCase()

export function chipLabel(path, locale = 'en') {
  const def = getField(path)
  if (!def) return String(path)
  const leaf = String(path).split('.').pop().replace(/\[\d+\]/g, '')
  const noun = (SECTION_NOUN[def.section] || {})[locale] || (SECTION_NOUN[def.section] || {}).en || ''
  const human = humanizeLeaf(leaf)
  if (GENERIC_LEAVES.has(leaf) && noun) return `${noun} ${human}`
  return human
}

export const SECTIONS = Object.freeze([
  'identity', 'residence', 'employment', 'income', 'loan', 'assets', 'liabilities',
  'reo', 'declarations', 'demographics', 'supplemental',
])

// Borrower-facing section names for the review view (§18).
export const SECTION_LABELS = Object.freeze({
  identity: L('About You', 'Sobre usted', 'О вас'),
  residence: L('Where You Live', 'Dónde vive', 'Где вы живёте'),
  employment: L('Employment', 'Empleo', 'Работа'),
  income: L('Income', 'Ingresos', 'Доход'),
  loan: L('Property and Loan', 'Propiedad y préstamo', 'Недвижимость и кредит'),
  assets: L('Assets', 'Activos', 'Активы'),
  liabilities: L('Debts', 'Deudas', 'Долги'),
  reo: L('Real Estate You Own', 'Bienes raíces que posee', 'Ваша недвижимость'),
  declarations: L('Declarations', 'Declaraciones', 'Декларации'),
  demographics: L('Optional Information', 'Información opcional', 'Дополнительная информация'),
  supplemental: L('Optional Information', 'Información opcional', 'Дополнительная информация'),
})

// Fields that may NEVER be written from conversational text.
export const SECURE_FIELDS = Object.freeze(CATALOG.filter((d) => d.secureEntry).map((d) => d.path))
// Fields the model may never infer, even when the borrower volunteers something adjacent.
export const AI_INFERENCE_FORBIDDEN = Object.freeze(
  CATALOG.filter((d) => d.aiInferenceForbidden).map((d) => d.path),
)

export const CATALOG_META = Object.freeze({
  schemaVersion: APPLICATION_SCHEMA_VERSION,
  catalogVersion: CATALOG_VERSION,
  fieldCount: CATALOG.length,
  sections: SECTIONS,
})
