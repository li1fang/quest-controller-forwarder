package dev.quest.usbforwarder;

import android.content.Context;
import android.content.pm.PackageManager;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;

/** Pairing lives in app-private storage. Import sources are untrusted until confirmed. */
public final class PairingStore {
    public static final String IMPORT_FILE = "pairing-import.json";
    private static final int MAX_BYTES = 4096;
    private PairingStore() {}
    public static boolean runtimeEnabled(Context context) {
        try {
            android.os.Bundle metadata = context.getPackageManager().getApplicationInfo(context.getPackageName(), PackageManager.GET_META_DATA).metaData;
            return metadata != null && metadata.getBoolean("dev.quest.forwarder.runtime_pairing", false);
        } catch (PackageManager.NameNotFoundException impossible) { throw new IllegalStateException("Application metadata unavailable"); }
    }
    private static AtomicFile saved(Context context) { return new AtomicFile(new File(context.getFilesDir(), "lan-pairing.json")); }
    public static File staged(Context context) {
        File directory = context.getExternalFilesDir(null);
        return directory == null ? null : new File(directory, IMPORT_FILE);
    }
    public static synchronized boolean hasSaved(Context context) {
        try (InputStream ignored = saved(context).openRead()) { return true; }
        catch (FileNotFoundException absent) { return false; }
        catch (IOException unreadable) { return true; }
    }
    public static synchronized LanPairing load(Context context) throws Exception { return read(saved(context).openRead()); }
    public static LanPairing read(InputStream source) throws Exception {
        if (source == null) throw new IOException("Pairing file unavailable");
        try (InputStream input = source; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > MAX_BYTES) throw new IOException("Pairing file too large");
                bytes.write(buffer, 0, count);
            }
            JSONObject json = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            if (json.length() != 5 || !(json.get("version") instanceof Integer) || !(json.get("port") instanceof Integer) ||
                !(json.get("host") instanceof String) || !(json.get("cert_sha256") instanceof String) || !(json.get("token") instanceof String))
                throw new IOException("Invalid pairing fields");
            return new LanPairing(json.getInt("version"), json.getString("host"), json.getInt("port"), json.getString("cert_sha256"), json.getString("token"));
        }
    }
    public static synchronized void save(Context context, LanPairing pairing) throws Exception {
        JSONObject json = new JSONObject().put("version", 1).put("host", pairing.host).put("port", pairing.port)
            .put("cert_sha256", pairing.certSha256).put("token", pairing.token);
        AtomicFile destination = saved(context); FileOutputStream output = null;
        try {
            output = destination.startWrite();
            output.write(json.toString().getBytes(StandardCharsets.UTF_8));
            destination.finishWrite(output);
            output = null;
        } catch (Exception error) { if (output != null) destination.failWrite(output); throw error; }
        LanPairing stored = load(context);
        if (!stored.host.equals(pairing.host) || stored.port != pairing.port || !stored.certSha256.equals(pairing.certSha256) || !stored.token.equals(pairing.token))
            throw new IOException("Pairing save could not be verified");
    }
    public static synchronized void forget(Context context) { saved(context).delete(); }
}
