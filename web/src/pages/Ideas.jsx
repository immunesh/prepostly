import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, patch, del, streamPost } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { Dropdown, Markdown, Spinner } from '../components/ui.jsx';

const EXAMPLES = [
  ['💡 Get content ideas', 'Write five social media post ideas for my brand this month.'],
  ['🗓️ Generate a content calendar', 'Generate a content calendar for the next 1 week.'],
  ['📣 Get ad ideas', 'Generate 10 attention-grabbing ad headlines for our best product.'],
];

export default function Ideas() {
  const { toast, refresh } = useApp();
  const nav = useNavigate();
  const [convs, { reload }] = useLoad(() => get('/api/ideas/conversations'), []);
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);

  // Load history only when the user picks a conversation. Loading on every change of `active`
  // raced the first reply in a new chat and wiped it from the screen.
  const open = (id) => {
    if (busy) return;
    setActive(id);
    setMessages([]);
    if (id) get(`/api/ideas/conversations/${id}`).then((c) => setMessages(c.messages)).catch((e) => toast(e.message, 'err'));
  };
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setBusy(true);
    setInput('');
    try {
      let id = active;
      if (!id) {
        id = (await post('/api/ideas/conversations', {})).id;
        setActive(id);
      }
      setMessages((m) => [...m, { id: `u${Date.now()}`, role: 'user', content }, { id: 'stream', role: 'assistant', content: '' }]);
      let failed = null;
      await streamPost(`/api/ideas/conversations/${id}/messages`, { content }, (ev, data) => {
        if (ev === 'delta') setMessages((m) => m.map((x) => (x.id === 'stream' ? { ...x, content: x.content + data.text } : x)));
        if (ev === 'error') failed = data.error;
      });
      if (failed) throw new Error(failed);
      setMessages((m) => m.map((x) => (x.id === 'stream' ? { ...x, id: `a${Date.now()}` } : x)));
      reload();
      refresh();
    } catch (e) {
      toast(e.message, 'err');
      setMessages((m) => m.filter((x) => x.id !== 'stream'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head"><div><h1>💡 Idea Lab</h1><p>Brainstorm posts, calendars and ad copy with an AI that knows your brand.</p></div></div>
      <div className="chat">
        <div className="card chat-list" style={{ padding: 10 }}>
          <button className="btn primary block" style={{ marginBottom: 8 }} disabled={busy} onClick={() => open(null)}>＋ New conversation</button>
          {(convs || []).map((c) => (
            <div key={c.id} className="row" style={{ gap: 2 }}>
              <button className={active === c.id ? 'on' : ''} onClick={() => open(c.id)} style={{ flex: 1, minWidth: 0 }}><span className="clip" style={{ display: 'block' }}>{c.title}</span><span className="tiny faint">{c.words} words</span></button>
              <Dropdown trigger={<button className="btn ghost sm icon-btn" aria-label="Conversation options">⋯</button>}>
                <button onClick={async () => { const t = prompt('Conversation title', c.title); if (t) { await patch(`/api/ideas/conversations/${c.id}`, { title: t }); reload(); } }}>✏️ Rename</button>
                <button onClick={async () => { await post(`/api/ideas/conversations/${c.id}/clear`); if (active === c.id) setMessages([]); }}>🧹 Clear history</button>
                <button onClick={async () => { await del(`/api/ideas/conversations/${c.id}`); if (active === c.id) open(null); reload(); }}>🗑️ Delete chat</button>
              </Dropdown>
            </div>
          ))}
        </div>
        <div className="card chat-main">
          <div className="messages">
            {!messages.length && (
              <div className="empty">
                <div className="big">💡</div>
                <h3>Try Idea Lab</h3>
                <p>Pick an example for inspiration, or just write a request.</p>
                <div className="stack mt" style={{ maxWidth: 520, margin: '20px auto 0' }}>
                  {EXAMPLES.map(([t, q]) => <button key={t} className="type-card" onClick={() => send(q)}><span className="lbl">{t}</span><span className="small muted">{q}</span></button>)}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.role === 'assistant' ? (m.content ? <Markdown text={m.content} /> : <Spinner />) : m.content}
                {m.role === 'assistant' && m.content && m.id !== 'stream' && (
                  <div className="row mt" style={{ marginTop: 8 }}>
                    <button className="btn sm" onClick={() => nav(`/app/create?type=carousel&prompt=${encodeURIComponent(m.content.slice(0, 1500))}`)}>✨ Create a post from this</button>
                    <button className="btn ghost sm" onClick={() => { navigator.clipboard?.writeText(m.content); toast('Copied'); }}>📋 Copy</button>
                  </div>
                )}
              </div>
            ))}
            <div ref={end} />
          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input className="input" placeholder="Type message here" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Message" />
            <button className="btn primary" disabled={busy || !input.trim()}>{busy ? <Spinner /> : 'Send'}</button>
          </form>
        </div>
      </div>
    </>
  );
}
