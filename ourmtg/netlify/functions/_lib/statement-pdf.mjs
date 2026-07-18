import pdfParseImport from 'pdf-parse/lib/pdf-parse.js'
import { extractStatementSummary } from './statement-income.mjs'

const pdfParse = pdfParseImport?.default || pdfParseImport

async function pageText(pageData) {
  const content = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false })
  return (content.items || []).map((item) => item.str || '').join(' ')
}

// A single upload may contain one 12/24-month PDF package. Read page-by-page, then
// collapse continuation pages into one row per statement month for that document.
export async function extractPdfStatementSummaries(buffer) {
  const pages = []
  const parsed = await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const text = await pageText(pageData)
      pages.push(text)
      return text
    },
  })
  const sources = pages.length ? pages : [parsed?.text || '']
  const byMonth = new Map()
  const unresolved = []
  for (const text of sources) {
    const summary = extractStatementSummary(text)
    if (!summary.statementMonth) {
      if (summary.totalDeposits != null) unresolved.push(summary)
      continue
    }
    const previous = byMonth.get(summary.statementMonth)
    if (!previous || (previous.totalDeposits == null && summary.totalDeposits != null)) {
      byMonth.set(summary.statementMonth, summary)
    }
  }
  const resolved = [...byMonth.values()].sort((a, b) => a.statementMonth.localeCompare(b.statementMonth))
  if (resolved.length) return resolved
  if (unresolved.length) return unresolved
  return [{ statementMonth: null, totalDeposits: null, extractionStatus: 'unreadable' }]
}
