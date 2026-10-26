package dev.quest.usbforwarder;

import java.util.function.LongSupplier;

/** Bounded receiver-authorized lease. A dispatched request is not proof of device effect. */
public final class ProximityLease {
    public interface Effects { void requestClose(); void release(); }
    private final LongSupplier clock;
    private final Effects effects;
    private long expires, lastRequest, requests, releases;
    private boolean owned, blocked;
    private String lastError;
    public ProximityLease(LongSupplier clock, Effects effects) { this.clock = clock; this.effects = effects; }
    public synchronized void newConnection() { disconnect(); blocked = false; lastError = null; }
    public synchronized void renew(int milliseconds) {
        if (milliseconds == 0) { disconnect(); return; }
        if (milliseconds < 1000 || milliseconds > 10000) throw new IllegalArgumentException("Lease outside allowed bounds");
        expires = clock.getAsLong() + milliseconds; tick();
    }
    public synchronized void tick() {
        long now = clock.getAsLong();
        if (expires == 0 || now >= expires) { disconnect(); return; }
        if (blocked || (owned && now - lastRequest < 2000)) return;
        try { effects.requestClose(); owned = true; lastRequest = now; ++requests; }
        catch (RuntimeException error) { blocked = true; lastError = error.getClass().getSimpleName(); }
    }
    public synchronized void disconnect() {
        expires = 0;
        if (!owned) return;
        try { effects.release(); ++releases; }
        catch (RuntimeException error) { lastError = error.getClass().getSimpleName(); }
        finally { owned = false; }
    }
    public synchronized long remainingMs() { return Math.max(0, expires - clock.getAsLong()); }
    public synchronized long requests() { return requests; }
    public synchronized long releases() { return releases; }
    public synchronized boolean requested() { return owned; }
    public synchronized boolean blocked() { return blocked; }
    public synchronized String error() { return lastError; }
}
