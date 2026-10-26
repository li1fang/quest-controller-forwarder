import dev.quest.usbforwarder.LanPairing;

/** Real validation policy used by Android, exercised without device/storage/Android classes. */
public final class LanPairingTest {
    static String pin = repeat('a'), token = repeat('b');
    static String repeat(char c) { char[] chars = new char[64]; java.util.Arrays.fill(chars, c); return new String(chars); }
    static void invalid(int version, String host, int port, String cert, String secret) {
        try { new LanPairing(version, host, port, cert, secret); throw new AssertionError("Invalid pairing accepted"); }
        catch (IllegalArgumentException expected) {
            if (expected.getMessage().contains("SECRET-INPUT")) throw new AssertionError("Error leaked input");
        }
    }
    public static void main(String[] args) {
        for (String host : new String[]{"10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.2"}) new LanPairing(1, host, 19428, pin, token);
        for (String host : new String[]{null, "", "localhost", "0.0.0.0", "127.0.0.1", "8.8.8.8", "::1", "172.32.0.1", "192.168.1.256", "192.168.001.2", "192.168.1.2\n"}) invalid(1, host, 19428, pin, token);
        for (int port : new int[]{-1, 0, 65536}) invalid(1, "192.168.1.2", port, pin, token);
        invalid(2, "192.168.1.2", 19428, pin, token);
        invalid(1, "192.168.1.2", 19428, repeat('A'), token);
        invalid(1, "192.168.1.2", 19428, pin, "SECRET-INPUT");
        LanPairing valid = new LanPairing(1, "192.168.1.2", 19428, pin, token);
        if (valid.toString().contains(token) || valid.toString().contains(pin)) throw new AssertionError("toString leaked credentials");
        if (!valid.endpoint().equals("192.168.1.2:19428")) throw new AssertionError("Endpoint changed");
        System.out.println("Runtime pairing policy passed (private IPv4, bounds, trust fields, redacted diagnostics).");
    }
}
