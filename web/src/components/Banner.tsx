export interface BannerData {
  kind: 'warn' | 'error' | 'info';
  title: string;
  detail: string;
}

interface Props {
  banner: BannerData;
  onClose: () => void;
  action?: { label: string; onClick: () => void };
}

export function Banner({ banner, onClose, action }: Props) {
  return (
    <div className={`banner ${banner.kind}`} role={banner.kind === 'error' ? 'alert' : 'status'}>
      <div>
        <span className="banner-title">{banner.title}</span>
        {banner.detail}
      </div>
      {action && (
        <button className="btn small" type="button" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      <button className="btn ghost small" type="button" onClick={onClose} aria-label="Dismiss message">
        Dismiss
      </button>
    </div>
  );
}
