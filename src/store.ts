// The poller, and everything it keeps.
//
// At module scope rather than in the component, for the reason Deck's own CLAUDE.md gives:
// a module unmounts the moment you navigate away, and a monitor that only watches while you are
// looking at it is not a monitor. The component subscribes; the polling is independent of it.
import { configRead, configWrite, notifyOs } from "../shim/bridge.js";
import { emptyWatch, fold, decode, type Entry, type Server, type Watch } from "./build";

const CFG = "plugin-buildmon";
export const POLL_MS = 60_000;

interface Stored {
  servers: Server[];
  /** Whether polling runs at all. Persisted, so switching it off survives a restart — otherwise
   *  Deck would quietly start watching again every launch, which is the opposite of what the
   *  switch is for. */
  running?: boolean;
  /** Keyed by server id. Only the history and the last-known build are worth persisting. */
  watches: Record<string, { buildId: string; history: Entry[] }>;
}

/**
 * None. This plugin is published, and a default here is a server every new install starts
 * polling — it used to be one particular company's dev API, switched on. An existing install
 * keeps the list it saved; a new one adds its own from the empty state.
 */
const DEFAULT_SERVERS: Server[] = [];

let servers: Server[] = DEFAULT_SERVERS;
let watches: Record<string, Watch> = {};
let timer: ReturnType<typeof setInterval> | null = null;
let loaded = false;
// Assumed on until the stored value says otherwise: a first run should watch, and the load
// below flips it off before the first tick if that is what was saved.
let running = true;

// useSyncExternalStore's contract: subscribers are told something changed, and read the value
// themselves. The version counter is what makes the snapshot comparable by identity.
let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; listeners.forEach((f) => f()); };

export const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const getVersion = () => version;
export const getServers = () => servers;
export const isRunning = () => running;
export const getWatch = (id: string) => watches[id] ?? emptyWatch(id);

// What was last read or written, so a poll that learned nothing new writes nothing. Every config
// write wakes every `config-changed` listener in Deck, and this runs once a minute.
let lastSaved = "";

async function save() {
  const stored: Stored = {
    servers,
    running,
    watches: Object.fromEntries(
      Object.entries(watches).map(([k, w]) => [k, { buildId: w.buildId, history: w.history }]),
    ),
  };
  const text = JSON.stringify(stored);
  if (text === lastSaved) return;
  lastSaved = text;
  await configWrite(CFG, text).catch(() => {});
}

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const t = await configRead(CFG);
    lastSaved = t;
    if (t.trim()) {
      const s = JSON.parse(t) as Stored;
      if (Array.isArray(s.servers) && s.servers.length) servers = s.servers;
      // Only an explicit false switches it off — an older file has no such field and should keep
      // polling rather than silently stop.
      if (s.running === false) running = false;
      for (const [id, w] of Object.entries(s.watches ?? {})) {
        watches[id] = { ...emptyWatch(id), buildId: w.buildId ?? "", history: w.history ?? [] };
      }
    }
  } catch { /* a corrupt file is not worth failing the tab for */ }
  emit();
}

/** Poll one server. Never throws — a server being down is a state, not an error. */
async function pollOne(s: Server) {
  const at = Date.now();
  let buildId = "", status = 0, error = "";
  try {
    // AbortSignal.timeout rather than a hand-rolled race: an unreachable host otherwise leaves
    // the request hanging until the browser's own (very long) default.
    const res = await fetch(`${s.url.replace(/\/+$/, "")}/api/v2/build-id`,
      { signal: AbortSignal.timeout(15_000) });
    status = res.status;
    if (res.ok) {
      buildId = ((await res.json()) as { build_id?: string }).build_id ?? "";
      if (!buildId) error = "no build_id in the reply";
    } else {
      error = `HTTP ${res.status}`;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const { next, changed } = fold(getWatch(s.id), buildId, at, status, error);
  watches[s.id] = next;

  if (changed) {
    const d = decode(buildId);
    void notifyOs(`${s.name} redeployed`, d ? `${d.label} · ${d.commit}` : buildId).catch(() => {});
  }
  return changed;
}

async function tick() {
  await load();
  if (!running) return;
  const on = servers.filter((s) => s.enabled);
  // Settled, not all: one unreachable server must not stop the others being polled.
  const results = await Promise.allSettled(on.map(pollOne));
  if (results.length) { await save(); emit(); }
}

/** Stop polling. Deck calls this (through the plugin's `dispose`) before a reload re-imports the
 *  plugin; the fresh copy starts its own timer. */
export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Start polling. Idempotent within one copy of the module; a reload is covered by `stop`. */
export function start() {
  if (timer) return;
  void tick();
  timer = setInterval(() => { void tick(); }, POLL_MS);
}

/**
 * Poll every enabled server now, without waiting for the next tick.
 *
 * Deliberately works while paused: the refresh button is an explicit ask, and refusing it would
 * mean pausing also takes away the manual check, which is the thing you want while paused.
 */
export async function refresh() {
  await load();
  const on = servers.filter((s) => s.enabled);
  await Promise.allSettled(on.map(pollOne));
  await save();
  emit();
}

/** Stop or resume polling. Persisted, and takes effect on the next tick either way. */
export async function setRunning(next: boolean) {
  running = next;
  await save();
  emit();
  if (next) void tick();
}

/** Milliseconds until the next scheduled poll, for the countdown. */
export function nextPollIn(): number {
  if (!running) return 0;
  const last = Math.max(0, ...Object.values(watches).map((w) => w.lastChecked ?? 0));
  return last ? Math.max(0, POLL_MS - (Date.now() - last)) : 0;
}

export async function setServers(next: Server[]) {
  servers = next;
  // Drop the watches of servers that no longer exist, so their history does not linger invisibly.
  const ids = new Set(next.map((s) => s.id));
  watches = Object.fromEntries(Object.entries(watches).filter(([id]) => ids.has(id)));
  await save();
  emit();
  void tick();
}

/**
 * Seed history for a server that has none.
 *
 * For carrying the old Python monitor's build_history.json across: it recorded the same
 * transitions, so importing it means the graph starts with three months of data rather than
 * today. Refuses to overwrite a history that already has entries.
 */
export async function seedHistory(serverId: string, entries: Entry[]): Promise<number> {
  const w = getWatch(serverId);
  if (w.history.length) return 0;
  const sorted = [...entries].sort((a, b) => a.seenAt - b.seenAt);
  watches[serverId] = { ...w, history: sorted, buildId: w.buildId || sorted.at(-1)?.buildId || "" };
  await save();
  emit();
  return sorted.length;
}
