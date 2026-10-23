"use client";

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import Link from "next/link";
import type { AdminDevice, AdminEvent, AdminStatus, Role } from "@/lib/tracker";
import { formatAgo, formatClock, formatClockSeconds, formatUptime } from "@/lib/format";
import { DrumCounter } from "../drum-counter";

// Polling this fast is what keeps the sensors on their fast check-in rate.
const POLL_MS = 1000;
const MAX_RANGE_MM = 1300;

type View = "loading" | "signin" | "unconfigured" | "ready";
type Act = (action: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

export default function AdminPage() {
  const [view, setView] = useState<View>("loading");
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [now, setNow] = useState(0);
  const [unreachable, setUnreachable] = useState(false);
  const [token, setToken] = useState<{ name: string; value: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/status", { cache: "no-store" });
      if (response.status === 401) return setView("signin");
      if (response.status === 503) return setView("unconfigured");
      if (!response.ok) throw new Error(String(response.status));
      setStatus(await response.json());
      setNow(Date.now());
      setUnreachable(false);
      setView("ready");
    } catch {
      setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    if (view === "signin" || view === "unconfigured") return;
    const first = setTimeout(refresh, 0);
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [view, refresh]);

  const act: Act = useCallback(
    async (action, payload = {}) => {
      const response = await fetch("/api/admin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      if (response.status === 401) {
        setView("signin");
        return null;
      }
      const result = await response.json().catch(() => null);
      await refresh();
      return response.ok ? result : null;
    },
    [refresh],
  );

  async function signOut() {
    await fetch("/api/admin/logout", { method: "POST" });
    setStatus(null);
    setView("signin");
  }

  return (
    <main className="admin">
      <header className="admin-head">
        <span className="wordmark">
          Rec Tracker <small>/ Admin</small>
        </span>
        <nav>
          <Link href="/">Public page</Link>
          {view === "ready" && (
            <button className="btn-link" onClick={signOut}>
              Sign out
            </button>
          )}
        </nav>
      </header>

      {view === "loading" && <p className="hint">{unreachable ? "Can't reach the server. Still trying." : "Loading…"}</p>}
      {view === "unconfigured" && (
        <section className="panel signin">
          <h1 className="panel-title">Admin is switched off</h1>
          <p>
            Set an <code>ADMIN_PASSWORD</code> environment variable for this project, then redeploy. The admin page
            stays locked until one exists.
          </p>
        </section>
      )}
      {view === "signin" && <SignIn onSignedIn={() => setView("loading")} />}

      {view === "ready" && status && (
        <>
          {unreachable && <p className="error">Can&rsquo;t reach the server. Showing the last values received.</p>}
          {token && <TokenReveal token={token} onDone={() => setToken(null)} />}
          <CountPanel status={status} act={act} />

          <section>
            <h2 className="panel-title">Sensors</h2>
            {status.devices.length === 0 ? (
              <p className="panel">No sensors yet. Add one below to get the token its firmware needs.</p>
            ) : (
              <div className="sensors">
                {status.devices.map((device) => (
                  <SensorCard
                    key={device.id}
                    device={device}
                    now={now}
                    act={act}
                    onToken={(value) => setToken({ name: device.name, value })}
                  />
                ))}
              </div>
            )}
          </section>

          <AddSensor act={act} onToken={setToken} />
          <Activity events={status.events} />
        </>
      )}
    </main>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.ok) return onSignedIn();
      setError(response.status === 401 ? "That password isn't right." : "Sign-in failed. Try again.");
    } catch {
      setError("Can't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel signin" onSubmit={submit}>
      <h1 className="panel-title">Admin sign-in</h1>
      <label className="field">
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          required
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn btn-solid" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function CountPanel({ status, act }: { status: AdminStatus; act: Act }) {
  const [resetTime, setResetTime] = useState(status.resetTime);
  const [saved, setSaved] = useState(status.resetTime);
  // Follow the server's value unless the field has an unsaved edit in it.
  if (status.resetTime !== saved) {
    setSaved(status.resetTime);
    setResetTime(status.resetTime);
  }

  return (
    <section className="panel count-panel">
      <DrumCounter value={status.occupancy} />
      <div className="count-side">
        <h1 className="panel-title" style={{ margin: 0 }}>
          People counted in the Rec
        </h1>
        <div className="row">
          <button className="btn" onClick={() => act("adjust", { delta: -1 })} disabled={status.occupancy === 0}>
            Subtract 1
          </button>
          <button className="btn" onClick={() => act("adjust", { delta: 1 })}>
            Add 1
          </button>
          <button
            className="btn btn-danger"
            onClick={() => confirm("Reset the count to 0? The public page changes right away.") && act("reset")}
          >
            Reset count to 0
          </button>
        </div>
        <p className="facts">
          <span>
            Peak today <b>{status.peak}</b>
            {status.peakAt && ` at ${formatClock(status.peakAt)}`}
          </span>
          <span>
            Last reset <b>{formatClock(status.lastResetAt)}</b>
          </span>
          <span>
            Sensors online{" "}
            <b>
              {status.sensors.online} of {status.sensors.total}
            </b>
          </span>
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            act("setResetTime", { resetTime });
          }}
        >
          <label className="field">
            Nightly reset time (Houston time)
            <input type="time" value={resetTime} onChange={(e) => setResetTime(e.target.value)} required />
          </label>
          <button className="btn" disabled={resetTime === status.resetTime}>
            Save reset time
          </button>
        </form>
        <ThresholdsForm thresholds={status.thresholds} act={act} />
      </div>
    </section>
  );
}

