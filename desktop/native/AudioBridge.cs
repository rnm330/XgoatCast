// Windows 11 / build >= 20348. No global loopback, microphone capture, or local mute.
// stdout: little-endian float32 stereo, 48 kHz, 480 frames per packet.
// stderr: newline-delimited status JSON. stdin: one JSON configuration, then EOF stops capture.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class AudioBridge {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static volatile bool Running = true;
    public static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
    static void Status(object data) { Console.Error.WriteLine(Json.Serialize(data)); }
    [MTAThread]
    static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            if (args.Length > 0 && args[0] == "--list") {
                Console.WriteLine(Json.Serialize(new { supported = Native.Build() >= 20348, build = Native.Build(), apps = AudioApps() }));
                return 0;
            }
            if (args.Length > 0 && args[0] == "--self-test") { PolicyTests.Run(); Console.WriteLine("Audio policy tests passed"); return 0; }
            if (Native.Build() < 20348) throw new Exception("按软件过滤音频需要 Windows 11 或 Windows build 20348 及以上。请选择不共享音频。");
            var config = Json.Deserialize<Config>(Console.ReadLine());
            if (config == null || config.exclude == null || config.exclude.Length > 300) throw new Exception("Invalid audio configuration");
            // A closed parent pipe terminates this helper even when Electron crashes.
            new Thread(delegate() { while (Console.ReadLine() != null) {} Running = false; }) { IsBackground = true }.Start();
            var captures = new Dictionary<int, Capture>();
            var timer = Stopwatch.StartNew();
            var nextRefresh = 0L;
            var nextPacket = 0L;
            var output = Console.OpenStandardOutput();
            Native.timeBeginPeriod(1);
            try {
                while (Running) {
                    if (timer.ElapsedMilliseconds >= nextRefresh) {
                        var processes = Native.Processes();
                        var apps = AudioApps();
                        var excluded = new HashSet<string>(config.exclude.Select(n => n.ToLowerInvariant()), StringComparer.OrdinalIgnoreCase);
                        var candidates = apps.Select(a => a.pid);
                        // Diagnostic harness restricts capture to its own synthetic tone processes.
                        if (config.capturePids != null) candidates = candidates.Where(pid => config.capturePids.Contains(pid));
                        var roots = Policy.Select(candidates, processes, excluded, config.ownerPid);
                        foreach (var pid in captures.Keys.Except(roots).ToArray()) { captures[pid].Dispose(); captures.Remove(pid); }
                        foreach (var pid in roots.Except(captures.Keys)) {
                            try { captures.Add(pid, new Capture(pid)); }
                            catch (Exception e) { throw new Exception("无法采集 " + pid + " 的音频：" + e.Message); }
                        }
                        Status(new { type = "ready", included = roots, apps = apps, excluded = config.exclude });
                        nextRefresh = timer.ElapsedMilliseconds + 1000;
                        // Never accumulate seconds of backlog during device enumeration/activation.
                        nextPacket = timer.ElapsedMilliseconds;
                    }
                    foreach (var capture in captures.Values) capture.Read();
                    if (timer.ElapsedMilliseconds >= nextPacket) {
                        var mix = new float[960];
                        foreach (var capture in captures.Values) capture.Mix(mix);
                        for (int i = 0; i < mix.Length; i++) mix[i] = Math.Max(-1f, Math.Min(1f, mix[i]));
                        var bytes = new byte[mix.Length * 4];
                        Buffer.BlockCopy(mix, 0, bytes, 0, bytes.Length);
                        output.Write(bytes, 0, bytes.Length);
                        nextPacket += 10;
                        if (timer.ElapsedMilliseconds - nextPacket > 100) nextPacket = timer.ElapsedMilliseconds;
                    }
                    Thread.Sleep(2);
                }
            } finally { foreach (var c in captures.Values) c.Dispose(); Native.timeEndPeriod(1); }
            return 0;
        } catch (Exception e) { Status(new { type = "error", message = e.Message, code = e.HResult }); return 1; }
    }
    public class Config { public string[] exclude { get; set; } public int ownerPid { get; set; } public int[] capturePids { get; set; } }
    public class AppInfo { public int pid; public string name; public string label; }
    static AppInfo[] AudioApps() {
        var ids = new HashSet<int>();
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDeviceCollection devices = null;
        try {
            Check(enumerator.EnumAudioEndpoints(0, 1, out devices));
            uint count; Check(devices.GetCount(out count));
            for (uint i = 0; i < count; i++) {
                IMMDevice device = null; object managerObject = null; IAudioSessionEnumerator sessions = null;
                try {
                    Check(devices.Item(i, out device));
                    var iid = typeof(IAudioSessionManager2).GUID;
                    Check(device.Activate(ref iid, 23, IntPtr.Zero, out managerObject));
                    var manager = (IAudioSessionManager2)managerObject;
                    Check(manager.GetSessionEnumerator(out sessions));
                    int total; Check(sessions.GetCount(out total));
                    for (int j = 0; j < total; j++) {
                        IAudioSessionControl2 control = null;
                        try { Check(sessions.GetSession(j, out control)); uint pid; Check(control.GetProcessId(out pid)); if (pid > 0) ids.Add((int)pid); }
                        finally { if (control != null) Marshal.ReleaseComObject(control); }
                    }
                } finally {
                    if (sessions != null) Marshal.ReleaseComObject(sessions);
                    if (managerObject != null) Marshal.ReleaseComObject(managerObject);
                    if (device != null) Marshal.ReleaseComObject(device);
                }
            }
        } finally { if (devices != null) Marshal.ReleaseComObject(devices); Marshal.ReleaseComObject(enumerator); }
        var result = new List<AppInfo>();
        foreach (var pid in ids) {
            try { using (var p = Process.GetProcessById(pid)) result.Add(new AppInfo { pid = pid, name = p.ProcessName, label = p.ProcessName }); }
            catch (ArgumentException) {} // Exited between enumeration and lookup.
        }
        return result.OrderBy(a => a.name).ToArray();
    }
}

