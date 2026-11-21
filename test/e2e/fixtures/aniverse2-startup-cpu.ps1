param([Parameter(Mandatory)][ValidateRange(2000,30000)][int]$DurationMs)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class StartupCpu
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Entry {
        public uint size, usage, pid;
        public UIntPtr heap;
        public uint module, threads, parent;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    }
    [DllImport("kernel32.dll")] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32First(IntPtr snapshot, ref Entry row);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32Next(IntPtr snapshot, ref Entry row);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr handle, out long started, out long exited, out long kernel, out long user);

    [StructLayout(LayoutKind.Sequential)]
    private struct Memory {
        public uint size, faults;
        public UIntPtr peakWorking, working, peakPaged, paged, peakNonpaged, nonpaged, pagefile, peakPagefile, privateBytes;
    }
    [DllImport("psapi.dll")] private static extern bool GetProcessMemoryInfo(IntPtr handle, ref Memory info, uint size);
    private static readonly uint MemorySize = (uint)Marshal.SizeOf(typeof(Memory));

    private static HashSet<uint> Descendants(uint root)
    {
        var descendants = new HashSet<uint> { root };
        var parents = new Dictionary<uint, uint>();
        var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) return descendants;
        try {
            var row = new Entry { size = (uint)Marshal.SizeOf(typeof(Entry)) };
            if (Process32First(snapshot, ref row)) {
                do { parents[row.pid] = row.parent; } while (Process32Next(snapshot, ref row));
            }
        } finally { CloseHandle(snapshot); }
        int count;
        do {
            count = descendants.Count;
            foreach (var item in parents) {
                if (descendants.Contains(item.Value)) descendants.Add(item.Key);
            }
        } while (descendants.Count != count);
        return descendants;
    }

    public static void Measure(uint pid, int duration)
    {
        long started, exited, kernel, user;
        var handles = new Dictionary<uint, IntPtr>();
        var root = OpenProcess(0x1000, false, pid);
        if (root == IntPtr.Zero) throw new InvalidOperationException("Could not open test application process");
        handles.Add(pid, root);
        try {
            if (!GetProcessTimes(root, out started, out exited, out kernel, out user))
                throw new InvalidOperationException("Could not time test application process");
            var first = started;
            var clock = Stopwatch.StartNew();
            var sinceStart = Math.Max(0, (DateTime.UtcNow.ToFileTimeUtc() - first) / 10000);
            while (true) {
                foreach (var child in Descendants(pid)) {
                    if (handles.ContainsKey(child)) continue;
                    var handle = OpenProcess(0x1000, false, child);
                    if (handle == IntPtr.Zero) continue;
                    if (GetProcessTimes(handle, out started, out exited, out kernel, out user) && started >= first)
                        handles.Add(child, handle);
                    else CloseHandle(handle);
                }
                long total = 0;
                ulong working = 0, privateBytes = 0;
                int live = 0, measured = 0;
                foreach (var handle in handles.Values) {
                    if (!GetProcessTimes(handle, out started, out exited, out kernel, out user)) continue;
                    total += kernel + user;
                    if (exited != 0) continue;
                    live++;
                    var memory = new Memory { size = MemorySize };
                    if (GetProcessMemoryInfo(handle, ref memory, MemorySize)) {
                        working += memory.working.ToUInt64();
                        privateBytes += memory.privateBytes.ToUInt64();
                        measured++;
                    }
                }
                var elapsed = sinceStart + clock.ElapsedMilliseconds;
                Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0},{1:F3},{2},{3},{4},{5},{6}",
                    elapsed, total / 10000.0, handles.Count, working, privateBytes, live, measured));
                if (elapsed >= duration) break;
                Thread.Sleep(150);
            }
        } finally {
            foreach (var handle in handles.Values) CloseHandle(handle);
        }
    }
}
'@
[Console]::WriteLine('ready')
[StartupCpu]::Measure([uint32][Console]::ReadLine(), $DurationMs)
