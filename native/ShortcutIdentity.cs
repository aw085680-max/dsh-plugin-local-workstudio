using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

internal static class ShortcutIdentity {
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey {
        public Guid format;
        public uint id;
        public PropertyKey(uint id) {
            format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
            this.id = id;
        }
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropertyValue {
        [FieldOffset(0)] public ushort type;
        [FieldOffset(8)] public IntPtr data;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropertyValue value);
        void SetValue(ref PropertyKey key, ref PropertyValue value);
        void Commit();
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern void SHChangeNotify(uint eventId, uint flags, string first, IntPtr second);

    public static void Set(string path, string appId) {
        var linkObject = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
        var link = (IPersistFile)linkObject;
        var store = (IPropertyStore)linkObject;
        var appString = Marshal.StringToCoTaskMemUni(appId);
        var protocolPlaceholder = Marshal.AllocCoTaskMem(16);
        try {
            link.Load(Path.GetFullPath(path), 2);
            var identity = new PropertyKey(5);
            var identityValue = new PropertyValue { type = 31, data = appString };
            store.SetValue(ref identity, ref identityValue);
            // Notifications use URL activation, so no COM server is registered for this CLSID.
            Marshal.StructureToPtr(new Guid("E88C567D-4AD1-41BA-9206-33371E70F40E"), protocolPlaceholder, false);
            var activator = new PropertyKey(26);
            var activatorValue = new PropertyValue { type = 72, data = protocolPlaceholder };
            store.SetValue(ref activator, ref activatorValue);
            store.Commit();
            link.Save(null, true);
            SHChangeNotify(0x00002000, 5, Path.GetFullPath(path), IntPtr.Zero);
        } finally {
            Marshal.FreeCoTaskMem(appString);
            Marshal.FreeCoTaskMem(protocolPlaceholder);
            Marshal.FinalReleaseComObject(linkObject);
        }
    }
}