// Where the public label switches between plenty of room, getting busy and packed.
function ThresholdsForm({ thresholds, act }: { thresholds: AdminStatus["thresholds"]; act: Act }) {
  const [quiet, setQuiet] = useState(String(thresholds.quietBelow));
  const [busy, setBusy] = useState(String(thresholds.busyFrom));
  const [saved, setSaved] = useState(thresholds);
  if (thresholds.quietBelow !== saved.quietBelow || thresholds.busyFrom !== saved.busyFrom) {
    setSaved(thresholds);
    setQuiet(String(thresholds.quietBelow));
    setBusy(String(thresholds.busyFrom));
  }
  const q = Number(quiet);
  const b = Number(busy);
  const valid = Number.isInteger(q) && Number.isInteger(b) && q >= 1 && q < b;
  const changed = q !== thresholds.quietBelow || b !== thresholds.busyFrom;

  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        act("setThresholds", { quietBelow: q, busyFrom: b });
      }}
    >
      <label className="field">
        &ldquo;Plenty of room&rdquo; below
        <input type="number" min={1} value={quiet} onChange={(e) => setQuiet(e.target.value)} required />
      </label>
      <label className="field">
        &ldquo;Packed&rdquo; from
        <input type="number" min={2} value={busy} onChange={(e) => setBusy(e.target.value)} required />
      </label>
      <button className="btn" disabled={!valid || !changed}>
        Save busy levels
      </button>
      {!valid && <p className="error">The first number has to be smaller than the second.</p>}
    </form>
  );
}

function calibrationNote(device: AdminDevice, now: number): string | null {
  const calibration = device.calibration;
  if (!calibration) return null;
  const ageMs = now - new Date(calibration.at).getTime();
  switch (calibration.state) {
    case "waiting":
      return "Recalibrate requested. Waiting for the sensor to check in…";
    case "running":
      return "Measuring the empty lane…";
    case "done":
      return ageMs < 120_000
        ? `Recalibrated at ${formatClockSeconds(calibration.at)}. Empty lane: ${device.baselineMm ?? "?"} mm.`
        : null;
    case "expired":
      return ageMs < 600_000 ? "Recalibrate dropped: the sensor didn't check in within 90 seconds. Try again once it's online." : null;
  }
}

// What the unit's report error codes mean, in plain words.
function reportError(code: number | null): string {
  if (code === null || code === 0) return "";
  if (code === -1) return "couldn't connect";
  if (code === -11) return "no reply in time";
  if (code === -5 || code === -4) return "connection dropped";
  if (code === -2 || code === -3) return "couldn't send";
  if (code === 401) return "token rejected";
  if (code >= 500) return "website error";
  return `code ${code}`;
}

// An "empty lane" this short means something was in front of the sensor.
const BLOCKED_LANE_MM = 300;

