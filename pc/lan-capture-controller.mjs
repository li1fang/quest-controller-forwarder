import { createCaptureSession } from './capture-session.mjs';

/** Transport/preview lifetime is independent of each immutable recording session. */
export function createLanCaptureController({ hub, root, source, makeSession = createCaptureSession, initialRecording, log = () => {} }) {
  let active = null, producer = null, operation = Promise.resolve(), shuttingDown = false, generation = 0;
  let last = initialRecording ?? { state: 'idle', frames: 0, packets: 0, dual_6dof_frames: 0, missing_packets: 0, directory: null };
  hub.recording(last); hub.phase('preview');
  const enqueue = action => { const pending = operation.then(action); operation = pending.catch(() => {}); return pending; };
  function publish(value) { last = value; hub.recording(value); }
  const controller = {
    status: () => active?.status() ?? last,
    start(context = {}) { return enqueue(() => {
      if (shuttingDown) throw new Error('LAN service is shutting down');
      if (active) return active.status();
      const current = ++generation;
      try {
        active = makeSession({ root, source: { ...source, ...(context.validation ? { validation: context.validation } : {}) },
          onUpdate: value => { if (current === generation) publish(value); },
          onError: error => { hub.error(error); queueMicrotask(() => controller.stop('recording_error').catch(error => hub.error(error))); } });
        if (producer) active.connected(producer);
        hub.clearError(); hub.phase('recording'); publish(active.status());
        log(`Recording session: ${active.directory}`); return active.status();
      } catch (error) {
        hub.error(error); if (!active) publish({ state: 'failed', error: error.message, directory: null, frames: 0, dual_6dof_frames: 0, missing_packets: 0 });
        throw error;
      }
    }); },
    stop(reason = 'user_stop') { return enqueue(async () => {
      if (!active) return last;
      const session = active; active = null;
      publish({ ...session.status(), state: 'stopping' });
      try {
        const result = await session.close(reason); publish(result); hub.phase('preview');
        log(`Recording ${result.state}: ${result.directory} (${result.frames} frames)`); return result;
      } catch (error) { hub.error(error); publish({ ...session.status(), state: 'failed', error: error.message }); throw error; }
    }); },
    connected(meta) { producer = meta; active?.connected(meta); hub.connected(); },
    disconnected(meta) {
      if (producer?.connection_id === meta.connection_id) producer = null;
      if (active?.status().state === 'recording') active.event('disconnected', { connection_id: meta.connection_id, app_run_id: meta.app_run_id });
      hub.disconnected();
    },
    packet(packet, meta) {
      const received = active ? active.packet(packet, meta) : { ...packet, received_at_utc: new Date().toISOString(), pc_monotonic_ns: process.hrtime.bigint().toString() };
      hub.packet(received);
      return received;
    },
    event(kind, details) { if (active?.status().state === 'recording') return active.event(kind, details); },
    error(error) {
      hub.error(error);
      if (active?.status().state === 'recording') try { active.event('transport_error', { message: String(error.message).slice(0, 200) }); } catch { /* Recorder requests its own stop. */ }
    },
    shutdown(reason = 'service_shutdown') { shuttingDown = true; return controller.stop(reason); },
  };
  return controller;
}
