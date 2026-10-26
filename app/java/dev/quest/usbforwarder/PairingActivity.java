package dev.quest.usbforwarder;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.*;
import java.io.*;

/** A small Android setup panel. It starts the existing NativeActivity after pairing. */
public final class PairingActivity extends Activity {
    private static final int PICK_PAIRING = 21;
    private LanPairing current;
    private TextView summary;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        // Only this visible setup panel uses KEEP_SCREEN_ON; capture keeps its existing lease policy.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_SECURE);
        boolean settings = getComponentName().getClassName().endsWith("PairingSettings") || "dev.quest.forwarder.CONFIGURE".equals(getIntent().getAction());
        try { if (PairingStore.hasSaved(this)) current = PairingStore.load(this); } catch (Exception ignored) {}
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(32, 24, 32, 24);
        ScrollView scroll = new ScrollView(this); scroll.addView(layout); setContentView(scroll);
        TextView title = new TextView(this); title.setText("Quest LAN — pairing"); title.setTextSize(26); layout.addView(title);
        summary = new TextView(this); summary.setTextSize(18); layout.addView(summary); refresh();
        button(layout, "Start controller capture", () -> {
            if (current == null) showError("Import a pairing file from your receiver PC first."); else startCapture();
        });
        button(layout, "Import pairing file…", () -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            try { startActivityForResult(intent, PICK_PAIRING); }
            catch (RuntimeException unavailable) { showError("File picker unavailable. Use Pair-Quest-LAN.cmd on your trusted PC via authorized USB."); }
        });
        button(layout, "Forget this receiver", () -> new AlertDialog.Builder(this).setTitle("Forget receiver?")
            .setMessage("Capture will require pairing again. Recordings on the PC are unchanged.")
            .setNegativeButton("Cancel", null).setPositiveButton("Forget", (d, w) -> {
                if (LanTransport.isConnected()) { showError("End the PC receiver service and release keepalive before changing pairing."); return; }
                PairingStore.forget(this); current = null; refresh();
            }).show());
        File staged = PairingStore.staged(this);
        if (staged != null && staged.exists()) {
            try { confirm(PairingStore.read(new FileInputStream(staged)), staged); }
            catch (Exception invalid) { showError("Staged pairing file is invalid. Existing pairing was kept; use the PC helper to replace the staged file."); }
        } else if (current != null && !settings) startCapture();
    }
    private void button(LinearLayout parent, String text, Runnable action) {
        Button button = new Button(this); button.setText(text); button.setOnClickListener(view -> action.run()); parent.addView(button);
    }
    private void refresh() {
        summary.setText(current == null ? "Not paired. Import only a file supplied by your trusted receiver PC.\nNo telemetry or keepalive is active in this setup panel." :
            "Receiver: " + current.endpoint() + "\nTLS SHA-256:\n" + current.fingerprintDisplay() + "\n\nCredentials are stored privately in this app.");
    }
    private void confirm(LanPairing candidate, File staged) {
        new AlertDialog.Builder(this).setTitle(current == null ? "Trust this receiver?" : "Replace receiver pairing?")
            .setMessage("Receiver: " + candidate.endpoint() + "\nTLS SHA-256:\n" + candidate.fingerprintDisplay() +
                "\n\nCompare with the trusted PC. The file contains a secret token; never share it publicly. Saving does not start keepalive.")
            .setNegativeButton("Cancel", null).setPositiveButton("Trust and save", (dialog, which) -> {
                if (LanTransport.isConnected()) { showError("End the PC receiver service and release keepalive before changing pairing."); return; }
                try {
                    PairingStore.save(this, candidate); current = candidate;
                    boolean removed = staged == null || !staged.exists() || staged.delete();
                    refresh();
                    if (!removed) showError("Pairing saved. Staged import could not be removed; remove it with the PC helper before the next launch.");
                    else Toast.makeText(this, "Paired. Select Start controller capture when ready.", Toast.LENGTH_LONG).show();
                } catch (Exception error) { showError("Could not verify the saved pairing. Keep the import source and retry before starting capture."); }
            }).show();
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_PAIRING && result == RESULT_OK && data != null && data.getData() != null) {
            try { confirm(PairingStore.read(getContentResolver().openInputStream(data.getData())), null); }
            catch (Exception invalid) { showError("Invalid pairing file. Existing pairing was kept."); }
        }
    }
    private void startCapture() {
        Intent capture = new Intent(this, android.app.NativeActivity.class);
        capture.setAction(Intent.ACTION_MAIN);
        capture.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        capture.addCategory("com.oculus.intent.category.VR");
        capture.addCategory("org.khronos.openxr.intent.category.IMMERSIVE_HMD");
        startActivity(capture);
        // The setup and capture tasks have distinct affinities; only remove the setup panel.
        finishAndRemoveTask();
    }
    private void showError(String message) { new AlertDialog.Builder(this).setTitle("Quest LAN pairing").setMessage(message).setPositiveButton("OK", null).show(); }
}
