import { useEffect, useMemo, useState } from 'react';
import { Bell, Check, Circle, Clock3, Mic, MicOff, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { LocalNotifications } from '@capacitor/local-notifications';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';

type Task = { id: string; title: string; dueAt: string | null; done: boolean; createdAt: number };
const STORE_KEY = 'yadavareh_tasks_v1';
let speechListener: { remove: () => Promise<void> } | null = null;
let latestTranscript = '';

function parsePersianDigits(value: string) {
  return value.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}
function parseSpokenTask(raw: string): { title: string; dueAt: string | null } {
  const text = parsePersianDigits(raw).trim();
  const now = new Date();
  let due: Date | null = null;
  let title = text;
  const timeMatch = text.match(/(?:ساعت|ساعتِ)\s*(\d{1,2})(?::(\d{2}))?/);
  const inHour = text.match(/(\d+)\s*ساعت\s*(?:دیگه|دیگر|بعد)/);
  const inMinute = text.match(/(\d+)\s*دقیقه\s*(?:دیگه|دیگر|بعد)/);
  const tomorrow = /فردا/.test(text);
  const tonight = /امشب/.test(text);
  if (inHour) { due = new Date(now.getTime() + Number(inHour[1]) * 3600000); title = title.replace(inHour[0], ''); }
  else if (inMinute) { due = new Date(now.getTime() + Number(inMinute[1]) * 60000); title = title.replace(inMinute[0], ''); }
  else if (timeMatch && (tomorrow || tonight || /امروز/.test(text) || timeMatch)) {
    due = new Date(now);
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] || 0);
    if (hour > 23 || minute > 59) return { title: text, dueAt: null };
    if (tomorrow) due.setDate(due.getDate() + 1);
    due.setHours(hour, minute, 0, 0);
    if (!tomorrow && due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
    title = title.replace(timeMatch[0], '').replace(/فردا|امشب|امروز/g, '');
  }
  title = title.replace(/^(یادآوری کن|یادم بنداز|بهم یادآوری کن|یادداشت کن|ثبت کن|اضافه کن)\s*/g, '').trim();
  title = title.replace(/[،,؛;]\s*$/, '').trim();
  if (!title) title = text;
  return { title, dueAt: due?.toISOString() ?? null };
}
function formatDue(value: string | null) {
  if (!value) return 'بدون یادآور';
  const date = new Date(value);
  return date.toLocaleString('fa-IR', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [listening, setListening] = useState(false);
  const [draft, setDraft] = useState('');
  const [dueInput, setDueInput] = useState('');
  const [status, setStatus] = useState('آماده‌ام؛ بگو چه کاری باید انجام شود.');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('all');
  const [modal, setModal] = useState(false);

  useEffect(() => { void loadTasks(); }, []);
  async function loadTasks() {
    try {
      const stored = await Preferences.get({ key: STORE_KEY });
      if (stored.value) setTasks(JSON.parse(stored.value));
      else {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) setTasks(JSON.parse(raw));
      }
    } catch { setStatus('خواندن یادداشت‌های ذخیره‌شده با مشکل روبه‌رو شد.'); }
  }
  async function persist(next: Task[]) {
    setTasks(next);
    const serialized = JSON.stringify(next);
    try { await Preferences.set({ key: STORE_KEY, value: serialized }); }
    catch { localStorage.setItem(STORE_KEY, serialized); }
  }
  async function setupNotifications() {
    if (!Capacitor.isNativePlatform()) return true;
    try {
      let permission = await LocalNotifications.checkPermissions();
      if (permission.display !== 'granted') permission = await LocalNotifications.requestPermissions();
      if (permission.display !== 'granted') {
        setStatus('مجوز اعلان فعال نشد؛ از تنظیمات گوشی اجازه اعلان بده.');
        return false;
      }
      return true;
    } catch {
      setStatus('دسترسی اعلان در دسترس نیست. ابتدا اپ را روی اندروید اجرا کن.');
      return false;
    }
  }
  async function scheduleNotification(task: Task) {
    if (!task.dueAt || task.done) return;
    const when = new Date(task.dueAt);
    if (when.getTime() <= Date.now()) return;
    if (!Capacitor.isNativePlatform()) {
      setStatus('در پیش‌نمایش وب، اعلان پس‌زمینه تضمین نمی‌شود؛ برای یادآوری واقعی APK را نصب کن.');
      return;
    }
    const ok = await setupNotifications();
    if (!ok) return;
    try {
      await LocalNotifications.schedule({
        notifications: [{
          id: Math.floor(Date.now() % 2000000000),
          title: 'وقت انجام کاره ⏰',
          body: task.title,
          schedule: { at: when, allowWhileIdle: true },
          extra: { taskId: task.id }
        }]
      });
      setStatus('یادآور تنظیم شد: ' + formatDue(task.dueAt));
    } catch {
      setStatus('ثبت اعلان انجام نشد. مجوز اعلان و تنظیمات باتری گوشی را بررسی کن.');
    }
  }
  async function startVoice() {
    if (listening) { await stopVoice(); return; }
    if (!Capacitor.isNativePlatform()) {
      setStatus('برای تست میکروفون بومی و تشخیص فارسی، این پروژه را به‌صورت APK اجرا کن. فعلاً متن را دستی وارد کن.');
      setModal(true);
      return;
    }
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) { setStatus('سرویس تشخیص گفتار روی این گوشی در دسترس نیست. سرویس گفتار گوشی را فعال کن.'); return; }
      const permission = await SpeechRecognition.requestPermissions();
      if (permission.speechRecognition !== 'granted') { setStatus('مجوز تشخیص گفتار داده نشد. از تنظیمات گوشی اجازه بده.'); return; }
      latestTranscript = '';
      speechListener = await SpeechRecognition.addListener('partialResults', (event: { matches?: string[] }) => {
        const match = event.matches?.[0];
        if (match) latestTranscript = match;
      });
      setListening(true);
      setStatus('گوش می‌دم… فارسی صحبت کن. برای پایان، دوباره روی میکروفون بزن.');
      await SpeechRecognition.start({
        language: 'fa-IR',
        maxResults: 1,
        prompt: 'کار یا یادآوری خود را بگویید',
        partialResults: true,
        popup: false
      });
    } catch {
      setListening(false);
      if (speechListener) { await speechListener.remove().catch(() => {}); speechListener = null; }
      setStatus('ضبط یا تشخیص گفتار ناموفق بود. اتصال اینترنت، زبان فارسی و مجوز میکروفون را بررسی کن.');
    }
  }
  async function stopVoice() {
    try { await SpeechRecognition.stop(); } catch {}
    if (speechListener) { await speechListener.remove().catch(() => {}); speechListener = null; }
    setListening(false);
    const transcript = latestTranscript.trim();
    if (transcript) {
      const parsed = parseSpokenTask(transcript);
      setDraft(parsed.title);
      setDueInput(parsed.dueAt ? toLocalInput(parsed.dueAt) : '');
      setModal(true);
      setStatus(parsed.dueAt ? 'متن و زمان را بررسی کن و بعد ثبت کن.' : 'متن را بررسی کن؛ اگر زمان نگفتی، می‌توانی دستی اضافه کنی.');
    } else setStatus('صدایی به متن تبدیل نشد. دوباره امتحان کن یا متن را بنویس.');
  }
  function toLocalInput(iso: string) {
    const d = new Date(iso);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }
  async function saveDraft() {
    const title = draft.trim();
    if (!title) { setStatus('اول متن کار را بنویس.'); return; }
    const dueAt = dueInput ? new Date(dueInput).toISOString() : null;
    if (dueAt && new Date(dueAt).getTime() <= Date.now()) { setStatus('زمان یادآوری باید در آینده باشد.'); return; }
    const task: Task = { id: newId(), title, dueAt, done: false, createdAt: Date.now() };
    const next = [task, ...tasks];
    await persist(next);
    await scheduleNotification(task);
    setDraft(''); setDueInput(''); setModal(false);
    if (!dueAt) setStatus('کار ذخیره شد. هر زمان خواستی برایش یادآور تنظیم کن.');
    else if (!Capacitor.isNativePlatform()) setStatus('کار ذخیره شد؛ برای اعلان واقعی پس‌زمینه، APK لازم است.');
    else setStatus('کار و یادآور ذخیره شدند.');
  }
  async function toggleTask(task: Task) {
    const next = tasks.map(t => t.id === task.id ? { ...t, done: !t.done } : t);
    await persist(next);
    if (!task.done && task.dueAt && Capacitor.isNativePlatform()) {
      try {
        const pending = await LocalNotifications.getPending();
        const ids = pending.notifications.filter(n => (n.extra as any)?.taskId === task.id).map(n => n.id);
        if (ids.length) await LocalNotifications.cancel({ notifications: ids.map(id => ({ id })) });
      } catch {}
    }
  }
  async function deleteTask(task: Task) {
    await persist(tasks.filter(t => t.id !== task.id));
    if (Capacitor.isNativePlatform()) {
      try {
        const pending = await LocalNotifications.getPending();
        const ids = pending.notifications.filter(n => (n.extra as any)?.taskId === task.id).map(n => n.id);
        if (ids.length) await LocalNotifications.cancel({ notifications: ids.map(id => ({ id })) });
      } catch {}
    }
  }
  const visibleTasks = useMemo(() => tasks.filter(t => {
    const matches = t.title.toLowerCase().includes(query.toLowerCase());
    return matches && (filter === 'all' || (filter === 'open' ? !t.done : t.done));
  }).sort((a, b) => Number(a.done) - Number(b.done) || ((a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity))), [tasks, query, filter]);
  const openCount = tasks.filter(t => !t.done).length;

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand-mark"><Sparkles size={21}/></div>
      <div className="brand-copy"><strong>یادآور</strong><span>دستیار صوتی تو</span></div>
      <div className="top-spacer"/>
      <div className="online-dot" title="آماده به کار"/>
      <button className="icon-button" onClick={() => { setDraft(''); setDueInput(''); setModal(true); }} aria-label="افزودن یادداشت"><Plus/></button>
    </header>

    <section className="hero">
      <div className="eyebrow"><span className="pulse-dot"/> دستیار شخصی شما</div>
      <h1>فقط بگو،<br/><span>یادت می‌مونه.</span></h1>
      <p>ذهنت رو آزاد کن. کارهات رو بگو تا ثبتشون کنم و سر وقت بهت یادآوری کنم.</p>
      <button className={`mic-button ${listening ? 'is-listening' : ''}`} onClick={() => void startVoice()} aria-label={listening ? 'توقف ضبط' : 'شروع ضبط'}>
        <span className="mic-halo halo-one"/><span className="mic-halo halo-two"/>
        {listening ? <MicOff size={31}/> : <Mic size={34}/>}
      </button>
      <div className="mic-label">{listening ? 'دارم گوش می‌دم…' : 'برای صحبت کردن لمس کن'}</div>
      <div className="voice-hint"><span>مثلاً بگو:</span> «فردا ساعت ۹ به فلانی زنگ بزن»</div>
    </section>

    <section className="status-line"><span className="status-icon"><Bell size={15}/></span><span>{status}</span></section>

    <section className="tasks-section">
      <div className="section-heading">
        <div><h2>کارهای من</h2><p>{openCount} کار باقی مونده</p></div>
        <button className="text-button" onClick={() => { setDraft(''); setDueInput(''); setModal(true); }}><Plus size={16}/> کار جدید</button>
      </div>
      <div className="searchbox"><Search size={17}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="جست‌وجوی بین کارها…"/></div>
      <div className="filter-tabs">
        {(['all','open','done'] as const).map(f => <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'همه' : f === 'open' ? 'در انتظار' : 'انجام‌شده'}</button>)}
      </div>
      <div className="task-list">
        {visibleTasks.length === 0 ? <div className="empty-state"><div className="empty-icon"><Clock3 size={25}/></div><strong>{query ? 'چیزی پیدا نشد' : 'هنوز کاری ثبت نکردی'}</strong><span>با دکمه میکروفون اولین کارت رو اضافه کن.</span></div> :
          visibleTasks.map(task => <article className={`task-card ${task.done ? 'completed' : ''}`} key={task.id}>
            <button className="check-button" onClick={() => void toggleTask(task)} aria-label={task.done ? 'بازگرداندن کار' : 'انجام شد'}>{task.done ? <Check size={17}/> : <Circle size={20}/>}</button>
            <div className="task-body"><div className="task-title">{task.title}</div><div className={`task-due ${task.dueAt ? 'has-due' : ''}`}><Clock3 size={13}/>{formatDue(task.dueAt)}</div></div>
            <button className="delete-button" onClick={() => void deleteTask(task)} aria-label="حذف کار"><Trash2 size={16}/></button>
          </article>)
        }
      </div>
    </section>

    <footer><span className="footer-spark">✳</span> یه کار کوچیک، یه قدم جلوتر <span className="footer-version">نسخه آزمایشی</span></footer>

    {modal && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setModal(false); }}>
      <section className="edit-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-head"><div><span className="modal-kicker">یادداشت جدید</span><h2 id="modal-title">چی رو یادت نگه دارم؟</h2></div><button className="icon-button" onClick={() => setModal(false)} aria-label="بستن"><X/></button></div>
        <label className="field-label" htmlFor="task-text">متن کار</label>
        <textarea id="task-text" rows={3} value={draft} onChange={e => setDraft(e.target.value)} placeholder="مثلاً فردا ساعت ۹ به دانش‌آموزها تکلیف بدم…"/>
        <label className="field-label" htmlFor="task-time">زمان یادآوری <span>(اختیاری)</span></label>
        <input id="task-time" className="datetime-input" type="datetime-local" value={dueInput} onChange={e => setDueInput(e.target.value)} min={toLocalInput(new Date().toISOString())}/>
        <div className="modal-actions"><button className="secondary-button" onClick={() => setModal(false)}>انصراف</button><button className="primary-button" onClick={() => void saveDraft()}><Check size={17}/> ذخیره کار</button></div>
      </section>
    </div>}
  </main>;
}