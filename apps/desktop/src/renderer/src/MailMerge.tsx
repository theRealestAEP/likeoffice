/**
 * The Mailings bar: pick a data source, preview the letter one record at a
 * time, step through the records.
 *
 * Preview is a VIEW, not an edit. The engine substitutes each record's values
 * as it lays the pages out and writes nothing, so stepping records makes no
 * undo entry, marks nothing dirty, and cannot put a merged value in the saved
 * file. That is why this bar owns the whole feature: there is no document state
 * to keep in step with it.
 *
 * The bar states its own limits rather than failing quietly. A label or
 * directory template repeats a block separated by NEXT; without NEXT every
 * label on the sheet would show record 1, which looks like a working merge and
 * is not one. Saying so beats printing forty identical labels.
 */
import { useEffect, useMemo, useState } from "react";
import type { DocxViewApi } from "wordinweb";

/** What this build does NOT do, in the words a user would use. Rendered in the
 * bar, so the scope is visible where the feature is, not in a release note. */
const UNSUPPORTED =
  "Letters and envelopes only. Labels and directories need the NEXT field, " +
  "which this build does not run — every label would repeat the first record. " +
  "IF conditional text, MERGESEQ, Address Block, Greeting Line and " +
  "Finish & Merge are not available yet. CSV and tab-separated files only.";

export function MailMerge({
  api,
  open,
  source,
  onSourceChange,
  index: at,
  onIndexChange,
  preview,
  onPreviewChange,
}: {
  api: DocxViewApi;
  open: boolean;
  source: MergeDataSource | null;
  onSourceChange: (source: MergeDataSource | null) => void;
  /** Already clamped by the app, which paints the record at this index. */
  index: number;
  onIndexChange: (index: number) => void;
  preview: boolean;
  onPreviewChange: (preview: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [fieldNames, setFieldNames] = useState<string[]>([]);

  // The document's merge fields, refreshed whenever the bar opens: a field
  // inserted while the bar was closed must appear in the unmatched note.
  useEffect(() => {
    if (!open) return;
    setFieldNames(api.listMergeFieldNames());
  }, [api, open]);

  /**
   * Fields the data does not supply. These keep their «Name» placeholder in
   * preview instead of rendering blank — a deliberate difference from Word, so
   * an unbound field is something the user SEES rather than a hole in a letter
   * that already went out.
   */
  const unmatched = useMemo(() => {
    if (!source) return [];
    const columns = new Set(source.headers);
    return fieldNames.filter((name) => !columns.has(name));
  }, [fieldNames, source]);

  if (!open) return null;

  const total = source?.records.length ?? 0;

  const choose = async () => {
    setLoading(true);
    try {
      const picked = await window.likeoffice.openMergeDataSource();
      if (!picked) return;
      onSourceChange(picked);
      onIndexChange(0);
      onPreviewChange(true);
    } finally {
      setLoading(false);
    }
  };

  const step = (to: number) => onIndexChange(Math.max(0, Math.min(total - 1, to)));

  return (
    <div className="mailmerge-bar" data-testid="mailmerge-bar">
      <div className="mailmerge-row">
        <span className="mailmerge-label">Mailings</span>

        <button
          className="mailmerge-btn"
          data-testid="mailmerge-choose"
          onClick={() => void choose()}
          disabled={loading}
        >
          {source ? "Change data source…" : "Select data source…"}
        </button>

        {source && (
          <>
            <span className="mailmerge-source" data-testid="mailmerge-source" title={source.path}>
              {source.name} · {total} {total === 1 ? "record" : "records"}
            </span>
            <button
              className="mailmerge-btn"
              data-testid="mailmerge-clear"
              onClick={() => {
                onSourceChange(null);
                onPreviewChange(false);
              }}
            >
              Remove
            </button>

            <label className="mailmerge-toggle">
              <input
                type="checkbox"
                data-testid="mailmerge-preview"
                checked={preview}
                onChange={(e) => onPreviewChange(e.target.checked)}
              />
              Preview results
            </label>

            <span className="mailmerge-stepper">
              <button
                className="mailmerge-step"
                data-testid="mailmerge-first"
                onClick={() => step(0)}
                disabled={!preview || at === 0}
                title="First record"
              >
                |◀
              </button>
              <button
                className="mailmerge-step"
                data-testid="mailmerge-prev"
                onClick={() => step(at - 1)}
                disabled={!preview || at === 0}
                title="Previous record"
              >
                ◀
              </button>
              <span className="mailmerge-count" data-testid="mailmerge-count">
                {total === 0 ? "No records" : `Record ${at + 1} of ${total}`}
              </span>
              <button
                className="mailmerge-step"
                data-testid="mailmerge-next"
                onClick={() => step(at + 1)}
                disabled={!preview || at >= total - 1}
                title="Next record"
              >
                ▶
              </button>
              <button
                className="mailmerge-step"
                data-testid="mailmerge-last"
                onClick={() => step(total - 1)}
                disabled={!preview || at >= total - 1}
                title="Last record"
              >
                ▶|
              </button>
            </span>
          </>
        )}
      </div>

      {unmatched.length > 0 && (
        <p className="mailmerge-note" data-testid="mailmerge-unmatched">
          {unmatched.length === 1 ? "1 field keeps" : `${unmatched.length} fields keep`} the
          placeholder — this data has no column for{" "}
          {unmatched.map((n) => `«${n}»`).join(", ")}
        </p>
      )}

      <p className="mailmerge-note mailmerge-scope" data-testid="mailmerge-scope">
        {UNSUPPORTED}
      </p>
    </div>
  );
}
