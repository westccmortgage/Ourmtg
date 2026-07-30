# Conversational 1003 — Field Coverage

Catalog version `2026.07.1003.1` · 109 fields · generated from `src/features/conversational-1003/applicationCatalog.js`.

**This is not complete URLA or MISMO coverage, and this document does not claim it is.** Per the
MVP brief (§5), coverage is only asserted for fields that are actually mapped, validated, and
exercised by tests. Everything else is listed as planned or excluded.

## Coverage classes

| Class | Count | Meaning |
|---|---|---|
| implemented | 66 | Always applicable; captured, normalized, and validated |
| conditionally implemented | 34 | Required only when a named, unit-tested rule fires |
| secure-entry-only | 3 | Never conversational; masked control + server validation (`ssn`, two `accountNumber`) |
| team-confirmed | 2 | Derived or verification-bearing; the loan team confirms (`monthlyEquivalent`, declaration `explanation`) |
| controlled-selection | 4 | AI inference forbidden; borrower selects directly (3 demographic + language preference) |
| **not yet mapped (ULAD/MISMO)** | **15** | Field is captured and validated, but we do not assert an official ULAD/MISMO term |

The 15 "not yet mapped" fields are captured and usable, but their ULAD/MISMO term names are
**not asserted** because we were not confident of the exact official identifier. They appear in
the tables below as **not yet mapped**. Resolving them is a prerequisite for any claim of ULAD
conformance — see *Not yet mapped* below.

## Excluded from MVP

These are deliberately out of scope for this phase and are **not** in the catalog:

| Area | Why excluded |
|---|---|
| Military service detail (§7 URLA military questions) | Needs the full VA question set + eligibility wording; not attempted rather than half-modeled |
| Non-borrower household income (§1e optional) | Program-specific; adds a party type the schema does not yet model |
| Trust / power-of-attorney vesting detail | Escrow and title own the controlling wording |
| Gift donor identity and contact detail | Requires the gift-letter workflow, which is a document flow, not an interview flow |
| Rental income schedules per REO unit (2–4 unit breakdowns) | Needs per-unit modeling; single aggregate rent captured instead |
| Asset "other" free-form subtypes | Deliberately constrained to the enum until underwriting confirms the list |
| Counseling / education program disclosures | Program-specific; not applicable to every loan |
| SCIF / Form 1103 supplemental consumer information | **Planned** — the language-preference field is modeled and kept structurally separate from demographics; the full 1103 workflow is not built |
| Full 2–4 unit property income analysis, construction/renovation loans, reverse mortgages | Out of scope for this MVP |

## Planned (next phase)

- Resolve the 15 unmapped ULAD/MISMO identifiers against the official ULAD mapping document.
- SCIF / Form 1103 as its own versioned section (see §6.L).
- Military service questions.
- Per-unit REO rental detail.

---

## Field tables

Legend: **Required** is `yes` (unconditional), `when <rule>` (conditional — the rule is defined
and unit-tested in `applicationRules.js`), or `optional`.


### identity (13 fields)

| Field path | Type | Required | Coverage | URLA | ULAD / MISMO |
|---|---|---|---|---|---|
| `parties[].legalFirstName` | name | yes | implemented | 1a | BorrowerFirstName / FirstName |
| `parties[].legalMiddleName` | name | optional | implemented | 1a | BorrowerMiddleName / MiddleName |
| `parties[].legalLastName` | name | yes | implemented | 1a | BorrowerLastName / LastName |
| `parties[].suffix` | text | optional | implemented | 1a | BorrowerSuffixName / SuffixName |
| `parties[].alternateNames` | longtext | when `alternateNamesApply` | conditionally implemented | 1a | BorrowerAlternateName / AlternateName |
| `parties[].email` | email | yes | implemented | 1a | BorrowerEmailAddress / EmailAddress |
| `parties[].phone` | phone | yes | implemented | 1a | BorrowerMobilePhoneNumber / PhoneNumber |
| `parties[].dateOfBirth` | date | yes | implemented | 1a | BorrowerBirthDate / BirthDate |
| `parties[].ssn` | ssn | yes | secure-entry-only | 1a | BorrowerSSNIdentifier / TaxpayerIdentifierValue |
| `parties[].citizenshipStatus` | enum | yes | implemented | 1a | CitizenshipResidencyType / CitizenshipResidencyType |
| `parties[].maritalStatus` | enum | yes | implemented | 1a | MaritalStatusType / MaritalStatusType |
| `parties[].dependentsCount` | integer | yes | implemented | 1a | DependentCount / DependentCount |
| `parties[].dependentsAges` | text | when `hasDependents` | conditionally implemented | 1a | DependentAgeYears / DependentAgeYears |

