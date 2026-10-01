// Reading a build id, and deciding when one has changed.
//
// Separate from the polling and the UI so it is pure and testable: the two build-id formats and
// the "record only changes" rule are the whole of the logic worth getting right, and neither
// needs a network call or a browser to check. See build.check.mjs.

/** One server being watched. */
export interface Server {
  id: string;
  name: string;
  /** Base URL, no trailing slash. The build id is read from `${url}/api/v2/build-id`. */
  url: string;
  enabled: boolean;
}

/** One recorded change. Only appended when the build id actually differs. */
export interface Entry {
  buildId: string;
  /** Unix millis when the change was first seen. */
  seenAt: number;
}

/** Live state for one server, held in memory and mirrored to config. */
export interface Watch {
  serverId: string;
  buildId: string;
  /** Unix millis of the last poll attempt, whether or not it succeeded. */
  lastChecked: number | null;
  /** HTTP status of the last attempt; 0 for a transport error. */
  lastStatus: number;
  lastError: string;
  polls: number;
  history: Entry[];
}

/** A build id split into its parts, or null when it matches neither known shape. */
export interface Decoded {
  /** "1.5.10" for a dotted id, "dev" for a dashed one. */
  label: string;
  commit: string;
  /** The build's own timestamp, as unix millis. */
  builtAt: number | null;
}

/**
 * Parse a "YYYYMMDDHHMMSS" stamp as LOCAL time.
 *
 * Deliberately local rather than UTC: the servers are built in the same timezone they are read
 * in, and treating the stamp as UTC shifted every build by the offset — which showed as a build
 * that had not happened yet.
 */
export function stampToMillis(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m.map(Number) as unknown as number[];
  const t = new Date(y, mo - 1, d, h, mi, sec).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Split a build id into version, commit and build time.
 *
 * Two shapes are in the wild, and both are still in the history:
 *   dotted  1.5.10.7b3028d.20260619113412   version . commit . stamp
 *   dashed  dev-b1215f8-20260804121329      branch - commit - stamp
 * Anything else returns null rather than a guess — a wrong commit hash is worse than none.
 */
export function decode(buildId: string): Decoded | null {
  const id = (buildId ?? "").trim();
  if (!id) return null;

  const dots = id.split(".");
  if (dots.length >= 5) {
    return {
      label: `v${dots.slice(0, 3).join(".")}`,
      commit: dots[3],
      builtAt: stampToMillis(dots[4]),
    };
  }

  const dash = id.split("-");
  if (dash.length >= 3) {
    return {
      // The branch may itself contain dashes ("release-2-x"), so it is everything but the last two.
      label: dash.slice(0, -2).join("-"),
      commit: dash[dash.length - 2],
      builtAt: stampToMillis(dash[dash.length - 1]),
    };
  }
  return null;
}

/**
 * Fold a polled build id into a watch.
 *
 * Returns the next watch and whether this was a CHANGE — which is what the caller notifies on.
 * A change is recorded once: the history holds transitions, not polls, which is why 12 entries
 * cover three months of minute-by-minute watching.
 *
 * An empty id (a failed poll) never counts as a change. Otherwise a server that went down would
 * record a "change" to nothing, and another one back when it returned.
 */
export function fold(watch: Watch, buildId: string, at: number, status: number, error = ""): {
  next: Watch;
  changed: boolean;
} {
  const polls = watch.polls + 1;
  const base = { ...watch, polls, lastChecked: at, lastStatus: status, lastError: error };

  if (!buildId) return { next: base, changed: false };
  if (buildId === watch.buildId) return { next: { ...base, buildId }, changed: false };

  // The first successful poll after a restart is not a change to announce — it is the state
  // catching up with a history that already knows this build.
  const known = watch.history.some((e) => e.buildId === buildId);
  const first = !watch.buildId && known;

  return {
    next: {
      ...base,
      buildId,
      history: known ? watch.history : [...watch.history, { buildId, seenAt: at }],
    },
    changed: !first && !!watch.buildId,
  };
}

/** A fresh watch for a server that has never been polled. */
export const emptyWatch = (serverId: string): Watch => ({
  serverId, buildId: "", lastChecked: null, lastStatus: 0, lastError: "", polls: 0, history: [],
});

/** "2m ago" / "just now". Used for both the last poll and how old a build is. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
