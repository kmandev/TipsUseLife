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
 * @property {string|null} post_permalink  value.post.permalink_url when Meta sends it
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
        // Kept exactly as Meta sent it (no trimming, no fallback to another
        // field): index.js compares it strictly against the configured Page.
        page_id: typeof entry.id === "string" || typeof entry.id === "number" ? String(entry.id) : "",
        comment_id: commentId,
        post_id: str(value.post_id),
        parent_id: str(value.parent_id),
        author_id: str(value.from?.id),
        author_name: str(value.from?.name),
        comment_text: commentText,
        created_time: isoTime(value.created_time),
        post_permalink: safePermalink(value.post?.permalink_url),
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
 * Keep a Facebook permalink only if it really is one. It is display-only
 * (Dashboard "open post" link) and never sent to the AI or appended to a
 * reply, but it still comes from the network, so it is checked.
 */
function safePermalink(value) {
  const s = str(value);
  if (!s || s.length > 500) return null;
  try {
    const url = new URL(s);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    return host === "facebook.com" || host.endsWith(".facebook.com") ? s : null;
  } catch {
    return null;
  }
}

/**
 * Which comment id a public reply should be posted under.
 *
 * Facebook threads are one level deep: a reply to a reply belongs to the
 * top-level comment's thread. For a nested reply the webhook's `parent_id`
 * is that top-level comment; for a top-level comment `parent_id` is the
 * post itself. Replying to the top-level comment is valid in both cases.
 *
 * @param {NormalizedComment} event
 */
export function replyTargetId(event) {
  const parent = event?.parent_id;
  if (parent && parent !== event.post_id) return parent;
  return event.comment_id;
}
