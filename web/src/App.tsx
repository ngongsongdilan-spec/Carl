import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type AnalyzeResponse,
  type AppConfigView,
  type AskResponse,
  type AttentionItemView,
  type AttentionListResponse,
  type AuthStatus,
  type SourceResponse,
} from './api';
import type { NotificationPayload } from './types';
import {
  notificationPermission,
  requestNotificationPermission,
  showNotification,
  subscribeToNotifications,
} from './notifications';
import { AskPanel } from './components/AskPanel';
import { Banner, type BannerData } from './components/Banner';
import { Card } from './components/Card';
import { ConnectView, Masthead } from './components/ConnectView';
import { greeting } from './format';

type Phase = 'loading' | 'connect' | 'ready';

/** Feedback shown after Google redirects back from the OAuth flow. */
const AUTH_OUTCOMES: Record<string, BannerData> = {
  connected: {
    kind: 'info',
    title: 'Connected',
    detail: 'Your Gmail is connected. Analyse your recent email to build the feed.',
  },
  denied: {
    kind: 'warn',
    title: 'Connection cancelled',
    detail: 'Nothing was shared. You can connect again whenever you like.',
  },
  invalid_state: {
    kind: 'error',
    title: 'Could not verify the connection',
    detail: 'The security check on the Google redirect failed. Please try connecting again.',
  },
  missing_code: {
    kind: 'error',
    title: 'No authorization code returned',
    detail: 'Google did not return a code. Please try connecting again.',
  },
  failed: {
    kind: 'error',
    title: 'Connection failed',
    detail: 'Google rejected the request. Check your credentials and redirect URI, then retry.',
  },
};

