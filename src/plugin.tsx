// Builds: what is deployed on each watched server, and when it last changed.
//
// This was a Python process serving a dashboard on localhost:8765 — start it by hand, open a
// browser tab, grant notification permission, lose it when the terminal closed. The whole engine
// was 300 lines of poller, login, token refresh and an HTTP server. It turns out /api/v2/build-id
// needs no authentication at all, so what is left is one GET a minute and somewhere to put it.
//
// The layout follows that dashboard: a grid of stat cards over a history table, monospace
// throughout, because a commit hash and a timestamp are things you compare column-wise.
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Radar, RotateCw, Plus, X, Check, AlertCircle, Pause, Play, Server as ServerIcon,
} from "lucide-react";
import {
  StatusItem, StatusPopover, PanelHead, ConfirmDialog, NamePrompt, toast,
  type ConfirmState, type NamePromptState,
} from "../shim/ui.js";
import { decode, ago, type Server, type Watch } from "./build";
import {
  POLL_MS, getServers, getVersion, getWatch, isRunning, nextPollIn, refresh, setRunning,
  setServers, start, subscribe,
} from "./store";

// Started at module scope, not in the component: Deck unmounts a module when you navigate away,
// and a monitor that only runs while you are looking at it is not a monitor.
start();

const OK = "#3fb950";

/** The line between history rows. Far fainter than --border-subtle, which is sized for a panel
 *  edge and reads as a hard rule once it repeats down a table. */
const ROW_LINE = "rgba(255,255,255,0.045)";

/** One bordered stat. The unit of the dashboard's grid. */
function Card({ label, children, accent, wide }: {
  label: string; children: React.ReactNode; accent?: boolean; wide?: boolean;
}) {
  return (
    <div className={"min-w-0 rounded-lg border border-subtle px-4 py-3 " + (wide ? "col-span-2" : "")}
      style={{ background: "var(--bg-card-glass)" }}>
      <div className="mb-1.5 text-[10px] uppercase tracking-[0.06em] text-text-muted">{label}</div>
      <div className={"truncate font-mono " + (accent ? "text-[15px] font-semibold" : "text-sm")}
        style={{ color: accent ? "var(--accent)" : "var(--text-secondary)" }}>
        {children}
      </div>
    </div>
  );
}

