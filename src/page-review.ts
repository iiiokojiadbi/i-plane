import { UsageError } from "./args.ts";

export interface Review {
  date: string;
  source: string;
}

export const validReviewDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export const parseReview = (text: string): Review => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError("A knowledge-review fence expects JSON with date and source strings.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UsageError("A knowledge-review fence expects a JSON object.");
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !["date", "source"].includes(key)))
    throw new UsageError(
      "A knowledge-review fence supports only date and source; unknown fields would be lost.",
    );
  if (typeof fields.date !== "string" || !validReviewDate(fields.date))
    throw new UsageError(
      "A knowledge-review date must be a valid calendar date in YYYY-MM-DD format.",
    );
  if (typeof fields.source !== "string" || !fields.source.trim())
    throw new UsageError("A knowledge-review source must be a nonempty string.");
  return { date: fields.date, source: fields.source };
};

const escapeReviewHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const reviewHtml = (review: Review): string =>
  `<div data-knowledge-review data-reviewed-at="${escapeReviewHtml(review.date)}" data-source="${escapeReviewHtml(review.source)}">Reviewed ${escapeReviewHtml(review.date)}: ${escapeReviewHtml(review.source)}</div>`;

export const reviewCodeHtml = (review: Review): string =>
  `<pre><code class="language-knowledge-review">${escapeReviewHtml(JSON.stringify(review, null, 2))}</code></pre>`;
