/**
 * Facebook Page "feed" webhook payload handling.
 *
 * Only `item === "comment"` with `verb === "add"` is actionable. Every
 * other change (posts, reactions, shares, edits, removals, hides) is
 * ignored -- we never want to draft a reply for an edit or a deletion.
 */

const ACTIONABLE_ITEM = "comment";
const ACTIONABLE_VERB = "add";

/**
 * @typedef {Object} NormalizedComment
 * @property {string} page_id
 * @property {string} comment_id
 * @property {string|null} post_id
 * @property {string|null} parent_id
 * @property {string|null} author_id
 * @property {string|null} author_name
 * @property {string} comment_text
 * @property {string|null} created_time
 */

function str(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function isoTime(value) {
  if (value === null || value === undefined) return null;
  // Meta sends a unix timestamp (seconds) on feed changes.
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && String(value).trim() !== "") {
    return new Date(asNumber * 1000).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Extract every actionable comment event from a verified Meta payload.
 * Malformed entries are skipped rather than throwing, so one bad change
 * never drops a whole webhook delivery.
 *
 * @param {any} payload
 * @returns {NormalizedComment[]}
 */
export function extractCommentEvents(payload) {
  const events = [];

  if (!payload || payload.object !== "page" || !Array.isArray(payload.entry)) {
    return events;
  }

  for (const entry of payload.entry) {
    if (!entry || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (!change || change.field !== "feed") continue;

      const value = change.value;
      if (!value || typeof value !== "object") continue;
      if (value.item !== ACTIONABLE_ITEM) continue;
      if (value.verb !== ACTIONABLE_VERB) continue;

      const commentId = str(value.comment_id);
      const commentText = value.message === undefined || value.message === null
        ? null
        : String(value.message);

      // A comment with no id cannot be deduplicated or replied to.
      // A comment with no message (sticker / photo only) has nothing for
      // the model to work with. Both are dropped as unsupported.
      if (!commentId) continue;
      if (!commentText || !commentText.trim()) continue;

      events.push({
        page_id: str(entry.id) || str(value.page_id) || "",
        comment_id: commentId,
        post_id: str(value.post_id),
        parent_id: str(value.parent_id),
        author_id: str(value.from?.id),
        author_name: str(value.from?.name),
        comment_text: commentText,
        created_time: isoTime(value.created_time),
      });
    }
  }

  return events;
}

/**
 * SELF-REPLY LOOP PROTECTION.
 *
 * Any event whose author is our own Page is a comment or reply that we
 * (or a Page admin posting as the Page) created. Reacting to it would
 * produce an infinite Page -> webhook -> Page loop.
 *
 * @param {NormalizedComment} event
 * @param {string} pageId
 */
export function isSelfEvent(event, pageId) {
  if (!event) return true;
  const ourPage = String(pageId || "").trim();
  if (!ourPage) return true; // fail closed: unknown page id => treat as self

  if (event.author_id && String(event.author_id) === ourPage) return true;
  return false;
}

/**
 * Build the normalized payload forwarded to Hermes. Deliberately a
 * *subset* of the Meta payload: no signatures, no tokens, no raw envelope.
 *
 * @param {NormalizedComment} event
 * @param {{mode: string, matchedProduct: any}} context
 */
export function buildHermesPayload(event, { mode, matchedProduct }) {
  return {
    source: "facebook",
    event: "page_comment",
    page_id: event.page_id,
    comment_id: event.comment_id,
    post_id: event.post_id,
    parent_id: event.parent_id,
    author_id: event.author_id,
    author_name: event.author_name,
    comment_text: event.comment_text,
    created_time: event.created_time,
    mode,
    // Trusted product context. If this is null the agent MUST NOT invent
    // any product fact (price, stock, link, shipping, warranty, specs).
    product: matchedProduct
      ? {
          id: matchedProduct.id,
          name: matchedProduct.name,
          description: matchedProduct.description ?? null,
          shopee_url: matchedProduct.shopee_url ?? null,
        }
      : null,
  };
}