function SensorCard({
  device,
  now,
  act,
  onToken,
}: {
  device: AdminDevice;
  now: number;
  act: Act;
  onToken: (token: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [role, setRole] = useState<Role>(device.role);

  const scale = Math.min(MAX_RANGE_MM, Math.max(device.baselineMm ?? 0, device.distanceMm ?? 0, 1));
  const percent = (mm: number | null) => `${Math.min(100, ((mm ?? 0) / scale) * 100)}%`;
  const note = calibrationNote(device, now);
  const calibrating = device.calibration?.state === "waiting" || device.calibration?.state === "running";
  const show = (value: number | string | null, unit = "") => (value === null ? "–" : `${value}${unit}`);
  const blocked = device.baselineMm !== null && device.baselineMm < BLOCKED_LANE_MM;
  const lastError = reportError(device.lastError);

  return (
    <article className="panel">
      <div className="sensor-head">
        <div>
          <h3 className="sensor-name">{device.name}</h3>
          <span className="role">{device.role === "entrance" ? "Entrance · adds" : "Exit · subtracts"}</span>
        </div>
        <span className={`lamp ${device.online ? "lamp-go" : device.lastSeenAt ? "lamp-warn" : "lamp-off"}`}>
          <span>
            {device.online ? "Online" : device.lastSeenAt ? "Offline" : "Never seen"}
            {device.lastSeenAt && <span className="sensor-seen">checked in {formatAgo(device.lastSeenAt, now)}</span>}
          </span>
        </span>
      </div>

      {device.lastSeenAt === null ? (
        <p className="sensor-note">
          This sensor hasn&rsquo;t checked in yet. Put its token in the firmware&rsquo;s <code>config.h</code> and upload.
        </p>
      ) : (
        <>
          {!device.online && <p className="sensor-note">Offline. The values below are from its last check-in.</p>}
          <div className="lane" role="img" aria-label={`Live distance ${show(device.distanceMm, " mm")}`}>
            <div
              className={`lane-fill ${device.present ? "is-blocked" : ""}`}
              style={{ "--at": percent(device.distanceMm) } as CSSProperties}
            />
            <div className="lane-trigger" style={{ "--at": percent(device.thresholdMm) } as CSSProperties} />
          </div>
          <div className="lane-caption">
            <span>Sensor</span>
            <span>{device.present ? "Someone in the lane" : "Lane clear"}</span>
            <span>Far side</span>
          </div>

          <dl className="readings">
            <Reading label="Live distance" value={show(device.distanceMm, " mm")} />
            <Reading label="Empty lane" value={show(device.baselineMm, " mm")} />
            <Reading label="Counts closer than" value={show(device.thresholdMm, " mm")} />
            <Reading label="Readings per second" value={show(device.readingsPerSec)} />
            <Reading
              label="Sensor"
              value={device.sensorOk === false ? "not responding" : show(device.sensorStatus)}
              bad={device.sensorOk === false}
            />
            <Reading label="Sensor restarts" value={show(device.sensorRestarts)} />
            <Reading label="Counted since reset" value={show(device.localCount)} />
            <Reading label="WiFi signal" value={show(device.rssi, " dBm")} bad={device.rssi !== null && device.rssi < -80} />
            <Reading label="Running for" value={device.uptimeS === null ? "–" : formatUptime(device.uptimeS)} />
            <Reading label="Last started because" value={show(device.resetReason)} />
            <Reading
              label="Failed reports"
              value={device.checkinFailures === null ? "–" : `${device.checkinFailures}${lastError && device.checkinFailures > 0 ? ` (${lastError})` : ""}`}
            />
            <Reading label="Free memory" value={device.freeHeap === null ? "–" : `${Math.round(device.freeHeap / 1024)} kB`} />
          </dl>
          {blocked && (
            <p className="sensor-note sensor-warning">
              The empty lane measured only {device.baselineMm} mm, so this sensor counts nothing farther than{" "}
              {device.thresholdMm} mm. Something was in front of it when it calibrated. Point it across the empty lane
              and press Recalibrate.
            </p>
          )}
        </>
      )}

      {note && <p className="sensor-note">{note}</p>}

      {editing ? (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            await act("updateDevice", { id: device.id, name, role });
            setEditing(false);
          }}
        >
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
          </label>
          <label className="field">
            Counts as
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="entrance">Entrance (adds)</option>
              <option value="exit">Exit (subtracts)</option>
            </select>
          </label>
          <button className="btn btn-solid">Save sensor</button>
          <button type="button" className="btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="sensor-actions">
          <button
            className="btn btn-solid"
            disabled={!device.online || calibrating}
            onClick={() =>
              confirm("Recalibrate measures the empty lane for 2 seconds. Make sure nobody is in it, then press OK.") &&
              act("calibrate", { id: device.id })
            }
          >
            Recalibrate
          </button>
          <button className="btn" onClick={() => setEditing(true)}>
            Rename or change role
          </button>
          <button
            className="btn"
            onClick={async () => {
              if (!confirm(`Make a new token for ${device.name}? Its current token stops working right away.`)) return;
              const result = await act("rotateToken", { id: device.id });
              if (typeof result?.token === "string") onToken(result.token);
            }}
          >
            New token
          </button>
          <button
            className="btn btn-danger"
            onClick={() => confirm(`Remove ${device.name}? Its token stops working. The count is not changed.`) && act("deleteDevice", { id: device.id })}
          >
            Remove sensor
          </button>
        </div>
      )}
      {!editing && !device.online && (
        <p className="hint" style={{ marginTop: "0.75rem" }}>
          Recalibrate needs the sensor online: the request is picked up at its next check-in.
        </p>
      )}
      {device.firmware && <p className="hint" style={{ marginTop: "0.75rem" }}>Firmware {device.firmware}</p>}
    </article>
  );
}

