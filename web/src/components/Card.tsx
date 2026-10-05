import { useState } from 'react';
import type { AttentionItemView, SourceResponse } from '../api';
import { hoursUntil, formatDeadline, formatReceived } from '../format';

/**
 * One attention item.
 *
 * Design intent: the card answers, in order -- what happened, why it matters,
 * what to do, and when. Everything else is secondary.
 *
 * All email-derived text is rendered as React children, never as HTML. There is
 * no dangerouslySetInnerHTML anywhere in this app.
 */
interface CardProps {
  item: AttentionItemView;
  leaving: boolean;
  source: SourceResponse | undefined;
  onAction: (kind: 'handled' | 'dismiss' | 'reopen') => void;
  onToggleSource: () => void;
}

export function Card({ item, leaving, source, onAction, onToggleSource }: CardProps) {
  const [showConfidence, setShowConfidence] = useState(false);

  const deadlineHours = item.deadline ? hoursUntil(item.deadline.iso) : null;
  const deadlineSoon = deadlineHours !== null && deadlineHours >= 0 && deadlineHours < 48;

  return (
    <article className={`card ${item.priority}${leaving ? ' leaving' : ''}`}>
      <div className="card-top">
        <span className={`pill ${item.priority}`}>{item.priority}</span>
        <span className="category">{item.category.replace(/_/g, ' ')}</span>
        {item.status !== 'open' && <span className="category">&middot; {item.status}</span>}
      </div>

      <h2>{item.title}</h2>
      {item.summary && <p className="summary">{item.summary}</p>}

      <div className="facts">
        <div>
          <div className="fact-label">Deadline</div>
          {item.deadline ? (
            <div className={`fact-value deadline${deadlineSoon ? ' soon' : ''}`}>
              {formatDeadline(item.deadline.iso)}
            </div>
          ) : (
            <div className="fact-value none">No deadline detected</div>
          )}
        </div>

        <div>
          <div className="fact-label">Why it matters</div>
          <div className="fact-value">{item.whyItMatters || '\u2014'}</div>
        </div>

        <div>
          <div className="fact-label">Action</div>
          <div className="fact-value action-value">{item.recommendedAction || '\u2014'}</div>
        </div>
      </div>

      {source && <SourcePreview source={source} />}

      <div className="card-foot">
        <div className="card-links">
          <a className="btn ghost small" href={item.gmailUrl} target="_blank" rel="noopener noreferrer">
            Open email
          </a>
          <button className="btn ghost small" type="button" onClick={onToggleSource}>
            {source ? 'Hide source' : 'Show source'}
          </button>
          {item.status === 'open' ? (
            <>
              <button className="btn ghost small" type="button" onClick={() => onAction('handled')}>
                Mark handled
              </button>
              <button className="btn ghost small" type="button" onClick={() => onAction('dismiss')}>
                Dismiss
              </button>
            </>
          ) : (
            <button className="btn ghost small" type="button" onClick={() => onAction('reopen')}>
              Reopen
            </button>
          )}
        </div>

        <div className="card-meta-group">
          <span
            className="card-meta"
            title={`Confidence ${Math.round(item.confidence * 100)}% (${item.decidedBy})`}
            onMouseEnter={() => setShowConfidence(true)}
            onMouseLeave={() => setShowConfidence(false)}
          >
            {formatReceived(item.source.receivedAt)}
          </span>
          {showConfidence && (
            <span className="confidence">
              {Math.round(item.confidence * 100)}% &middot; {item.decidedBy}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function SourcePreview({ source }: { source: SourceResponse }) {
  return (
    <div className="source">
      <div className="source-meta">
        {source.from ?? 'unknown sender'}
        {source.receivedAt ? ` \u00b7 ${new Date(source.receivedAt).toLocaleString()}` : ''}
        <br />
        {source.subject ?? '(no subject)'}
      </div>
      <div className="source-excerpt">{source.excerpt || '(no preview available)'}</div>
    </div>
  );
}
