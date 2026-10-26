/*
 * Synthetic, isolated parser diagnostic. No live service, credential file,
 * settings provider or Binder API is accessed. The algorithm comparison is
 * based on Apache-2.0 AOSP AdbDebuggingManager.readKeyStoreContents.
 */
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlSerializer;

public final class AdbXmlParserProbe {
    private static final String KEY = "SYNTHETIC_PUBLIC_KEY_NOT_A_CREDENTIAL";
    private static final String AP = "02:00:00:00:00:01";
    private static Method beginDocument;
    private static Method skipCurrentTag;
    private static Method resolveParser;

    private static XmlPullParser parser(byte[] bytes) throws Exception {
        XmlPullParser value = (XmlPullParser) resolveParser.invoke(null, new ByteArrayInputStream(bytes));
        beginDocument.invoke(null, value, "keyStore");
        return value;
    }

    // The allocated object belongs only to this shell process. Its constructor
    // is intentionally not called: that constructor reads the real keystore.
    private static JSONObject actualReader(byte[] bytes) throws Exception {
        Class<?> unsafeClass = Class.forName("sun.misc.Unsafe");
        Field singleton = unsafeClass.getDeclaredField("theUnsafe");
        singleton.setAccessible(true);
        Object unsafe = singleton.get(null);
        Class<?> storeClass = Class.forName("com.android.server.adb.AdbDebuggingManager$AdbKeyStore");
        Object store = unsafeClass.getMethod("allocateInstance", Class.class).invoke(unsafe, storeClass);
        Map<String, Long> keys = new HashMap<String, Long>();
        Collection<String> networks = new ArrayList<String>();
        Field keyField = storeClass.getDeclaredField("mKeyMap");
        Field networkField = storeClass.getDeclaredField("mTrustedNetworks");
        keyField.setAccessible(true); networkField.setAccessible(true);
        keyField.set(store, keys); networkField.set(store, networks);
        Method read = storeClass.getDeclaredMethod("readKeyStoreContents", Class.forName("com.android.modules.utils.TypedXmlPullParser"));
        read.setAccessible(true);
        read.invoke(store, parser(bytes));
        return new JSONObject().put("keys_loaded", keys.size()).put("wifi_aps_loaded", networks.size());
    }

    // Comparison only: ignore non-start events before skipping child elements.
    // This does not replace or patch any installed implementation.
    private static JSONObject guardedReader(byte[] bytes) throws Exception {
        XmlPullParser value = parser(bytes);
        int keys = 0, networks = 0, event;
        while ((event = value.next()) != XmlPullParser.END_DOCUMENT) {
            if (event != XmlPullParser.START_TAG) continue;
            if ("adbKey".equals(value.getName())) keys++;
            else if ("wifiAP".equals(value.getName())) networks++;
            skipCurrentTag.invoke(null, value);
        }
        return new JSONObject().put("keys_loaded", keys).put("wifi_aps_loaded", networks);
    }

    private static JSONObject inspect(String label, byte[] bytes) throws Exception {
        XmlPullParser value = parser(bytes);
        int first = value.next();
        JSONArray whitespace = new JSONArray();
        String text = value.getText();
        if (first == XmlPullParser.TEXT && text != null) {
            for (int index = 0; index < text.length(); index++) whitespace.put((int) text.charAt(index));
        }
        return new JSONObject().put("label", label).put("input_bytes", bytes.length)
            .put("first_event_after_root", first)
            .put("first_event_name", value.getName() == null ? JSONObject.NULL : value.getName())
            .put("whitespace_character_codes", whitespace)
            .put("installed_reader", actualReader(bytes))
            .put("start_tag_guard_comparison", guardedReader(bytes));
    }

    private static byte[] installedWriter(boolean binaryComparison) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        Object raw = binaryComparison
            ? Class.forName("com.android.modules.utils.BinaryXmlSerializer").getDeclaredConstructor().newInstance()
            : Class.forName("android.util.Xml").getMethod("resolveSerializer", OutputStream.class).invoke(null, output);
        XmlSerializer writer = (XmlSerializer) raw;
        if (binaryComparison) writer.setOutput(output, "UTF-8");
        Class<?> typed = Class.forName("com.android.modules.utils.TypedXmlSerializer");
        Method integer = typed.getMethod("attributeInt", String.class, String.class, int.class);
        Method longValue = typed.getMethod("attributeLong", String.class, String.class, long.class);
        writer.startDocument(null, Boolean.TRUE);
        writer.startTag(null, "keyStore"); integer.invoke(raw, null, "version", 1);
        writer.startTag(null, "adbKey"); writer.attribute(null, "key", KEY); longValue.invoke(raw, null, "lastConnection", 1L); writer.endTag(null, "adbKey");
        writer.startTag(null, "wifiAP"); writer.attribute(null, "bssid", AP); writer.endTag(null, "wifiAP");
        writer.endTag(null, "keyStore"); writer.endDocument();
        return output.toByteArray();
    }

    public static void main(String[] args) {
        JSONObject report = new JSONObject();
        try {
            report.put("synthetic_data_only", true).put("live_store_accessed", false)
                .put("live_settings_modified", false).put("live_system_service_called", false)
                .put("uid", android.os.Process.myUid()).put("pid", android.os.Process.myPid());
            Class<?> util = Class.forName("com.android.internal.util.XmlUtils");
            beginDocument = util.getMethod("beginDocument", XmlPullParser.class, String.class);
            skipCurrentTag = util.getMethod("skipCurrentTag", XmlPullParser.class);
            resolveParser = Class.forName("android.util.Xml").getMethod("resolvePullParser", InputStream.class);
            String key = "<adbKey key=\"" + KEY + "\" lastConnection=\"1\" />";
            String ap = "<wifiAP bssid=\"" + AP + "\" />";
            String open = "<?xml version=\"1.0\"?><keyStore version=\"1\">";
            JSONArray tests = new JSONArray();
            tests.put(inspect("compact", (open + key + ap + "</keyStore>").getBytes(StandardCharsets.UTF_8)));
            tests.put(inspect("root_whitespace", (open + "\n    " + key + "\n    " + ap + "\n</keyStore>").getBytes(StandardCharsets.UTF_8)));
            tests.put(inspect("inter_child_whitespace", (open + key + "\n    " + ap + "</keyStore>").getBytes(StandardCharsets.UTF_8)));
            byte[] generated = installedWriter(false);
            report.put("installed_serializer_format", generated.length >= 3 && generated[0] == 'A' && generated[1] == 'B' && generated[2] == 'X' ? "binary_abx" : "text_xml");
            tests.put(inspect("installed_serializer_round_trip", generated));
            try { tests.put(inspect("in_memory_binary_comparison", installedWriter(true))); }
            catch (Throwable optional) { report.put("binary_comparison_available", false); }
            report.put("fixtures", tests).put("status", "completed");
        } catch (Throwable error) {
            Throwable cause = error.getCause() == null ? error : error.getCause();
            try { report.put("status", "unavailable").put("error_type", cause.getClass().getName()).put("error_message", String.valueOf(cause.getMessage())); }
            catch (Exception ignored) { }
        }
        System.out.println("QUEST_XML_PROBE=" + report.toString());
    }
}
