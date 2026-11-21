using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

internal static class TaskReminder {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    static readonly Regex Key = new Regex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    static readonly Regex AppId = new Regex(@"\Acom\.localworkstudio\.[a-f0-9]{16}\z", RegexOptions.CultureInvariant);
    static readonly Dictionary<string,ToastNotification> Live = new Dictionary<string,ToastNotification>();
    static readonly object IoLock = new object();
    static Binding Config;
    static string BindingPath;
    public sealed class Binding {
        public string root {get;set;}
        public string appId {get;set;}
        public string protocol {get;set;}
        public string host {get;set;}
        public string launcher {get;set;}
    }
    public sealed class Request {
        public int id {get;set;}
        public string command {get;set;}
        public string[] args {get;set;}
    }
    public sealed class Ticket {
        public string workspaceId {get;set;}
        public string key {get;set;}
    }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint id);
    static bool IsHarnessForeground() {
        uint id;
        if(GetWindowThreadProcessId(GetForegroundWindow(),out id)==0) return false;
        try {
            using(var process=Process.GetProcessById((int)id))
                return string.Equals(process.MainModule.FileName,Config.host,StringComparison.OrdinalIgnoreCase);
        } catch(System.ComponentModel.Win32Exception) {return false;}
          catch(ArgumentException) {return false;}
          catch(InvalidOperationException) {return false;}
    }
    static void Send(object value) {
        lock(IoLock) {
            Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush();
        }
    }
    static Ticket GetTicket(string key) {
        if(key==null||!Key.IsMatch(key)) throw new ArgumentException("无效的任务提醒标识");
        var ticket=Json.Deserialize<Ticket>(File.ReadAllText(Path.Combine(Config.root,"tickets",key+".json"),Utf8));
        if(ticket==null||ticket.key!=key||!Key.IsMatch(ticket.workspaceId??"")) throw new InvalidDataException("提醒不属于当前工作区");
        return ticket;
    }
    static void RecordClick(string key,string action) {
        var ticket=GetTicket(key);
        var directory=Path.Combine(Config.root,"clicks");
        var name=DateTime.UtcNow.Ticks.ToString("D19")+"-"+Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(directory);
        var temp=Path.Combine(directory,name+".tmp");
        lock(IoLock) File.WriteAllText(temp,Json.Serialize(new{key,action,ticket.workspaceId}),Utf8);
        File.Move(temp,Path.ChangeExtension(temp,".json"));
    }
    static void BringToTask(string key) {
        RecordClick(key,"open");
        LaunchHarness();
    }
    static void LaunchHarness() {
        var start=new ProcessStartInfo(Config.launcher){UseShellExecute=false,WorkingDirectory=Path.GetDirectoryName(Config.launcher)};
        start.EnvironmentVariables["DSH_HOME"]=Path.GetDirectoryName(Path.GetDirectoryName(Config.root));
        Process.Start(start).Dispose();
    }
    static int Activate(string text) {
        var match=Regex.Match(text??"",@"\A"+Regex.Escape(Config.protocol)+@"://(open|dismiss)/([a-f0-9]{64})/?\z",RegexOptions.CultureInvariant);
        if(!match.Success)return 2;
        string id=match.Groups[2].Value;
        if(match.Groups[1].Value=="open") BringToTask(id); else RecordClick(id,"dismiss");
        return 0;
    }
    static string Escape(string s) {
        return SecurityElement.Escape(new string((s??"").Where(c=>System.Xml.XmlConvert.IsXmlChar(c)).Take(240).ToArray()));
    }
    static string Mark(string key,string suffix) {
        var path=Path.Combine(Config.root,"native");
        Directory.CreateDirectory(path);
        return Path.Combine(path,key+suffix);
    }
    static bool InHistory(string key) {
        return ToastNotificationManager.History.GetHistory(Config.appId).Any(t=>t.Tag==key.Substring(0,16)&&t.Group==key.Substring(16,16));
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    static bool AllowsNotifications(ToastNotifier notifier) {
        try {return notifier.Setting==NotificationSetting.Enabled;}
        catch(Exception error) {if(error.HResult!=unchecked((int)0x80070490))throw;return true;}
    }
    static object Present(string[] a) {
        if(a.Length!=4)throw new ArgumentException();
        var key=GetTicket(a[0]).key;
        bool silentProbe=a[3]=="silent-test",recover=a[3]=="recover";
        if(!silentProbe&&IsHarnessForeground())return new{status="foreground"};
        var notifier=ToastNotificationManager.CreateToastNotifier(Config.appId);
        if(!AllowsNotifications(notifier))return new{status="disabled"};
        string started=Mark(key,".attempt"),accepted=Mark(key,".accepted");
        if(File.Exists(accepted))return new{status="existing"};
        if(recover&&InHistory(key))return new{status="existing"};
        bool silent=silentProbe||File.Exists(started);
        var doc=new XmlDocument();
        string open=Config.protocol+"://open/"+key,dismiss=Config.protocol+"://dismiss/"+key;
        doc.LoadXml("<toast activationType=\"protocol\" launch=\""+open+"\"><visual><binding template=\"ToastGeneric\"><text>"
            +Escape(a[1])+"</text><text>"+Escape(a[2])+"</text></binding></visual><actions>"
            +"<action content=\"查看群消息\" activationType=\"protocol\" arguments=\""+open+"\"/>"
            +"<action content=\"关闭提醒\" activationType=\"protocol\" arguments=\""+dismiss+"\"/></actions></toast>");
        var toast=new ToastNotification(doc){Tag=key.Substring(0,16),Group=key.Substring(16,16),SuppressPopup=silent};
        toast.Dismissed+=(sender,e)=>{
            if(e.Reason==ToastDismissalReason.UserCanceled) {
                try{RecordClick(key,"dismiss");}catch(IOException){}
            }
            lock(Live)Live.Remove(key);
        };
        toast.Failed+=(sender,e)=>{
            try {File.WriteAllText(Mark(key,".failed"),e.ErrorCode.HResult.ToString(),Utf8);}catch(IOException){}
            lock(Live)Live.Remove(key);
        };
        lock(Live) Live[key]=toast;
        File.WriteAllText(started,DateTime.UtcNow.ToString("O"),Utf8);
        notifier.Show(toast);
        File.WriteAllText(accepted,DateTime.UtcNow.ToString("O"),Utf8);
        return new{status=silent&&!silentProbe?"recovered-silently":"accepted",suppressed=silent};
    }
    static object Execute(string op,string[] args){
        if(op=="state"){
            var n=ToastNotificationManager.CreateToastNotifier(Config.appId);
            return new{enabled=AllowsNotifications(n),foreground=IsHarnessForeground(),identity=Config.appId};
        }
        if(op=="present")return Present(args);
        if(op=="history"){var id=GetTicket(args[0]).key;return new{exists=InHistory(id)};}
        if(op=="remove"){var id=GetTicket(args[0]).key;ToastNotificationManager.History.Remove(id.Substring(0,16),id.Substring(16,16),Config.appId);return new{ok=true};}
        if(op=="pin"){
            var key=GetTicket(args[0]).key;
            var start=new ProcessStartInfo(Application.ExecutablePath,"--binding \""+BindingPath+"\" --pin "+key){UseShellExecute=false};
            Process.Start(start).Dispose();return new{ok=true};
        }
        throw new ArgumentException("不支持的任务提醒操作");
    }
    static void Pin(string key) {
        GetTicket(key);
        PinnedTaskWindow.EnableDisplayScaling();
        using (var window = new PinnedTaskWindow(delegate { BringToTask(key); }))
        using (var timer = new System.Windows.Forms.Timer { Interval = 1600 }) {
            Action refresh = delegate {
                try {
                    var data = Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(Config.root, "records.json"), Utf8));
                    foreach (string source in new[] { "events", "pins" }) {
                        object bucket, entry, name, text;
                        if (!data.TryGetValue(source, out bucket)) continue;
                        var rows = bucket as Dictionary<string,object>;
                        if (rows == null || !rows.TryGetValue(key, out entry)) continue;
                        var row = entry as Dictionary<string,object>;
                        if (row == null || !row.TryGetValue("roomName", out name) || !row.TryGetValue("text", out text)) continue;
                        window.UpdateText(Convert.ToString(name), Convert.ToString(text));
                        return;
                    }
                } catch (IOException) {}
            };
            refresh();
            timer.Tick += delegate { refresh(); };
            timer.Start();
            Application.Run(window);
        }
    }
    [STAThread] static int Main(string[] args){
        try{
            if(args.Length==3 && args[0]=="--stamp-shortcut" && AppId.IsMatch(args[2])){
                ShortcutIdentity.Set(args[1],args[2]);return 0;
            }
            if(args.Length<3||args[0]!="--binding"||!Path.IsPathRooted(args[1]))return 2;
            BindingPath=Path.GetFullPath(args[1]);
            args=args.Skip(2).ToArray();
            Config=Json.Deserialize<Binding>(File.ReadAllText(BindingPath,Utf8));
            if(Config==null||!AppId.IsMatch(Config.appId??"")
                ||Config.protocol!="dsh-workstudio-task-"+Config.appId.Substring(Config.appId.Length-16)
                ||!Path.IsPathRooted(Config.root??"")||!String.Equals(Path.GetFullPath(Config.root),Path.GetDirectoryName(BindingPath),StringComparison.OrdinalIgnoreCase)||!Path.IsPathRooted(Config.host??"")||!Path.IsPathRooted(Config.launcher??""))return 2;
            if(args.Length==1&&args[0]=="--launch"){LaunchHarness();return 0;}
            bool activation=args[0].StartsWith(Config.protocol+":",StringComparison.OrdinalIgnoreCase);
            if(!activation&&args[0]!="--pin"){Console.SetIn(new StreamReader(Console.OpenStandardInput(),Utf8));Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),Utf8){AutoFlush=true});Console.SetError(new StreamWriter(Console.OpenStandardError(),Utf8){AutoFlush=true});}
            Marshal.ThrowExceptionForHR(SetCurrentProcessExplicitAppUserModelID(Config.appId));
            if(args.Length==1&&activation)return Activate(args[0]);
            if(args.Length==2&&args[0]=="--pin"){Pin(args[1]);return 0;}
            if(args.Length==1&&args[0]=="serve"){
                string line;
                while((line=Console.ReadLine())!=null){
                    var req=Json.Deserialize<Request>(line);
                    try{Send(new{id=req.id,value=Execute(req.command,req.args??new string[0])});}
                    catch(Exception e){Send(new{id=req.id,error=e.Message});}
                }
                return 0;
            }
            if(args.Length>0){Send(Execute(args[0],args.Skip(1).ToArray()));return 0;}
            return 2;
        }catch(Exception e){Console.Error.WriteLine(e.ToString());return 1;}
    }
}