class ProcessInfo {
    public int Pid; public int Parent; public string Name;
    public ProcessInfo(int pid, int parent, string name) { Pid = pid; Parent = parent; Name = name; }
}
static class Policy {
    static bool Descendant(int pid, int ancestor, Dictionary<int, ProcessInfo> all) {
        var seen = new HashSet<int>();
        while (pid > 0 && seen.Add(pid)) {
            if (pid == ancestor) return true;
            ProcessInfo p; if (!all.TryGetValue(pid, out p)) break;
            pid = p.Parent;
        }
        return false;
    }
    public static HashSet<int> Select(IEnumerable<int> candidates, Dictionary<int, ProcessInfo> all, HashSet<string> excluded, int owner) {
        var blocked = all.Values.Where(p => excluded.Contains(Path.GetFileNameWithoutExtension(p.Name))).Select(p => p.Pid).ToList();
        blocked.Add(owner);
        blocked.Add(Process.GetCurrentProcess().Id);
        var safe = candidates.Where(pid => all.ContainsKey(pid) && !blocked.Any(b => Descendant(pid, b, all) || Descendant(b, pid, all))).Distinct().ToArray();
        // Include each audio tree only once. An ancestor of an excluded process is omitted
        // too, since WASAPI includes descendants. Never subtract captured voice from a mix.
        return new HashSet<int>(safe.Where(pid => !safe.Any(other => other != pid && Descendant(pid, other, all))));
    }
}
static class PolicyTests {
    public static void Run() {
        var tree = new [] { new ProcessInfo(100,0,"explorer.exe"), new ProcessInfo(101,100,"KOOK.exe"), new ProcessInfo(102,101,"helper.exe"), new ProcessInfo(103,100,"HeyBoxChat.exe"), new ProcessInfo(104,100,"game.exe"), new ProcessInfo(105,104,"renderer.exe"), new ProcessInfo(106,100,"XgoatCast.exe") }.ToDictionary(p => p.Pid);
        var result = Policy.Select(new [] {100,101,102,103,104,105,106}, tree, new HashSet<string>(new [] {"kook","heyboxchat"}, StringComparer.OrdinalIgnoreCase),106);
        if (!result.SetEquals(new [] {104})) throw new Exception("Policy leaked excluded tree or duplicated capture");
        tree[107] = new ProcessInfo(107,104,"KOOK.exe");
        result = Policy.Select(new [] {104,105,107}, tree, new HashSet<string>(new [] {"kook"}, StringComparer.OrdinalIgnoreCase),106);
        if (!result.SetEquals(new [] {105})) throw new Exception("Mixed ancestor was not excluded");
    }
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public class Activation : IActivateAudioInterfaceCompletionHandler, IAgileObject {
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public IAudioClient Client; public int Result;
    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) {
        try { object value; int hr; AudioBridge.Check(operation.GetActivateResult(out hr, out value)); Result = hr; if (hr >= 0) Client = (IAudioClient)value; }
        catch (Exception e) { Result = e.HResult; }
        finally { Done.Set(); }
        return 0;
    }
}
class Capture : IDisposable {
    IAudioClient client; IAudioCaptureClient capture;
    readonly Queue<float> queue = new Queue<float>();
    readonly AutoResetEvent sampleEvent = new AutoResetEvent(false);
    public Capture(int pid) {
        string stage = "ActivateAudioInterfaceAsync";
        try {
            var activation = new Activation();
            var config = new ActivationParams { Type = 1, Pid = (uint)pid, Mode = 0 };
            IntPtr blob = Marshal.AllocHGlobal(Marshal.SizeOf(config));
            IActivateAudioInterfaceAsyncOperation operation = null;
            try {
                Marshal.StructureToPtr(config, blob, false);
                var prop = new PropVariant { Type = 65, Size = (uint)Marshal.SizeOf(config), Data = blob };
                var iid = typeof(IAudioClient).GUID;
                AudioBridge.Check(Native.ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, ref prop, activation, out operation));
                stage = "Activation callback";
                // Keep the activation blob alive until Windows has consumed it.
                if (!activation.Done.WaitOne(10000)) throw new TimeoutException("音频接口启动超时");
                AudioBridge.Check(activation.Result);
                client = activation.Client;
            } finally { Marshal.FreeHGlobal(blob); if (operation != null) Marshal.ReleaseComObject(operation); }
            stage = "Initialize";
            var format = new WaveFormat { Tag = 1, Channels = 2, Rate = 48000, BytesPerSecond = 192000, Align = 4, Bits = 16 };
            AudioBridge.Check(client.Initialize(0, 0x80000000 | 0x00020000 | 0x00040000, 0, 0, ref format, IntPtr.Zero));
            var captureIid = typeof(IAudioCaptureClient).GUID; object service;
            stage = "GetService";
            AudioBridge.Check(client.GetService(ref captureIid, out service)); capture = (IAudioCaptureClient)service;
            stage = "SetEventHandle";
            AudioBridge.Check(client.SetEventHandle(sampleEvent.SafeWaitHandle.DangerousGetHandle()));
            stage = "Start";
            AudioBridge.Check(client.Start());
        } catch (Exception e) { Dispose(); throw new Exception(stage + ": " + e.Message + " (0x" + e.HResult.ToString("X8") + ")", e); }
    }
    public void Read() {
        uint frames;
        AudioBridge.Check(capture.GetNextPacketSize(out frames));
        while (frames > 0) {
            IntPtr data; uint flags; ulong devicePosition, qpc;
            AudioBridge.Check(capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpc));
            try {
                var samples = new short[frames * 2];
                if ((flags & 2) == 0) Marshal.Copy(data, samples, 0, samples.Length);
                foreach (var value in samples) queue.Enqueue(value / 32768f);
                while (queue.Count > 9600) queue.Dequeue(); // 100 ms maximum backlog
            } finally { AudioBridge.Check(capture.ReleaseBuffer(frames)); }
            AudioBridge.Check(capture.GetNextPacketSize(out frames));
        }
    }
    public void Mix(float[] output) { for (int i = 0; i < output.Length && queue.Count > 0; i++) output[i] += queue.Dequeue(); }
    public void Dispose() {
        if (client != null) { client.Stop(); }
        if (capture != null) { Marshal.ReleaseComObject(capture); capture = null; }
        if (client != null) { Marshal.ReleaseComObject(client); client = null; }
        sampleEvent.Dispose();
    }
}