/** Time-of-day plus date, the way a deploy log reads. */
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function ServerPanel({ server, watch, now, showTitle }: {
  server: Server; watch: Watch; now: number;
  /** Only with more than one server: with a single one the page header already names it. */
  showTitle: boolean;
}) {
  const d = decode(watch.buildId);
  const failing = watch.lastChecked !== null && !!watch.lastError;
  const latest = watch.history.at(-1);
  // The countdown doubles as a progress bar: a bar emptying is readable at a glance in a way a
  // number is not, and it is what the original dashboard did.
  const remaining = nextPollIn();
  const pct = watch.lastChecked ? Math.max(0, Math.min(100, (remaining / POLL_MS) * 100)) : 0;

  return (
    <section className="mb-6">
      {showTitle && (
        <div className="mb-3 flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: !server.enabled ? "var(--text-muted)" : failing ? "var(--danger)" : OK }} />
          <h2 className="text-sm font-semibold text-text-primary">{server.name}</h2>
          <span className="truncate font-mono text-[11px] text-text-muted">{server.url}</span>
          {!server.enabled && <span className="shrink-0 text-[11px] italic text-text-muted">paused</span>}
        </div>
      )}

      {failing && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-subtle px-3 py-2 text-xs"
          style={{ color: "var(--danger)" }}>
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{watch.lastError}</span>
        </div>
      )}

      {/* Inline rather than an arbitrary Tailwind class: the content scan generates only what it
          literally sees, and a grid-template written this way is easy to get silently dropped. */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <Card label="Current build" accent wide>
          {d ? `${d.label} · ${d.commit}` : watch.buildId || "—"}
        </Card>
        <Card label="Built">{d?.builtAt ? stamp(d.builtAt) : "—"}</Card>
        <Card label="Deployed">{latest ? ago(latest.seenAt, now) : "—"}</Card>
        <Card label="Last checked">
          {watch.lastChecked ? ago(watch.lastChecked, now) : "—"}
        </Card>
        <Card label="Next poll in">
          {!isRunning() ? "paused" : watch.lastChecked ? `${Math.ceil(remaining / 1000)}s` : "—"}
          {isRunning() && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--bg-elev)" }}>
              <div className="h-full rounded-full transition-[width] duration-1000 ease-linear"
                style={{ width: `${pct}%`, background: "var(--accent)" }} />
            </div>
          )}
        </Card>
        <Card label="Polls / changes">{watch.polls} / {watch.history.length}</Card>
      </div>

      {watch.history.length > 0 && (
        <div className="mt-4">
          <div className="mb-2.5 flex items-baseline gap-2">
            <h3 className="text-sm font-semibold text-text-primary">Change history</h3>
            <span className="text-xs text-text-muted">{watch.history.length} changes</span>
          </div>
          <div className="overflow-hidden rounded-lg border border-subtle">
            <table className="w-full font-mono text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.06em] text-text-muted"
                  style={{ background: "var(--bg-elev)", borderBottom: `1px solid ${ROW_LINE}` }}>
                  <th className="px-4 py-2.5 font-medium">Commit</th>
                  <th className="px-4 py-2.5 font-medium">Version</th>
                  <th className="px-4 py-2.5 font-medium">Built</th>
                  <th className="px-4 py-2.5 text-right font-medium">Seen</th>
                </tr>
              </thead>
              <tbody>
                {[...watch.history].reverse().map((e, i) => {
                  const ed = decode(e.buildId);
                  const current = i === 0;
                  return (
                    <tr key={`${e.buildId}-${e.seenAt}`}
                      className="transition-colors hover:bg-white/5"
                      style={{
                        borderBottom: i === watch.history.length - 1 ? "none" : `1px solid ${ROW_LINE}`,
                        ...(current ? { background: "var(--accent-soft)" } : {}),
                      }}>
                      <td className="px-4 py-2.5 font-medium"
                        style={{ color: current ? "var(--accent)" : "var(--text-primary)" }}>
                        {ed?.commit ?? e.buildId}
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary">{ed?.label ?? "—"}</td>
                      <td className="px-4 py-2.5 text-text-muted">{ed?.builtAt ? stamp(ed.builtAt) : "—"}</td>
                      <td className="px-4 py-2.5 text-right text-text-muted" title={stamp(e.seenAt)}>
                        {ago(e.seenAt, now)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/** Add and remove watched servers. Inline rather than in a dialog — the list is short. */
function ServerList({ servers, onChange }: { servers: Server[]; onChange: (s: Server[]) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [rename, setRename] = useState<NamePromptState | null>(null);

  const add = () => {
    const u = url.trim().replace(/\/+$/, "");
    if (!u) return;
    // The id is what the stored history is keyed on, so it must be stable and unique. Derived
    // from the URL rather than the name, which the user may rename later.
    const id = u.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    if (servers.some((s) => s.id === id)) return;
    onChange([...servers, { id, name: name.trim() || id, url: u, enabled: true }]);
    setName(""); setUrl("");
  };

  return (
    <div className="space-y-2">
      {servers.map((s) => (
        <div key={s.id} className="flex items-center gap-2 rounded-lg border border-subtle px-3 py-2">
          <button onClick={() => onChange(servers.map((x) => x.id === s.id ? { ...x, enabled: !x.enabled } : x))}
            title={s.enabled ? "Pause" : "Resume"}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded border"
            style={{ borderColor: s.enabled ? "var(--accent)" : "var(--border-strong)",
              background: s.enabled ? "var(--accent)" : "transparent" }}>
            {s.enabled && <Check size={11} color="#fff" />}
          </button>
          <button
            onClick={() => setRename({
              title: "Rename server",
              subtitle: s.url,
              initial: s.name,
              confirmLabel: "Rename",
              onSave: (v) => {
                const next = v.trim();
                if (!next || next === s.name) return;
                onChange(servers.map((x) => x.id === s.id ? { ...x, name: next } : x));
                toast(`Renamed to ${next}`, "success");
              },
            })}
            title="Rename"
            className="text-sm text-text-primary transition hover:text-accent"
          >
            {s.name}
          </button>
          <span className="truncate font-mono text-[11px] text-text-muted">{s.url}</span>
          <button
            onClick={() => setConfirm({
              title: `Stop watching ${s.name}?`,
              // The history is the part worth warning about: the server is two fields to retype,
              // the record of when it deployed is not.
              body: `Its build history (${getWatch(s.id).history.length} recorded ${getWatch(s.id).history.length === 1 ? "change" : "changes"}) is deleted with it.`,
              confirmLabel: "Remove",
              onConfirm: () => {
                onChange(servers.filter((x) => x.id !== s.id));
                toast(`Stopped watching ${s.name}`);
              },
            })}
            title="Remove — its history goes too"
            className="ml-auto shrink-0 rounded p-1 text-text-muted transition hover:text-text-primary">
            <X size={13} />
          </button>
        </div>
      ))}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      <NamePrompt state={rename} onClose={() => setRename(null)} />

      <div className="flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name"
          className="h-8 w-28 shrink-0 rounded-md border border-subtle bg-transparent px-2 text-xs text-text-primary outline-none focus:border-[var(--accent)]" />
        <input value={url} onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder="https://api-dev.example.com"
          className="h-8 min-w-0 flex-1 rounded-md border border-subtle bg-transparent px-2 font-mono text-xs text-text-primary outline-none focus:border-[var(--accent)]" />
        <button onClick={add}
          className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-subtle px-2.5 text-xs text-text-secondary transition hover:border-strong hover:text-text-primary">
          <Plus size={12} /> Add
        </button>
      </div>
    </div>
  );
}

export default function Builds() {
  useSyncExternalStore(subscribe, getVersion);
  const servers = getServers();
  const only = servers.length === 1 ? servers[0] : null;
  const running = isRunning();
  const [busy, setBusy] = useState(false);
  const [showServers, setShowServers] = useState(false);

  // One second, because the countdown and its bar are on screen. Everything else derived from it
  // ("2m ago") is coarse enough not to mind.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden p-6">
      <div className="mb-5 flex items-center gap-3">
        <Radar size={18} style={{ color: "var(--accent)" }} />
        <h1 className="text-lg font-semibold text-text-primary">Builds</h1>
        {/* With one server its name belongs up here rather than in a second header below; with
            several, each panel names itself and this just counts them. */}
        {only ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: !running || !only.enabled ? "var(--text-muted)"
                : getWatch(only.id).lastError ? "var(--danger)" : OK }} />
            <span className="shrink-0 text-sm font-medium text-text-secondary">{only.name}</span>
            <span className="truncate font-mono text-[11px] text-text-muted">{only.url}</span>
          </span>
        ) : (
          <span className="text-[11px] text-text-muted">
            {servers.filter((s) => s.enabled).length} watched
          </span>
        )}
        <span className="shrink-0 text-[11px] text-text-muted">
          {running ? `every ${POLL_MS / 1000}s` : "paused"}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button onClick={() => void setRunning(!running)}
            title={running ? "Pause polling" : "Resume polling"}
            className="rounded-md p-1.5 transition hover:bg-white/5"
            style={{ color: running ? "var(--text-muted)" : "var(--accent)" }}>
            {running ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button onClick={() => setShowServers((v) => !v)} title="Servers"
            className="rounded-md p-1.5 transition hover:bg-white/5"
            style={{ color: showServers ? "var(--accent)" : "var(--text-muted)" }}>
            <ServerIcon size={14} />
          </button>
          <button onClick={() => { setBusy(true); void refresh().finally(() => setBusy(false)); }}
            disabled={busy} title="Poll now"
            className="rounded-md p-1.5 text-text-muted transition hover:bg-white/5 hover:text-text-primary disabled:opacity-40">
            <RotateCw size={14} className={busy ? "animate-spin" : ""} />
          </button>
        </span>
      </div>

      {showServers && (
        <div className="mb-5 rounded-xl border border-subtle p-3" style={{ background: "var(--bg-card-glass)" }}>
          <ServerList servers={servers} onChange={(s) => void setServers(s)} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {servers.length === 0
          ? <p className="text-sm text-text-muted">No servers yet — add one with the server button above.</p>
          : servers.map((s) => (
              <ServerPanel key={s.id} server={s} watch={getWatch(s.id)} now={now}
                showTitle={servers.length > 1} />
            ))}
      </div>
    </div>
  );
}

/**
 * The footer readout: the newest build, and whether watching is paused.
 *
 * Worth a permanent line rather than only the tab, because the thing this plugin exists to tell
 * you — the backend redeployed — is something you want to notice without having gone looking.
 * The notification is the alert; this is the at-a-glance state.
 *
 * Deck renders it beside RAM and VPS, and Settings > Footer can hide or reorder it like any
 * other readout. Clicking opens the tab.
 */
export function Status() {
  useSyncExternalStore(subscribe, getVersion);
  const [open, setOpen] = useState(false);
  const servers = getServers().filter((s) => s.enabled);
  const running = isRunning();

  // Newest build across the watched servers. With one server — the common case — this is just
  // its build; with several, the most recently seen tells you something changed somewhere.
  let newest: { name: string; watch: Watch } | null = null;
  for (const s of servers) {
    const w = getWatch(s.id);
    if (!w.buildId) continue;
    if (!newest || (w.lastChecked ?? 0) > (newest.watch.lastChecked ?? 0)) newest = { name: s.name, watch: w };
  }

  if (!servers.length) return null;

  const d = newest ? decode(newest.watch.buildId) : null;
  const failing = !!newest?.watch.lastError;
  // Paused is the state most worth flagging: a stale build id looks identical to a current one,
  // and the only difference is whether anything is still checking.
  const color = !running ? "var(--text-muted)" : failing ? "var(--danger)" : "var(--accent)";
  const label = !newest ? "no build yet"
    : d ? `${d.label} · ${d.commit}`
    : newest.watch.buildId.slice(0, 18);

  return (
    <StatusPopover
      open={open}
      onToggle={() => setOpen((v) => !v)}
      onClose={() => setOpen(false)}
      item={<StatusItem
        icon={<Radar size={10} />}
        color={color}
        label={`${label}${!running ? " (paused)" : ""}`}
        title={`${newest?.name ?? "Builds"} — ${running ? "watching" : "paused"}`}
      />}
    >
      <PanelHead label="Builds" value={running ? "watching" : "paused"} />
      <div className="max-h-64 overflow-auto pb-1">
        {servers.map((s) => {
          const w = getWatch(s.id);
          const sd = decode(w.buildId);
          return (
            <div key={s.id} className="px-2.5 py-1.5 text-[11px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-text-primary">{s.name}</span>
                <span className="shrink-0 text-[10px] text-text-muted">
                  {w.lastChecked ? ago(w.lastChecked) : "never"}
                </span>
              </div>
              <div className="truncate text-[10px] text-text-muted">
                {w.lastError
                  ? <span style={{ color: "var(--danger)" }}>{w.lastError}</span>
                  : sd ? `${sd.label} · ${sd.commit}` : w.buildId || "no build yet"}
              </div>
            </div>
          );
        })}
      </div>
      {/* The actions are the point of the panel: a readout you can only look at may as well be
          text, and these are the two things you want without opening the tab. */}
      <div className="flex gap-1 border-t border-subtle p-1.5">
        <button
          onClick={() => { void refresh(); }}
          className="flex-1 rounded px-2 py-1 text-[11px] text-text-secondary transition hover:bg-white/10 hover:text-text-primary"
        >
          Check now
        </button>
        <button
          onClick={() => { void setRunning(!running); }}
          className="flex-1 rounded px-2 py-1 text-[11px] text-text-secondary transition hover:bg-white/10 hover:text-text-primary"
        >
          {running ? "Pause" : "Resume"}
        </button>
        <button
          onClick={() => {
            setOpen(false);
            window.dispatchEvent(new CustomEvent("deck-navigate", { detail: "buildmon" }));
          }}
          className="flex-1 rounded px-2 py-1 text-[11px] text-text-secondary transition hover:bg-white/10 hover:text-text-primary"
        >
          Open
        </button>
      </div>
    </StatusPopover>
  );
}

/**
 * Command-palette entries.
 *
 * Called each time the palette opens rather than registered once, so the per-server entries
 * reflect the servers being watched now.
 */
export function commands() {
  const servers = getServers();
  return [
    {
      id: "check",
      title: "Builds: check now",
      run: () => { void refresh().then(() => toast("Checked for new builds")); },
    },
    {
      id: "toggle",
      title: isRunning() ? "Builds: pause watching" : "Builds: resume watching",
      run: () => {
        const next = !isRunning();
        void setRunning(next).then(() => toast(next ? "Watching builds" : "Build watching paused"));
      },
    },
    // One per server: the build id is the thing you actually want to paste into a ticket.
    ...servers.filter((s) => s.enabled).map((s) => ({
      id: `copy:${s.id}`,
      title: `Builds: copy ${s.name} build id`,
      run: () => {
        const id = getWatch(s.id).buildId;
        if (!id) { toast(`No build seen for ${s.name} yet`, "error"); return; }
        void navigator.clipboard.writeText(id).then(
          () => toast(`Copied ${id}`, "success"),
          () => toast("Could not copy to the clipboard", "error"),
        );
      },
    })),
  ];
}
