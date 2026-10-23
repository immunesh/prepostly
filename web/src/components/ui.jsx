import { useEffect, useRef, useState } from 'react';
import { PLATFORM_ICON, STATUS_BADGE, STATUS_LABEL } from '../lib/api.js';

export function Spinner({ lg }) {
  return <span className={`spinner ${lg ? 'lg' : ''}`} />;
}

export function Loading({ label = 'Loading…' }) {
  return <div className="empty"><div className="row" style={{ justifyContent: 'center' }}><Spinner /> <span>{label}</span></div></div>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="alert err">
      <span>⚠️</span>
      <div className="stack tight" style={{ flex: 1 }}>
        <span>{error.message || String(error)}</span>
        {onRetry && <button className="btn sm" onClick={onRetry} style={{ alignSelf: 'flex-start' }}>Try again</button>}
      </div>
    </div>
  );
}

export function Empty({ icon = '✨', title, children, action }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <h3>{title}</h3>
      {children && <p style={{ maxWidth: 440, margin: '0 auto' }}>{children}</p>}
      {action && <div className="mt">{action}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn ghost sm icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Switch({ on, onChange, label, disabled }) {
  return (
    <label className="row" style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
      {label && <span className="bold">{label}</span>}
    </label>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={value === id} className={`tab ${value === id ? 'on' : ''}`} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}

export function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_BADGE[status] || ''}`}>{STATUS_LABEL[status] || status}</span>;
}

export function PlatformIcon({ platform, size = 16 }) {
  return <span style={{ fontSize: size, lineHeight: 1 }} title={platform}>{PLATFORM_ICON[platform] || '🔗'}</span>;
}

export function Avatar({ src, name, size = 32 }) {
  const initials = String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  if (src) return <img src={src} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flex: 'none' }} />;
  return <span style={{ width: size, height: size, borderRadius: '50%', background: 'var(--gradient)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.38, fontWeight: 700, flex: 'none' }}>{initials}</span>;
}

/** A button that runs an async action, showing a spinner and reporting errors via onError. */
export function AsyncButton({ onClick, children, className = 'btn', onError, ...rest }) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  return (
    <button
      {...rest}
      className={className}
      disabled={busy || rest.disabled}
      onClick={async (e) => {
        setBusy(true);
        try {
          await onClick(e);
        } catch (err) {
          onError?.(err);
        } finally {
          if (mounted.current) setBusy(false);
        }
      }}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Dropdown({ trigger, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="dropdown" ref={ref}>
      <span onClick={() => setOpen((o) => !o)}>{trigger}</span>
      {open && <div className="menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

/** Very small Markdown renderer for chat answers (headings, lists, tables, bold, italics). */
export function Markdown({ text }) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>').replace(/_(.+?)_/g, '<em>$1</em>').replace(/`(.+?)`/g, '<code>$1</code>');
  const lines = String(text || '').split('\n');
  let html = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r.trim()));
      html += `<table>${body.map((r, ri) => `<tr>${cells(r).map((c) => (ri === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('')}</tr>`).join('')}</table>`;
    } else if (/^#{1,3}\s/.test(l)) html += `<h3>${inline(l.replace(/^#+\s/, ''))}</h3>`;
    else if (/^\s*([-*•])\s+/.test(l)) {
      html += '<ul>';
      while (i < lines.length && /^\s*([-*•])\s+/.test(lines[i])) html += `<li>${inline(lines[i++].replace(/^\s*([-*•])\s+/, ''))}</li>`;
      i--;
      html += '</ul>';
    } else if (/^\s*\d+[.)]\s+/.test(l)) {
      html += '<ol>';
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) html += `<li>${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))}</li>`;
      i--;
      html += '</ol>';
    } else if (l.trim()) html += `<p style="margin:4px 0">${inline(l)}</p>`;
  }
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