function Reading({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={bad ? "is-bad" : undefined}>{value}</dd>
    </div>
  );
}

function AddSensor({ act, onToken }: { act: Act; onToken: (token: { name: string; value: string }) => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("entrance");

  return (
    <section className="panel">
      <h2 className="panel-title">Add a sensor</h2>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await act("createDevice", { name, role });
          if (typeof result?.token === "string") {
            onToken({ name: name.trim(), value: result.token });
            setName("");
          }
        }}
      >
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Entrance left" maxLength={40} required />
        </label>
        <label className="field">
          Counts as
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="entrance">Entrance (adds)</option>
            <option value="exit">Exit (subtracts)</option>
          </select>
        </label>
        <button className="btn btn-solid">Add sensor</button>
      </form>
    </section>
  );
}

function TokenReveal({ token, onDone }: { token: { name: string; value: string }; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel" aria-live="polite">
      <h2 className="panel-title">Token for {token.name}</h2>
      <p>
        Paste this into <code>DEVICE_TOKEN</code> in the firmware&rsquo;s <code>config.h</code>. It is shown only once; if
        you lose it, make a new one from the sensor&rsquo;s card.
      </p>
      <div className="token">
        <code>{token.value}</code>
        <div className="row">
          <button
            className="btn btn-solid"
            onClick={async () => {
              await navigator.clipboard.writeText(token.value);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy token"}
          </button>
          <button className="btn" onClick={onDone}>
            I&rsquo;ve saved it
          </button>
        </div>
      </div>
    </section>
  );
}

const EVENT_LABEL: Record<AdminEvent["kind"], string> = {
  count: "",
  reset: "Reset from this page",
  nightly_reset: "Nightly reset",
  adjust: "Adjusted by hand",
};

function Activity({ events }: { events: AdminEvent[] }) {
  return (
    <section className="panel">
      <h2 className="panel-title">Recent changes to the count</h2>
      {events.length === 0 ? (
        <p className="hint">Nothing yet. Counts appear here as people pass a sensor.</p>
      ) : (
        <ol className="activity">
          {events.map((event) => (
            <li key={event.id}>
              <time dateTime={event.at}>{formatClockSeconds(event.at)}</time>
              <span>
                {event.kind === "count" ? (event.device ?? "Removed sensor") : EVENT_LABEL[event.kind]}{" "}
                <b>{event.delta > 0 ? `+${event.delta}` : event.delta}</b>
              </span>
              <span className="after">now {event.occupancyAfter}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
