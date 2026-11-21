using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.CSharp.RuntimeBinder;

internal static class ExplorerSelection {
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hwnd,int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd,uint attr,out int value,int size);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd,StringBuilder name,int capacity);

    private sealed class FolderView : IDisposable {
        public IntPtr Window;
        public object Document;
        public bool Selected;
        public void Dispose(){ Release(Document); Document=null; }
    }
    private static void Release(object value) {
        if (value!=null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
    }
    private static bool SamePath(string actual,string target) {
        if(String.IsNullOrEmpty(actual))return false;
        if(String.Equals(DeliveryShell.DisplayPath(actual),target,StringComparison.OrdinalIgnoreCase))return true;
        if(actual.IndexOf('~')<0)return false;
        try{return String.Equals(DeliveryShell.LongName(actual),target,StringComparison.OrdinalIgnoreCase);}
        catch(System.ComponentModel.Win32Exception){return false;}
    }
    private static bool OnDesktop(IntPtr hwnd) {
        int cloaked;
        return IsWindowVisible(hwnd) && !IsIconic(hwnd) && DwmGetWindowAttribute(hwnd,14,out cloaked,4)==0 && cloaked==0;
    }
    private static bool IsSelected(dynamic view,string file) {
        dynamic items=null,item=null;
        try{
            items=view.SelectedItems();
            for(int i=0;i<(int)items.Count;i++){
                try{item=items.Item(i);if(item!=null && SamePath((string)item.Path,file))return true;}
                finally{Release((object)item);item=null;}
            }
            return false;
        }finally{Release((object)items);}
    }
    private static FolderView FindFolder(dynamic windows,string directory,string file) {
        FolderView best=null;int bestRank=-1;
        for(int i=0,count=(int)windows.Count;i<count;i++){
            dynamic browser=null,view=null,folder=null,self=null;
            try{
                browser=windows.Item(i);if(browser==null)continue;
                IntPtr hwnd=GetAncestor(new IntPtr(Convert.ToInt64(browser.HWND)),2);
                var cls=new StringBuilder(96);GetClassName(hwnd,cls,cls.Capacity);
                if(cls.ToString()!="CabinetWClass" && cls.ToString()!="ExploreWClass")continue;
                view=browser.Document;if(view==null)continue;
                folder=view.Folder;self=folder.Self;
                if(!SamePath((string)self.Path,directory))continue;
                bool selected=IsSelected(view,file);
                int rank=(OnDesktop(hwnd)?4:0)+(GetForegroundWindow()==hwnd?8:0)+(selected?1:0);
                if(rank<=bestRank)continue;
                if(best!=null)best.Dispose();
                best=new FolderView{Window=hwnd,Document=(object)view,Selected=selected};
                view=null;bestRank=rank;
                if(rank==13)break;
            }catch(COMException){/* A tab can close between samples. */}
             catch(RuntimeBinderException){/* A non-folder tab has no folder view. */}
            finally{Release((object)self);Release((object)folder);Release((object)view);Release((object)browser);}
        }
        return best;
    }
    private static bool SelectFile(FolderView frame,string file) {
        dynamic view=frame.Document,folder=null,item=null;
        try{
            folder=view.Folder;
            item=folder.ParseName(file.Substring(file.LastIndexOf('\\')+1));
            if(item==null || !SamePath((string)item.Path,file))return false;
            view.SelectItem((object)item,29); // select, deselect others, focus item, keep in view
            return true;
        }catch(COMException){return false;}
         catch(RuntimeBinderException){return false;}
        finally{Release((object)item);Release((object)folder);}
    }
    // Open exactly one normal folder when none exists. Select within that view;
    // allow Explorer to finish its own activation before requesting focus.
    internal static string Present(IntPtr fileId,string file) {
        string target=DeliveryShell.LongName(file);
        int cut=target.LastIndexOf('\\');
        string directory=target.Substring(0,cut==2 && target[1]==':'?3:cut);
        dynamic shell=null,windows=null;
        try{
            shell=Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application",true));
            windows=shell.Windows();
            var clock=Stopwatch.StartNew();
            bool opened=false,first=true;
            IntPtr selected=IntPtr.Zero,shown=IntPtr.Zero,activated=IntPtr.Zero,observed=IntPtr.Zero;
            long seenAt=0,visibleAt=-1,focusAt=0;
            while(clock.ElapsedMilliseconds<6500){
                using(FolderView frame=FindFolder(windows,directory,target)){
                    long now=clock.ElapsedMilliseconds;
                    if(frame==null) {
                        if(first){DeliveryShell.OpenParent(fileId);opened=true;}
                    }else{
                        IntPtr hwnd=frame.Window;
                        if(observed!=hwnd){observed=hwnd;seenAt=now;visibleAt=-1;}
                        if(!frame.Selected && selected!=hwnd && SelectFile(frame,target))selected=hwnd;
                        if(frame.Selected || selected==hwnd){
                            if(OnDesktop(hwnd) && frame.Selected){
                                if(GetForegroundWindow()==hwnd)return "foreground";
                                if(visibleAt<0)visibleAt=now;
                                long grace=(opened||shown==hwnd)?450:0;
                                if(activated!=hwnd && now-visibleAt>=grace){
                                    SetForegroundWindow(hwnd);activated=hwnd;focusAt=now;
                                }else if(activated==hwnd && now-focusAt>=600)return "background";
                            }else if(shown!=hwnd && (!opened || now-seenAt>=600)){
                                if(IsIconic(hwnd)||!IsWindowVisible(hwnd)){
                                    ShowWindowAsync(hwnd,IsIconic(hwnd)?9:5);
                                    shown=hwnd;visibleAt=-1;
                                }
                            }
                        }
                    }
                    first=false;
                }
                Thread.Sleep(65);
            }
            return "unconfirmed";
        }catch(COMException){return "unconfirmed";}
         catch(RuntimeBinderException){return "unconfirmed";}
        finally{Release((object)windows);Release((object)shell);}
    }
}