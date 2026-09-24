// The message the borrower gets after their upload has been read.
//
// This is the piece that removes the loan officer from routine iterations. The expensive loop
// today is: borrower uploads → someone reads it → someone notices page 6 is missing → someone
// calls → borrower uploads page 6 → someone reads it again. Every arrow but the first and last
// is a person's afternoon. Here the read is automatic and this module writes the ask.
//
// ── Why this is deterministic and not a model ───────────────────────────────
// A model writing free text to a borrower is a model that can, on a bad day, reassure them, give
// a number, guess at a missing month, or characterize their file. None of those are recoverable
// once sent. Every sentence here is either composed from a count, or carried VERBATIM from
// completeness.js, which is a pure function over what was actually received. The most this
// module can do wrong is be unhelpful.
//
// ── What it cannot say ──────────────────────────────────────────────────────
// It reads `borrowerView(tasks)` and nothing else. Findings are never borrower-owned, so they
// are not in its input — not filtered out of its output, absent from its input. That is the
// same structural guarantee fileTasks.js makes, relied on rather than re-implemented.
//
// ── When it stays quiet ─────────────────────────────────────────────────────
// Silence is the default. A borrower who gets a message every time a background job runs stops
// reading them, and the one that mattered is the one they skipped. So: nothing is sent unless
// the outstanding set actually CHANGED since the last thing we said.

import { borrowerView } from './fileTasks.js'

// More than this and the message becomes a wall nobody finishes. The rest are on their screen,
// which the message links to.
const MAX_ITEMS = 5

/**
 * Compose at most one follow-up.
 *
 * @param {object} input
 * @param {Array}  input.tasks        the file's full task list (buildFileTasks().tasks)
 * @param {string} [input.justRead]   label of the document that was just read, if any
 * @param {string} [input.lastMessage] body of the last follow-up sent on this file
 * @param {boolean} [input.readFailed] the read could not be completed
 * @returns {{send: boolean, reason: string, body: string|null, outstanding: number}}
 */
export function composeFollowUp(input = {}) {
  const { tasks = [], justRead = null, lastMessage = null, readFailed = false } = input
  const mine = borrowerView(tasks)
  const body = compose(mine, { justRead, readFailed })

  if (!body) return { send: false, reason: 'nothing_to_say', body: null, outstanding: mine.length }
  // The same ask twice is the fastest way to teach someone to ignore the channel. If nothing
  // changed, the borrower already has this message.
  if (lastMessage && normalize(lastMessage) === normalize(body)) {
    return { send: false, reason: 'unchanged', body: null, outstanding: mine.length }
  }
  return { send: true, reason: 'outstanding_changed', body, outstanding: mine.length }
}

function compose(mine, { justRead, readFailed }) {
  const lines = []

  if (readFailed) {
    // Honest about the failure without blaming the borrower or guessing at the cause: we do not
    // know whether it was their scan or our reader, and saying either would be inventing.
    lines.push(justRead
      ? `We received your ${justRead}, but we could not read it. Someone from our team will take a look — you do not need to do anything with it right now.`
      : 'We received your upload but could not read it. Someone from our team will take a look.')
  } else if (justRead) {
    lines.push(`Thanks — we have read your ${justRead}.`)
  }

  if (mine.length === 0) {
    // Only worth saying at all if we just did something. "You have nothing to do" out of the
    // blue is noise; after an upload it is the answer to the question they just asked.
    if (!justRead) return null
    lines.push('That is everything we need from you right now. We will be in touch if anything else comes up.')
    return lines.join('\n\n')
  }

  const shown = mine.slice(0, MAX_ITEMS)
  const rest = mine.length - shown.length

  lines.push(mine.length === 1
    ? 'One thing is still outstanding:'
    : `${mine.length} things are still outstanding:`)

  for (const t of shown) {
    // A document task carries its own sentences, already phrased as a request and already
    // specific about the page or the month. Those are the best words available and rewriting
    // them here would be a second voice for the same fact.
    const asks = (t.requests || []).filter(Boolean)
    lines.push(asks.length ? asks.map((a) => `• ${a}`).join('\n') : `• ${t.title}`)
  }

  if (rest > 0) lines.push(`…and ${rest} more on your checklist.`)
  lines.push('You can add anything missing from your portal whenever it suits you.')
  return lines.join('\n\n')
}

// Whitespace is not meaning. Two messages that differ only in how they wrapped are the same ask.
const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim()

export { MAX_ITEMS }