### residence (12 fields)

| Field path | Type | Required | Coverage | URLA | ULAD / MISMO |
|---|---|---|---|---|---|
| `parties[].residence[].street` | address | yes | implemented | 1b | AddressLineText / AddressLineText |
| `parties[].residence[].unit` | text | optional | implemented | 1b | AddressUnitIdentifier / AddressUnitIdentifier |
| `parties[].residence[].city` | text | yes | implemented | 1b | CityName / CityName |
| `parties[].residence[].state` | text | yes | implemented | 1b | StateCode / StateCode |
| `parties[].residence[].postalCode` | text | yes | implemented | 1b | PostalCode / PostalCode |
| `parties[].residence[].isCurrent` | boolean | yes | implemented | 1b | BorrowerResidencyType / BorrowerResidencyType |
| `parties[].residence[].startDate` | month | yes | implemented | 1b | BorrowerResidencyStartDate / ResidencyStartDate |
| `parties[].residence[].endDate` | month | when `residenceIsPrevious` | conditionally implemented | 1b | BorrowerResidencyEndDate / ResidencyEndDate |
| `parties[].residence[].occupancyBasis` | enum | yes | implemented | 1b | BorrowerResidencyBasisType / BorrowerResidencyBasisType |
| `parties[].residence[].monthlyHousingExpense` | amount | when `housingExpenseApplies` | conditionally implemented | 1b | BorrowerResidenceMonthlyRentAmount / MonthlyRentAmount |
| `parties[].mailingAddressSameAsCurrent` | boolean | yes | implemented | 1b | BorrowerMailingAddressIndicator / — |
| `parties[].mailingAddress` | address | when `mailingAddressDiffers` | conditionally implemented | 1b | MailingAddressLineText / AddressLineText |

### employment (14 fields)

| Field path | Type | Required | Coverage | URLA | ULAD / MISMO |
|---|---|---|---|---|---|
| `parties[].employment[].employerName` | text | yes | implemented | 1c | EmployerName / FullName |
| `parties[].employment[].position` | text | yes | implemented | 1c | EmploymentPositionDescription / EmploymentPositionDescription |
| `parties[].employment[].isCurrent` | boolean | yes | implemented | 1c | EmploymentStatusType / EmploymentStatusType |
| `parties[].employment[].startDate` | month | yes | implemented | 1c | EmploymentStartDate / EmploymentStartDate |
| `parties[].employment[].endDate` | month | when `employmentIsPrevious` | conditionally implemented | 1d | EmploymentEndDate / EmploymentEndDate |
| `parties[].employment[].employmentType` | enum | yes | implemented | 1c | EmploymentClassificationType / EmploymentClassificationType |
| `parties[].employment[].employerStreet` | address | when `employerAddressRequired` | conditionally implemented | 1c | EmployerAddressLineText / AddressLineText |
| `parties[].employment[].employerCity` | text | when `employerAddressRequired` | conditionally implemented | 1c | EmployerCityName / CityName |
| `parties[].employment[].employerState` | text | when `employerAddressRequired` | conditionally implemented | 1c | EmployerStateCode / StateCode |
| `parties[].employment[].employerPostalCode` | text | when `employerAddressRequired` | conditionally implemented | 1c | EmployerPostalCode / PostalCode |
| `parties[].employment[].employerPhone` | phone | optional | implemented | 1c | EmployerPhoneNumber / PhoneNumber |
| `parties[].employment[].isSelfEmployedOwner` | boolean | when `employmentIsSelfEmployed` | conditionally implemented | 1c | EmploymentBorrowerSelfEmployedIndicator / SelfEmployedIndicator |
| `parties[].employment[].ownershipPct` | percent | when `employmentIsSelfEmployed` | conditionally implemented | 1c | EmploymentOwnershipInterestType / OwnershipInterestType |
| `parties[].employment[].businessStartDate` | month | when `employmentIsSelfEmployed` | conditionally implemented | 1c | **not yet mapped** |

