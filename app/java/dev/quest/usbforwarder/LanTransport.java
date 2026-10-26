package dev.quest.usbforwarder;

import android.app.Activity;
import android.os.Build;
import android.util.Log;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.*;
import java.util.UUID;
import java.util.concurrent.*;
import javax.net.ssl.*;

/** TLS writer plus bounded receiver controls. No persistent settings, ADB or PIN operations. */
public final class LanTransport {
    private static volatile LanTransport live;
    private Activity runtimeActivity;
    private boolean enabled;
    private LanPairing config;
    private String configError;
    private String phase = "configuration";
    private final String runId = UUID.randomUUID().toString();
    private volatile SSLSocket socket;
    private volatile boolean authenticated;
    private OutputStream output;
    private ProximityControl proximity;
    private final Object controlLock = new Object();
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "quest-lan-timeout"); t.setDaemon(true); return t;
    });
    public LanTransport(Activity activity) {
        try {
            if (PairingStore.runtimeEnabled(activity)) { enabled = true; runtimeActivity = activity; config = PairingStore.load(activity); live = this; }
            else load(activity.getAssets().open("lan-config.json")); // Diagnostic/legacy variants only.
            proximity = new ProximityControl(activity);
        }
        catch (FileNotFoundException absent) {
            enabled = PairingStore.runtimeEnabled(activity);
            if (enabled) configError = "Open Quest LAN pairing before capture";
        }
        catch (Exception error) { enabled = true; configError = "LAN configuration invalid"; }
    }
    // Package-private entry for the separate diagnostic DEX; no test producer is packaged in the APK.
    LanTransport(InputStream input) {
        try { load(input); } catch (Exception error) { enabled = true; configError = "LAN configuration invalid"; }
    }
    private void load(InputStream source) throws Exception {
        enabled = true;
        config = PairingStore.read(source);
    }
    public boolean isConfigured() { return enabled; }
    public static boolean isConnected() {
        LanTransport transport = live;
        return transport != null && transport.authenticated;
    }
    public String getPhase() { return phase; }
    private void connect() throws Exception {
        // Re-read private configuration on reconnect, so endpoint changes need no process or APK rebuild.
        if (runtimeActivity != null) config = PairingStore.load(runtimeActivity);
        final String expected = config.certSha256;
        X509TrustManager pinned = new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException("Client role only"); }
            public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                try {
                    if (chain == null || chain.length != 1) throw new CertificateException("Expected pinned self-signed certificate");
                    chain[0].checkValidity();
                    chain[0].verify(chain[0].getPublicKey());
                    byte[] digest = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                    StringBuilder hex = new StringBuilder();
                    for (byte b : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
                    if (!MessageDigest.isEqual(hex.toString().getBytes(StandardCharsets.US_ASCII), expected.getBytes(StandardCharsets.US_ASCII)))
                        throw new CertificateException("Server certificate pin mismatch");
                } catch (CertificateException e) { throw e; }
                catch (Exception e) { throw new CertificateException("Pinned certificate rejected", e); }
            }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{pinned}, null);
        SSLSocket next = (SSLSocket) context.getSocketFactory().createSocket();
        socket = next; // Watchdog can close a blocked connect/handshake/write.
        next.setEnabledProtocols(new String[]{"TLSv1.3", "TLSv1.2"});
        next.setTcpNoDelay(true); next.setSoTimeout(2000);
        phase = "tcp_connect";
        next.connect(new InetSocketAddress(config.host, config.port), 2000);
        phase = "tls_handshake";
        next.startHandshake();
        phase = "receiver_auth";
        output = next.getOutputStream();
        JSONObject hello = new JSONObject().put("protocol", "quest-lan-v1").put("kind", "hello")
            .put("token", config.token).put("app_run_id", runId)
            .put("device_model", Build.MODEL).put("sdk_int", Build.VERSION.SDK_INT).put("app_version", "0.8.1")
            .put("power_control", proximity == null ? JSONObject.NULL : "prox-lease-v1");
        output.write((hello.toString() + "\n").getBytes(StandardCharsets.UTF_8)); output.flush();
        ByteArrayOutputStream response = new ByteArrayOutputStream();
        InputStream input = next.getInputStream(); int value;
        while ((value = input.read()) != '\n') {
            if (value < 0 || response.size() >= 1024) throw new IOException("Receiver did not accept pairing");
            response.write(value);
        }
        if (!new JSONObject(response.toString("UTF-8")).optBoolean("accepted")) throw new IOException("Pairing rejected");
        synchronized (controlLock) {
            if (socket != next) throw new IOException("Connection closed during acceptance");
            authenticated = true;
            if (proximity != null) proximity.newConnection();
        }
        if (proximity != null) {
            Thread reader = new Thread(() -> readControls(next), "quest-lan-control"); reader.setDaemon(true); reader.start();
        }
        Log.i("QuestLAN", "Connected to paired LAN receiver using " + next.getSession().getProtocol());
    }
    public boolean send(String packet) {
        if (configError != null) { Log.e("QuestLAN", configError); return false; }
        ScheduledFuture<?> timeout = watchdog.schedule(() -> { disconnect(); }, 2500, TimeUnit.MILLISECONDS);
        try {
            if (socket == null || socket.isClosed()) connect();
            phase = "write";
            if (proximity != null) {
                int end = packet.lastIndexOf('}');
                if (end < 0) throw new IOException("Invalid native packet");
                packet = packet.substring(0, end) + ",\"power\":" + proximity.snapshot().toString() + "}\n";
            }
            output.write(packet.getBytes(StandardCharsets.UTF_8)); output.flush(); phase = "sent"; return true;
        } catch (Exception error) {
            // Never log configuration, hello or exception strings containing their contents.
            Log.w("QuestLAN", "LAN unavailable at " + phase + ": " + error.getClass().getSimpleName());
            disconnect(); return false;
        } finally { timeout.cancel(false); }
    }
    private void disconnect() {
        disconnect(null);
    }
    private void disconnect(SSLSocket expected) {
        SSLSocket previous;
        synchronized (controlLock) {
            if (expected != null && socket != expected) return;
            previous = socket; socket = null; authenticated = false;
            if (proximity != null) proximity.disconnected();
        }
        if (previous != null) try { previous.close(); } catch (IOException ignored) {}
    }
    private void readControls(SSLSocket peer) {
        try {
            // The independent lease timer expires even if this read blocks on a lost network.
            peer.setSoTimeout(0);
            InputStream in = peer.getInputStream(); ByteArrayOutputStream line = new ByteArrayOutputStream(); int value;
            while (socket == peer && (value = in.read()) >= 0) {
                if (value != '\n') { if (line.size() >= 2048) throw new IOException("Control line too large"); line.write(value); continue; }
                JSONObject control = new JSONObject(line.toString("UTF-8")); line.reset();
                if (!"quest-lan-control-v1".equals(control.optString("protocol"))) throw new IOException("Unknown control protocol");
                int duration = control.getInt("lease_ms");
                synchronized (controlLock) { if (socket == peer) proximity.renew(duration); }
            }
        } catch (Exception ignored) { /* Never log control payloads or pairing data. */ }
        finally { disconnect(peer); }
    }
    public void close() { disconnect(); if (live == this) live = null; if (proximity != null) proximity.close(); watchdog.shutdownNow(); }
}
