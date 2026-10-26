package dev.quest.usbforwarder;

/** Immutable pairing policy, also exercised on a desktop JVM without Android. */
public final class LanPairing {
    public final String host, certSha256, token;
    public final int port;
    public LanPairing(int version, String host, int port, String certSha256, String token) {
        if (version != 1 || !privateIpv4(host) || port < 1 || port > 65535 ||
            certSha256 == null || !certSha256.matches("[a-f0-9]{64}") ||
            token == null || !token.matches("[a-f0-9]{64}"))
            throw new IllegalArgumentException("Invalid pairing configuration");
        this.host = host; this.port = port; this.certSha256 = certSha256; this.token = token;
    }
    private static boolean privateIpv4(String host) {
        if (host == null || !host.matches("(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}")) return false;
        String[] parts = host.split("\\.");
        int[] ip = new int[4];
        for (int i = 0; i < 4; ++i) { ip[i] = Integer.parseInt(parts[i]); if (ip[i] > 255) return false; }
        return ip[0] == 10 || ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31 || ip[0] == 192 && ip[1] == 168;
    }
    public String endpoint() { return host + ":" + port; }
    public String fingerprintDisplay() { return certSha256.replaceAll("(.{8})(?!$)", "$1 "); }
    @Override public String toString() { return "LanPairing[credentials withheld]"; }
}
