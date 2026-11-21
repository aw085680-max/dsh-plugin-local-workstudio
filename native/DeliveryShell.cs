using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class DeliveryShell {
    private static void WriteError(string message) {
        using (var writer = new System.IO.StreamWriter(Console.OpenStandardError(),new UTF8Encoding(false))) {
            writer.WriteLine(message);
        }
    }

    private static readonly Guid ShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
    private const uint FileSystemName = 0x80058000;

    [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved, uint flags);
    [DllImport("ole32.dll")] private static extern void CoUninitialize();
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    private static extern int SHCreateItemFromParsingName(string name, IntPtr bind, ref Guid iid, out IntPtr item);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    private static extern int SHCreateItemFromRelativeName(IntPtr parent, string name, IntPtr bind, ref Guid iid, out IntPtr item);
    [DllImport("shell32.dll")] private static extern int SHGetIDListFromObject(IntPtr item, out IntPtr pidl);
    [DllImport("shell32.dll")] private static extern int SHGetNameFromIDList(IntPtr pidl, uint nameType, out IntPtr name);
    [DllImport("shell32.dll", ExactSpelling=true)] private static extern IntPtr ILClone(IntPtr item);
    [DllImport("shell32.dll", ExactSpelling=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool ILRemoveLastID(IntPtr item);
    [DllImport("shell32.dll", ExactSpelling=true)] private static extern void ILFree(IntPtr item);

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct ExecuteInfo {
        public int size;
        public uint mask;
        public IntPtr hwnd, verb, file, parameters, directory;
        public int show;
        public IntPtr instance, idList, className, classKey;
        public uint hotKey;
        public IntPtr icon, process;
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShellExecuteExW(ref ExecuteInfo info);

    internal static string DisplayPath(string path) {
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + path.Substring(8);
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path.Substring(4);
        return path;
    }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    private static extern uint GetLongPathNameW(string path, StringBuilder result, uint capacity);

    // Explorer can expose a perfectly valid long file as its DOS short name.
    internal static string LongName(string path) {
        string plain = DisplayPath(path);
        string extended = plain.StartsWith(@"\\",StringComparison.Ordinal)
            ? @"\\?\UNC\" + plain.Substring(2) : @"\\?\" + plain;
        uint capacity = GetLongPathNameW(extended,null,0);
        if (capacity == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        var buffer = new StringBuilder(checked((int)capacity));
        uint written = GetLongPathNameW(extended,buffer,capacity);
        if (written == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (written >= capacity) throw new InvalidOperationException("The file path changed during selection.");
        return DisplayPath(buffer.ToString());
    }

    private static int RootLength(string path) {
        if (path.Length >= 3 && Char.IsLetter(path[0]) && path[1] == ':' && path[2] == '\\') return 3;
        if (path.StartsWith(@"\\", StringComparison.Ordinal) && !path.StartsWith(@"\\.\")) {
            int host = path.IndexOf('\\', 2);
            int share = host > 2 ? path.IndexOf('\\', host + 1) : -1;
            if (share > host+1) return share+1;
        }
        throw new ArgumentException("An absolute filesystem path is required.");
    }

    // Resolve one component at a time. Explorer's command line and its file-URL parser
    // do not participate, including when the complete Unicode path exceeds MAX_PATH.
    internal static IntPtr ResolveItem(string absolutePath) {
        string path = DisplayPath(absolutePath);
        int root = RootLength(path);
        Guid iid = ShellItem;
        IntPtr item, pidl;
        Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path.Substring(0,root),IntPtr.Zero,ref iid,out item));
        try {
            foreach (string part in path.Substring(root).Split('\\')) {
                if (part.Length == 0 || part == "." || part == "..") throw new ArgumentException("Invalid file path.");
                IntPtr next;
                Marshal.ThrowExceptionForHR(SHCreateItemFromRelativeName(item,part,IntPtr.Zero,ref iid,out next));
                Marshal.Release(item);
                item = next;
            }
            Marshal.ThrowExceptionForHR(SHGetIDListFromObject(item,out pidl));
        } finally { Marshal.Release(item); }
        try {
            string resolved = NameOf(pidl);
            if (!String.Equals(resolved,LongName(path),StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The Shell resolved a different file.");
            return pidl;
        } catch { Marshal.FreeCoTaskMem(pidl); throw; }
    }
    internal static string NameOf(IntPtr pidl) {
        IntPtr value;
        Marshal.ThrowExceptionForHR(SHGetNameFromIDList(pidl,FileSystemName,out value));
        try { return LongName(Marshal.PtrToStringUni(value)); }
        finally { Marshal.FreeCoTaskMem(value); }
    }
    internal static void OpenParent(IntPtr fileId) {
        IntPtr parent=ILClone(fileId);
        if(parent==IntPtr.Zero)throw new OutOfMemoryException();
        try{
            if(!ILRemoveLastID(parent))throw new InvalidOperationException("The file does not have a parent folder.");
            var info=new ExecuteInfo();
            info.size=Marshal.SizeOf(typeof(ExecuteInfo));
            info.mask=0x00000004 | 0x00000100; // SEE_MASK_IDLIST | SEE_MASK_NOASYNC
            info.idList=parent;
            info.show=1; // SW_SHOWNORMAL
            if(!ShellExecuteExW(ref info))throw new Win32Exception(Marshal.GetLastWin32Error());
        }finally{ILFree(parent);}
    }

    [STAThread]
    private static int Main(string[] args) {
        if (args.Length != 2 || (args[0] != "open" && args[0] != "reveal")) return 2;
        try {
            Marshal.ThrowExceptionForHR(CoInitializeEx(IntPtr.Zero,2));
            try {
                IntPtr pidl = ResolveItem(args[1]);
                try {
                    if (args[0] == "reveal") {
                        string outcome = ExplorerSelection.Present(pidl,args[1]);
                        Console.Out.WriteLine(outcome);
                        if (outcome != "foreground") {
                            
                            WriteError(outcome == "background"
                                ? "已选中文件，资源管理器在任务栏。"
                                : "未确认资源管理器窗口已显示。");
                            // Older hosts only check the process exit code.
                            return outcome == "background" ? 3 : 4;
                        }
                    } else {
                        var info = new ExecuteInfo();
                        info.size = Marshal.SizeOf(typeof(ExecuteInfo));
                        info.mask = 0x00000004 | 0x00000100; // SEE_MASK_IDLIST | SEE_MASK_NOASYNC
                        info.idList = pidl;
                        info.show = 1;
                        if (!ShellExecuteExW(ref info)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    }
                } finally { Marshal.FreeCoTaskMem(pidl); }
            } finally { CoUninitialize(); }
            return 0;
        } catch (Exception error) {
            
            WriteError(error.Message);
            return 1;
        }
    }
}
