using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint JobObjectLimitActiveProcess = 0x00000008;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const uint WaitFailed = 0xffffffff;

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint cb;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpReserved;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpDesktop;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public uint dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr security, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int informationClass, IntPtr info, uint size);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string? applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void Ensure(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static string Quote(string input)
    {
        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (char ch in input)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
            }
            else
            {
                result.Append('\\', slashes);
                result.Append(ch);
            }
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static IntPtr MinimalEnvironment()
    {
        string root = Environment.GetEnvironmentVariable("SystemRoot")
            ?? throw new InvalidOperationException("SystemRoot must be set.");
        string temp = Path.GetTempPath().TrimEnd('\\');
        // Windows requires a double-NUL-terminated sorted UTF-16 environment block.
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = root,
            ["TEMP"] = temp,
            ["TMP"] = temp
        };
        string block = string.Join("\0", values.Select(x => x.Key + "=" + x.Value)) + "\0\0";
        return Marshal.StringToHGlobalUni(block);
    }

    private static int Run(string[] arguments)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        // This utility guarantees Job Object lifetime only: NOT filesystem or
        // network containment, NOT an unattended model sandbox.
        if (arguments.Length < 4 ||
            !int.TryParse(arguments[0], out int timeoutMs) ||
            timeoutMs < 100 || timeoutMs > 120000)
            throw new ArgumentException("Expected timeout-ms workdir absolute-executable arguments...");

        string workingDirectory = Path.GetFullPath(arguments[1]);
        string executable = Path.GetFullPath(arguments[2]);
        if (!Path.IsPathFullyQualified(arguments[1]) || !Path.IsPathFullyQualified(arguments[2]) ||
            !Directory.Exists(workingDirectory) || !File.Exists(executable))
            throw new ArgumentException("Existing absolute workdir and executable required.");

        IntPtr job = IntPtr.Zero, limitsPointer = IntPtr.Zero, environment = IntPtr.Zero;
        ProcessInformation process = default;
        try
        {
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
            var limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags =
                JobObjectLimitKillOnJobClose | JobObjectLimitActiveProcess;
            limits.BasicLimitInformation.ActiveProcessLimit = 32;
            int size = Marshal.SizeOf<ExtendedLimits>();
            limitsPointer = Marshal.AllocHGlobal(size);
            Marshal.StructureToPtr(limits, limitsPointer, false);
            Ensure(SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                limitsPointer, (uint)size), "SetInformationJobObject");

            var startup = new StartupInfo { cb = (uint)Marshal.SizeOf<StartupInfo>() };
            string cmd = string.Join(" ", new[] { executable }
                .Concat(arguments.Skip(3)).Select(Quote));
            environment = MinimalEnvironment();
            Ensure(CreateProcessW(executable, new StringBuilder(cmd),
                IntPtr.Zero, IntPtr.Zero, false,
                CreateSuspended | CreateNoWindow | CreateUnicodeEnvironment,
                environment, workingDirectory, ref startup, out process), "CreateProcessW");

            // Critical: assignment happens BEFORE ResumeThread, eliminating
            // the race where the worker executes outside the Job Object.
            Ensure(AssignProcessToJobObject(job, process.hProcess), "AssignProcessToJobObject");
            if (ResumeThread(process.hThread) == uint.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");

            uint wait = WaitForSingleObject(process.hProcess, (uint)timeoutMs);
            if (wait == WaitTimeout)
            {
                Ensure(TerminateJobObject(job, 124), "TerminateJobObject");
                if (WaitForSingleObject(process.hProcess, 5000) != WaitObject0)
                    throw new InvalidOperationException("JOB_TREE_KILL_UNVERIFIED");
                return 124;
            }
            if (wait == WaitFailed || wait != WaitObject0)
                throw new InvalidOperationException("JOB_WAIT_UNVERIFIED");
            Ensure(GetExitCodeProcess(process.hProcess, out uint code), "GetExitCodeProcess");
            return code == 0 ? 0 : 1;
        }
        finally
        {
            // If the worker returns normally but leaves descendants running,
            // closing the last Job handle terminates the entire associated tree.
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (limitsPointer != IntPtr.Zero) Marshal.FreeHGlobal(limitsPointer);
        }
    }

    private static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception error)
        {
            Console.Error.WriteLine("JOB_SUPERVISOR_FAIL_CLOSED: " + error.GetType().Name);
            return 125;
        }
    }
}
