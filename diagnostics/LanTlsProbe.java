package dev.quest.usbforwarder;

import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Setup-only diagnostic, separate DEX; sends status packets to an isolated probe port. */
public final class LanTlsProbe {
    public static void main(String[] args) throws Exception {
        String line = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine();
        JSONObject config = new JSONObject(line);
        if (args.length > 0 && args[0].equals("bad-pin")) config.put("cert_sha256", "0000000000000000000000000000000000000000000000000000000000000000");
        if (args.length > 0 && args[0].equals("bad-token")) config.put("token", "0000000000000000000000000000000000000000000000000000000000000000");
        LanTransport sender = new LanTransport(new ByteArrayInputStream(config.toString().getBytes(StandardCharsets.UTF_8)));
        boolean sent;
        try { sent = sender.send("{\"schema\":\"quest-usb-v1\",\"kind\":\"status\",\"sequence\":1,\"device_monotonic_ns\":\"1\",\"state\":\"isolated_transport_probe\"}\n"); }
        finally { sender.close(); }
        System.out.println("QUEST_LAN_PROBE " + new JSONObject().put("sent", sent).put("phase", sender.getPhase()).toString());
    }
}
