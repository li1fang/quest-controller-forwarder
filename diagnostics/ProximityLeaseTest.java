import dev.quest.usbforwarder.ProximityLease;

/** Pure policy tests: no device, broadcasts, network or Android classes. */
public final class ProximityLeaseTest {
    static long now;
    static int closes, releases;
    static boolean deny;
    static void check(boolean ok, String name) { if (!ok) throw new AssertionError(name); }
    public static void main(String[] args) {
        ProximityLease lease = new ProximityLease(() -> now, new ProximityLease.Effects() {
            public void requestClose() { ++closes; if (deny) throw new SecurityException("test denial"); }
            public void release() { ++releases; }
        });
        lease.tick(); check(closes == 0, "no unsolicited override");
        for (int invalid : new int[]{-1, 999, 10001, Integer.MAX_VALUE}) {
            try { lease.renew(invalid); throw new AssertionError("invalid lease accepted"); }
            catch (IllegalArgumentException expected) {}
        }
        lease.newConnection(); lease.renew(10000);
        check(closes == 1 && lease.requested(), "first lease requests close");
        now = 1999; lease.tick(); check(closes == 1, "rate limit");
        now = 2000; lease.tick(); check(closes == 2, "periodic request");
        now = 9000; lease.renew(10000); check(lease.remainingMs() == 10000, "renewal uses monotonic time");
        now = 18999; lease.tick(); check(lease.requested(), "valid until expiry");
        now = 19000; lease.tick(); check(!lease.requested() && releases == 1, "expiry releases");
        lease.disconnect(); lease.tick(); check(releases == 1, "release once");
        lease.renew(1000); lease.renew(0); check(releases == 2 && !lease.requested(), "explicit revocation");
        deny = true; lease.newConnection(); lease.renew(10000); int rejected = closes;
        now += 2001; lease.tick(); check(closes == rejected && lease.blocked(), "permission denial does not loop");
        check("SecurityException".equals(lease.error()), "redacted diagnostic error");
        deny = false; lease.newConnection(); lease.renew(10000);
        check(!lease.blocked() && lease.requested(), "reconnect can retry");
        lease.disconnect(); check(!lease.requested(), "normal close restores");
        System.out.println("Proximity lease policy passed (bounds, rate, expiry, revoke, denial, reconnect).");
    }
}