### income (7 fields)

| Field path | Type | Required | Coverage | URLA | ULAD / MISMO |
|---|---|---|---|---|---|
| `parties[].income[].incomeType` | enum | yes | implemented | 1e | IncomeType / IncomeType |
| `parties[].income[].amount` | amount | yes | implemented | 1e | IncomeAmount / CurrentIncomeMonthlyTotalAmount |
| `parties[].income[].frequency` | frequency | yes | implemented | 1e | IncomePayFrequencyType / PayFrequencyType |
| `parties[].income[].hoursPerWeek` | integer | when `incomeIsHourly` | conditionally implemented | 1e | **not yet mapped** |
| `parties[].income[].employmentIndex` | integer | when `incomeIsEmploymentLinked` | conditionally implemented | 1e | **not yet mapped** |
| `parties[].income[].description` | text | when `incomeIsOther` | conditionally implemented | 1e | IncomeTypeOtherDescription / IncomeTypeOtherDescription |
| `parties[].income[].monthlyEquivalent` | amount | optional | team-confirmed | 1e | **not yet mapped** |

### loan (19 fields)

| Field path | Type | Required | Coverage | URLA | ULAD / MISMO |
|---|---|---|---|---|---|
| `loan.purpose` | enum | yes | implemented | 4a | LoanPurposeType / LoanPurposeType |
| `loan.occupancy` | enum | yes | implemented | 4a | PropertyUsageType / PropertyUsageType |
| `loan.propertyStreet` | address | when `propertyAddressKnown` | conditionally implemented | 4a | PropertyAddressLineText / AddressLineText |
| `loan.propertyCity` | text | when `propertyAddressKnown` | conditionally implemented | 4a | PropertyCityName / CityName |
| `loan.propertyState` | text | when `propertyAddressKnown` | conditionally implemented | 4a | PropertyStateCode / StateCode |
| `loan.propertyPostalCode` | text | when `propertyAddressKnown` | conditionally implemented | 4a | PropertyPostalCode / PostalCode |
| `loan.propertyType` | enum | yes | implemented | 4a | AttachmentType / PropertyType |
| `loan.purchasePrice` | amount | when `loanIsPurchase` | conditionally implemented | 4a | PurchasePriceAmount / PurchasePriceAmount |
| `loan.estimatedPropertyValue` | amount | when `loanIsRefinance` | conditionally implemented | 4a | PropertyEstimatedValueAmount / PropertyEstimatedValueAmount |
| `loan.requestedLoanAmount` | amount | yes | implemented | 4a | LoanAmount / BaseLoanAmount |
| `loan.downPaymentAmount` | amount | when `loanIsPurchase` | conditionally implemented | 4a | DownPaymentAmount / DownPaymentAmount |
| `loan.downPaymentSource` | enum | when `loanIsPurchase` | conditionally implemented | 4a | DownPaymentSourceType / FundsSourceType |
| `loan.refinancePurpose` | enum | when `loanIsRefinance` | conditionally implemented | 4a | RefinanceCashOutDeterminationType / RefinanceCashOutDeterminationType |
| `loan.existingLoanBalance` | amount | when `loanIsRefinance` | conditionally implemented | 4a | — / UPBAmount |
| `loan.cashOutAmount` | amount | when `refinanceIsCashOut` | conditionally implemented | 4a | CashOutAmount / CashOutAmount |
| `loan.isUnderContract` | boolean | when `loanIsPurchase` | conditionally implemented | 4a | **not yet mapped** |
| `loan.estimatedClosingDate` | date | optional | implemented | 4a | **not yet mapped** |
| `loan.titleVestingIntent` | text | when `titleVestingApplies` | conditionally implemented | 4a | **not yet mapped** |
| `loan.mixedUseProperty` | boolean | yes | implemented | 5 | PropertyMixedUsageIndicator / PropertyMixedUsageIndicator |

### assets (6 fields)

