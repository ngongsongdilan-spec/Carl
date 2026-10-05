import type { AuthStatus } from '../api';
import { beginGoogleAuth } from '../api';
import { Banner, type BannerData } from './Banner';
import { AskPanel } from './AskPanel';

interface Props {
  auth: AuthStatus | null;
  banner: BannerData | null;
  onDismissBanner: () => void;
  analysing: boolean;
  progress: string | null;
  question: string;
  onQuestionChange: (value: string) => void;
  asking: boolean;
  answer: Parameters<typeof AskPanel>[0]['answer'];
  onAsk: (question: string) => void;
  onLoadDemo: () => void;
  streamUp: boolean;
}

/**
 * The initial state: one clear action.
 *
 * The product spec asks for "Connect Gmail" then "Continue with Google", with a
 * demo path so the engine is usable before anyone sets up Google Cloud.
 */
export function ConnectView({
  auth,
  banner,
  onDismissBanner,
  analysing,
  progress,
  question,
  onQuestionChange,
  asking,
  answer,
  onAsk,
  onLoadDemo,
  streamUp,
}: Props) {
  const configured = auth?.configured ?? false;

  return (
    <div className="shell">
      <Masthead streamUp={streamUp} />

      {banner && <Banner banner={banner} onClose={onDismissBanner} />}

      <div className="connect">
        <h1>Connect Gmail</h1>
        <p>
          This reads your recent email and works out which messages actually need you. It
          cannot send, modify, or delete anything, and no email content leaves your machine
          unless you choose to configure an AI provider.
        </p>

        <ol className="steps">
          {configured ? (
            <>
              <li>
                <span className="n">1</span>
                <span>Authorize read-only access to your mailbox.</span>
              </li>
              <li>
                <span className="n">2</span>
                <span>Analyse your recent messages.</span>
              </li>
              <li>
                <span className="n">3</span>
                <span>Review only what needs attention.</span>
              </li>
            </>
          ) : (
            <>
              <li>
                <span className="n">1</span>
                <span>
                  Add Google OAuth credentials and restart. README section 3 covers it; it uses
                  a read-only scope and takes about five minutes.
                </span>
              </li>
              <li>
                <span className="n">2</span>
                <span>Authorize read-only access to your mailbox.</span>
              </li>
              <li>
                <span className="n">3</span>
                <span>Analyse your recent messages.</span>
              </li>
            </>
          )}
        </ol>

        <div className="connect-actions">
          {configured && (
            <button className="btn primary" type="button" onClick={beginGoogleAuth}>
              Continue with Google
            </button>
          )}
          <button
            className={configured ? 'btn' : 'btn primary'}
            type="button"
            onClick={onLoadDemo}
            disabled={analysing}
          >
            {analysing ? <span className="spinner" /> : null}
            {analysing ? 'Analysing' : 'Load demo inbox'}
          </button>
        </div>

        {analysing && progress && (
          <div className="progress">
            <span className="spinner" /> {progress}
          </div>
        )}

        {auth?.setupHint && <p className="setup-hint">{auth.setupHint}</p>}
      </div>

      <AskPanel
        question={question}
        onQuestionChange={onQuestionChange}
        asking={asking}
        answer={answer}
        onSubmit={onAsk}
      />
    </div>
  );
}

export function Masthead({
  streamUp,
  email,
  notificationsOn,
}: {
  streamUp: boolean;
  email?: string | null;
  notificationsOn?: boolean;
}) {
  return (
    <header className="masthead">
      <p className="wordmark">Attention</p>
      <div className="masthead-status">
        {email && <span className="account">{email}</span>}
        <span className={`dot${streamUp ? ' on' : ''}`} />
        {streamUp ? 'live' : 'offline'}
        {notificationsOn ? ' \u00b7 notifications on' : ''}
      </div>
    </header>
  );
}
