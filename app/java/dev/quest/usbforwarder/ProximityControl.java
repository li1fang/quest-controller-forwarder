package dev.quest.usbforwarder;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.hardware.*;
import android.os.*;
import android.view.Display;
import org.json.JSONObject;
import java.util.concurrent.*;

/** App-UID candidate: no secure/global settings writes, root, shell commands or boot receiver. */
public final class ProximityControl implements SensorEventListener {
    private final Activity activity;
    private final PowerManager power;
    private final PowerManager.WakeLock wakeLock;
    private final SensorManager sensors;
    private final Sensor sensor;
    private final ProximityLease lease;
    private final ScheduledExecutorService timer;
    private volatile Float distance;
    private String sensorError;
    private long snapshotAt;
    private JSONObject cachedSnapshot;
    public ProximityControl(Activity activity) {
        this.activity = activity;
        power = (PowerManager) activity.getSystemService(Context.POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "QuestLAN:ReceiverLease");
        wakeLock.setReferenceCounted(false);
        sensors = (SensorManager) activity.getSystemService(Context.SENSOR_SERVICE);
        sensor = sensors.getDefaultSensor(Sensor.TYPE_PROXIMITY);
        if (sensor != null) try {
            if (!sensors.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL, new Handler(Looper.getMainLooper()))) sensorError = "registration_failed";
        } catch (RuntimeException error) { sensorError = error.getClass().getSimpleName(); }
        lease = new ProximityLease(SystemClock::elapsedRealtime, new ProximityLease.Effects() {
            public void requestClose() {
                wakeLock.acquire(15000);
                try { broadcast("com.oculus.vrpowermanager.prox_close"); }
                catch (RuntimeException error) { if (wakeLock.isHeld()) wakeLock.release(); throw error; }
            }
            public void release() {
                try { broadcast("com.oculus.vrpowermanager.automation_disable"); }
                finally { if (wakeLock.isHeld()) wakeLock.release(); }
            }
        });
        timer = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r, "quest-proximity-lease"); t.setDaemon(true); return t; });
        timer.scheduleAtFixedRate(lease::tick, 1, 1, TimeUnit.SECONDS);
    }
    private void broadcast(String action) { activity.sendBroadcast(new Intent(action).addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES)); }
    public void newConnection() { lease.newConnection(); }
    public void renew(int milliseconds) { lease.renew(milliseconds); }
    public void disconnected() { lease.disconnect(); }
    public synchronized JSONObject snapshot() {
        long now = SystemClock.elapsedRealtime();
        if (cachedSnapshot != null && now - snapshotAt < 500) return cachedSnapshot;
        JSONObject out = new JSONObject();
        try {
            out.put("schema", "quest-power-v1").put("app_uid", android.os.Process.myUid())
                .put("interactive", power.isInteractive()).put("device_idle_mode", power.isDeviceIdleMode())
                .put("power_save_mode", power.isPowerSaveMode()).put("window_focus", activity.hasWindowFocus())
                .put("lease_remaining_ms", lease.remainingMs()).put("override_requested", lease.requested())
                .put("request_count", lease.requests()).put("release_count", lease.releases()).put("request_blocked", lease.blocked())
                .put("control_error", lease.error() == null ? JSONObject.NULL : lease.error())
                .put("proximity_sensor_available", sensor != null)
                .put("proximity_sensor_error", sensorError == null ? JSONObject.NULL : sensorError)
                .put("proximity_distance", distance == null ? JSONObject.NULL : distance)
                .put("proximity_max_range", sensor == null ? JSONObject.NULL : sensor.getMaximumRange());
            Display display = activity.getWindowManager().getDefaultDisplay();
            out.put("display_state", display == null ? -1 : display.getState());
        } catch (Exception error) { try { out.put("diagnostic_error", error.getClass().getSimpleName()); } catch (Exception ignored) {} }
        snapshotAt = now; cachedSnapshot = out; return out;
    }
    public void onSensorChanged(SensorEvent event) { if (event.values.length > 0) distance = event.values[0]; }
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    public void close() { timer.shutdownNow(); lease.disconnect(); sensors.unregisterListener(this); }
}