const SUGGESTIONS_FALLBACK: Record<string, AskResponse> = {
  empty: {
    answer: 'Nothing needs your attention right now.',
    citedItemIds: [],
    source: 'intent',
    outOfScope: false,
  },
};

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [config, setConfig] = useState<AppConfigView | null>(null);
  const [feed, setFeed] = useState<AttentionListResponse | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerData | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [sources, setSources] = useState<Record<string, SourceResponse>>({});
  const [streamUp, setStreamUp] = useState(false);
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermission | 'unsupported'>(() =>
    notificationPermission(),
  );

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AskResponse | null>(null);

  const demoAutoLoaded = useRef(false);

  const report = useCallback((err: unknown, title: string) => {
    if (err instanceof ApiError) {
      setBanner({ kind: 'error', title, detail: err.hint ? `${err.message} ${err.hint}` : err.message });
    } else {
      setBanner({ kind: 'error', title, detail: 'An unexpected error occurred.' });
    }
  }, []);

  const loadFeed = useCallback(
    async (all: boolean) => {
      try {
        setFeed(await api.listAttention(all ? 'all' : 'open'));
      } catch (err) {
        report(err, 'Could not load your items');
      }
    },
    [report],
  );

  const runAnalysis = useCallback(
    async (options: { demo?: boolean } = {}) => {
      setAnalysing(true);
      setProgress(options.demo ? 'Analysing the demo inbox' : 'Fetching recent messages');
      try {
        const result: AnalyzeResponse = await api.analyze(options);
        await loadFeed(showAll);

        const { newItems, skippedNoise, aiCalls, degraded } = result.run;
        if (newItems === 0) {
          setBanner({
            kind: 'info',
            title: 'Nothing new needs you',
            detail: `${result.run.analysed} messages analysed, ${skippedNoise} filtered as noise.`,
          });
        } else {
          setBanner({
            kind: degraded ? 'warn' : 'info',
            title: `${newItems} item${newItems === 1 ? '' : 's'} found`,
            detail: degraded
              ? 'AI analysis is temporarily unavailable, so these come from the deterministic analyzer.'
              : `${result.run.analysed} messages analysed, ${skippedNoise} filtered as noise, ${aiCalls} AI calls.`,
          });
        }
      } catch (err) {
        report(err, 'Analysis failed');
      } finally {
        setAnalysing(false);
        setProgress(null);
      }
    },
    [loadFeed, report, showAll],
  );

  // ---- bootstrap -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const outcome = new URLSearchParams(window.location.search).get('auth');
      if (outcome && AUTH_OUTCOMES[outcome]) setBanner(AUTH_OUTCOMES[outcome]);
      if (outcome) window.history.replaceState({}, '', window.location.pathname);

      try {
        const [status, cfg] = await Promise.all([api.authStatus(), api.config()]);
        if (cancelled) return;

        setAuth(status);
        setConfig(cfg);

        if (status.connected) {
          setPhase('ready');
          await loadFeed(false);
        } else {
          setPhase('connect');
          // With no credentials there is nothing to connect, so demonstrate the
          // engine rather than presenting a dead end.
          if (!status.configured && !demoAutoLoaded.current) {
            demoAutoLoaded.current = true;
            await runAnalysis({ demo: true });
          }
        }
      } catch (err) {
        if (cancelled) return;
        setPhase('connect');
        report(err, 'Cannot reach the backend');
      }
    })();

    return () => {
      cancelled = true;
    };
    // Runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- notifications ---------------------------------------------------
  useEffect(
    () =>
      subscribeToNotifications((payload: NotificationPayload) => {
        showNotification(payload);
        if (phase === 'ready') void loadFeed(showAll);
      }, setStreamUp),
    [phase, showAll, loadFeed],
  );

  const updateItem = useCallback(
    async (id: string, kind: 'handled' | 'dismiss' | 'reopen') => {
      setLeaving((prev) => new Set(prev).add(id));
      try {
        const response =
          kind === 'handled'
            ? await api.markHandled(id)
            : kind === 'dismiss'
              ? await api.dismiss(id)
              : await api.reopen(id);
        if (response.item) {
          const updated = response.item as AttentionItemView;
          setFeed((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              items: showAll
                ? prev.items.map((i) => (i.id === id ? updated : i))
                : prev.items.filter((i) => i.id !== id),
            };
          });
        }
      } catch (err) {
        report(err, 'Could not update that item');
      } finally {
        setLeaving((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [report, showAll],
  );

  const toggleSource = useCallback(
    async (id: string) => {
      if (sources[id]) {
        setSources((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        return;
      }
      try {
        const source = await api.source(id);
        setSources((prev) => ({ ...prev, [id]: source }));
      } catch (err) {
        report(err, 'Could not load the source email');
      }
    },
    [sources, report],
  );

  const submitQuestion = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      setAsking(true);
      try {
        setAnswer(await api.ask(trimmed));
      } catch (err) {
        if (err instanceof ApiError) {
          setAnswer({
            answer: err.hint ? `${err.message} ${err.hint}` : err.message,
            citedItemIds: [],
            source: 'intent',
            outOfScope: false,
          });
        } else {
          setAnswer(SUGGESTIONS_FALLBACK.empty);
        }
      } finally {
        setAsking(false);
      }
    },
    [],
  );

  const disconnect = useCallback(async () => {
    try {
      await api.disconnect();
      const status = await api.authStatus();
      setAuth(status);
      setPhase('connect');
      setFeed(null);
    } catch (err) {
      report(err, 'Could not disconnect');
    }
  }, [report]);

  // ---- render ----------------------------------------------------------
  if (phase === 'loading') {
    return (
      <div className="shell">
        <Masthead streamUp={false} />
        <div className="progress">
          <span className="spinner" /> Loading
        </div>
      </div>
    );
  }

  if (phase === 'connect') {
    return (
      <ConnectView
        auth={auth}
        banner={banner}
        onDismissBanner={() => setBanner(null)}
        analysing={analysing}
        progress={progress}
        question={question}
        onQuestionChange={setQuestion}
        asking={asking}
        answer={answer}
        onAsk={(q) => void submitQuestion(q)}
        onLoadDemo={() => void runAnalysis({ demo: true })}
        streamUp={streamUp}
      />
    );
  }

  const items = feed?.items ?? [];
  const openCount = feed?.counts.open ?? 0;
  const showEmpty = !analysing && items.length === 0;
  const aiUnavailable = config !== null && !config.ai.available && config.ai.mode !== 'off';

  return (
    <div className="shell">
      <Masthead
        streamUp={streamUp}
        email={auth?.email}
        notificationsOn={notifyPerm === 'granted'}
      />

      {banner && <Banner banner={banner} onClose={() => setBanner(null)} />}

      {aiUnavailable && (
        <div className="banner warn" role="status">
          <div>
            <span className="banner-title">AI analysis is temporarily unavailable</span>
            {config?.ai.detail ?? 'Showing results from the deterministic analyzer.'}
          </div>
        </div>
      )}

      <div className="feed-header">
        <h1>
          {greeting()}
          {openCount > 0 && <span className="headline-count"> &middot; {openCount} need you</span>}
        </h1>

        <div className="feed-actions">
          <div className="filters" role="group" aria-label="Filter items">
            <button
              type="button"
              className={`filter${showAll ? '' : ' active'}`}
              onClick={() => {
                setShowAll(false);
                void loadFeed(false);
              }}
            >
              Open
            </button>
            <button
              type="button"
              className={`filter${showAll ? ' active' : ''}`}
              onClick={() => {
                setShowAll(true);
                void loadFeed(true);
              }}
            >
              All
            </button>
          </div>

          <button
            className="btn small"
            type="button"
            disabled={analysing}
            onClick={() => void runAnalysis()}
          >
            {analysing ? <span className="spinner" /> : null}
            {analysing ? 'Analysing' : 'Refresh'}
          </button>
          <button className="btn ghost small" type="button" onClick={() => void disconnect()}>
            Disconnect
          </button>
        </div>
      </div>

      {notifyPerm !== 'granted' && notifyPerm !== 'unsupported' && (
        <div className="banner">
          <div>
            <span className="banner-title">Turn on notifications</span>
            Find out when something important arrives, without checking.
          </div>
          <button
            className="btn small"
            type="button"
            onClick={() => void requestNotificationPermission().then(setNotifyPerm)}
          >
            Enable
          </button>
        </div>
      )}

      {progress && (
        <div className="progress">
          <span className="spinner" /> {progress}
        </div>
      )}

      {showEmpty && (
        <div className="empty">
          <h2>No important items right now.</h2>
          <p>
            Your recent messages were analysed and nothing needs you. That is the result the
            product is built for, not a failure.
          </p>
        </div>
      )}

      {items.length > 0 && (
        <div className="cards">
          {items.map((item) => (
            <Card
              key={item.id}
              item={item}
              leaving={leaving.has(item.id)}
              source={sources[item.id]}
              onAction={(kind) => void updateItem(item.id, kind)}
              onToggleSource={() => void toggleSource(item.id)}
            />
          ))}
        </div>
      )}

      <AskPanel
        question={question}
        onQuestionChange={setQuestion}
        asking={asking}
        answer={answer}
        onSubmit={(q) => void submitQuestion(q)}
      />

      <p className="footnote">
        {config?.ai.mode === 'off' || !config?.ai.available
          ? 'Deterministic analyzer (no AI provider configured).'
          : `AI: ${config?.ai.model ?? config?.ai.provider}`}
        {config ? ` \u00b7 ${config.attention.messageLimit} recent messages per run` : ''}
      </p>
    </div>
  );
}
