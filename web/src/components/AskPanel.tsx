import { useState } from 'react';
import type { AskResponse } from '../api';

/**
 * The scoped assistant panel.
 *
 * Deliberately not a chat window: one question, one answer, no history. The
 * product spec asks for a narrowly scoped way to ask "what needs my attention",
 * and a chat transcript would push this toward a general assistant.
 */

const SUGGESTIONS = [
  'What needs my attention?',
  'What is the most urgent thing?',
  'What do I need to do?',
  'When are my deadlines?',
];

interface AskPanelProps {
  question: string;
  onQuestionChange: (value: string) => void;
  asking: boolean;
  answer: AskResponse | null;
  onSubmit: (question: string) => void;
}

export function AskPanel({
  question,
  onQuestionChange,
  asking,
  answer,
  onSubmit,
}: AskPanelProps) {
  const [focused, setFocused] = useState(false);

  return (
    <section className="ask" aria-label="Ask about your attention items">
      <h2>What needs my attention?</h2>

      <form
        className="ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(question);
        }}
      >
        <label className="sr-only" htmlFor="ask-input">
          Ask about your attention items
        </label>
        <input
          id="ask-input"
          value={question}
          placeholder="What needs my attention?"
          maxLength={500}
          disabled={asking}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onQuestionChange(e.target.value)}
        />
        <button className="btn" type="submit" disabled={asking || question.trim().length === 0}>
          {asking ? <span className="spinner" /> : null}
          {asking ? 'Thinking' : 'Ask'}
        </button>
      </form>

      {(!focused && answer === null) || question.trim().length === 0 ? (
        <div className="ask-suggestions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="chip"
              type="button"
              onClick={() => {
                onQuestionChange(s);
                onSubmit(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {answer && (
        <div className="ask-answer" role="status">
          {answer.answer}
        </div>
      )}
    </section>
  );
}
