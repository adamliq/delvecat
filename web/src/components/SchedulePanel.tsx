import { useEffect, useState } from "react";
import { DAYS, describe, fromCron, readSchedule, saveSchedule, toCron, type Schedule, type When } from "../lib/schedule";

/** Build on a schedule: the app's own scheduled report of | delvecatbuild, with the parts
 * and options chosen above. */
export function SchedulePanel({ search }: { search: string }) {
  const [current, setCurrent] = useState<Schedule | null | undefined>(undefined);
  const [when, setWhen] = useState<When>(fromCron("17 2 * * *"));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    readSchedule()
      .then((s) => {
        setCurrent(s);
        if (s?.cron) setWhen(fromCron(s.cron));
      })
      .catch((e: Error) => { setCurrent(null); setError(e.message); });
  useEffect(() => { void load(); }, []);

  if (current === undefined) return null;
  if (current === null) {
    return (
      <section className="card">
        <h2>Schedule</h2>
        <p className="muted">The scheduled build report is not in this app (it ships with version 0.31 and later).</p>
      </section>
    );
  }
  const cron = toCron(when);
  const save = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await saveSchedule({ enabled, cron, search });
      setMessage(enabled ? `Scheduled: the catalog will be built ${describe(cron)} (Splunk's clock).` : "Scheduled builds are off.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const num = (v: string, max: number) => Math.min(max, Math.max(0, Number(v) || 0));

  return (
    <section className="card schedule">
      <h2>Schedule</h2>
      <p>
        {current.enabled
          ? <>Builds run {describe(current.cron)}{current.nextRun ? <>; next at {new Date(current.nextRun).toLocaleString()}</> : null}.</>
          : <>Builds run only when someone starts one.</>}
      </p>
      <p className="muted small">
        A scheduled build runs the parts and options selected below, as the app's own report "{SCHEDULE_TITLE}", and publishes
        like a build started here (it is not published if it is much smaller than the current catalog).
      </p>
      {current.canWrite ? (
        <form className="schedule-form" onSubmit={(e) => { e.preventDefault(); void save(true); }}>
          <label>How often
            <select value={when.frequency} onChange={(e) => setWhen({ ...when, frequency: e.target.value as When["frequency"], cron: when.frequency === "custom" ? when.cron : cron })}>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="custom">Custom (cron)</option>
            </select>
          </label>
          {when.frequency === "weekly" && (
            <label>On
              <select value={when.day} onChange={(e) => setWhen({ ...when, day: Number(e.target.value) })}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
          )}
          {when.frequency !== "custom" ? (
            <label>At
              <span className="time-inputs">
                <input type="number" min={0} max={23} value={when.hour} aria-label="Hour" onChange={(e) => setWhen({ ...when, hour: num(e.target.value, 23) })} />:
                <input type="number" min={0} max={59} value={when.minute} aria-label="Minute" onChange={(e) => setWhen({ ...when, minute: num(e.target.value, 59) })} />
              </span>
            </label>
          ) : (
            <label>Cron expression
              <input type="text" value={when.cron} onChange={(e) => setWhen({ ...when, cron: e.target.value })} placeholder="17 2 * * *" />
            </label>
          )}
          <div className="schedule-actions">
            <button type="submit" className="btn" disabled={busy || !cron}>{current.enabled ? "Update the schedule" : "Turn on"}</button>
            {current.enabled && <button type="button" className="btn btn-small" disabled={busy} onClick={() => void save(false)}>Turn off</button>}
          </div>
        </form>
      ) : (
        <p className="muted small">Only catalog publishers (delvecat_publisher) and admins can change the schedule.</p>
      )}
      {message && <p className="ok" role="status">{message}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const SCHEDULE_TITLE = "Licoryx Delvecat - scheduled build";
