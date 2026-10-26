using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security;
using System.Text.RegularExpressions;

namespace QuestUsbForwarder {
    // Exact app-owned targets only. Never enumerate another application's credentials.
    public static class PinVault {
        const string Prefix = "QuestUsbForwarder/MetaStorePIN/";
        const string Owner = "MetaStorePIN-v1";
        const uint Generic = 1, LocalMachinePersistence = 2;
        const int NotFound = 1168;
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct Credential {
            public uint Flags, Type;
            public string TargetName, Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist, AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias, UserName;
        }
        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CredWrite(ref Credential value, uint flags);
        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CredRead(string target, uint type, uint flags, out IntPtr value);
        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CredDelete(string target, uint type, uint flags);
        [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr values);
        [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);

        static bool IsTarget(string target) {
            return target != null && Regex.IsMatch(target, "\\AQuestUsbForwarder/MetaStorePIN/[a-f0-9]{64}\\z");
        }
        static void RequireTarget(string target) {
            if (!IsTarget(target)) throw new ArgumentException("Only app-owned PIN targets are allowed.");
        }
        static Exception Failure(string operation) {
            return new InvalidOperationException("Windows Credential Manager " + operation + " failed (code " + Marshal.GetLastWin32Error() + ").");
        }
        static void ClearBlob(Credential value) {
            if (value.CredentialBlob != IntPtr.Zero && value.CredentialBlobSize <= 2560) {
                for (int i = 0; i < value.CredentialBlobSize; i++) Marshal.WriteByte(value.CredentialBlob, i, 0);
            }
        }
        public static void Save(string target, SecureString pin) {
            RequireTarget(target);
            if (pin == null || pin.Length != 4) throw new ArgumentException("A four-digit Store PIN is required.");
            IntPtr buffer = IntPtr.Zero;
            try {
                buffer = Marshal.SecureStringToCoTaskMemUnicode(pin);
                for (int i = 0; i < 4; i++) {
                    short c = Marshal.ReadInt16(buffer, i * 2);
                    if (c < '0' || c > '9') throw new ArgumentException("A four-digit Store PIN is required.");
                }
                Credential value = new Credential();
                value.Type = Generic; value.TargetName = target; value.UserName = Owner;
                value.Comment = "Quest USB Forwarder: locally saved Meta Store PIN";
                value.CredentialBlobSize = 8; value.CredentialBlob = buffer;
                // Persists across this user's logons on this computer; no enterprise roaming.
                value.Persist = LocalMachinePersistence;
                if (!CredWrite(ref value, 0)) throw Failure("write");
            } finally { if (buffer != IntPtr.Zero) Marshal.ZeroFreeCoTaskMemUnicode(buffer); }
        }
        public static SecureString Read(string target) {
            RequireTarget(target);
            IntPtr pointer;
            if (!CredRead(target, Generic, 0, out pointer)) {
                if (Marshal.GetLastWin32Error() == NotFound) return null;
                throw Failure("read");
            }
            Credential value = new Credential();
            SecureString pin = null;
            try {
                value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
                if (value.Type != Generic || value.UserName != Owner || value.CredentialBlobSize != 8 || value.CredentialBlob == IntPtr.Zero) {
                    throw new InvalidOperationException("Saved Quest PIN has an invalid format. Enter it locally again.");
                }
                pin = new SecureString();
                for (int i = 0; i < 4; i++) {
                    char c = (char)Marshal.ReadInt16(value.CredentialBlob, i * 2);
                    if (c < '0' || c > '9') throw new InvalidOperationException("Saved Quest PIN has an invalid format. Enter it locally again.");
                    pin.AppendChar(c);
                }
                pin.MakeReadOnly();
                SecureString result = pin; pin = null; return result;
            } finally { if (pin != null) pin.Dispose(); ClearBlob(value); CredFree(pointer); }
        }
        public static bool Delete(string target) {
            RequireTarget(target);
            if (CredDelete(target, Generic, 0)) return true;
            if (Marshal.GetLastWin32Error() == NotFound) return false;
            throw Failure("delete");
        }
        public static string[] Targets() {
            uint count; IntPtr values;
            if (!CredEnumerate(Prefix + "*", 0, out count, out values)) {
                if (Marshal.GetLastWin32Error() == NotFound) return new string[0];
                throw Failure("enumeration");
            }
            List<string> result = new List<string>();
            try {
                for (int i = 0; i < count; i++) {
                    IntPtr pointer = Marshal.ReadIntPtr(values, i * IntPtr.Size);
                    Credential value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
                    try { if (value.Type == Generic && value.UserName == Owner && IsTarget(value.TargetName)) result.Add(value.TargetName); }
                    finally { ClearBlob(value); }
                }
                return result.ToArray();
            } finally { CredFree(values); }
        }
    }
}