static class Native {
    [DllImport("Mmdevapi.dll", ExactSpelling = true, CharSet = CharSet.Unicode)] public static extern int ActivateAudioInterfaceAsync(string path, ref Guid iid, ref PropVariant config, IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation operation);
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint period);
    [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint period);
    [DllImport("ntdll.dll", CharSet = CharSet.Unicode)] static extern int RtlGetVersion(ref OSVersion version);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct OSVersion { public uint Size, Major, Minor, Build, Platform; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string ServicePack; }
    public static uint Build() { var v = new OSVersion(); v.Size = (uint)Marshal.SizeOf(v); AudioBridge.Check(RtlGetVersion(ref v)); return v.Build; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessEntry {
        public uint Size, Usage, Pid; public UIntPtr Heap; public uint Module, Threads, Parent; public int Priority; public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe;
    }
    public static Dictionary<int, ProcessInfo> Processes() {
        var snapshot = CreateToolhelp32Snapshot(2,0);
        if (snapshot == new IntPtr(-1)) throw new Exception("无法读取软件进程列表");
        try {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            var result = new Dictionary<int, ProcessInfo>();
            if (!Process32FirstW(snapshot, ref entry)) throw new Exception("无法读取软件进程列表");
            do { result[(int)entry.Pid] = new ProcessInfo((int)entry.Pid, (int)entry.Parent, entry.Exe); } while (Process32NextW(snapshot, ref entry));
            return result;
        } finally { CloseHandle(snapshot); }
    }
}
[StructLayout(LayoutKind.Sequential)] struct ActivationParams { public int Type; public uint Pid; public int Mode; }
[StructLayout(LayoutKind.Explicit, Size=24)] struct PropVariant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public uint Size; [FieldOffset(16)] public IntPtr Data; }
[StructLayout(LayoutKind.Sequential, Pack=2)] public struct WaveFormat { public ushort Tag, Channels; public uint Rate, BytesPerSecond; public ushort Align, Bits, Extra; }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IMMDeviceCollection devices);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count); [PreserveSig] int Item(uint index, out IMMDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object value);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr guid, uint flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, uint flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count); [PreserveSig] int GetSession(int index, out IAudioSessionControl2 control);
}
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr context);
    [PreserveSig] int GetGroupingParam(out Guid group);
    [PreserveSig] int SetGroupingParam(ref Guid group, IntPtr context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint pid);
}
[ComVisible(true), Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IActivateAudioInterfaceCompletionHandler {
    [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}
[ComVisible(true), Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IAgileObject {}
[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IActivateAudioInterfaceAsyncOperation {
    [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object value);
}
[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IAudioClient {
    [PreserveSig] int Initialize(int mode, uint flags, long duration, long periodicity, ref WaveFormat format, IntPtr session);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(int mode, ref WaveFormat format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long normal, out long minimum);
    [PreserveSig] int Start(); [PreserveSig] int Stop(); [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object value);
}
[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpc);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}