| Field path | Type | Required | Coverage | URLA | ULAD / MISMO |
|---|---|---|---|---|---|
| `parties[].assets[].assetType` | enum | yes | implemented | 2a | AssetType / AssetType |
| `parties[].assets[].institutionName` | text | when `assetNeedsInstitution` | conditionally implemented | 2a | AssetFinancialInstitutionName / FullName |
| `parties[].assets[].accountNumber` | account_number | when `assetNeedsInstitution` | secure-entry-only | 2a | AssetAccountIdentifier / AccountIdentifier |
| `parties[].assets[].balance` | amount | yes | implemented | 2a | AssetCashOrMarketValueAmount / AssetCashOrMarketValueAmount |
| `parties[].assets[].giftSource` | enum | when `assetIsGiftOrGrant` | conditionally implemented | 2b | FundsSourceType / FundsSourceType |
| `parties[].assets[].isDeposited` | boolean | when `assetIsGiftOrGrant` | conditionally implemented | 2b | AssetDepositIndicator / — |

### liabilities (7 fields)

| Field path | Type | Required | Coverage | URLA | ULAD / MISMO |
|---|---|---|---|---|---|
| `parties[].hasAnyLiabilities` | boolean | yes | implemented | 2c | **not yet mapped** |
| `parties[].liabilities[].liabilityType` | enum | yes | implemented | 2c | LiabilityType / LiabilityType |
| `parties[].liabilities[].creditorName` | text | yes | implemented | 2c | LiabilityHolderName / FullName |
| `parties[].liabilities[].monthlyPayment` | amount | yes | implemented | 2c | LiabilityMonthlyPaymentAmount / LiabilityMonthlyPaymentAmount |
| `parties[].liabilities[].unpaidBalance` | amount | yes | implemented | 2c | LiabilityUnpaidBalanceAmount / LiabilityUnpaidBalanceAmount |
| `parties[].liabilities[].accountNumber` | account_number | optional | secure-entry-only | 2c | LiabilityAccountIdentifier / AccountIdentifier |
| `parties[].liabilities[].toBePaidOffAtClosing` | boolean | yes | implemented | 2c | LiabilityPayoffStatusIndicator / LiabilityPayoffStatusIndicator |

### reo (10 fields)

| Field path | Type | Required | Coverage | URLA | ULAD / MISMO |
|---|---|---|---|---|---|
| `parties[].ownsOtherRealEstate` | boolean | yes | implemented | 3 | **not yet mapped** |
| `parties[].reo[].propertyAddress` | address | yes | implemented | 3a | AddressLineText / AddressLineText |
| `parties[].reo[].propertyValue` | amount | yes | implemented | 3a | REOPropertyValueAmount / PropertyEstimatedValueAmount |
| `parties[].reo[].mortgageBalance` | amount | yes | implemented | 3a | REOMortgageUnpaidBalanceAmount / UPBAmount |
| `parties[].reo[].monthlyPayment` | amount | yes | implemented | 3a | REOMortgagePaymentAmount / LiabilityMonthlyPaymentAmount |
| `parties[].reo[].monthlyTaxesInsuranceHoa` | amount | yes | implemented | 3a | REOMaintenanceExpenseAmount / — |
| `parties[].reo[].occupancy` | enum | yes | implemented | 3a | REOPropertyUsageType / PropertyUsageType |
| `parties[].reo[].monthlyRentalIncome` | amount | when `reoIsRental` | conditionally implemented | 3a | REORentalIncomeGrossAmount / RentalIncomeGrossAmount |
| `parties[].reo[].dispositionIntent` | enum | yes | implemented | 3a | REODispositionStatusType / DispositionStatusType |
| `parties[].reo[].ownershipPct` | percent | optional | implemented | 3a | **not yet mapped** |

### declarations (17 fields)

| Field path | Type | Required | Coverage | URLA | ULAD / MISMO |
|---|---|---|---|---|---|
| `parties[].declarations.occupyAsPrimaryResidence` | boolean | yes | implemented | 5a.A | IntentToOccupyIndicator / IntentToOccupyType |
| `parties[].declarations.ownershipInterestPastThreeYears` | boolean | yes | implemented | 5a.B | HomeownerPastThreeYearsIndicator / HomeownerPastThreeYearsType |
| `parties[].declarations.familyRelationshipWithSeller` | boolean | yes | implemented | 5a.C | SpecialBorrowerSellerRelationshipIndicator / SpecialBorrowerSellerRelationshipIndicator |
| `parties[].declarations.borrowingOtherMoney` | boolean | yes | implemented | 5a.D1 | UndisclosedBorrowedFundsIndicator / UndisclosedBorrowedFundsIndicator |
| `parties[].declarations.applyingOtherMortgage` | boolean | yes | implemented | 5a.D2 | UndisclosedMortgageApplicationIndicator / UndisclosedMortgageApplicationIndicator |
| `parties[].declarations.applyingNewCredit` | boolean | yes | implemented | 5a.D3 | UndisclosedCreditApplicationIndicator / UndisclosedCreditApplicationIndicator |
| `parties[].declarations.propertySubjectToLien` | boolean | yes | implemented | 5a.D4 | PropertyProposedCleanEnergyLienIndicator / PropertyProposedCleanEnergyLienIndicator |
| `parties[].declarations.coSignerOrGuarantor` | boolean | yes | implemented | 5b.E | UndisclosedComakerOfNoteIndicator / UndisclosedComakerOfNoteIndicator |
| `parties[].declarations.outstandingJudgments` | boolean | yes | implemented | 5b.F | OutstandingJudgmentsIndicator / OutstandingJudgmentsIndicator |
| `parties[].declarations.delinquentFederalDebt` | boolean | yes | implemented | 5b.G | PresentlyDelinquentIndicator / PresentlyDelinquentIndicator |
| `parties[].declarations.partyToLawsuit` | boolean | yes | implemented | 5b.H | PartyToLawsuitIndicator / PartyToLawsuitIndicator |
| `parties[].declarations.conveyedTitleInLieu` | boolean | yes | implemented | 5b.I | PriorPropertyDeedInLieuConveyedIndicator / PriorPropertyDeedInLieuConveyedIndicator |
| `parties[].declarations.preForeclosureShortSale` | boolean | yes | implemented | 5b.J | PriorPropertyShortSaleCompletedIndicator / PriorPropertyShortSaleCompletedIndicator |
| `parties[].declarations.propertyForeclosed` | boolean | yes | implemented | 5b.K | PriorPropertyForeclosureCompletedIndicator / PriorPropertyForeclosureCompletedIndicator |
| `parties[].declarations.declaredBankruptcy` | boolean | yes | implemented | 5b.L | BankruptcyIndicator / BankruptcyIndicator |
| `parties[].declarations.bankruptcyType` | enum | when `declaredBankruptcy` | conditionally implemented | 5b.L | BankruptcyType / BankruptcyType |
| `parties[].declarations.explanation` | longtext | when `declarationNeedsExplanation` | team-confirmed | 5b | **not yet mapped** |

### demographics (3 fields)

| Field path | Type | Required | Coverage | URLA | ULAD / MISMO |
|---|---|---|---|---|---|
| `parties[].demographics.ethnicity` | enum | optional | controlled-selection | 7 | **not yet mapped** |
| `parties[].demographics.race` | enum | optional | controlled-selection | 7 | **not yet mapped** |
| `parties[].demographics.sex` | enum | optional | controlled-selection | 7 | **not yet mapped** |

### supplemental (1 fields)

| Field path | Type | Required | Coverage | URLA | ULAD / MISMO |
|---|---|---|---|---|---|
| `parties[].languagePreference` | enum | optional | controlled-selection | LPA | **not yet mapped** |

---

## Not yet mapped

The following fields are captured and validated but carry **no asserted ULAD/MISMO term**. They
are either OurMTG-internal (interview mechanics, section gates) or fields whose official
identifier we did not want to guess:

- Section gates and interview mechanics: `hasAnyLiabilities`, `ownsOtherRealEstate`,
  `mailingAddressSameAsCurrent`, `isUnderContract`, `estimatedClosingDate`, `titleVestingIntent`
- Income mechanics: `hoursPerWeek`, `employmentIndex`, `monthlyEquivalent`
- Employment: `businessStartDate`
- REO: `monthlyTaxesInsuranceHoa`, `ownershipPct`
- Declarations: `explanation`
- Demographics and language preference (URLA §7 / LPA — the *values* are official; we do not
  assert a MISMO container name here)

**Do not represent this catalog as ULAD- or MISMO-conformant until these are resolved and
tested against the official specification.**
