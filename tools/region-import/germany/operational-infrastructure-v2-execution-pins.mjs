import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { link, lstat, mkdtemp, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA = "zugfolge-germany-operational-v2-execution-pins/v1";
export const GERMANY_OPERATIONAL_EXECUTION_PROOF_SCHEMA = "zugfolge-germany-operational-v2-execution-proof/v1";
export const GERMANY_OPERATIONAL_PROVENANCE_SCHEMA = "zugfolge-germany-operational-v2-provenance/v1";
export const GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND = "integrated-runner-v1";
export const GERMANY_OPERATIONAL_FORENSIC_PRODUCER_KIND = "forensic-stdin-v1";
export const GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE = "held-direct-contract-windows-v1";
export const GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA =
  "zugfolge-operational-v2-direct-system-launch-contract/v1";
export const GERMANY_OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT = "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs";
export const GERMANY_OPERATIONAL_EXECUTION_RUNNER_BUNDLE = "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs";
export const GERMANY_OPERATIONAL_EXECUTION_COMMAND_BUILDER = "tools/region-import/germany/print-operational-infrastructure-v2-system-launch-command.mjs";
export const GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE = "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1";
export const GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE = "tools/region-import/germany/operational-windows-anchor-helper.dll";
export const GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE = "tools/region-import/germany/operational-infrastructure-v2-system-launcher.linux.py";
export const GERMANY_OPERATIONAL_RUNNER_INVOCATION_MODE = "system-launcher-held-bundle-stdin-v1";
export const GERMANY_OPERATIONAL_COMMAND_BUILDER_MODE = "source-only-print-direct-command-v1";
export const GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE = "windows-system-powershell-held-bundle-v1";
export const GERMANY_OPERATIONAL_LINUX_LAUNCHER_MODE = "linux-system-python-held-bundle-v1";
export const GERMANY_OPERATIONAL_RUNNER_PHASES = Object.freeze({
  "derive-and-capture-v1": 7,
  "execute-annual-operational-v2-v1": 8,
  "materialize-annual-plan-evidence-v1": 6,
  "materialize-validator-rebuild-v3": 3,
});
export const GERMANY_OPERATIONAL_REBUILD_AUTHORITY_ENVIRONMENT_KEYS = Object.freeze([
  "GITHUB_ACTIONS",
  "GITHUB_EVENT_NAME",
  "GITHUB_REF",
  "GITHUB_REF_PROTECTED",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_REF",
  "RUNNER_ARCH",
  "RUNNER_ENVIRONMENT",
  "RUNNER_OS",
  "ZUGFOLGE_REBUILD_RUNNER_IMAGE",
]);
export const GERMANY_OPERATIONAL_ANNUAL_PLAN_TIMEOUT_MILLISECONDS = 120_000;
export const GERMANY_OPERATIONAL_ANNUAL_RUN_TIMEOUT_MILLISECONDS = 21_600_000;
export const GERMANY_OPERATIONAL_EXECUTION_RUNNER_ROOT_FILES = Object.freeze([
  "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs",
  "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
  GERMANY_OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT,
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_COMMAND = /^[a-z0-9][a-z0-9-]*$/u;
const ASCII_CONTROL_CHARACTER = /[\x00-\x1f\x7f]/u;
const MAX_PINS_BYTES = 1024 * 1024;
const WINDOWS_TRUSTED_SYSTEM_ROOT = String.raw`C:\Windows`;
const WINDOWS_TRUSTED_CMD = String.raw`C:\Windows\System32\cmd.exe`;
const WINDOWS_TRUSTED_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const COMMAND_ARGUMENTS = Object.freeze([
  "derive-germany-operational-v2",
  "{specification}",
  "{sourceRoot}",
  "{candidate}",
  "{report}",
]);

// CreateProcessW must receive the image-load mitigation at process creation:
// setting it inside Node or the validator would be too late for their initial
// imports. This PS-5.1-compatible helper applies the documented
// PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY through STARTUPINFOEX and keeps all
// redirected handles live until the process has ended.
const WINDOWS_MITIGATED_PROCESS_CSHARP_SOURCE = String.raw`
public sealed class ZugfolgeMitigatedProcessResult
{
    public int ExitCode { get; private set; }
    public byte[] Stdout { get; private set; }
    public byte[] Stderr { get; private set; }

    internal ZugfolgeMitigatedProcessResult(int exitCode, byte[] stdout, byte[] stderr)
    {
        ExitCode = exitCode;
        Stdout = stdout;
        Stderr = stderr;
    }
}

public static class ZugfolgeMitigatedProcess
{
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_FAILED = 0xffffffff;
    private static readonly System.IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new System.IntPtr(0x00020002);
    private static readonly System.IntPtr PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY = new System.IntPtr(0x00020007);
    private const ulong IMAGE_LOAD_POLICY =
        (1UL << 44) | // BLOCK_NON_MICROSOFT_BINARIES_ALWAYS_ON
        (1UL << 52) | // IMAGE_LOAD_NO_REMOTE_ALWAYS_ON
        (1UL << 56) | // IMAGE_LOAD_NO_LOW_LABEL_ALWAYS_ON
        (1UL << 60);  // IMAGE_LOAD_PREFER_SYSTEM32_ALWAYS_ON

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public System.IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public System.IntPtr lpReserved2;
        public System.IntPtr hStdInput;
        public System.IntPtr hStdOutput;
        public System.IntPtr hStdError;
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public System.IntPtr lpAttributeList;
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public System.IntPtr hProcess;
        public System.IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool CreatePipe(out System.IntPtr hReadPipe, out System.IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(System.IntPtr hObject, uint dwMask, uint dwFlags);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(System.IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref System.IntPtr lpSize);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(System.IntPtr lpAttributeList, uint dwFlags, System.IntPtr attribute, System.IntPtr lpValue, System.IntPtr cbSize, System.IntPtr lpPreviousValue, System.IntPtr lpReturnSize);

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(System.IntPtr lpAttributeList);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        System.Text.StringBuilder lpCommandLine,
        System.IntPtr lpProcessAttributes,
        System.IntPtr lpThreadAttributes,
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] bool bInheritHandles,
        uint dwCreationFlags,
        System.IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(System.IntPtr hHandle, uint dwMilliseconds);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(System.IntPtr hProcess, out uint lpExitCode);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool TerminateProcess(System.IntPtr hProcess, uint uExitCode);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool CloseHandle(System.IntPtr hObject);

    private static System.ComponentModel.Win32Exception Win32(string action)
    {
        return new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(), action);
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length == 0) return "\"\"";
        bool quoted = false;
        foreach (char character in value)
        {
            if (System.Char.IsWhiteSpace(character) || character == '\"') { quoted = true; break; }
        }
        if (!quoted) return value;
        System.Text.StringBuilder output = new System.Text.StringBuilder();
        output.Append('\"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes += 1; continue; }
            if (character == '\"')
            {
                output.Append('\\', backslashes * 2 + 1);
                output.Append('\"');
                backslashes = 0;
                continue;
            }
            output.Append('\\', backslashes);
            backslashes = 0;
            output.Append(character);
        }
        output.Append('\\', backslashes * 2);
        output.Append('\"');
        return output.ToString();
    }

    private static System.IntPtr EnvironmentBlock(System.Collections.IDictionary environment)
    {
        System.Collections.Generic.SortedDictionary<string, string> sorted =
            new System.Collections.Generic.SortedDictionary<string, string>(System.StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry entry in environment)
        {
            string key = entry.Key as string;
            string value = entry.Value as string;
            if (System.String.IsNullOrEmpty(key) || key.IndexOf('=') >= 0 || key.IndexOf('\0') >= 0 || value == null || value.IndexOf('\0') >= 0)
                throw new System.InvalidOperationException("Windows-Kindumgebung enthaelt einen ungueltigen Eintrag.");
            sorted.Add(key, value);
        }
        System.Text.StringBuilder block = new System.Text.StringBuilder();
        foreach (System.Collections.Generic.KeyValuePair<string, string> entry in sorted)
        {
            block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        }
        block.Append('\0');
        return System.Runtime.InteropServices.Marshal.StringToHGlobalUni(block.ToString());
    }

    private static void CreateRedirectPipe(bool parentReads, out System.IntPtr childHandle, out System.IntPtr parentHandle)
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = System.Runtime.InteropServices.Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = 1;
        System.IntPtr read;
        System.IntPtr write;
        if (!CreatePipe(out read, out write, ref attributes, 0)) throw Win32("CreatePipe");
        childHandle = parentReads ? write : read;
        parentHandle = parentReads ? read : write;
        if (!SetHandleInformation(parentHandle, HANDLE_FLAG_INHERIT, 0))
        {
            int error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
            CloseHandle(read);
            CloseHandle(write);
            childHandle = System.IntPtr.Zero;
            parentHandle = System.IntPtr.Zero;
            throw new System.ComponentModel.Win32Exception(error, "SetHandleInformation");
        }
    }

    private static byte[] ReadBounded(System.IO.Stream stream, int maximumBytes, System.IntPtr processHandle, string label)
    {
        using (System.IO.MemoryStream output = new System.IO.MemoryStream())
        {
            byte[] buffer = new byte[8192];
            while (true)
            {
                int read = stream.Read(buffer, 0, buffer.Length);
                if (read == 0) break;
                if (output.Length + read > maximumBytes)
                {
                    TerminateProcess(processHandle, 93);
                    throw new System.InvalidOperationException(label + " ueberschritt das gepinnte Limit.");
                }
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }
    }

    public static ZugfolgeMitigatedProcessResult Run(
        string executable,
        string[] arguments,
        string workingDirectory,
        System.Collections.IDictionary environment,
        byte[] standardInput,
        int maximumBytes)
    {
        if (!System.IO.Path.IsPathRooted(executable)) throw new System.InvalidOperationException("Windows-Kindpfad ist nicht absolut.");
        if (maximumBytes <= 0) throw new System.InvalidOperationException("Windows-Kindausgabelimit ist ungueltig.");
        if (arguments == null) arguments = new string[0];
        if (standardInput == null) standardInput = new byte[0];

        System.IntPtr childStdin = System.IntPtr.Zero;
        System.IntPtr parentStdin = System.IntPtr.Zero;
        System.IntPtr childStdout = System.IntPtr.Zero;
        System.IntPtr parentStdout = System.IntPtr.Zero;
        System.IntPtr childStderr = System.IntPtr.Zero;
        System.IntPtr parentStderr = System.IntPtr.Zero;
        System.IntPtr attributeList = System.IntPtr.Zero;
        System.IntPtr inheritedHandleList = System.IntPtr.Zero;
        System.IntPtr mitigation = System.IntPtr.Zero;
        System.IntPtr environmentBlock = System.IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool attributesInitialized = false;
        try
        {
            CreateRedirectPipe(false, out childStdin, out parentStdin);
            CreateRedirectPipe(true, out childStdout, out parentStdout);
            CreateRedirectPipe(true, out childStderr, out parentStderr);

            System.IntPtr attributeBytes = System.IntPtr.Zero;
            InitializeProcThreadAttributeList(System.IntPtr.Zero, 2, 0, ref attributeBytes);
            if (attributeBytes == System.IntPtr.Zero) throw Win32("InitializeProcThreadAttributeList(size)");
            attributeList = System.Runtime.InteropServices.Marshal.AllocHGlobal(attributeBytes);
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeBytes)) throw Win32("InitializeProcThreadAttributeList");
            attributesInitialized = true;
            inheritedHandleList = System.Runtime.InteropServices.Marshal.AllocHGlobal(System.IntPtr.Size * 3);
            System.Runtime.InteropServices.Marshal.WriteIntPtr(inheritedHandleList, 0 * System.IntPtr.Size, childStdin);
            System.Runtime.InteropServices.Marshal.WriteIntPtr(inheritedHandleList, 1 * System.IntPtr.Size, childStdout);
            System.Runtime.InteropServices.Marshal.WriteIntPtr(inheritedHandleList, 2 * System.IntPtr.Size, childStderr);
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inheritedHandleList, new System.IntPtr(System.IntPtr.Size * 3), System.IntPtr.Zero, System.IntPtr.Zero))
                throw Win32("UpdateProcThreadAttribute(HANDLE_LIST)");
            mitigation = System.Runtime.InteropServices.Marshal.AllocHGlobal(8);
            System.Runtime.InteropServices.Marshal.WriteInt64(mitigation, unchecked((long)IMAGE_LOAD_POLICY));
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, mitigation, new System.IntPtr(8), System.IntPtr.Zero, System.IntPtr.Zero))
                throw Win32("UpdateProcThreadAttribute(MITIGATION_POLICY)");

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = System.Runtime.InteropServices.Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = childStdin;
            startup.StartupInfo.hStdOutput = childStdout;
            startup.StartupInfo.hStdError = childStderr;
            startup.lpAttributeList = attributeList;

            System.Text.StringBuilder commandLine = new System.Text.StringBuilder(QuoteArgument(executable));
            foreach (string argument in arguments)
            {
                if (argument == null || argument.IndexOf('\0') >= 0) throw new System.InvalidOperationException("Windows-Kindargument ist ungueltig.");
                commandLine.Append(' ').Append(QuoteArgument(argument));
            }
            environmentBlock = EnvironmentBlock(environment);
            uint creationFlags = CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
            if (!CreateProcessW(executable, commandLine, System.IntPtr.Zero, System.IntPtr.Zero, true, creationFlags, environmentBlock, workingDirectory, ref startup, out process))
                throw Win32("CreateProcessW(mitigated)");

            CloseHandle(childStdin); childStdin = System.IntPtr.Zero;
            CloseHandle(childStdout); childStdout = System.IntPtr.Zero;
            CloseHandle(childStderr); childStderr = System.IntPtr.Zero;

            using (System.IO.FileStream input = new System.IO.FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(parentStdin, true), System.IO.FileAccess.Write, 4096, false))
            using (System.IO.FileStream output = new System.IO.FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(parentStdout, true), System.IO.FileAccess.Read, 4096, false))
            using (System.IO.FileStream error = new System.IO.FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(parentStderr, true), System.IO.FileAccess.Read, 4096, false))
            {
                parentStdin = System.IntPtr.Zero;
                parentStdout = System.IntPtr.Zero;
                parentStderr = System.IntPtr.Zero;
                System.Threading.Tasks.Task inputTask = System.Threading.Tasks.Task.Factory.StartNew(delegate {
                    if (standardInput.Length > 0) input.Write(standardInput, 0, standardInput.Length);
                    input.Close();
                }, System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
                System.Threading.Tasks.Task<byte[]> stdoutTask = System.Threading.Tasks.Task.Factory.StartNew(
                    delegate { return ReadBounded(output, maximumBytes, process.hProcess, "stdout"); },
                    System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
                System.Threading.Tasks.Task<byte[]> stderrTask = System.Threading.Tasks.Task.Factory.StartNew(
                    delegate { return ReadBounded(error, maximumBytes, process.hProcess, "stderr"); },
                    System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
                uint wait = WaitForSingleObject(process.hProcess, INFINITE);
                if (wait == WAIT_FAILED) throw Win32("WaitForSingleObject");
                System.Threading.Tasks.Task.WaitAll(inputTask, stdoutTask, stderrTask);
                uint exitCode;
                if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw Win32("GetExitCodeProcess");
                return new ZugfolgeMitigatedProcessResult(unchecked((int)exitCode), stdoutTask.Result, stderrTask.Result);
            }
        }
        finally
        {
            if (process.hThread != System.IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != System.IntPtr.Zero) CloseHandle(process.hProcess);
            if (childStdin != System.IntPtr.Zero) CloseHandle(childStdin);
            if (parentStdin != System.IntPtr.Zero) CloseHandle(parentStdin);
            if (childStdout != System.IntPtr.Zero) CloseHandle(childStdout);
            if (parentStdout != System.IntPtr.Zero) CloseHandle(parentStdout);
            if (childStderr != System.IntPtr.Zero) CloseHandle(childStderr);
            if (parentStderr != System.IntPtr.Zero) CloseHandle(parentStderr);
            if (environmentBlock != System.IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(environmentBlock);
            if (mitigation != System.IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(mitigation);
            if (inheritedHandleList != System.IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(inheritedHandleList);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributeList);
            if (attributeList != System.IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(attributeList);
        }
    }
}
`;

// This parser intentionally lives entirely inside a string. Keeping its own
// CommonJS bootstrap out of this module's AST prevents the closure scanner from
// mistaking the trusted parser process for a loader in the release graph.
const MODULE_PARSER_CHILD_SOURCE = String.raw`
const { readFileSync } = require("node:fs");
const acorn = require("internal/deps/acorn/acorn/dist/acorn");
const tree = acorn.parse(readFileSync(0, "utf8"), {
  allowHashBang: true,
  ecmaVersion: "latest",
  sourceType: "module",
});
const staticSpecifiers = [];
const unsupportedLoaders = new Set();
const visited = new Set();
const nodes = [];
const propertyName = (node) => {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
};
const walk = (node) => {
  if (node === null || typeof node !== "object" || visited.has(node)) return;
  visited.add(node);
  nodes.push(node);
  if (node.type === "Identifier") {
    if (node.name === "require") unsupportedLoaders.add("commonjs-require");
    if (node.name === "createRequire") unsupportedLoaders.add("commonjs-create-require");
    if (node.name === "eval") unsupportedLoaders.add("runtime-eval");
    if (node.name === "Function") unsupportedLoaders.add("runtime-function-constructor");
    if (node.name === "getBuiltinModule") unsupportedLoaders.add("dynamic-builtin-module");
  }
  if (["ImportDeclaration", "ExportAllDeclaration", "ExportNamedDeclaration"].includes(node.type)
    && typeof node.source?.value === "string") staticSpecifiers.push(node.source.value);
  if (node.type === "ImportExpression") unsupportedLoaders.add("dynamic-import");
  if (node.type === "ImportDeclaration" && node.source?.value === "node:module") {
    unsupportedLoaders.add("node-module-loader-api");
    for (const specifier of node.specifiers) {
      if (specifier.type !== "ImportSpecifier" || propertyName(specifier.imported) === "createRequire") {
        unsupportedLoaders.add("commonjs-create-require");
      }
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
    } else {
      walk(value);
    }
  }
};
walk(tree);
for (const node of nodes) {
  if (node.type !== "CallExpression" && node.type !== "NewExpression") continue;
  const direct = propertyName(node.callee);
  const member = node.callee?.type === "MemberExpression" ? propertyName(node.callee.property) : null;
  if (direct === "require" || member === "require") unsupportedLoaders.add("commonjs-require");
  if (direct === "createRequire" || member === "createRequire") unsupportedLoaders.add("commonjs-create-require");
  if (direct === "eval" || member === "eval") unsupportedLoaders.add("runtime-eval");
  if (direct === "Function" || member === "Function") unsupportedLoaders.add("runtime-function-constructor");
  if (direct === "getBuiltinModule" || member === "getBuiltinModule") unsupportedLoaders.add("dynamic-builtin-module");
}
process.stdout.write(JSON.stringify({
  staticSpecifiers,
  unsupportedLoaders: [...unsupportedLoaders].sort(),
}) + "\n");
`;

const WINDOWS_HELD_BUNDLE_LAUNCH_POWERSHELL_SOURCE = String.raw`
$ErrorActionPreference = "Stop"
function Load-ZugfolgeMitigatedProcess([string]$EnvironmentPrefix) {
  if ($null -ne ("ZugfolgeMitigatedProcess" -as [type])) { throw "Windows-Anchor-Helper wurde vor der gehaltenen Bytepruefung vorgeladen." }
  $path = [Environment]::GetEnvironmentVariable($EnvironmentPrefix + "PATH", "Process")
  $bytesText = [Environment]::GetEnvironmentVariable($EnvironmentPrefix + "BYTES", "Process")
  $expectedSha256 = [Environment]::GetEnvironmentVariable($EnvironmentPrefix + "SHA256", "Process")
  if ([String]::IsNullOrEmpty($path) -or [String]::IsNullOrEmpty($bytesText) -or
      $expectedSha256 -cnotmatch "^[a-f0-9]{64}$") { throw "Windows-Anchor-Helper-Pin fehlt." }
  $expectedBytes = [Int32]::Parse($bytesText, [Globalization.CultureInfo]::InvariantCulture)
  if ($expectedBytes -le 0 -or $expectedBytes -gt 2097152) { throw "Windows-Anchor-Helper-Bytezahl ist ungueltig." }
  $handle = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($handle.Length -ne $expectedBytes) { throw "Gehaltene Windows-Anchor-Helper-Assembly besitzt eine falsche Bytezahl." }
    $bytes = New-Object byte[] $expectedBytes
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $handle.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -eq 0) { throw "Gehaltene Windows-Anchor-Helper-Assembly endete vorzeitig." }
      $offset += $count
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actualSha256 = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($actualSha256 -cne $expectedSha256) { throw "Gehaltene Windows-Anchor-Helper-Assembly besitzt einen falschen SHA-256." }
    $assembly = [Reflection.Assembly]::Load($bytes)
    if (-not [String]::IsNullOrEmpty($assembly.Location) -or
        $null -eq $assembly.GetType("ZugfolgeMitigatedProcess", $false, $false)) {
      throw "Windows-Anchor-Helper wurde nicht ausschliesslich aus den gehaltenen Bytes geladen."
    }
  } finally {
    $handle.Dispose()
  }
}
if ([Environment]::GetEnvironmentVariable("ZUGFOLGE_OPERATIONAL_LAUNCHER_PURPOSE") -eq "validator") {
  $prefix = "ZUGFOLGE_OPERATIONAL_ANCHOR_"
  function AnchorRequired([string]$name) {
    $value = [Environment]::GetEnvironmentVariable($prefix + $name)
    if ([String]::IsNullOrEmpty($value)) { throw "Fehlender Validator-Launcher-Wert $name." }
    return $value
  }
  function AnchorHex([byte[]]$value) {
    return ([BitConverter]::ToString($value)).Replace("-", "").ToLowerInvariant()
  }
  $heldValidator = $null
  $heldInputs = New-Object 'System.Collections.Generic.List[System.IO.FileStream]'
  $inputProofs = New-Object 'System.Collections.Generic.List[object]'
  try {
    Load-ZugfolgeMitigatedProcess "ZUGFOLGE_OPERATIONAL_ANCHOR_HELPER_"
    $executable = AnchorRequired "PATH"
    $workingDirectory = AnchorRequired "CWD"
    $expectedBytes = [Int64]::Parse((AnchorRequired "BYTES"), [Globalization.CultureInfo]::InvariantCulture)
    $expectedSha256 = AnchorRequired "SHA256"
    $maximumBytes = [Int32]::Parse((AnchorRequired "MAX_BYTES"), [Globalization.CultureInfo]::InvariantCulture)
    $timeoutMilliseconds = [Int32]::Parse((AnchorRequired "TIMEOUT_MILLISECONDS"), [Globalization.CultureInfo]::InvariantCulture)
    if ($timeoutMilliseconds -le 0 -or $timeoutMilliseconds -gt 21600000) { throw "Validator-Launcher besitzt keinen begrenzten Timeout." }
    $argumentCount = [Int32]::Parse((AnchorRequired "ARG_COUNT"), [Globalization.CultureInfo]::InvariantCulture)
    $inputCountText = [Environment]::GetEnvironmentVariable($prefix + "INPUT_COUNT")
    $inputCount = if ([String]::IsNullOrEmpty($inputCountText)) { 0 } else { [Int32]::Parse($inputCountText, [Globalization.CultureInfo]::InvariantCulture) }
    if ($inputCount -lt 0 -or $inputCount -gt 16) { throw "Validator-Launcher besitzt eine ungueltige Inputzahl." }
    $heldValidator = [IO.File]::Open($executable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($heldValidator.Length -ne $expectedBytes) { throw "Exklusiv gehaltener Validator besitzt eine falsche Bytezahl." }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $heldSha256 = AnchorHex ($sha.ComputeHash($heldValidator)) } finally { $sha.Dispose() }
    if ($heldSha256 -ne $expectedSha256) { throw "Exklusiv gehaltener Validator besitzt einen falschen SHA-256." }
    $arguments = New-Object string[] $argumentCount
    for ($index = 0; $index -lt $argumentCount; $index += 1) { $arguments[$index] = AnchorRequired "ARG_$index" }
    for ($index = 0; $index -lt $inputCount; $index += 1) {
      $inputFile = AnchorRequired "INPUT_$($index)_FILE"
      $inputPath = AnchorRequired "INPUT_$($index)_PATH"
      $inputBytes = [Int64]::Parse((AnchorRequired "INPUT_$($index)_BYTES"), [Globalization.CultureInfo]::InvariantCulture)
      $inputSha256 = AnchorRequired "INPUT_$($index)_SHA256"
      if ($inputBytes -le 0 -or $inputBytes -gt 16777216 -or $inputSha256 -cnotmatch "^[a-f0-9]{64}$") { throw "Validator-Launcher-Inputpin ist ungueltig." }
      $inputHandle = [IO.File]::Open($inputPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      if ($inputHandle.Length -ne $inputBytes) { $inputHandle.Dispose(); throw "Gehaltene Validator-Inputdatei besitzt eine falsche Bytezahl." }
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $actualInputSha256 = AnchorHex ($sha.ComputeHash($inputHandle)) } finally { $sha.Dispose() }
      if ($actualInputSha256 -cne $inputSha256) { $inputHandle.Dispose(); throw "Gehaltene Validator-Inputdatei besitzt einen falschen SHA-256." }
      $inputHandle.Position = 0
      $heldInputs.Add($inputHandle)
      $inputProofs.Add([ordered]@{ bytes = $inputBytes; file = $inputFile; sha256 = $actualInputSha256 })
    }
    $childEnvironment = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
      $name = [String]$entry.Key
      if (-not $name.StartsWith("ZUGFOLGE_OPERATIONAL_ANCHOR_", [StringComparison]::Ordinal) -and -not $name.StartsWith("ZUGFOLGE_OPERATIONAL_LAUNCHER_", [StringComparison]::Ordinal)) {
        $childEnvironment[$name] = [String]$entry.Value
      }
    }
    $child = [ZugfolgeMitigatedProcess]::RunStrict(
      $executable,
      $arguments,
      $workingDirectory,
      $childEnvironment,
      [byte[]]@(),
      $maximumBytes,
      $timeoutMilliseconds,
      $null)
    for ($index = 0; $index -lt $heldInputs.Count; $index += 1) {
      $inputHandle = $heldInputs[$index]
      $expectedInput = $inputProofs[$index]
      if ($inputHandle.Length -ne $expectedInput.bytes) { throw "Gehaltene Validator-Inputdatei driftete waehrend des Kindprozesses." }
      $inputHandle.Position = 0
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $afterInputSha256 = AnchorHex ($sha.ComputeHash($inputHandle)) } finally { $sha.Dispose() }
      if ($afterInputSha256 -cne $expectedInput.sha256) { throw "Gehaltene Validator-Inputdatei driftete waehrend des Kindprozesses." }
    }
    $envelope = [ordered]@{
      anchorBytes = $expectedBytes
      anchorSha256 = $heldSha256
      inputProofs = $inputProofs.ToArray()
      status = $child.ExitCode
      signal = $null
      stdoutBase64 = [Convert]::ToBase64String($child.Stdout)
      stderrBase64 = [Convert]::ToBase64String($child.Stderr)
    }
    [Console]::Out.Write(($envelope | ConvertTo-Json -Compress))
  } catch {
    [Console]::Error.Write($_.Exception.ToString())
    exit 91
  } finally {
    foreach ($inputHandle in $heldInputs) { $inputHandle.Dispose() }
    if ($null -ne $heldValidator) { $heldValidator.Dispose() }
  }
  exit 0
}
$prefix = "ZUGFOLGE_OPERATIONAL_RUNNER_"
function Required([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($prefix + $name)
  if ([String]::IsNullOrEmpty($value)) { throw "Fehlender Bundle-Launcher-Wert $name." }
  return $value
}
function Hex([byte[]]$value) {
  return ([BitConverter]::ToString($value)).Replace("-", "").ToLowerInvariant()
}
$heldBundle = $null
$heldNode = $null
$tempAnchor = $null
$privateTemp = $null
$child = $null
try {
  $bundlePath = Required "BUNDLE_PATH"
  $nodePath = Required "NODE_PATH"
  $workspaceRoot = Required "WORKSPACE_ROOT"
  $expectedBytes = [Int64]::Parse((Required "BUNDLE_BYTES"), [Globalization.CultureInfo]::InvariantCulture)
  $expectedSha256 = Required "BUNDLE_SHA256"
  $expectedNodeBytes = [Int64]::Parse((Required "NODE_BYTES"), [Globalization.CultureInfo]::InvariantCulture)
  $expectedNodeSha256 = Required "NODE_SHA256"
  $launcherMode = Required "LAUNCHER_MODE"
  $launcherSourceBytes = Required "LAUNCHER_SOURCE_BYTES"
  $launcherSourceSha256 = Required "LAUNCHER_SOURCE_SHA256"
  $annualLaunchProofBase64 = Required "ANNUAL_LAUNCH_PROOF_BASE64"
  $runnerPhase = Required "PHASE"
  if ($annualLaunchProofBase64.Length -le 0 -or $annualLaunchProofBase64.Length -gt 1048576 -or
      ($annualLaunchProofBase64.Length % 4) -ne 0 -or $annualLaunchProofBase64 -cnotmatch "^[A-Za-z0-9+/]*={0,2}$") {
    throw "Annual-Launch-Proof ist kein begrenztes kanonisches Base64."
  }
  $cliCount = [Int32]::Parse((Required "CLI_COUNT"), [Globalization.CultureInfo]::InvariantCulture)
  if (($runnerPhase -cne "derive-and-capture-v1" -or $cliCount -ne 7) -and
      ($runnerPhase -cne "execute-annual-operational-v2-v1" -or $cliCount -ne 8) -and
      ($runnerPhase -cne "materialize-annual-plan-evidence-v1" -or $cliCount -ne 6) -and
      ($runnerPhase -cne "materialize-validator-rebuild-v3" -or $cliCount -ne 3)) {
    throw "Operational-v2-Systemlauncher besitzt eine ungueltige interne Phase oder Argumentzahl."
  }
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
  $administratorsSid = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  $directorySecurity = New-Object Security.AccessControl.DirectorySecurity
  $directorySecurity.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $null = $directorySecurity.AddAccessRule($rule)
  }
  $privateTemp = [IO.Path]::Combine("C:\Windows\Temp", "zugfolge-operational-runner.retained-owned-cleanup-" + [Guid]::NewGuid().ToString("N"))
  if ([IO.Directory]::Exists($privateTemp)) { throw "Privates Launcher-Tempverzeichnis kollidiert." }
  $null = [IO.Directory]::CreateDirectory($privateTemp, $directorySecurity)
  if (([IO.File]::GetAttributes($privateTemp) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Privates Launcher-Tempverzeichnis ist ein Reparse Point." }
  $tempAnchorPath = [IO.Path]::Combine($privateTemp, "owner.anchor")
  $tempAnchorToken = [Guid]::NewGuid().ToString("N")
  $tempAnchorBytes = [Text.Encoding]::UTF8.GetBytes($tempAnchorToken)
  $tempAnchor = New-Object IO.FileStream($tempAnchorPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $tempAnchor.Write($tempAnchorBytes, 0, $tempAnchorBytes.Length)
  $tempAnchor.Flush($true)
  [Environment]::SetEnvironmentVariable("TEMP", $privateTemp, "Process")
  [Environment]::SetEnvironmentVariable("TMP", $privateTemp, "Process")
  Load-ZugfolgeMitigatedProcess "ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_"
  $heldBundle = [IO.File]::Open($bundlePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $heldNode = [IO.File]::Open($nodePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  if ($expectedBytes -le 0 -or $expectedBytes -gt 16777216 -or $heldBundle.Length -ne $expectedBytes) { throw "Gehaltenes Runner-Bundle besitzt eine falsche Bytezahl." }
  $bundle = New-Object byte[] ([Int32]$expectedBytes)
  $offset = 0
  while ($offset -lt $bundle.Length) {
    $count = $heldBundle.Read($bundle, $offset, $bundle.Length - $offset)
    if ($count -eq 0) { throw "Gehaltenes Runner-Bundle endete vorzeitig." }
    $offset += $count
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $actualSha256 = Hex ($sha.ComputeHash($bundle)) } finally { $sha.Dispose() }
  if ($actualSha256 -ne $expectedSha256) { throw "Gehaltenes Runner-Bundle besitzt einen falschen SHA-256." }
  if ($expectedNodeBytes -le 0 -or $heldNode.Length -ne $expectedNodeBytes) { throw "Gehaltene Node-Runtime besitzt eine falsche Bytezahl." }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $actualNodeSha256 = Hex ($sha.ComputeHash($heldNode)) } finally { $sha.Dispose() }
  if ($actualNodeSha256 -ne $expectedNodeSha256) { throw "Gehaltene Node-Runtime besitzt einen falschen SHA-256." }

  $versionEnvironment = @{
    SystemRoot = "C:\Windows"
    WINDIR = "C:\Windows"
    PATH = "C:\Windows\System32;C:\Windows"
    TEMP = $privateTemp
    TMP = $privateTemp
  }
  $versionChild = [ZugfolgeMitigatedProcess]::RunStrict(
    $nodePath,
    [string[]]@("--version"),
    $workspaceRoot,
    $versionEnvironment,
    [byte[]]@(),
    65536,
    15000,
    $null)
  $versionOutput = [Text.Encoding]::UTF8.GetString($versionChild.Stdout)
  $versionError = [Text.Encoding]::UTF8.GetString($versionChild.Stderr)
  if ($versionChild.ExitCode -ne 0 -or $versionOutput -notmatch '^v24\.[0-9]+\.[0-9]+(?:-|\s*$)') {
    throw "Gehaltene Node-Runtime ist nicht Node 24: $versionOutput $versionError"
  }

  $childEnvironment = @{
    SystemRoot = "C:\Windows"
    WINDIR = "C:\Windows"
    ComSpec = "C:\Windows\System32\cmd.exe"
    PATH = "C:\Windows\System32;C:\Windows"
    PATHEXT = ".COM;.EXE;.BAT;.CMD"
    TEMP = $privateTemp
    TMP = $privateTemp
    ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE = $launcherMode
    ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_BYTES = $launcherSourceBytes
    ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_SHA256 = $launcherSourceSha256
    ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_BYTES = [String]$expectedBytes
    ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SHA256 = $actualSha256
    ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SOURCE_PATH = $bundlePath
    ZUGFOLGE_OPERATIONAL_RUNNER_NODE_BYTES = [String]$expectedNodeBytes
    ZUGFOLGE_OPERATIONAL_RUNNER_NODE_SHA256 = $actualNodeSha256
    ZUGFOLGE_OPERATIONAL_RUNNER_NODE_PATH = $nodePath
    ZUGFOLGE_OPERATIONAL_RUNNER_NODE_REEXEC_PATH = $nodePath
    ZUGFOLGE_OPERATIONAL_RUNNER_RUNTIME_SOURCE_PATH = $nodePath
    ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_PATH = (Required "ANCHOR_HELPER_PATH")
    ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_BYTES = (Required "ANCHOR_HELPER_BYTES")
    ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_SHA256 = (Required "ANCHOR_HELPER_SHA256")
    ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT = $workspaceRoot
    ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT = [String]$cliCount
    ZUGFOLGE_OPERATIONAL_RUNNER_ANNUAL_LAUNCH_PROOF_BASE64 = $annualLaunchProofBase64
    ZUGFOLGE_OPERATIONAL_RUNNER_PHASE = $runnerPhase
  }
  if ($runnerPhase -ceq "materialize-validator-rebuild-v3") {
    foreach ($name in @(
      "GITHUB_ACTIONS",
      "GITHUB_EVENT_NAME",
      "GITHUB_REF",
      "GITHUB_REF_PROTECTED",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
      "GITHUB_SHA",
      "GITHUB_WORKFLOW_REF",
      "RUNNER_ARCH",
      "RUNNER_ENVIRONMENT",
      "RUNNER_OS",
      "ZUGFOLGE_REBUILD_RUNNER_IMAGE"
    )) {
      $childEnvironment[$name] = Required ("AUTHORITY_" + $name)
    }
  }
  for ($index = 0; $index -lt $cliCount; $index += 1) {
    $childEnvironment["ZUGFOLGE_OPERATIONAL_RUNNER_CLI_$index"] = Required "CLI_$index"
  }
  $child = [ZugfolgeMitigatedProcess]::RunStrict(
    $nodePath,
    [string[]]@("--input-type=module", "-"),
    $workspaceRoot,
    $childEnvironment,
    $bundle,
    1048576,
    43200000,
    $null)
  $childExitCode = $child.ExitCode
  if (([IO.File]::GetAttributes($privateTemp) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Privates Launcher-Tempverzeichnis driftete zu einem Reparse Point." }
  $tempAnchor.Position = 0
  $verifiedTempAnchor = New-Object byte[] $tempAnchorBytes.Length
  if ($tempAnchor.Read($verifiedTempAnchor, 0, $verifiedTempAnchor.Length) -ne $verifiedTempAnchor.Length -or (Hex $verifiedTempAnchor) -ne (Hex $tempAnchorBytes)) {
    throw "Privater Launcher-Tempanker driftete."
  }
  $retainedTempEntries = [IO.Directory]::GetFileSystemEntries($privateTemp)
  if ($retainedTempEntries.Count -ne 1 -or $retainedTempEntries[0] -ne $tempAnchorPath) {
    throw "Privates Launcher-Tempverzeichnis enthaelt fremde Dateien und bleibt erhalten."
  }
  $envelope = [ordered]@{
    anchorBytes = $expectedBytes
    anchorSha256 = $actualSha256
    status = $childExitCode
    signal = $null
    stdoutBase64 = [Convert]::ToBase64String($child.Stdout)
    stderrBase64 = [Convert]::ToBase64String($child.Stderr)
  }
  [Console]::Out.Write(($envelope | ConvertTo-Json -Compress))
  if ($childExitCode -ne 0) { exit 94 }
} catch {
  [Console]::Error.Write($_.Exception.ToString())
  exit 92
} finally {
  if ($null -ne $tempAnchor) { $tempAnchor.Dispose() }
  if ($null -ne $heldNode) { $heldNode.Dispose() }
  if ($null -ne $heldBundle) { $heldBundle.Dispose() }
}
`;

const LINUX_HELD_BUNDLE_LAUNCHER_SOURCE = String.raw`
import base64
import fcntl
import hashlib
import json
import os
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import traceback

temp_anchor_fd = None
private_temp = None
child = None
RUNNER_TIMEOUT_SECONDS = 21600
try:
    node_path, node_bytes_text, node_sha256, bundle_path, expected_bytes_text, expected_sha256, launcher_mode, launcher_source_bytes, launcher_source_sha256, workspace_root, *arguments = sys.argv[1:]
    expected_bytes = int(expected_bytes_text)
    expected_node_bytes = int(node_bytes_text)
    private_temp = tempfile.mkdtemp(prefix="zugfolge-operational-runner.retained-owned-cleanup-", dir="/tmp")
    os.chmod(private_temp, 0o700)
    private_temp_before = os.lstat(private_temp)
    if not stat.S_ISDIR(private_temp_before.st_mode) or stat.S_ISLNK(private_temp_before.st_mode):
        raise RuntimeError("Privates Launcher-Tempverzeichnis ist kein eigener regulaerer Verzeichnisroot.")
    temp_anchor_path = os.path.join(private_temp, "owner.anchor")
    temp_anchor_token = os.urandom(32)
    temp_anchor_fd = os.open(temp_anchor_path, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    os.write(temp_anchor_fd, temp_anchor_token)
    os.fsync(temp_anchor_fd)
    temp_anchor_identity = os.fstat(temp_anchor_fd)
    descriptor = os.open(bundle_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    node_descriptor = os.open(node_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size != expected_bytes or expected_bytes <= 0 or expected_bytes > 16777216:
            raise RuntimeError("Gehaltenes Runner-Bundle besitzt eine falsche Bytezahl.")
        chunks = []
        remaining = expected_bytes
        while remaining:
            chunk = os.read(descriptor, min(1048576, remaining))
            if not chunk:
                raise RuntimeError("Gehaltenes Runner-Bundle endete vorzeitig.")
            chunks.append(chunk)
            remaining -= len(chunk)
        bundle = b"".join(chunks)
        actual_sha256 = hashlib.sha256(bundle).hexdigest()
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size) or actual_sha256 != expected_sha256:
            raise RuntimeError("Gehaltenes Runner-Bundle driftete oder besitzt einen falschen SHA-256.")
        node_before = os.fstat(node_descriptor)
        if not stat.S_ISREG(node_before.st_mode) or node_before.st_size != expected_node_bytes or expected_node_bytes <= 0:
            raise RuntimeError("Gehaltene Node-Runtime besitzt eine falsche Bytezahl.")
        node_hash = hashlib.sha256()
        node_chunks = []
        while True:
            chunk = os.read(node_descriptor, 1048576)
            if not chunk:
                break
            node_chunks.append(chunk)
            node_hash.update(chunk)
        node_after = os.fstat(node_descriptor)
        if (node_before.st_dev, node_before.st_ino, node_before.st_size) != (node_after.st_dev, node_after.st_ino, node_after.st_size) or node_hash.hexdigest() != node_sha256:
            raise RuntimeError("Gehaltene Node-Runtime driftete oder besitzt einen falschen SHA-256.")
        node_bytes = b"".join(node_chunks)
        runtime_fd = os.memfd_create("zugfolge-operational-node", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        position = 0
        while position < len(node_bytes):
            position += os.write(runtime_fd, node_bytes[position:])
        os.fchmod(runtime_fd, 0o500)
        runtime_seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(runtime_fd, fcntl.F_ADD_SEALS, runtime_seals)
        if fcntl.fcntl(runtime_fd, fcntl.F_GET_SEALS) != runtime_seals:
            raise RuntimeError("Node-Runtime-memfd wurde nicht vollstaendig versiegelt.")
        executable_node = "/proc/self/fd/" + str(runtime_fd)
        reexec_node = "/proc/" + str(os.getpid()) + "/fd/" + str(runtime_fd)
        probe = subprocess.run(
            [executable_node, "--version"],
            executable=executable_node,
            cwd=workspace_root,
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "TMPDIR": private_temp},
            pass_fds=(runtime_fd,),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )
        version = probe.stdout.decode("ascii", "strict").strip()
        version_parts = version.removeprefix("v").split(".")
        if probe.returncode != 0 or len(version_parts) != 3 or version_parts[0] != "24" or not all(part.split("-", 1)[0].isdigit() for part in version_parts):
            raise RuntimeError("Gehaltene Node-Runtime ist nicht Node 24.")
        environment = {
            "PATH": "/usr/bin:/bin",
            "LANG": "C",
            "LC_ALL": "C",
            "TMPDIR": private_temp,
            "ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE": launcher_mode,
            "ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_BYTES": launcher_source_bytes,
            "ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_SHA256": launcher_source_sha256,
            "ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_BYTES": str(expected_bytes),
            "ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SHA256": actual_sha256,
            "ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SOURCE_PATH": bundle_path,
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_BYTES": str(expected_node_bytes),
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_SHA256": node_sha256,
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_PATH": executable_node,
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_REEXEC_PATH": reexec_node,
            "ZUGFOLGE_OPERATIONAL_RUNNER_RUNTIME_SOURCE_PATH": node_path,
            "ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT": workspace_root,
            "ZUGFOLGE_OPERATIONAL_RUNNER_PHASE": "derive-and-capture-v1",
            "ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT": str(len(arguments)),
        }
        for index, argument in enumerate(arguments):
            environment["ZUGFOLGE_OPERATIONAL_RUNNER_CLI_" + str(index)] = argument
        child = subprocess.Popen(
            [executable_node, "--input-type=module", "-"],
            executable=executable_node,
            cwd=workspace_root,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(runtime_fd,),
            start_new_session=True,
        )
        streams = {child.stdout: bytearray(), child.stderr: bytearray()}
        selector = selectors.DefaultSelector()
        selector.register(child.stdin, selectors.EVENT_WRITE)
        selector.register(child.stdout, selectors.EVENT_READ)
        selector.register(child.stderr, selectors.EVENT_READ)
        written = 0
        deadline = time.monotonic() + RUNNER_TIMEOUT_SECONDS
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                raise RuntimeError("Bundle-Node-Prozess ueberschritt das gepinnte Zeitlimit.")
            for key, mask in selector.select(min(1.0, remaining)):
                stream = key.fileobj
                if stream is child.stdin:
                    try:
                        count = os.write(stream.fileno(), bundle[written:written + 65536])
                        written += count
                    except BrokenPipeError:
                        written = len(bundle)
                    if written == len(bundle):
                        selector.unregister(stream)
                        stream.close()
                    continue
                chunk = os.read(stream.fileno(), 8192)
                if not chunk:
                    selector.unregister(stream)
                    continue
                target = streams[stream]
                if len(target) + len(chunk) > 1048576:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    raise RuntimeError("Bundle-Node-Prozess ueberschritt das stdout/stderr-Limit.")
                target.extend(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise RuntimeError("Bundle-Node-Prozess ueberschritt das gepinnte Zeitlimit.")
        try:
            returncode = child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise RuntimeError("Bundle-Node-Prozess ueberschritt das gepinnte Zeitlimit.")
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        private_temp_after = os.lstat(private_temp)
        anchor_path_after = os.stat(temp_anchor_path, follow_symlinks=False)
        anchor_handle_after = os.fstat(temp_anchor_fd)
        if ((private_temp_before.st_dev, private_temp_before.st_ino) != (private_temp_after.st_dev, private_temp_after.st_ino)
                or not stat.S_ISDIR(private_temp_after.st_mode) or stat.S_ISLNK(private_temp_after.st_mode)
                or (temp_anchor_identity.st_dev, temp_anchor_identity.st_ino, temp_anchor_identity.st_size) != (anchor_path_after.st_dev, anchor_path_after.st_ino, anchor_path_after.st_size)
                or (temp_anchor_identity.st_dev, temp_anchor_identity.st_ino, temp_anchor_identity.st_size) != (anchor_handle_after.st_dev, anchor_handle_after.st_ino, anchor_handle_after.st_size)):
            raise RuntimeError("Privater Launcher-Temp-Root oder Ownership-Anker driftete und bleibt erhalten.")
        os.lseek(temp_anchor_fd, 0, os.SEEK_SET)
        if os.read(temp_anchor_fd, len(temp_anchor_token) + 1) != temp_anchor_token:
            raise RuntimeError("Privater Launcher-Tempanker driftete und bleibt erhalten.")
        if os.listdir(private_temp) != ["owner.anchor"]:
            raise RuntimeError("Privates Launcher-Tempverzeichnis enthaelt fremde Dateien und bleibt erhalten.")
        envelope = {
            "anchorBytes": expected_bytes,
            "anchorSha256": actual_sha256,
            "status": returncode if returncode >= 0 else None,
            "signal": -returncode if returncode < 0 else None,
            "stdoutBase64": base64.b64encode(bytes(streams[child.stdout])).decode("ascii"),
            "stderrBase64": base64.b64encode(bytes(streams[child.stderr])).decode("ascii"),
        }
        sys.stdout.write(json.dumps(envelope, separators=(",", ":"), sort_keys=True))
        os.close(runtime_fd)
        if returncode != 0:
            sys.exit(94 if returncode >= 0 else 128 - returncode)
    finally:
        os.close(node_descriptor)
        os.close(descriptor)
except Exception:
    if child is not None and child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        except Exception:
            pass
    traceback.print_exc(file=sys.stderr)
    sys.exit(93)
finally:
    if temp_anchor_fd is not None:
        os.close(temp_anchor_fd)
`;

const LINUX_SEALED_MEMFD_LAUNCHER_SOURCE = String.raw`
import base64
import fcntl
import hashlib
import json
import os
import selectors
import signal
import subprocess
import sys
import time
import traceback

VALIDATOR_TIMEOUT_SECONDS = 21600
child = None
outer_session_bound = False
try:
    header = sys.stdin.buffer.readline()
    request = json.loads(header.decode("utf-8"))
    binary = sys.stdin.buffer.read()
    expected_bytes = request["bytes"]
    expected_sha256 = request["sha256"]
    maximum_bytes = request["maximumBytes"]
    arguments = request["arguments"]
    outer_session_bound = request["outerSessionBound"]
    if len(binary) != expected_bytes or hashlib.sha256(binary).hexdigest() != expected_sha256:
        raise RuntimeError("Memfd-Launcher erhielt andere Validatorbytes als gepinnt.")
    if not isinstance(arguments, list) or not all(isinstance(value, str) for value in arguments) or not isinstance(outer_session_bound, bool):
        raise RuntimeError("Memfd-Launcher erhielt ungueltige Argumente.")
    fd = os.memfd_create("zugfolge-operational-validator", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        position = 0
        while position < len(binary):
            position += os.write(fd, binary[position:])
        os.fchmod(fd, 0o500)
        seal_mask = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seal_mask)
        if fcntl.fcntl(fd, fcntl.F_GET_SEALS) != seal_mask:
            raise RuntimeError("Memfd-Launcher konnte die Validatorbytes nicht vollstaendig versiegeln.")
        executable = "/proc/self/fd/" + str(fd)
        child = subprocess.Popen(
            [executable, *arguments],
            executable=executable,
            cwd=request["cwd"],
            env={key: value for key, value in os.environ.items() if not key.startswith("ZUGFOLGE_OPERATIONAL_MEMFD_")},
            pass_fds=(fd,),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # In the eligible outer runner, remain in its one owned session.
            # Standalone diagnostics own a separate child session instead.
            start_new_session=not outer_session_bound,
        )
        streams = {child.stdout: bytearray(), child.stderr: bytearray()}
        selector = selectors.DefaultSelector()
        for stream in streams:
            selector.register(stream, selectors.EVENT_READ)
        deadline = time.monotonic() + VALIDATOR_TIMEOUT_SECONDS
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                os.killpg(os.getpgrp() if outer_session_bound else child.pid, signal.SIGKILL)
                if not outer_session_bound:
                    child.wait()
                raise RuntimeError("Memfd-Validator ueberschritt das gepinnte Zeitlimit.")
            for key, _ in selector.select(min(1.0, remaining)):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                target = streams[key.fileobj]
                if len(target) + len(chunk) > maximum_bytes:
                    os.killpg(os.getpgrp() if outer_session_bound else child.pid, signal.SIGKILL)
                    if not outer_session_bound:
                        child.wait()
                    raise RuntimeError("Memfd-Validator ueberschritt das gepinnte stdout/stderr-Limit.")
                target.extend(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            os.killpg(os.getpgrp() if outer_session_bound else child.pid, signal.SIGKILL)
            if not outer_session_bound:
                child.wait()
            raise RuntimeError("Memfd-Validator ueberschritt das gepinnte Zeitlimit.")
        try:
            returncode = child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgrp() if outer_session_bound else child.pid, signal.SIGKILL)
            if not outer_session_bound:
                child.wait()
            raise RuntimeError("Memfd-Validator ueberschritt das gepinnte Zeitlimit.")
        envelope = {
            "anchorBytes": expected_bytes,
            "anchorSha256": expected_sha256,
            "sealMask": seal_mask,
            "status": returncode if returncode >= 0 else None,
            "signal": -returncode if returncode < 0 else None,
            "stdoutBase64": base64.b64encode(bytes(streams[child.stdout])).decode("ascii"),
            "stderrBase64": base64.b64encode(bytes(streams[child.stderr])).decode("ascii"),
        }
        sys.stdout.write(json.dumps(envelope, separators=(",", ":"), sort_keys=True))
    finally:
        os.close(fd)
except Exception:
    if child is not None:
        try:
            os.killpg(os.getpgrp() if outer_session_bound else child.pid, signal.SIGKILL)
            if not outer_session_bound:
                child.wait()
        except Exception:
            pass
    traceback.print_exc(file=sys.stderr)
    sys.exit(92)
`;

export function germanyOperationalSystemLauncherSourceProof(platform) {
  const source = germanyOperationalSystemLauncherSource(platform);
  const bytes = Buffer.from(source, "utf8");
  return {
    mode: platform === "win32" ? GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE : GERMANY_OPERATIONAL_LINUX_LAUNCHER_MODE,
    sourceBytes: bytes.length,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function germanyOperationalSystemLauncherSource(platform) {
  const source = platform === "win32"
    ? WINDOWS_HELD_BUNDLE_LAUNCH_POWERSHELL_SOURCE
    : platform === "linux" ? LINUX_HELD_BUNDLE_LAUNCHER_SOURCE : null;
  invariant(source !== null, `Operational-v2 besitzt fuer ${platform} keinen Systemlauncher.`);
  return source;
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  invariant(isRecord(value), `${label} muss ein Objekt sein.`);
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} besitzt fremde oder fehlende Felder.`,
  );
  return value;
}

export function validateGermanyOperationalRebuildAuthorityEnvironment(value) {
  exactKeys(value, GERMANY_OPERATIONAL_REBUILD_AUTHORITY_ENVIRONMENT_KEYS,
    "Operational-v2-Rebuild-Authority-Umgebung");
  return Object.freeze(Object.fromEntries(
    GERMANY_OPERATIONAL_REBUILD_AUTHORITY_ENVIRONMENT_KEYS.map((name) => {
      const entry = value[name];
      invariant(typeof entry === "string" && entry.length > 0 && entry.length <= 2048
        && !ASCII_CONTROL_CHARACTER.test(entry),
        `Operational-v2-Rebuild-Authority ${name} ist kein begrenzter Umgebungswert.`);
      return [name, entry];
    }),
  ));
}

function positiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} muss eine positive sichere Ganzzahl sein.`);
  return value;
}

function sha256(value, label) {
  invariant(typeof value === "string" && SHA256.test(value), `${label} ist kein SHA-256.`);
  return value;
}

function gitCommit(value, label) {
  invariant(typeof value === "string" && GIT_COMMIT.test(value), `${label} ist kein Git-Commit.`);
  return value;
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 512, `${label} fehlt oder ist zu lang.`);
  invariant(!isAbsolute(value) && !value.includes("\\") && !value.includes("\0"), `${label} muss ein portabler relativer Pfad sein.`);
  const segments = value.split("/");
  invariant(segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."), `${label} enthaelt unsichere Segmente.`);
  return value;
}

function stringList(value, label, { portable = false } = {}) {
  invariant(Array.isArray(value), `${label} muss eine Liste sein.`);
  return value.map((entry, index) => {
    invariant(typeof entry === "string" && entry.length > 0 && entry.length <= 1024 && !entry.includes("\0"), `${label}[${index}] ist ungueltig.`);
    return portable ? portablePath(entry, `${label}[${index}]`) : entry;
  });
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value))}\n`, "utf8");
}

export function germanyOperationalStructuredValueSha256(value) {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

function fileProof(value, label, { schema = false } = {}) {
  exactKeys(value, schema ? ["file", "bytes", "sha256", "schema"] : ["file", "bytes", "sha256"], label);
  portablePath(value.file, `${label}.file`);
  positiveInteger(value.bytes, `${label}.bytes`);
  sha256(value.sha256, `${label}.sha256`);
  if (schema) invariant(typeof value.schema === "string" && value.schema.length > 0, `${label}.schema fehlt.`);
  return value;
}

function byteProof(value, label) {
  exactKeys(value, ["bytes", "sha256"], label);
  positiveInteger(value.bytes, `${label}.bytes`);
  sha256(value.sha256, `${label}.sha256`);
  return value;
}

function runtimeProof(value, label) {
  exactKeys(value, ["id", "platform", "bytes", "sha256"], label);
  invariant(value.id === "nodejs-24-operational-runner-v1", `${label}.id ist unbekannt.`);
  invariant(value.platform === "win32" || value.platform === "linux", `${label}.platform ist nicht unterstuetzt.`);
  positiveInteger(value.bytes, `${label}.bytes`);
  sha256(value.sha256, `${label}.sha256`);
  return value;
}

function launcherProof(value, label, platform) {
  exactKeys(value, ["mode", "sourceBytes", "sourceSha256"], label);
  invariant(value.mode === GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE
    || value.mode === GERMANY_OPERATIONAL_LINUX_LAUNCHER_MODE, `${label}.mode ist unbekannt.`);
  positiveInteger(value.sourceBytes, `${label}.sourceBytes`);
  sha256(value.sourceSha256, `${label}.sourceSha256`);
  if (platform !== undefined) {
    invariant(sameCanonical(value, germanyOperationalSystemLauncherSourceProof(platform)),
      `${label} bindet nicht exakt den kanonischen ${platform}-Systemlauncher.`);
  }
  return value;
}

function sameCanonical(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function canonicalJsonBase64(value, label, maximumBytes = 1024 * 1024) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= Math.ceil(maximumBytes * 4 / 3) + 4
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value), `${label} ist kein begrenztes Base64.`);
  const bytes = Buffer.from(value, "base64");
  invariant(bytes.length > 0 && bytes.length <= maximumBytes && bytes.toString("base64") === value,
    `${label} ist nicht kanonisch Base64-kodiert.`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges UTF-8.`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON.`, { cause: error });
  }
  invariant(JSON.stringify(canonicalValue(parsed)) === text, `${label} ist kein kanonisches JSON.`);
  return parsed;
}

function validateAnnualLaunchProof(value, label = "Operational-v2-Annual-Launch-Proof") {
  exactKeys(value, ["contract", "executionPins", "mode", "trustedExecutor"], label);
  invariant(value.mode === GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE, `${label}.mode ist unbekannt.`);
  exactKeys(value.contract, ["bytes", "file", "releaseId", "schema", "sha256"], `${label}.contract`);
  portablePath(value.contract.file, `${label}.contract.file`);
  positiveInteger(value.contract.bytes, `${label}.contract.bytes`);
  sha256(value.contract.sha256, `${label}.contract.sha256`);
  invariant(value.contract.schema === GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA,
    `${label}.contract.schema ist unbekannt.`);
  invariant(typeof value.contract.releaseId === "string" && value.contract.releaseId.length > 0,
    `${label}.contract.releaseId fehlt.`);
  exactKeys(value.executionPins, ["bytes", "file", "schema", "sha256"], `${label}.executionPins`);
  fileProof(value.executionPins, `${label}.executionPins`, { schema: true });
  invariant(value.executionPins.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
    `${label}.executionPins.schema ist unbekannt.`);
  exactKeys(value.trustedExecutor, ["buildCommit", "bytes", "file", "sha256"], `${label}.trustedExecutor`);
  portablePath(value.trustedExecutor.file, `${label}.trustedExecutor.file`);
  positiveInteger(value.trustedExecutor.bytes, `${label}.trustedExecutor.bytes`);
  sha256(value.trustedExecutor.sha256, `${label}.trustedExecutor.sha256`);
  gitCommit(value.trustedExecutor.buildCommit, `${label}.trustedExecutor.buildCommit`);
  return value;
}

function validateSortedUniqueFileProofs(value, label) {
  invariant(Array.isArray(value) && value.length > 0, `${label} muss eine nichtleere Liste sein.`);
  const proofs = value.map((entry, index) => fileProof(entry, `${label}[${index}]`));
  const paths = proofs.map(({ file }) => file);
  invariant(new Set(paths).size === paths.length, `${label} enthaelt doppelte Pfade.`);
  invariant(paths.every((entry, index) => index === 0 || paths[index - 1].localeCompare(entry, "en") < 0), `${label} muss stabil sortiert sein.`);
  return proofs;
}

function validateRunnerInvocation(value, label) {
  exactKeys(value, ["mode", "nodeArguments", "nodeOptions"], label);
  invariant(value.mode === GERMANY_OPERATIONAL_RUNNER_INVOCATION_MODE, `${label}.mode ist unbekannt.`);
  const nodeArguments = stringList(value.nodeArguments, `${label}.nodeArguments`);
  invariant(sameCanonical(nodeArguments, ["--input-type=module", "-"]), `${label}.nodeArguments startet nicht exakt ein ESM-stdin-Bundle.`);
  invariant(value.nodeOptions === null, `${label}.nodeOptions muss fuer v1 null sein.`);
  return value;
}

function synchronousRuntimeByteProof(path, label) {
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    invariant(before.isFile() && before.size > 0n && before.size <= BigInt(256 * 1024 * 1024),
      `${label} ist keine begrenzte regulaere Datei.`);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, bytes);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    invariant(sameNodeIdentity(before, after) && BigInt(bytes) === after.size,
      `${label} driftete waehrend der Selbstpruefung.`);
    return { bytes, sha256: digest.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

function currentRuntimeByteProof() {
  return synchronousRuntimeByteProof(process.platform === "linux" ? "/proc/self/exe" : process.execPath,
    "Operational-v2-Runner-Node-Runtime");
}

function operationalNodeReexecPath() {
  if (process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE === undefined) return process.execPath;
  const path = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_REEXEC_PATH;
  invariant(typeof path === "string" && path.length > 0, "Operational-v2-Systemlauncher besitzt keinen gehaltenen Node-Reexec-Anker.");
  return path;
}

function currentRunnerInvocation(pins) {
  invariant(/^24\.[0-9]+\.[0-9]+(?:-|$)/u.test(process.versions.node),
    "Operational-v2-Runner-Runtime ist nicht die vertraglich festgelegte Node-24-Hauptversion.");
  const nodeOptions = process.env.NODE_OPTIONS;
  invariant(nodeOptions === undefined || nodeOptions.trim() === "", "Operational-v2-Runner darf NODE_OPTIONS nicht verwenden.");
  invariant(sameCanonical(process.execArgv, ["--input-type=module"]), "Operational-v2-Runner muss als bereinigtes Node-ESM-stdin-Bundle ohne Loader oder Preloads starten.");
  invariant(process.argv[1] === "-", "Operational-v2-Runner muss seine exakt gehaltenen Bundle-Bytes ueber stdin ausfuehren.");
  invariant(process.argv.length === 2, "Operational-v2-Runner darf keine ungepinnten Node-Argumente besitzen.");
  invariant(process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE === pins.runner.launcher.mode
    && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_BYTES === String(pins.runner.launcher.sourceBytes)
    && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_SHA256 === pins.runner.launcher.sourceSha256,
  "Operational-v2-Runner besitzt nicht den gepinnten systemgeschuetzten OS-Startanker.");
  const phase = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_PHASE;
  invariant(typeof phase === "string" && Object.hasOwn(GERMANY_OPERATIONAL_RUNNER_PHASES, phase)
    && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT === String(GERMANY_OPERATIONAL_RUNNER_PHASES[phase]),
  "Operational-v2-Runner besitzt keine bekannte intern gebundene Phase und Argumentzahl.");
  invariant(process.env.ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_BYTES === String(pins.runner.bundle.bytes)
    && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SHA256 === pins.runner.bundle.sha256,
  "Operational-v2-Runner-Startanker bindet andere Bundle-Bytes als die Execution-Pins.");
  invariant(process.platform === pins.runner.runtime.platform
    && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_BYTES === String(pins.runner.runtime.bytes)
    && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_SHA256 === pins.runner.runtime.sha256,
  "Operational-v2-Runner-Startanker bindet andere Node-Runtime-Bytes als die Execution-Pins.");
  if (process.platform === "win32") {
    invariant(process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_BYTES === String(pins.runner.anchorHelper.bytes)
      && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_SHA256 === pins.runner.anchorHelper.sha256
      && typeof process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_PATH === "string",
    "Operational-v2-Runner-Startanker bindet nicht die gepinnte Helper-Assembly.");
  }
  const actualRuntime = currentRuntimeByteProof();
  invariant(actualRuntime.bytes === pins.runner.runtime.bytes && actualRuntime.sha256 === pins.runner.runtime.sha256,
    "Operational-v2-Runner laeuft nicht aus den gehaltenen gepinnten Node-Runtime-Bytes.");
  const heldNodePath = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_PATH;
  invariant(typeof heldNodePath === "string" && heldNodePath.length > 0
    && (process.platform !== "win32"
      || heldNodePath.toLocaleLowerCase("en-US") === process.execPath.toLocaleLowerCase("en-US")),
  "Operational-v2-Runner-Prozess stammt nicht vom gehaltenen Node-Runtime-Pfad des Systemlaunchers.");
  const reexecNodePath = operationalNodeReexecPath();
  invariant(process.platform === "win32"
    ? reexecNodePath.toLocaleLowerCase("en-US") === process.execPath.toLocaleLowerCase("en-US")
    : /^\/proc\/[1-9][0-9]*\/fd\/[0-9]+$/u.test(reexecNodePath),
  "Operational-v2-Runner besitzt keinen plattformgebundenen gehaltenen Node-Reexec-Anker.");
  const reexecRuntime = synchronousRuntimeByteProof(reexecNodePath, "Operational-v2-Runner-Node-Reexec-Anker");
  invariant(reexecRuntime.bytes === pins.runner.runtime.bytes && reexecRuntime.sha256 === pins.runner.runtime.sha256,
    "Operational-v2-Runner-Node-Reexec-Anker bindet nicht die gepinnten Runtime-Bytes.");
  return validateRunnerInvocation({
    mode: GERMANY_OPERATIONAL_RUNNER_INVOCATION_MODE,
    nodeArguments: ["--input-type=module", "-"],
    nodeOptions: null,
  }, "Operational-v2-Runner-Aufruf");
}

export function validateGermanyOperationalExecutionPins(value, expectedReleaseId) {
  exactKeys(value, ["schema", "releaseId", "runner", "validator", "command"], "Operational-v2-Execution-Pins");
  invariant(value.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA, "Operational-v2-Execution-Pins besitzt ein unbekanntes Schema.");
  invariant(typeof value.releaseId === "string" && value.releaseId.length > 0, "Operational-v2-Execution-Pins besitzt keine Release-ID.");
  if (expectedReleaseId !== undefined) invariant(value.releaseId === expectedReleaseId, "Operational-v2-Execution-Pins bindet eine falsche Release-ID.");

  exactKeys(value.runner, ["anchorHelper", "bundle", "entrypoint", "roots", "importClosure", "invocation", "launcher", "runtime"], "Operational-v2-Execution-Pins.runner");
  const bundle = fileProof(value.runner.bundle, "Operational-v2-Execution-Pins.runner.bundle");
  invariant(bundle.file === GERMANY_OPERATIONAL_EXECUTION_RUNNER_BUNDLE, "Operational-v2-Execution-Pins bindet nicht das kanonische gehaltene Runner-Bundle.");
  const entrypoint = fileProof(value.runner.entrypoint, "Operational-v2-Execution-Pins.runner.entrypoint");
  const roots = validateSortedUniqueFileProofs(value.runner.roots, "Operational-v2-Execution-Pins.runner.roots");
  const importClosure = validateSortedUniqueFileProofs(value.runner.importClosure, "Operational-v2-Execution-Pins.runner.importClosure");
  validateRunnerInvocation(value.runner.invocation, "Operational-v2-Execution-Pins.runner.invocation");
  runtimeProof(value.runner.runtime, "Operational-v2-Execution-Pins.runner.runtime");
  launcherProof(value.runner.launcher, "Operational-v2-Execution-Pins.runner.launcher", value.runner.runtime.platform);
  if (value.runner.runtime.platform === "win32") {
    fileProof(value.runner.anchorHelper, "Operational-v2-Execution-Pins.runner.anchorHelper");
    invariant(value.runner.anchorHelper.file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
      "Operational-v2-Execution-Pins bindet nicht die kanonische Windows-Anchor-Helper-Assembly.");
  } else {
    invariant(value.runner.anchorHelper === null, "Linux-Execution-Pins duerfen keine Windows-Anchor-Helper-Assembly binden.");
  }
  invariant(entrypoint.file === GERMANY_OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT,
    "Operational-v2-Execution-Pins bindet nicht den festgelegten integrierten Runner-Entrypoint.");
  invariant(sameCanonical(roots.map(({ file }) => file), GERMANY_OPERATIONAL_EXECUTION_RUNNER_ROOT_FILES),
    "Operational-v2-Execution-Pins bindet nicht exakt Runner, Capture und Publisher als Closure-Wurzeln.");
  const launcherSourceFile = value.runner.runtime.platform === "win32"
    ? GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE
    : GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE;
  const launcherSource = importClosure.find(({ file }) => file === launcherSourceFile);
  invariant(launcherSource !== undefined
    && launcherSource.bytes === value.runner.launcher.sourceBytes
    && launcherSource.sha256 === value.runner.launcher.sourceSha256,
  "Operational-v2-Execution-Pins binden Launcher-Beleg und gehaltene Launcher-Datenfile nicht bytegleich.");
  if (value.runner.runtime.platform === "win32") {
    const anchorHelper = importClosure.find(({ file }) => file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE);
    invariant(anchorHelper !== undefined && sameCanonical(anchorHelper, value.runner.anchorHelper),
      "Operational-v2-Execution-Pins binden die Helper-Assembly nicht exakt einmal bytegleich in der Importclosure.");
  }
  const rootEntrypoint = roots.find(({ file }) => file === entrypoint.file);
  const closureEntrypoint = importClosure.find(({ file }) => file === entrypoint.file);
  invariant(rootEntrypoint !== undefined && sameCanonical(rootEntrypoint, entrypoint), "Operational-v2-Execution-Pins-Entrypoint fehlt bytegleich in den Closure-Wurzeln.");
  invariant(closureEntrypoint !== undefined && sameCanonical(closureEntrypoint, entrypoint), "Operational-v2-Execution-Pins-Entrypoint fehlt bytegleich in der Importclosure.");
  invariant(roots.every((root) => importClosure.some((entry) => sameCanonical(entry, root))), "Operational-v2-Execution-Pins-Closure enthaelt nicht alle Wurzeln bytegleich.");

  exactKeys(value.validator, ["file", "buildCommit", "bytes", "sha256", "rebuildSpecification", "rebuildEvidence"], "Operational-v2-Execution-Pins.validator");
  portablePath(value.validator.file, "Operational-v2-Execution-Pins.validator.file");
  gitCommit(value.validator.buildCommit, "Operational-v2-Execution-Pins.validator.buildCommit");
  positiveInteger(value.validator.bytes, "Operational-v2-Execution-Pins.validator.bytes");
  sha256(value.validator.sha256, "Operational-v2-Execution-Pins.validator.sha256");
  portablePath(value.validator.rebuildSpecification, "Operational-v2-Execution-Pins.validator.rebuildSpecification");
  portablePath(value.validator.rebuildEvidence, "Operational-v2-Execution-Pins.validator.rebuildEvidence");

  exactKeys(value.command, ["name", "argumentPrefix", "argumentFiles", "arguments", "stdoutMaxBytes"], "Operational-v2-Execution-Pins.command");
  invariant(typeof value.command.name === "string" && SAFE_COMMAND.test(value.command.name) && value.command.name === "derive-germany-operational-v2", "Operational-v2-Execution-Pins bindet einen falschen Native-Befehl.");
  const argumentPrefix = stringList(value.command.argumentPrefix, "Operational-v2-Execution-Pins.command.argumentPrefix");
  invariant(Array.isArray(value.command.argumentFiles), "Operational-v2-Execution-Pins.command.argumentFiles muss eine Liste sein.");
  invariant(argumentPrefix.length === 0 && value.command.argumentFiles.length === 0,
    "Operational-v2-Execution-Pins-v1 erlaubt keinen Argumentpraefix und keine Argumentdateien.");
  invariant(sameCanonical(value.command.arguments, COMMAND_ARGUMENTS), "Operational-v2-Execution-Pins bindet eine falsche Argumentvorlage.");
  positiveInteger(value.command.stdoutMaxBytes, "Operational-v2-Execution-Pins.command.stdoutMaxBytes");
  invariant(value.command.stdoutMaxBytes <= 1024 * 1024, "Operational-v2-Execution-Pins erlaubt zu viel stdout.");
  return value;
}

export function serializeGermanyOperationalExecutionPins(value, expectedReleaseId) {
  validateGermanyOperationalExecutionPins(value, expectedReleaseId);
  return canonicalBytes(value);
}

function validateExecutionProof(value, label, nativeReceipt) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  const allowedKeys = new Set([
    "annualLaunch", "schema", "executionPinsSha256", "runner", "validator", "rebuild", "invocation", "stdout", "exit",
  ]);
  invariant(Object.keys(value).every((key) => allowedKeys.has(key)), `${label} besitzt fremde Felder.`);
  for (const required of ["schema", "executionPinsSha256", "runner", "validator", "rebuild", "invocation", "stdout", "exit"]) {
    invariant(Object.hasOwn(value, required), `${label}.${required} fehlt.`);
  }
  invariant(value.schema === GERMANY_OPERATIONAL_EXECUTION_PROOF_SCHEMA, `${label}.schema ist unbekannt.`);
  sha256(value.executionPinsSha256, `${label}.executionPinsSha256`);
  exactKeys(value.runner, ["anchorHelper", "bundle", "entrypoint", "importClosure", "invocation", "launcher", "runtime"], `${label}.runner`);
  fileProof(value.runner.bundle, `${label}.runner.bundle`);
  fileProof(value.runner.entrypoint, `${label}.runner.entrypoint`);
  validateRunnerInvocation(value.runner.invocation, `${label}.runner.invocation`);
  runtimeProof(value.runner.runtime, `${label}.runner.runtime`);
  launcherProof(value.runner.launcher, `${label}.runner.launcher`, value.runner.runtime.platform);
  if (value.runner.runtime.platform === "win32") {
    fileProof(value.runner.anchorHelper, `${label}.runner.anchorHelper`);
    invariant(value.runner.anchorHelper.file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
      `${label}.runner.anchorHelper bindet nicht die kanonische Helper-Assembly.`);
  } else {
    invariant(value.runner.anchorHelper === null, `${label}.runner.anchorHelper ist fuer Linux unzulaessig.`);
  }
  invariant(Array.isArray(value.runner.importClosure) && value.runner.importClosure.length > 0, `${label}.runner.importClosure fehlt.`);
  let previous = "";
  for (const [index, proof] of value.runner.importClosure.entries()) {
    fileProof(proof, `${label}.runner.importClosure[${index}]`);
    invariant(proof.file.localeCompare(previous, "en") > 0, `${label}.runner.importClosure muss eindeutig sortiert sein.`);
    previous = proof.file;
  }
  invariant(value.runner.importClosure.some(({ file }) => file === value.runner.entrypoint.file), `${label}.runner.entrypoint fehlt in der Importclosure.`);
  if (value.runner.runtime.platform === "win32") {
    invariant(Object.hasOwn(value, "annualLaunch"), `${label}.annualLaunch fehlt fuer den Windows-Jahreslauf.`);
    validateAnnualLaunchProof(value.annualLaunch, `${label}.annualLaunch`);
  } else {
    invariant(!Object.hasOwn(value, "annualLaunch"), `${label}.annualLaunch ist fuer einen Nicht-Windows-Lauf unzulaessig.`);
  }

  exactKeys(value.validator, ["buildCommit", "preserved", "executed"], `${label}.validator`);
  gitCommit(value.validator.buildCommit, `${label}.validator.buildCommit`);
  fileProof(value.validator.preserved, `${label}.validator.preserved`);
  exactKeys(value.validator.executed, ["mode", "bytes", "sha256"], `${label}.validator.executed`);
  invariant(["linux-sealed-memfd-launch-v1", "windows-exclusive-handle-launch-v1"].includes(value.validator.executed.mode), `${label}.validator.executed.mode ist unbekannt.`);
  positiveInteger(value.validator.executed.bytes, `${label}.validator.executed.bytes`);
  sha256(value.validator.executed.sha256, `${label}.validator.executed.sha256`);
  invariant(value.validator.executed.bytes === value.validator.preserved.bytes && value.validator.executed.sha256 === value.validator.preserved.sha256, `${label} bindet andere ausgefuehrte als preserved Validator-Bytes.`);

  exactKeys(value.rebuild, ["specification", "evidence", "sourceCommit"], `${label}.rebuild`);
  fileProof(value.rebuild.specification, `${label}.rebuild.specification`);
  fileProof(value.rebuild.evidence, `${label}.rebuild.evidence`, { schema: true });
  gitCommit(value.rebuild.sourceCommit, `${label}.rebuild.sourceCommit`);
  invariant(value.rebuild.sourceCommit === value.validator.buildCommit, `${label} bindet Rebuild und Validator an verschiedene Commits.`);

  exactKeys(value.invocation, ["command", "argumentPrefix", "argumentFiles", "arguments"], `${label}.invocation`);
  invariant(value.invocation.command === "derive-germany-operational-v2", `${label}.invocation.command ist falsch.`);
  stringList(value.invocation.argumentPrefix, `${label}.invocation.argumentPrefix`);
  invariant(Array.isArray(value.invocation.argumentFiles), `${label}.invocation.argumentFiles muss eine Liste sein.`);
  for (const [index, proof] of value.invocation.argumentFiles.entries()) fileProof(proof, `${label}.invocation.argumentFiles[${index}]`);
  const arguments_ = stringList(value.invocation.arguments, `${label}.invocation.arguments`);
  invariant(arguments_.length === COMMAND_ARGUMENTS.length && arguments_[0] === value.invocation.command, `${label}.invocation.arguments ist unvollstaendig.`);
  for (let index = 1; index < arguments_.length; index += 1) portablePath(arguments_[index], `${label}.invocation.arguments[${index}]`);

  exactKeys(value.stdout, ["bytes", "sha256", "recordCount", "structuredReceiptSha256"], `${label}.stdout`);
  positiveInteger(value.stdout.bytes, `${label}.stdout.bytes`);
  sha256(value.stdout.sha256, `${label}.stdout.sha256`);
  invariant(value.stdout.recordCount === 1, `${label}.stdout muss genau einen strukturierten Datensatz enthalten.`);
  sha256(value.stdout.structuredReceiptSha256, `${label}.stdout.structuredReceiptSha256`);
  if (nativeReceipt !== undefined) {
    invariant(value.stdout.structuredReceiptSha256 === germanyOperationalStructuredValueSha256(nativeReceipt), `${label}.stdout bindet ein anderes strukturiertes Native-Receipt.`);
  }
  exactKeys(value.exit, ["code", "signal"], `${label}.exit`);
  invariant(value.exit.code === 0 && value.exit.signal === null, `${label}.exit ist kein erfolgreicher signal-freier Prozessabschluss.`);
  return value;
}

export function validateGermanyOperationalExecutionProofAgainstPins(executionProof, executionPins, { nativeReceipt } = {}) {
  const pins = validateGermanyOperationalExecutionPins(executionPins);
  const proof = validateExecutionProof(executionProof, "Operational-v2-Execution-Proof gegen Pins", nativeReceipt);
  const expectedExecutionPinsBytes = serializeGermanyOperationalExecutionPins(pins);
  const expectedExecutionPinsSha256 = createHash("sha256").update(expectedExecutionPinsBytes).digest("hex");
  invariant(proof.executionPinsSha256 === expectedExecutionPinsSha256,
    "Operational-v2-Execution-Proof bindet nicht den kanonischen SHA-256 der uebergebenen Execution-Pins.");
  invariant(sameCanonical(proof.runner.entrypoint, pins.runner.entrypoint),
    "Operational-v2-Execution-Proof bindet andere Runner-Entrypoint-Bytes als die Execution-Pins.");
  invariant(sameCanonical(proof.runner.importClosure, pins.runner.importClosure),
    "Operational-v2-Execution-Proof bindet andere Importclosure-Bytes als die Execution-Pins.");
  invariant(sameCanonical(proof.runner.bundle, pins.runner.bundle),
    "Operational-v2-Execution-Proof bindet andere gehaltene Bundle-Bytes als die Execution-Pins.");
  invariant(sameCanonical(proof.runner.invocation, pins.runner.invocation),
    "Operational-v2-Execution-Proof bindet einen anderen Node-Runner-Aufruf als die Execution-Pins.");
  invariant(sameCanonical(proof.runner.runtime, pins.runner.runtime),
    "Operational-v2-Execution-Proof bindet eine andere Node-Runtime als die Execution-Pins.");
  invariant(sameCanonical(proof.runner.launcher, pins.runner.launcher),
    "Operational-v2-Execution-Proof bindet einen anderen Systemlauncher als die Execution-Pins.");
  invariant(sameCanonical(proof.runner.anchorHelper, pins.runner.anchorHelper),
    "Operational-v2-Execution-Proof bindet eine andere Windows-Anchor-Helper-Assembly als die Execution-Pins.");
  invariant(proof.validator.buildCommit === pins.validator.buildCommit
    && sameCanonical(proof.validator.preserved, {
      file: pins.validator.file,
      bytes: pins.validator.bytes,
      sha256: pins.validator.sha256,
    }),
  "Operational-v2-Execution-Proof bindet andere Validatorbytes oder einen anderen Commit als die Execution-Pins.");
  invariant(proof.rebuild.specification.file === pins.validator.rebuildSpecification
    && proof.rebuild.evidence.file === pins.validator.rebuildEvidence
    && proof.rebuild.sourceCommit === pins.validator.buildCommit,
  "Operational-v2-Execution-Proof bindet andere Rebuild-Pfade oder einen anderen Commit als die Execution-Pins.");
  if (pins.runner.runtime.platform === "win32") {
    invariant(proof.annualLaunch.executionPins.bytes === expectedExecutionPinsBytes.length
      && proof.annualLaunch.executionPins.sha256 === expectedExecutionPinsSha256
      && proof.annualLaunch.executionPins.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
    "Operational-v2-Execution-Proof-Annual-Launch bindet nicht dieselben Execution-Pins.");
    invariant(sameCanonical(proof.annualLaunch.trustedExecutor, {
      file: pins.validator.file,
      buildCommit: pins.validator.buildCommit,
      bytes: pins.validator.bytes,
      sha256: pins.validator.sha256,
    }), "Operational-v2-Execution-Proof-Annual-Launch bindet nicht denselben Trusted-Executor.");
  }
  invariant(proof.invocation.command === pins.command.name
    && sameCanonical(proof.invocation.argumentPrefix, pins.command.argumentPrefix)
    && sameCanonical(proof.invocation.argumentFiles, pins.command.argumentFiles),
  "Operational-v2-Execution-Proof bindet andere Native-Argumente als die Execution-Pins.");
  return proof;
}

export function validateGermanyOperationalProvenance(value, { nativeReceipt } = {}) {
  exactKeys(value, ["schema", "producerKind", "releaseEvidenceEligible", "productionActivationEligible", "executionPins", "executionProof"], "Operational-v2-Provenienz");
  invariant(value.schema === GERMANY_OPERATIONAL_PROVENANCE_SCHEMA, "Operational-v2-Provenienz besitzt ein unbekanntes Schema.");
  fileProof(value.executionPins, "Operational-v2-Provenienz.executionPins", { schema: true });
  invariant(value.executionPins.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA, "Operational-v2-Provenienz bindet ein falsches Execution-Pins-Schema.");
  if (value.producerKind === GERMANY_OPERATIONAL_FORENSIC_PRODUCER_KIND) {
    invariant(value.releaseEvidenceEligible === false && value.productionActivationEligible === false && value.executionProof === null, "Forensische Operational-v2-Provenienz darf weder Evidence noch Aktivierung freigeben.");
    return value;
  }
  invariant(value.producerKind === GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND, "Operational-v2-Provenienz besitzt eine unbekannte Producer-Art.");
  invariant(value.releaseEvidenceEligible === true && value.productionActivationEligible === true, "Integrierte Operational-v2-Provenienz muss beide Eignungsgates explizit schliessen.");
  validateExecutionProof(value.executionProof, "Operational-v2-Provenienz.executionProof", nativeReceipt);
  invariant(value.executionProof.executionPinsSha256 === value.executionPins.sha256, "Operational-v2-Provenienz bindet Execution-Pins und Execution-Proof verschieden.");
  return value;
}

export function germanyOperationalProvenanceSha256(value) {
  validateGermanyOperationalProvenance(value);
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameNodeIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readPinnedRegularFile(path, label, maxBytes = MAX_PINS_BYTES) {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && before.size > 0n && before.size <= BigInt(maxBytes), `${label} ist keine kleine regulaere Datei.`);
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    invariant(pathAfter.isFile() && !pathAfter.isSymbolicLink() && sameIdentity(before, after) && sameIdentity(after, pathAfter) && BigInt(bytes.length) === after.size, `${label} wurde waehrend des Lesens ersetzt oder veraendert.`);
    return { bytes, proof: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
  } finally {
    await handle.close();
  }
}

function resolvePortable(root, file, label) {
  portablePath(file, label);
  const path = resolve(root, ...file.split("/"));
  const rel = relative(root, path);
  invariant(rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `${label} verlaesst die Arbeitswurzel.`);
  return path;
}

function comparableResolvedPath(path) {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

async function assertCanonicalRepositoryPath(root, path, label) {
  const [realRoot, actual] = await Promise.all([realpath(root), realpath(path)]);
  const expected = resolve(realRoot, relative(root, path));
  invariant(
    comparableResolvedPath(actual) === comparableResolvedPath(expected),
    `${label} verwendet einen symbolischen Link oder Junction-Ahnen.`,
  );
}

function parseStaticModuleSpecifiers(bytes, label) {
  const environment = process.platform === "win32"
    ? {
        SystemRoot: WINDOWS_TRUSTED_SYSTEM_ROOT,
        WINDIR: WINDOWS_TRUSTED_SYSTEM_ROOT,
        ComSpec: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32\\cmd.exe`,
        PATH: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32;${WINDOWS_TRUSTED_SYSTEM_ROOT}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      }
    : { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const result = spawnSync(operationalNodeReexecPath(), ["--expose-internals", "-e", MODULE_PARSER_CHILD_SOURCE], {
    encoding: "utf8",
    env: environment,
    input: bytes,
    maxBuffer: MAX_PINS_BYTES,
    shell: false,
    windowsHide: true,
  });
  invariant(result.error === undefined, `${label} konnte nicht mit dem Node-Modulparser gelesen werden: ${result.error?.message ?? "unbekannter Fehler"}`);
  invariant(result.signal === null && result.status === 0, `${label} ist kein gueltiges statisches ESM-Modul.`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} lieferte keinen strukturierten Modulparser-Beleg.`, { cause: error });
  }
  exactKeys(parsed, ["staticSpecifiers", "unsupportedLoaders"], `${label} Modulparser-Beleg`);
  const staticSpecifiers = stringList(parsed.staticSpecifiers, `${label} statische Modulbezeichner`);
  const unsupportedLoaders = stringList(parsed.unsupportedLoaders, `${label} nicht gepinnte Loader`);
  invariant(unsupportedLoaders.length === 0, `${label} enthaelt nicht gepinnte Loader: ${unsupportedLoaders.join(", ")}.`);
  return staticSpecifiers;
}

function portableRelative(root, path, label) {
  const rel = relative(root, resolve(path));
  invariant(rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `${label} verlaesst die Arbeitswurzel.`);
  return portablePath(rel.split(sep).join("/"), label);
}

function portableWorkspaceRootOrRelative(root, path, label) {
  const rel = relative(root, resolve(path));
  if (rel === "") return ".";
  return portableRelative(root, path, label);
}

export async function loadGermanyOperationalExecutionPins({ workspaceRoot, executionPinsPath, expectedReleaseId }) {
  const root = resolve(workspaceRoot);
  const path = resolve(executionPinsPath);
  const file = portableRelative(root, path, "Operational-v2-Execution-Pins-Pfad");
  await assertCanonicalRepositoryPath(root, path, "Operational-v2-Execution-Pins");
  const source = await readPinnedRegularFile(path, "Operational-v2-Execution-Pins");
  await assertCanonicalRepositoryPath(root, path, "Operational-v2-Execution-Pins nach dem Lesen");
  let value;
  try {
    value = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Operational-v2-Execution-Pins ist kein gueltiges JSON.", { cause: error });
  }
  validateGermanyOperationalExecutionPins(value, expectedReleaseId);
  invariant(
    source.bytes.equals(serializeGermanyOperationalExecutionPins(value, expectedReleaseId)),
    "Operational-v2-Execution-Pins besitzt nicht die kanonische Byteform.",
  );
  return { value, proof: { file, ...source.proof, schema: value.schema } };
}

export async function proveGermanyOperationalAnnualLaunchFromEnvironment({
  workspaceRoot,
  executionPinsSource,
  encodedProof = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANNUAL_LAUNCH_PROOF_BASE64,
}) {
  const root = resolve(workspaceRoot);
  const pins = validateGermanyOperationalExecutionPins(executionPinsSource.value);
  invariant(process.platform === "win32", "Operational-v2-Annual-Launch-Proof ist nur fuer den Windows-Jahreslauf definiert.");
  const proof = validateAnnualLaunchProof(
    canonicalJsonBase64(encodedProof, "Operational-v2-Annual-Launch-Proof-Transport"),
  );
  invariant(proof.contract.releaseId === pins.releaseId,
    "Operational-v2-Annual-Launch-Proof bindet eine falsche Release-ID.");
  invariant(sameCanonical(proof.executionPins, executionPinsSource.proof),
    "Operational-v2-Annual-Launch-Proof bindet andere Execution-Pins als der Runner.");
  invariant(sameCanonical(proof.trustedExecutor, {
    file: pins.validator.file,
    buildCommit: pins.validator.buildCommit,
    bytes: pins.validator.bytes,
    sha256: pins.validator.sha256,
  }), "Operational-v2-Annual-Launch-Proof bindet andere Trusted-Executor-Bytes als die Execution-Pins.");

  const contractPath = resolvePortable(root, proof.contract.file, "Operational-v2-Annual-Launch-Vertrag");
  await assertCanonicalRepositoryPath(root, contractPath, "Operational-v2-Annual-Launch-Vertrag");
  const source = await readPinnedRegularFile(contractPath, "Operational-v2-Annual-Launch-Vertrag", 2 * 1024 * 1024);
  invariant(source.proof.bytes === proof.contract.bytes && source.proof.sha256 === proof.contract.sha256,
    "Operational-v2-Annual-Launch-Vertrag driftet vom gehaltenen Startbeleg.");
  let contract;
  try {
    contract = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Operational-v2-Annual-Launch-Vertrag ist kein gueltiges JSON.", { cause: error });
  }
  invariant(canonicalBytes(contract).equals(source.bytes),
    "Operational-v2-Annual-Launch-Vertrag ist nicht kanonisch serialisiert.");
  exactKeys(contract, ["bootstrap", "dynamicBindings", "executionPins", "launcher", "platform", "releaseId", "schema", "trustedExecutor"],
    "Operational-v2-Annual-Launch-Vertrag");
  invariant(contract.schema === proof.contract.schema && contract.releaseId === proof.contract.releaseId
    && contract.platform === "win32",
  "Operational-v2-Annual-Launch-Vertrag besitzt eine falsche Identitaet.");
  invariant(sameCanonical(contract.executionPins, proof.executionPins),
    "Operational-v2-Annual-Launch-Vertrag bindet andere Execution-Pins als sein Startbeleg.");
  invariant(sameCanonical(contract.trustedExecutor, proof.trustedExecutor),
    "Operational-v2-Annual-Launch-Vertrag bindet andere Trusted-Executor-Bytes als sein Startbeleg.");
  await assertCanonicalRepositoryPath(root, contractPath, "Operational-v2-Annual-Launch-Vertrag nach dem Lesen");
  return proof;
}

async function repositoryImportClosure(root, roots) {
  const visited = new Map();
  const pending = roots.map((file) => portablePath(file, "Operational-v2-Importclosure-Wurzel"));
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    const path = resolvePortable(root, file, `Operational-v2-Importclosure ${file}`);
    await assertCanonicalRepositoryPath(root, path, `Operational-v2-Importclosure ${file}`);
    const source = await readPinnedRegularFile(path, `Operational-v2-Importclosure ${file}`);
    await assertCanonicalRepositoryPath(root, path, `Operational-v2-Importclosure ${file} nach dem Lesen`);
    visited.set(file, { file, ...source.proof });
    if (file === GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE
      || file === GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE
      || file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE) continue;
    for (const specifier of parseStaticModuleSpecifiers(source.bytes, `Operational-v2-Importclosure ${file}`)) {
      if (specifier.startsWith("node:")) continue;
      invariant(specifier.startsWith("./") || specifier.startsWith("../"), `Operational-v2-Importclosure ${file} enthaelt den nicht gepinnten Modulbezeichner ${specifier}.`);
      const importedPath = resolve(dirname(path), specifier);
      pending.push(portableRelative(root, importedPath, `Operational-v2-Import aus ${file}`));
    }
  }
  return [...visited.values()].sort((left, right) => left.file.localeCompare(right.file, "en"));
}

export async function proveGermanyOperationalExecutionContext({ workspaceRoot, executionPins, verifyCurrentInvocation = true }) {
  const root = resolve(workspaceRoot);
  const pins = validateGermanyOperationalExecutionPins(executionPins);
  const invocation = verifyCurrentInvocation ? currentRunnerInvocation(pins) : pins.runner.invocation;
  if (verifyCurrentInvocation) invariant(sameCanonical(invocation, pins.runner.invocation), "Operational-v2-Runner-Aufruf driftet von den Execution-Pins.");
  const launcherSourceFile = pins.runner.runtime.platform === "win32"
    ? GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE
    : GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE;
  const importClosure = await repositoryImportClosure(root, [
    ...pins.runner.roots.map(({ file }) => file),
    launcherSourceFile,
    ...(pins.runner.anchorHelper === null ? [] : [pins.runner.anchorHelper.file]),
  ]);
  invariant(sameCanonical(importClosure, pins.runner.importClosure), "Operational-v2-Runner-/Capture-/Publisher-Importclosure driftet von ihren unveraenderlichen Byte-Pins.");
  const entrypoint = importClosure.find(({ file }) => file === pins.runner.entrypoint.file);
  invariant(entrypoint !== undefined, "Operational-v2-Runner-Entrypoint fehlt im Ausfuehrungsbeleg.");
  invariant(sameCanonical(entrypoint, pins.runner.entrypoint), "Operational-v2-Runner-Entrypoint driftet von seinem unveraenderlichen Byte-Pin.");
  const bundlePath = resolvePortable(root, pins.runner.bundle.file, "Operational-v2-gehaltenes Runner-Bundle");
  await assertCanonicalRepositoryPath(root, bundlePath, "Operational-v2-gehaltenes Runner-Bundle");
  const bundleSource = await readPinnedRegularFile(bundlePath, "Operational-v2-gehaltenes Runner-Bundle", 16 * 1024 * 1024);
  const bundle = { file: pins.runner.bundle.file, ...bundleSource.proof };
  invariant(sameCanonical(bundle, pins.runner.bundle), "Operational-v2-gehaltenes Runner-Bundle driftet von seinem unveraenderlichen Byte-Pin.");
  return {
    anchorHelper: pins.runner.anchorHelper === null ? null : { ...pins.runner.anchorHelper },
    bundle,
    entrypoint,
    importClosure,
    invocation,
    launcher: { ...pins.runner.launcher },
    runtime: { ...pins.runner.runtime },
  };
}

async function proveGermanyOperationalPinnedExecutionFiles({ workspaceRoot, executionPins }) {
  const root = resolve(workspaceRoot);
  const pins = validateGermanyOperationalExecutionPins(executionPins);
  const importClosure = [];
  for (const expected of pins.runner.importClosure) {
    const path = resolvePortable(root, expected.file, `Operational-v2-gepinnte Importclosure ${expected.file}`);
    await assertCanonicalRepositoryPath(root, path, `Operational-v2-gepinnte Importclosure ${expected.file}`);
    const source = await readPinnedRegularFile(path, `Operational-v2-gepinnte Importclosure ${expected.file}`);
    await assertCanonicalRepositoryPath(root, path, `Operational-v2-gepinnte Importclosure ${expected.file} nach dem Lesen`);
    const actual = { file: expected.file, ...source.proof };
    invariant(
      sameCanonical(actual, expected),
      `Operational-v2-gepinnte Importclosure ${expected.file} driftet von ihrem Annual-Pin.`,
    );
    importClosure.push(actual);
  }
  const entrypoint = importClosure.find(({ file }) => file === pins.runner.entrypoint.file);
  invariant(entrypoint !== undefined, "Operational-v2-Runner-Entrypoint fehlt im gepinnten Ausfuehrungsbeleg.");
  invariant(sameCanonical(entrypoint, pins.runner.entrypoint), "Operational-v2-Runner-Entrypoint driftet von seinem unveraenderlichen Byte-Pin.");
  const bundlePath = resolvePortable(root, pins.runner.bundle.file, "Operational-v2-gehaltenes Runner-Bundle");
  await assertCanonicalRepositoryPath(root, bundlePath, "Operational-v2-gehaltenes Runner-Bundle");
  const bundleSource = await readPinnedRegularFile(bundlePath, "Operational-v2-gehaltenes Runner-Bundle", 16 * 1024 * 1024);
  const bundle = { file: pins.runner.bundle.file, ...bundleSource.proof };
  invariant(sameCanonical(bundle, pins.runner.bundle), "Operational-v2-gehaltenes Runner-Bundle driftet von seinem unveraenderlichen Byte-Pin.");
  return {
    anchorHelper: pins.runner.anchorHelper === null ? null : { ...pins.runner.anchorHelper },
    bundle,
    entrypoint,
    importClosure,
    invocation: pins.runner.invocation,
    launcher: { ...pins.runner.launcher },
    runtime: { ...pins.runner.runtime },
  };
}

function powershellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function windowsHeldLauncherBootstrap({ environment, launcherPath, launcher }) {
  const context = Buffer.from(JSON.stringify(environment), "utf8").toString("base64");
  return {
    context,
    source: `$ErrorActionPreference='Stop';$f=$null;try{$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ZUGFOLGE_OPERATIONAL_BOOTSTRAP_CONTEXT_BASE64))|ConvertFrom-Json;if($c.ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SHA256 -ne '${environment.ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SHA256}' -or $c.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_SHA256 -ne '${environment.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_SHA256}' -or $c.ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_SHA256 -ne '${launcher.sourceSha256}'){throw'Annual-Pins drifteten'};foreach($p in $c.PSObject.Properties){[Environment]::SetEnvironmentVariable($p.Name,[String]$p.Value,'Process')};[Environment]::SetEnvironmentVariable('ZUGFOLGE_OPERATIONAL_BOOTSTRAP_CONTEXT_BASE64',$null,'Process');$f=[IO.File]::Open(${powershellSingleQuoted(launcherPath)},'Open','Read','Read');if($f.Length -ne ${launcher.sourceBytes}){throw'Launcher-Bytes'};$b=New-Object byte[] ${launcher.sourceBytes};$o=0;while($o -lt $b.Length){$n=$f.Read($b,$o,$b.Length-$o);if($n -eq 0){throw'Launcher-EOF'};$o+=$n};$s=[Security.Cryptography.SHA256]::Create();try{$h=([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()};if($h -ne '${launcher.sourceSha256}'){throw'Launcher-SHA'};&([ScriptBlock]::Create((New-Object Text.UTF8Encoding($false,$true)).GetString($b)))}catch{[Console]::Error.Write($_.Exception.ToString());exit 90}finally{if($null -ne $f){$f.Dispose()}}`,
  };
}

function windowsHeldValidatorLauncherBootstrap({ environment, launcherPath, launcher }) {
  const context = Buffer.from(JSON.stringify(environment), "utf8").toString("base64");
  return {
    context,
    source: `$ErrorActionPreference='Stop';$f=$null;try{$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ZUGFOLGE_OPERATIONAL_BOOTSTRAP_CONTEXT_BASE64))|ConvertFrom-Json;if($c.ZUGFOLGE_OPERATIONAL_LAUNCHER_PURPOSE -ne 'validator' -or $c.ZUGFOLGE_OPERATIONAL_ANCHOR_SHA256 -ne '${environment.ZUGFOLGE_OPERATIONAL_ANCHOR_SHA256}' -or $c.ZUGFOLGE_OPERATIONAL_LAUNCHER_SOURCE_SHA256 -ne '${launcher.sourceSha256}'){throw'Validator-Annual-Pins drifteten'};foreach($p in $c.PSObject.Properties){[Environment]::SetEnvironmentVariable($p.Name,[String]$p.Value,'Process')};[Environment]::SetEnvironmentVariable('ZUGFOLGE_OPERATIONAL_BOOTSTRAP_CONTEXT_BASE64',$null,'Process');$f=[IO.File]::Open(${powershellSingleQuoted(launcherPath)},'Open','Read','Read');if($f.Length -ne ${launcher.sourceBytes}){throw'Validator-Launcher-Bytes'};$b=New-Object byte[] ${launcher.sourceBytes};$o=0;while($o -lt $b.Length){$n=$f.Read($b,$o,$b.Length-$o);if($n -eq 0){throw'Validator-Launcher-EOF'};$o+=$n};$s=[Security.Cryptography.SHA256]::Create();try{$h=([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()};if($h -ne '${launcher.sourceSha256}'){throw'Validator-Launcher-SHA'};&([ScriptBlock]::Create((New-Object Text.UTF8Encoding($false,$true)).GetString($b)))}catch{[Console]::Error.Write($_.Exception.ToString());exit 90}finally{if($null -ne $f){$f.Dispose()}}`,
  };
}

function linuxHeldLauncherBootstrap({ launcher }) {
  return `import hashlib, os, stat, sys, traceback
try:
    launcher_path = sys.argv.pop(1)
    arguments = sys.argv[1:]
    if len(arguments) != 17:
        raise RuntimeError("Direkter Linux-Bootstrap erwartet exakt zehn Launcher- und sieben Runner-Argumente.")
    expected = ${JSON.stringify({
      bundleBytes: launcher.bundle.bytes,
      bundleSha256: launcher.bundle.sha256,
      launcherBytes: launcher.proof.sourceBytes,
      launcherMode: launcher.proof.mode,
      launcherSha256: launcher.proof.sourceSha256,
      runtimeBytes: launcher.runtime.bytes,
      runtimeSha256: launcher.runtime.sha256,
    })}
    if (arguments[1] != str(expected["runtimeBytes"])
            or arguments[2] != expected["runtimeSha256"]
            or arguments[4] != str(expected["bundleBytes"])
            or arguments[5] != expected["bundleSha256"]
            or arguments[6] != expected["launcherMode"]
            or arguments[7] != str(expected["launcherBytes"])
            or arguments[8] != expected["launcherSha256"]):
        raise RuntimeError("Direkter Linux-Bootstrap erhielt von den literalen Annual-Pins abweichende Ausfuehrungswerte.")
    descriptor = os.open(launcher_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size != expected["launcherBytes"]:
            raise RuntimeError("Gehaltene Launcher-Datenfile besitzt eine falsche Bytezahl.")
        chunks = []
        while True:
            chunk = os.read(descriptor, 1048576)
            if not chunk:
                break
            chunks.append(chunk)
        source = b"".join(chunks)
        after = os.fstat(descriptor)
        if ((before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size)
                or hashlib.sha256(source).hexdigest() != expected["launcherSha256"]):
            raise RuntimeError("Gehaltene Launcher-Datenfile driftete oder besitzt einen falschen SHA-256.")
        code = compile(source.decode("utf-8", "strict"), launcher_path, "exec")
        exec(code, {"__builtins__": __builtins__, "__file__": launcher_path, "__name__": "__main__"})
    finally:
        os.close(descriptor)
except SystemExit:
    raise
except Exception:
    traceback.print_exc(file=sys.stderr)
    sys.exit(90)`;
}

function windowsCleanCmdCommand(encodedBootstrap) {
  return [
    "setlocal DisableDelayedExpansion",
    'set "COR_ENABLE_PROFILING="',
    'set "COR_PROFILER="',
    'set "COR_PROFILER_PATH="',
    'set "COR_PROFILER_PATH_32="',
    'set "COR_PROFILER_PATH_64="',
    'set "CORECLR_ENABLE_PROFILING="',
    'set "CORECLR_PROFILER="',
    'set "CORECLR_PROFILER_PATH="',
    'set "CORECLR_PROFILER_PATH_32="',
    'set "CORECLR_PROFILER_PATH_64="',
    'set "DOTNET_STARTUP_HOOKS="',
    'set "DOTNET_ADDITIONAL_DEPS="',
    'set "DOTNET_SHARED_STORE="',
    'set "APPDOMAIN_MANAGER_ASM="',
    'set "APPDOMAIN_MANAGER_TYPE="',
    'set "COMPLUS_ApplicationMigrationRuntimeActivationConfigPath="',
    'set "COMPLUS_Version="',
    'set "NODE_OPTIONS="',
    'set "NODE_PATH="',
    String.raw`set "PSModulePath=C:\Windows\System32\WindowsPowerShell\v1.0\Modules"`,
    'set "__COMPAT_LAYER="',
    String.raw`set "SystemRoot=C:\Windows"`,
    String.raw`set "WINDIR=C:\Windows"`,
    String.raw`set "ComSpec=C:\Windows\System32\cmd.exe"`,
    String.raw`set "PATH=C:\Windows\System32;C:\Windows"`,
    'set "PATHEXT=.COM;.EXE;.BAT;.CMD"',
    String.raw`set "TEMP=C:\Windows\Temp"`,
    String.raw`set "TMP=C:\Windows\Temp"`,
    `${WINDOWS_TRUSTED_POWERSHELL} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedBootstrap}`,
  ].join(" & ");
}

async function proofFromHandle(handle, label) {
  const before = await handle.stat({ bigint: true });
  invariant(before.isFile() && before.size > 0n, `${label} ist keine regulaere Datei.`);
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  while (true) {
    const result = await handle.read(buffer, 0, buffer.length, bytes);
    if (result.bytesRead === 0) break;
    digest.update(buffer.subarray(0, result.bytesRead));
    bytes += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  invariant(sameIdentity(before, after) && BigInt(bytes) === after.size, `${label} driftete waehrend der Hashbildung.`);
  return { identity: after, proof: { bytes, sha256: digest.digest("hex") } };
}

async function copyHeldFile(sourceHandle, destinationHandle, label) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const result = await sourceHandle.read(buffer, 0, buffer.length, position);
    if (result.bytesRead === 0) break;
    let written = 0;
    while (written < result.bytesRead) {
      const writeResult = await destinationHandle.write(buffer, written, result.bytesRead - written, position + written);
      invariant(writeResult.bytesWritten > 0, `${label} konnte nicht vollstaendig geschrieben werden.`);
      written += writeResult.bytesWritten;
    }
    digest.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  await destinationHandle.chmod(0o700);
  await destinationHandle.sync();
  return { bytes: position, sha256: digest.digest("hex") };
}

function parseSingleStructuredStdout(stdout, maximumBytes) {
  invariant(Buffer.isBuffer(stdout) && stdout.length > 0 && stdout.length <= maximumBytes, "Native Operational-v2-Ableitung lieferte kein begrenztes stdout-Receipt.");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch (error) {
    throw new Error("Native Operational-v2-Ableitung lieferte kein gueltiges UTF-8 auf stdout.", { cause: error });
  }
  const body = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : null;
  invariant(body !== null && body.length > 0 && body.trim() === body && !/[\r\n]/u.test(body), "Native Operational-v2-Ableitung muss exakt einen kompakten JSON-stdout-Datensatz liefern.");
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error("Native Operational-v2-Ableitung lieferte keinen einzelnen strukturierten JSON-stdout-Datensatz.", { cause: error });
  }
  invariant(isRecord(value), "Native Operational-v2-Ableitung lieferte kein JSON-Objekt.");
  return {
    value,
    proof: {
      bytes: stdout.length,
      sha256: createHash("sha256").update(stdout).digest("hex"),
      recordCount: 1,
      structuredReceiptSha256: germanyOperationalStructuredValueSha256(value),
    },
  };
}

function canonicalBase64Bytes(value, label) {
  invariant(typeof value === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value), `${label} ist kein kanonisches Base64.`);
  const bytes = Buffer.from(value, "base64");
  invariant(bytes.toString("base64") === value, `${label} ist kein kanonisches Base64.`);
  return bytes;
}

async function windowsPowerShellPath() {
  const actual = await realpath(WINDOWS_TRUSTED_POWERSHELL);
  invariant(comparableResolvedPath(actual) === comparableResolvedPath(WINDOWS_TRUSTED_POWERSHELL),
    "Windows-Validator-Launcher liegt nicht am fest gebundenen, systemgeschuetzten PowerShell-Pfad.");
  return WINDOWS_TRUSTED_POWERSHELL;
}

async function executeWindowsExclusiveHandleValidator({
  executionPath,
  expected,
  anchorHelperPath,
  anchorHelper,
  inputFiles = [],
  arguments: arguments_,
  cwd,
  maximumBytes,
  timeoutMilliseconds = GERMANY_OPERATIONAL_ANNUAL_RUN_TIMEOUT_MILLISECONDS,
}) {
  const launcherPath = await windowsPowerShellPath();
  const launcherBefore = await readPinnedRegularFile(launcherPath, "Windows-System32-PowerShell-Launcher", 16 * 1024 * 1024);
  const launcherSourcePath = resolvePortable(cwd, GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE, "Windows-Validator-Systemlauncher-Datenfile");
  await assertCanonicalRepositoryPath(cwd, launcherSourcePath, "Windows-Validator-Systemlauncher-Datenfile");
  const launcherSourceProof = germanyOperationalSystemLauncherSourceProof("win32");
  const launcherSourceBefore = await readPinnedRegularFile(launcherSourcePath, "Windows-Validator-Systemlauncher-Datenfile", 1024 * 1024);
  invariant(launcherSourceBefore.proof.bytes === launcherSourceProof.sourceBytes
    && launcherSourceBefore.proof.sha256 === launcherSourceProof.sourceSha256,
  "Windows-Validator-Systemlauncher-Datenfile driftet von der kanonischen Quelle.");
  // Do not inherit CLR profiler, module-path or shell variables from the caller:
  // they could otherwise redirect code loading before the exclusive handle exists.
  const environment = {
    SystemRoot: WINDOWS_TRUSTED_SYSTEM_ROOT,
    WINDIR: WINDOWS_TRUSTED_SYSTEM_ROOT,
    ComSpec: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32\\cmd.exe`,
    PATH: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32;${WINDOWS_TRUSTED_SYSTEM_ROOT}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: dirname(executionPath),
    TMP: dirname(executionPath),
  };
  Object.assign(environment, {
    ZUGFOLGE_OPERATIONAL_ANCHOR_PATH: executionPath,
    ZUGFOLGE_OPERATIONAL_ANCHOR_CWD: cwd,
    ZUGFOLGE_OPERATIONAL_ANCHOR_BYTES: String(expected.bytes),
    ZUGFOLGE_OPERATIONAL_ANCHOR_SHA256: expected.sha256,
    ZUGFOLGE_OPERATIONAL_ANCHOR_MAX_BYTES: String(maximumBytes),
    ZUGFOLGE_OPERATIONAL_ANCHOR_TIMEOUT_MILLISECONDS: String(timeoutMilliseconds),
    ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_COUNT: String(arguments_.length),
    ZUGFOLGE_OPERATIONAL_ANCHOR_INPUT_COUNT: String(inputFiles.length),
    ZUGFOLGE_OPERATIONAL_ANCHOR_HELPER_PATH: anchorHelperPath,
    ZUGFOLGE_OPERATIONAL_ANCHOR_HELPER_BYTES: String(anchorHelper.bytes),
    ZUGFOLGE_OPERATIONAL_ANCHOR_HELPER_SHA256: anchorHelper.sha256,
    ZUGFOLGE_OPERATIONAL_LAUNCHER_PURPOSE: "validator",
    ZUGFOLGE_OPERATIONAL_LAUNCHER_SOURCE_BYTES: String(launcherSourceProof.sourceBytes),
    ZUGFOLGE_OPERATIONAL_LAUNCHER_SOURCE_SHA256: launcherSourceProof.sourceSha256,
  });
  for (const [index, argument] of arguments_.entries()) environment[`ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_${index}`] = argument;
  invariant(inputFiles.length <= 16, "Windows-Validator-Launcher erhielt zu viele gehaltene Inputdateien.");
  const expectedInputProofs = [];
  for (const [index, input] of inputFiles.entries()) {
    const inputProof = { bytes: input.bytes, file: input.file, sha256: input.sha256 };
    fileProof(inputProof, `Windows-Validator-Launcher-Input[${index}]`);
    invariant(isAbsolute(input.path), `Windows-Validator-Launcher-Input[${index}] besitzt keinen absoluten Pfad.`);
    expectedInputProofs.push(inputProof);
    environment[`ZUGFOLGE_OPERATIONAL_ANCHOR_INPUT_${index}_FILE`] = input.file;
    environment[`ZUGFOLGE_OPERATIONAL_ANCHOR_INPUT_${index}_PATH`] = input.path;
    environment[`ZUGFOLGE_OPERATIONAL_ANCHOR_INPUT_${index}_BYTES`] = String(input.bytes);
    environment[`ZUGFOLGE_OPERATIONAL_ANCHOR_INPUT_${index}_SHA256`] = input.sha256;
  }
  const bootstrap = windowsHeldValidatorLauncherBootstrap({
    environment,
    launcherPath: launcherSourcePath,
    launcher: launcherSourceProof,
  });
  const encodedCommand = Buffer.from(bootstrap.source, "utf16le").toString("base64");
  const envelopeMaximum = Math.ceil(maximumBytes * 8 / 3) + 1024 * 1024;
  const result = spawnSync(launcherPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encodedCommand,
  ], {
    cwd,
    encoding: "utf8",
    env: {
      SystemRoot: WINDOWS_TRUSTED_SYSTEM_ROOT,
      WINDIR: WINDOWS_TRUSTED_SYSTEM_ROOT,
      ComSpec: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32\\cmd.exe`,
      PATH: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32;${WINDOWS_TRUSTED_SYSTEM_ROOT}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: dirname(executionPath),
      TMP: dirname(executionPath),
      ZUGFOLGE_OPERATIONAL_BOOTSTRAP_CONTEXT_BASE64: bootstrap.context,
    },
    maxBuffer: envelopeMaximum,
    shell: false,
    windowsHide: true,
  });
  const [launcherAfter, launcherSourceAfter] = await Promise.all([
    readPinnedRegularFile(launcherPath, "Windows-System32-PowerShell-Launcher nach Ausfuehrung", 16 * 1024 * 1024),
    readPinnedRegularFile(launcherSourcePath, "Windows-Validator-Systemlauncher-Datenfile nach Ausfuehrung", 1024 * 1024),
  ]);
  invariant(sameCanonical(launcherBefore.proof, launcherAfter.proof), "Windows-System32-PowerShell-Launcher driftete waehrend der Ausfuehrung.");
  invariant(sameCanonical(launcherSourceBefore.proof, launcherSourceAfter.proof), "Windows-Validator-Systemlauncher-Datenfile driftete waehrend der Ausfuehrung.");
  if (result.error !== undefined) throw new Error(`Exklusiver Windows-Validator-Launcher konnte nicht gestartet werden: ${result.error.message}`, { cause: result.error });
  invariant(result.signal === null && result.status === 0, `Exklusiver Windows-Validator-Launcher scheiterte mit Exit ${result.status}: ${String(result.stderr).slice(0, 2048)}`);
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Exklusiver Windows-Validator-Launcher lieferte keinen strukturierten Ankerbeleg.", { cause: error });
  }
  exactKeys(envelope, ["anchorBytes", "anchorSha256", "inputProofs", "status", "signal", "stdoutBase64", "stderrBase64"], "Windows-Validator-Launcher-Beleg");
  invariant(envelope.anchorBytes === expected.bytes && envelope.anchorSha256 === expected.sha256,
    "Windows-Validator-Launcher hielt andere Bytes als den geprueften Validator.");
  invariant(sameCanonical(envelope.inputProofs, expectedInputProofs),
    "Windows-Validator-Launcher hielt andere Inputbytes als der Supervisorvertrag.");
  invariant(Number.isInteger(envelope.status) && envelope.signal === null, "Windows-Validator-Launcher lieferte keinen eindeutigen Prozessabschluss.");
  return {
    status: envelope.status,
    signal: null,
    inputProofs: envelope.inputProofs,
    stdout: canonicalBase64Bytes(envelope.stdoutBase64, "Windows-Validator-stdout"),
    stderr: canonicalBase64Bytes(envelope.stderrBase64, "Windows-Validator-stderr"),
  };
}

async function bytesFromHandle(handle, expected, label) {
  const before = await handle.stat({ bigint: true });
  invariant(before.isFile() && before.size === BigInt(expected.bytes), `${label} besitzt eine falsche Bytezahl.`);
  const chunks = [];
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < expected.bytes) {
    const result = await handle.read(buffer, 0, Math.min(buffer.length, expected.bytes - position), position);
    invariant(result.bytesRead > 0, `${label} endete vor der gepinnten Bytezahl.`);
    const chunk = Buffer.from(buffer.subarray(0, result.bytesRead));
    chunks.push(chunk);
    digest.update(chunk);
    position += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  invariant(sameIdentity(before, after) && position === expected.bytes && digest.digest("hex") === expected.sha256,
    `${label} driftete von den gepinnten Bytes.`);
  return Buffer.concat(chunks, position);
}

async function executeLinuxSealedMemfdValidator({
  binary,
  expected,
  arguments: arguments_,
  cwd,
  maximumBytes,
}) {
  const configuredPath = "/usr/bin/python3";
  const launcherPath = await realpath(configuredPath);
  invariant(launcherPath.startsWith("/usr/bin/python3"), "Linux-memfd-Launcher ist nicht das festgelegte /usr/bin/python3.");
  const launcherBefore = await readPinnedRegularFile(launcherPath, "Linux-System-Python-memfd-Launcher", 32 * 1024 * 1024);
  const request = Buffer.from(`${JSON.stringify({
    bytes: expected.bytes,
    sha256: expected.sha256,
    maximumBytes,
    arguments: arguments_,
    cwd,
    outerSessionBound: process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE === GERMANY_OPERATIONAL_LINUX_LAUNCHER_MODE,
  })}\n`, "utf8");
  const envelopeMaximum = Math.ceil(maximumBytes * 8 / 3) + 1024 * 1024;
  const result = spawnSync(launcherPath, ["-I", "-S", "-c", LINUX_SEALED_MEMFD_LAUNCHER_SOURCE], {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    input: Buffer.concat([request, binary]),
    maxBuffer: envelopeMaximum,
    shell: false,
  });
  const launcherAfter = await readPinnedRegularFile(launcherPath, "Linux-System-Python-memfd-Launcher nach Ausfuehrung", 32 * 1024 * 1024);
  invariant(sameCanonical(launcherBefore.proof, launcherAfter.proof), "Linux-System-Python-memfd-Launcher driftete waehrend der Ausfuehrung.");
  if (result.error !== undefined) throw new Error(`Versiegelter Linux-memfd-Validator-Launcher konnte nicht gestartet werden: ${result.error.message}`, { cause: result.error });
  invariant(result.signal === null && result.status === 0, `Versiegelter Linux-memfd-Validator-Launcher scheiterte mit Exit ${result.status}: ${String(result.stderr).slice(0, 2048)}`);
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Versiegelter Linux-memfd-Validator-Launcher lieferte keinen strukturierten Ankerbeleg.", { cause: error });
  }
  exactKeys(envelope, ["anchorBytes", "anchorSha256", "sealMask", "status", "signal", "stdoutBase64", "stderrBase64"], "Linux-memfd-Validator-Launcher-Beleg");
  invariant(envelope.anchorBytes === expected.bytes && envelope.anchorSha256 === expected.sha256 && envelope.sealMask === 15,
    "Linux-memfd-Validator-Launcher versiegelte andere oder unvollstaendige Bytes.");
  invariant((Number.isInteger(envelope.status) && envelope.signal === null)
    || (envelope.status === null && Number.isInteger(envelope.signal) && envelope.signal > 0),
  "Linux-memfd-Validator-Launcher lieferte keinen eindeutigen Prozessabschluss.");
  return {
    status: envelope.status,
    signal: envelope.signal === null ? null : `SIG${envelope.signal}`,
    stdout: canonicalBase64Bytes(envelope.stdoutBase64, "Linux-memfd-Validator-stdout"),
    stderr: canonicalBase64Bytes(envelope.stderrBase64, "Linux-memfd-Validator-stderr"),
  };
}

export async function createGermanyOperationalAnchoredRunnerInvocation({
  workspaceRoot,
  executionPinsPath,
  arguments: arguments_,
  nodePath: requestedNodePath,
  annualLaunchProofBase64,
  phase = "derive-and-capture-v1",
  workflowAuthorityEnvironment,
}) {
  const root = resolve(workspaceRoot);
  invariant(Array.isArray(arguments_) && Object.values(GERMANY_OPERATIONAL_RUNNER_PHASES).includes(arguments_.length)
    && arguments_.every((argument) => typeof argument === "string" && argument.length > 0 && !argument.includes("\0")),
  "Operational-v2-Systemlauncher besitzt keine bekannte begrenzte Runner-Argumentzahl.");
  invariant(Object.hasOwn(GERMANY_OPERATIONAL_RUNNER_PHASES, phase)
    && GERMANY_OPERATIONAL_RUNNER_PHASES[phase] === arguments_.length,
  "Operational-v2-Systemlauncher besitzt eine ungueltige interne Phase oder Argumentzahl.");
  const rebuildAuthorityEnvironment = phase === "materialize-validator-rebuild-v3"
    ? validateGermanyOperationalRebuildAuthorityEnvironment(workflowAuthorityEnvironment)
    : undefined;
  invariant(phase === "materialize-validator-rebuild-v3" || workflowAuthorityEnvironment === undefined,
    "Operational-v2-Systemlauncher darf Workflow-Authority nur in der Validator-Rebuild-v3-Phase transportieren.");
  const executionPinsSource = await loadGermanyOperationalExecutionPins({
    workspaceRoot: root,
    executionPinsPath,
  });
  const pins = executionPinsSource.value;
  invariant(pins.runner.runtime.platform === process.platform,
    "Operational-v2-Systemlauncher laeuft nicht auf der in den Execution-Pins gebundenen Plattform.");
  const runnerProof = await proveGermanyOperationalPinnedExecutionFiles({
    workspaceRoot: root,
    executionPins: pins,
  });
  const bundlePath = resolvePortable(root, pins.runner.bundle.file, "Operational-v2-Systemlauncher-Bundle");
  const expected = runnerProof.bundle;
  const nodePath = await realpath(requestedNodePath ?? process.execPath);
  invariant(isAbsolute(nodePath), "Operational-v2-Systemlauncher-Node besitzt keinen kanonischen absoluten Pfad.");
  const nodeSource = await readPinnedRegularFile(nodePath, "Operational-v2-gepinnte Node-Runtime", 256 * 1024 * 1024);
  invariant(nodeSource.proof.bytes === pins.runner.runtime.bytes && nodeSource.proof.sha256 === pins.runner.runtime.sha256,
    "Operational-v2-Systemlauncher-Node driftet von den Execution-Pins.");
  const launcher = pins.runner.launcher;
  const launcherSourceFile = process.platform === "win32"
    ? GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE
    : GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE;
  const launcherSourcePath = resolvePortable(root, launcherSourceFile, "Operational-v2-Systemlauncher-Datenfile");
  await assertCanonicalRepositoryPath(root, launcherSourcePath, "Operational-v2-Systemlauncher-Datenfile");
  const launcherSource = await readPinnedRegularFile(launcherSourcePath, "Operational-v2-Systemlauncher-Datenfile", 1024 * 1024);
  invariant(launcherSource.proof.bytes === launcher.sourceBytes && launcherSource.proof.sha256 === launcher.sourceSha256,
    "Operational-v2-Systemlauncher-Datenfile driftet vom literalen Annual-Launcher-Pin.");
  if (process.platform === "win32") {
    const anchorHelperPath = resolvePortable(root, pins.runner.anchorHelper.file, "Operational-v2-Windows-Anchor-Helper");
    const environment = {
      SystemRoot: WINDOWS_TRUSTED_SYSTEM_ROOT,
      WINDIR: WINDOWS_TRUSTED_SYSTEM_ROOT,
      ComSpec: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32\\cmd.exe`,
      PATH: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32;${WINDOWS_TRUSTED_SYSTEM_ROOT}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\Temp`,
      TMP: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\Temp`,
      ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_PATH: bundlePath,
      ZUGFOLGE_OPERATIONAL_RUNNER_NODE_PATH: nodePath,
      ZUGFOLGE_OPERATIONAL_RUNNER_NODE_BYTES: String(pins.runner.runtime.bytes),
      ZUGFOLGE_OPERATIONAL_RUNNER_NODE_SHA256: pins.runner.runtime.sha256,
      ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT: root,
      ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_BYTES: String(expected.bytes),
      ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SHA256: expected.sha256,
      ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_PATH: anchorHelperPath,
      ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_BYTES: String(pins.runner.anchorHelper.bytes),
      ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_SHA256: pins.runner.anchorHelper.sha256,
      ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_MODE: launcher.mode,
      ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_BYTES: String(launcher.sourceBytes),
      ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_SHA256: launcher.sourceSha256,
      ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT: String(arguments_.length),
      ZUGFOLGE_OPERATIONAL_RUNNER_PHASE: phase,
    };
    if (annualLaunchProofBase64 !== undefined) {
      validateAnnualLaunchProof(canonicalJsonBase64(
        annualLaunchProofBase64,
        "Operational-v2-Systemlauncher-Annual-Launch-Proof",
      ));
      environment.ZUGFOLGE_OPERATIONAL_RUNNER_ANNUAL_LAUNCH_PROOF_BASE64 = annualLaunchProofBase64;
    }
    if (rebuildAuthorityEnvironment !== undefined) {
      for (const [name, value] of Object.entries(rebuildAuthorityEnvironment)) {
        environment[`ZUGFOLGE_OPERATIONAL_RUNNER_AUTHORITY_${name}`] = value;
      }
    }
    for (const [index, argument] of arguments_.entries()) environment[`ZUGFOLGE_OPERATIONAL_RUNNER_CLI_${index}`] = argument;
    await windowsPowerShellPath();
    const actualCmd = await realpath(WINDOWS_TRUSTED_CMD);
    invariant(comparableResolvedPath(actualCmd) === comparableResolvedPath(WINDOWS_TRUSTED_CMD),
      "Windows-Systemlauncher liegt nicht am fest gebundenen nativen cmd.exe-Pfad.");
    const bootstrap = windowsHeldLauncherBootstrap({ environment, launcherPath: launcherSourcePath, launcher });
    const encoded = Buffer.from(bootstrap.source, "utf16le").toString("base64");
    return {
      command: WINDOWS_TRUSTED_CMD,
      arguments: ["/d", "/c", windowsCleanCmdCommand(encoded)],
      cwd: root,
      env: {
        SystemRoot: WINDOWS_TRUSTED_SYSTEM_ROOT,
        WINDIR: WINDOWS_TRUSTED_SYSTEM_ROOT,
        ComSpec: WINDOWS_TRUSTED_CMD,
        PATH: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32;${WINDOWS_TRUSTED_SYSTEM_ROOT}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        TEMP: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\Temp`,
        TMP: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\Temp`,
        ZUGFOLGE_OPERATIONAL_BOOTSTRAP_CONTEXT_BASE64: bootstrap.context,
      },
      expected: { bundle: expected, launcher, runtime: pins.runner.runtime },
      executionPinsSource,
      runnerProof,
    };
  }
  if (process.platform === "linux") {
    invariant(phase === "derive-and-capture-v1",
      "Linux-Systemlauncher unterstuetzt nur die gebundene Derive-and-Capture-Phase.");
    const launcherPath = "/usr/bin/python3";
    const canonicalLauncherPath = await realpath(launcherPath);
    invariant(canonicalLauncherPath.startsWith("/usr/bin/python3"), "Linux-Bundle-Launcher ist nicht das festgelegte /usr/bin/python3.");
    const bootstrap = linuxHeldLauncherBootstrap({ launcher: {
      bundle: expected,
      proof: launcher,
      runtime: pins.runner.runtime,
    } });
    return {
      command: "/usr/bin/env",
      arguments: [
        "-i", launcherPath, "-I", "-S", "-c", bootstrap, launcherSourcePath,
        nodePath, String(pins.runner.runtime.bytes), pins.runner.runtime.sha256,
        bundlePath, String(expected.bytes), expected.sha256,
        launcher.mode, String(launcher.sourceBytes), launcher.sourceSha256,
        root, ...arguments_,
      ],
      cwd: root,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      expected: { bundle: expected, launcher, runtime: pins.runner.runtime },
      executionPinsSource,
      runnerProof,
    };
  }
  throw new Error(`Operational-v2 besitzt fuer ${process.platform} keinen systemgeschuetzten Bundle-Launcher.`);
}

export function decodeGermanyOperationalAnchoredRunnerResult(result, expected) {
  if (result.error !== undefined) throw new Error(`Operational-v2-System-Bundle-Launcher konnte nicht gestartet werden: ${result.error.message}`, { cause: result.error });
  invariant(result.signal === null && [0, 94].includes(result.status), `Operational-v2-System-Bundle-Launcher scheiterte mit Exit ${result.status}: ${String(result.stderr).slice(0, 2048)}`);
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Operational-v2-System-Bundle-Launcher lieferte keinen strukturierten Ankerbeleg.", { cause: error });
  }
  exactKeys(envelope, ["anchorBytes", "anchorSha256", "status", "signal", "stdoutBase64", "stderrBase64"], "Operational-v2-System-Bundle-Ankerbeleg");
  invariant(envelope.anchorBytes === expected.bundle.bytes && envelope.anchorSha256 === expected.bundle.sha256,
    "Operational-v2-System-Bundle-Launcher startete andere als die gepinnten Bundle-Bytes.");
  invariant((Number.isInteger(envelope.status) && envelope.signal === null)
    || (envelope.status === null && Number.isInteger(envelope.signal) && envelope.signal > 0),
  "Operational-v2-System-Bundle-Launcher lieferte keinen eindeutigen Prozessabschluss.");
  invariant(
    (result.status === 0 && envelope.status === 0 && envelope.signal === null)
      || (result.status === 94 && (envelope.status !== 0 || envelope.signal !== null)),
    "Operational-v2-System-Bundle-Launcher transportiert einen widerspruechlichen Kindprozessabschluss.",
  );
  return {
    status: envelope.status,
    signal: envelope.signal === null ? null : `SIG${envelope.signal}`,
    stdout: canonicalBase64Bytes(envelope.stdoutBase64, "Operational-v2-System-Bundle-stdout"),
    stderr: canonicalBase64Bytes(envelope.stderrBase64, "Operational-v2-System-Bundle-stderr"),
  };
}

export function decodeGermanyOperationalNestedAnnualRun(stdout, runnerProof) {
  invariant(Buffer.isBuffer(stdout) && stdout.length > 0 && stdout.length <= 2 * 1024 * 1024,
    "Annual-v2-Rust-Executor lieferte keinen begrenzten verschachtelten Launcherbeleg.");
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
  } catch (error) {
    throw new Error("Annual-v2-Rust-Executor lieferte keinen einzelnen verschachtelten Launcherbeleg.", { cause: error });
  }
  exactKeys(envelope, ["anchorBytes", "anchorSha256", "status", "signal", "stdoutBase64", "stderrBase64"],
    "Annual-v2-verschachtelter Systemlauncher-Beleg");
  invariant(envelope.anchorBytes === runnerProof.bundle.bytes
    && envelope.anchorSha256 === runnerProof.bundle.sha256,
  "Annual-v2-verschachtelter Systemlauncher startete andere Bundle-Bytes.");
  invariant(envelope.status === 0 && envelope.signal === null,
    "Annual-v2-verschachtelter Systemlauncher besitzt keinen erfolgreichen eindeutigen Abschluss.");
  const nestedStderr = canonicalBase64Bytes(envelope.stderrBase64, "Annual-v2-verschachtelter Systemlauncher-stderr");
  invariant(nestedStderr.length === 0, "Annual-v2-verschachtelter Systemlauncher erzeugte unerwartete stderr-Bytes.");
  const nestedStdout = canonicalBase64Bytes(envelope.stdoutBase64, "Annual-v2-verschachtelter Systemlauncher-stdout");
  const captured = parseSingleStructuredStdout(nestedStdout, 1024 * 1024);
  exactKeys(captured.value, ["activationEligible", "candidateProduced", "nativeReceipt", "status", "unresolvedRequired"],
    "Annual-v2-kausaler Capture-Abschluss");
  invariant(captured.value.status === "captured"
    && captured.value.candidateProduced === true
    && captured.value.activationEligible === true
    && captured.value.unresolvedRequired === 0,
  "Annual-v2-kausaler Capture-Abschluss ist nicht aktivierungsfaehig.");
  exactKeys(captured.value.nativeReceipt, ["bytes", "file", "sha256"], "Annual-v2-kausaler Native-Receipt-Beleg");
  positiveInteger(captured.value.nativeReceipt.bytes, "Annual-v2-kausaler Native-Receipt-Beleg.bytes");
  sha256(captured.value.nativeReceipt.sha256, "Annual-v2-kausaler Native-Receipt-Beleg.sha256");
  portablePath(captured.value.nativeReceipt.file, "Annual-v2-kausaler Native-Receipt-Beleg.file");
  return {
    capture: captured.value,
    launcher: {
      anchorBytes: envelope.anchorBytes,
      anchorSha256: envelope.anchorSha256,
      status: envelope.status,
      signal: envelope.signal,
      stdout: captured.proof,
    },
  };
}

export async function withGermanyOperationalHeldOutputFiles({ workspaceRoot, files, callback }) {
  invariant(process.platform === "win32", "Annual-v2-Outputbindung ist ausschliesslich fuer Windows definiert.");
  invariant(Array.isArray(files) && files.length > 0 && files.length <= 4 && typeof callback === "function",
    "Annual-v2-Outputbindung benoetigt eine begrenzte nichtleere Dateimenge.");
  const root = resolve(workspaceRoot);
  const prepared = [];
  const seen = new Set();
  let callbackResult;
  try {
    for (const [index, entry] of files.entries()) {
      invariant(isRecord(entry), `Annual-v2-Output[${index}] ist kein Objekt.`);
      exactKeys(entry, ["captureBytes", "label", "path", "proof"], `Annual-v2-Output[${index}]`);
      invariant(typeof entry.label === "string" && entry.label.length > 0,
        `Annual-v2-Output[${index}].label fehlt.`);
      invariant(typeof entry.path === "string" && isAbsolute(entry.path),
        `Annual-v2-Output[${index}].path ist nicht absolut.`);
      invariant(typeof entry.captureBytes === "boolean", `Annual-v2-Output[${index}].captureBytes ist ungueltig.`);
      fileProof(entry.proof, `Annual-v2-Output[${index}].proof`);
      const path = resolve(entry.path);
      const file = portableRelative(root, path, `Annual-v2-Output[${index}]`);
      invariant(file === entry.proof.file, `Annual-v2-Output[${index}] bindet einen anderen Pfad als sein Native-Receipt.`);
      invariant(!seen.has(comparableResolvedPath(path)), "Annual-v2-Outputbindung enthaelt doppelte Pfade.");
      seen.add(comparableResolvedPath(path));
      await assertCanonicalRepositoryPath(root, path, `Annual-v2-Output[${index}]`);
      const pathBefore = await lstat(path, { bigint: true });
      invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink(), `Annual-v2-Output[${index}] ist keine regulaere Datei.`);
      const handle = await open(path, "r");
      prepared.push({ ...entry, file, handle, identity: pathBefore });
      const held = await handle.stat({ bigint: true });
      invariant(sameIdentity(pathBefore, held), `Annual-v2-Output[${index}] driftete vor der gehaltenen Pruefung.`);
    }
    const proofs = {};
    const capturedBytes = {};
    for (const entry of prepared) {
      const actual = await proofFromHandle(entry.handle, entry.label);
      invariant(actual.proof.bytes === entry.proof.bytes && actual.proof.sha256 === entry.proof.sha256,
        `${entry.label} driftet vom kausalen Native-Receipt.`);
      proofs[entry.label] = { file: entry.file, ...actual.proof };
      if (entry.captureBytes) {
        invariant(entry.proof.bytes <= 16 * 1024 * 1024, `${entry.label} ist fuer gehaltene Inhaltsbindung zu gross.`);
        capturedBytes[entry.label] = await bytesFromHandle(entry.handle, entry.proof, entry.label);
      }
    }
    callbackResult = await callback({ proofs, capturedBytes });
    for (const entry of prepared) {
      const after = await proofFromHandle(entry.handle, `${entry.label} nach Outer-Receipt-Materialisierung`);
      const pathAfter = await lstat(entry.path, { bigint: true });
      invariant(sameIdentity(entry.identity, after.identity) && sameIdentity(after.identity, pathAfter)
        && after.proof.bytes === entry.proof.bytes && after.proof.sha256 === entry.proof.sha256,
      `${entry.label} driftete waehrend der Outer-Receipt-Materialisierung.`);
    }
    return callbackResult;
  } finally {
    await Promise.allSettled(prepared.map(({ handle }) => handle.close()));
  }
}

export async function executeGermanyOperationalPinnedAnnualExecutor({
  workspaceRoot,
  executionPinsSource,
  runnerProof,
  runnerPhase = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_PHASE,
  inputPaths,
  rustArgumentPaths,
  annualLaunchProofBase64,
}) {
  invariant(process.platform === "win32", "Annual-v2-Executor-Supervision ist ausschliesslich fuer Windows definiert.");
  const phaseContract = runnerPhase === "materialize-annual-plan-evidence-v1"
    ? {
        command: "plan",
        inputCount: 3,
        rustArgumentCount: 3,
        timeoutMilliseconds: GERMANY_OPERATIONAL_ANNUAL_PLAN_TIMEOUT_MILLISECONDS,
      }
    : runnerPhase === "execute-annual-operational-v2-v1"
      ? {
          command: "run-annual-operational-v2",
          inputCount: 6,
          rustArgumentCount: 4,
          timeoutMilliseconds: GERMANY_OPERATIONAL_ANNUAL_RUN_TIMEOUT_MILLISECONDS,
        }
      : null;
  invariant(phaseContract !== null, "Annual-v2-Executor-Supervision besitzt keine gebundene Runnerphase.");
  invariant(Array.isArray(inputPaths) && inputPaths.length === phaseContract.inputCount
    && Array.isArray(rustArgumentPaths) && rustArgumentPaths.length === phaseContract.rustArgumentCount,
  "Annual-v2-Executor-Supervision besitzt eine falsche Input- oder Rust-Argumentzahl.");
  const root = resolve(workspaceRoot);
  const pins = validateGermanyOperationalExecutionPins(executionPinsSource.value);
  const runnerBefore = await proveGermanyOperationalExecutionContext({
    workspaceRoot: root,
    executionPins: pins,
  });
  invariant(sameCanonical(runnerProof, runnerBefore),
    "Annual-v2-Executor-Supervision driftete von der gehaltenen Runner-Closure.");
  const annualLaunch = await proveGermanyOperationalAnnualLaunchFromEnvironment({
    workspaceRoot: root,
    executionPinsSource,
    encodedProof: annualLaunchProofBase64 ?? process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANNUAL_LAUNCH_PROOF_BASE64,
  });
  const heldInputs = [];
  for (const [index, inputPath] of inputPaths.entries()) {
    const path = resolve(inputPath);
    await assertCanonicalRepositoryPath(root, path, `Annual-v2-Supervisor-Input[${index}]`);
    const source = await readPinnedRegularFile(path, `Annual-v2-Supervisor-Input[${index}]`, 16 * 1024 * 1024);
    heldInputs.push({
      file: portableRelative(root, path, `Annual-v2-Supervisor-Input[${index}]`),
      path,
      ...source.proof,
    });
  }
  const rustArguments = rustArgumentPaths.map((path, index) => {
    const absolute = resolve(path);
    invariant(comparableResolvedPath(absolute) === comparableResolvedPath(heldInputs[index].path),
      `Annual-v2-Rust-Argument[${index}] bindet nicht den entsprechenden gehaltenen Input.`);
    return absolute;
  });
  const executorPath = resolvePortable(root, pins.validator.file, "Annual-v2-gepinnter Rust-Executor");
  await assertCanonicalRepositoryPath(root, executorPath, "Annual-v2-gepinnter Rust-Executor");
  const executor = await readPinnedRegularFile(executorPath, "Annual-v2-gepinnter Rust-Executor", 64 * 1024 * 1024);
  invariant(executor.proof.bytes === pins.validator.bytes && executor.proof.sha256 === pins.validator.sha256,
    "Annual-v2-Rust-Executor driftet von den Execution-Pins.");
  const anchorHelperPath = resolvePortable(root, pins.runner.anchorHelper.file, "Annual-v2-Windows-Anchor-Helper");
  const result = await executeWindowsExclusiveHandleValidator({
    executionPath: executorPath,
    expected: executor.proof,
    anchorHelperPath,
    anchorHelper: pins.runner.anchorHelper,
    inputFiles: heldInputs,
    arguments: [phaseContract.command, ...rustArguments],
    cwd: root,
    maximumBytes: pins.command.stdoutMaxBytes,
    timeoutMilliseconds: phaseContract.timeoutMilliseconds,
  });
  invariant(result.signal === null && result.status === 0,
    `Gehaltene Annual-v2-Rust-Executor-Phase scheiterte mit Exit ${result.status}: ${result.stderr.toString("utf8").slice(0, 2048)}`);
  const runnerAfter = await proveGermanyOperationalExecutionContext({
    workspaceRoot: root,
    executionPins: pins,
  });
  invariant(sameCanonical(runnerBefore, runnerAfter),
    "Annual-v2-Runner-/Importclosure driftete waehrend der Executor-Phase.");
  return {
    annualLaunch,
    executionPins: { ...executionPinsSource.proof },
    inputs: result.inputProofs,
    invocation: {
      arguments: [phaseContract.command, ...rustArguments.map((path) => portableRelative(root, path, "Annual-v2-Rust-Argument"))],
      command: phaseContract.command,
      phase: runnerPhase,
    },
    job: {
      mode: "windows-kill-on-job-close-root-exit-bounded-io-v1",
      timeoutMilliseconds: phaseContract.timeoutMilliseconds,
    },
    runner: runnerAfter,
    trustedExecutor: {
      buildCommit: pins.validator.buildCommit,
      bytes: pins.validator.bytes,
      file: pins.validator.file,
      sha256: pins.validator.sha256,
    },
    exit: { code: result.status, signal: result.signal },
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function executeGermanyOperationalPinnedValidator({
  workspaceRoot,
  executionPinsSource,
  runnerProof,
  validatorRebuild,
  specificationPath,
  sourceRoot,
  candidatePath,
  reportPath,
  annualLaunchProofBase64,
  runnerPhase = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_PHASE,
  hooks = {},
}) {
  const root = resolve(workspaceRoot);
  const pins = validateGermanyOperationalExecutionPins(executionPinsSource.value);
  const runnerBefore = await proveGermanyOperationalExecutionContext({ workspaceRoot: root, executionPins: pins, verifyCurrentInvocation: false });
  invariant(sameCanonical(runnerProof, runnerBefore), "Operational-v2-Runner-/Importclosure driftete vor der Validator-Ausfuehrung.");
  const annualLaunch = process.platform === "win32"
    ? await proveGermanyOperationalAnnualLaunchFromEnvironment({
        workspaceRoot: root,
        executionPinsSource,
        encodedProof: annualLaunchProofBase64 ?? process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANNUAL_LAUNCH_PROOF_BASE64,
      })
    : undefined;
  invariant(runnerPhase === "derive-and-capture-v1",
    "Operational-v2-Native-Validator darf nur in der gebundenen Derive-and-Capture-Phase starten.");
  const preservedPath = resolvePortable(root, pins.validator.file, "Operational-v2-preserved-Validator");
  const prefixFiles = new Set(pins.command.argumentFiles.map(({ file }) => file));
  const argumentPrefix = pins.command.argumentPrefix.map((argument) => (
    prefixFiles.has(argument) ? resolvePortable(root, argument, "Operational-v2-Native-Argumentdatei") : argument
  ));
  const argumentFiles = [];
  for (const expected of pins.command.argumentFiles) {
    const source = await readPinnedRegularFile(resolvePortable(root, expected.file, `Operational-v2-Argumentdatei ${expected.file}`), `Operational-v2-Argumentdatei ${expected.file}`);
    const actual = { file: expected.file, ...source.proof };
    invariant(sameCanonical(actual, expected), `Operational-v2-Argumentdatei ${expected.file} driftet von ihrem unveraenderlichen Byte-Pin.`);
    argumentFiles.push(actual);
  }
  const portableArguments = [
    pins.command.name,
    portableRelative(root, specificationPath, "Operational-v2-Aufrufsspezifikation"),
    portableWorkspaceRootOrRelative(root, sourceRoot, "Operational-v2-Aufrufsquellwurzel"),
    portableRelative(root, candidatePath, "Operational-v2-Aufrufscandidate"),
    portableRelative(root, reportPath, "Operational-v2-Aufrufsbericht"),
  ];
  const nativeArguments = [pins.command.name, resolve(specificationPath), resolve(sourceRoot), resolve(candidatePath), resolve(reportPath)];
  const executionDirectory = await mkdtemp(join(dirname(resolve(candidatePath)), ".operational-v2-exec-retained-owned-cleanup-"));
  const executionDirectoryIdentity = await lstat(executionDirectory, { bigint: true });
  invariant(executionDirectoryIdentity.isDirectory() && !executionDirectoryIdentity.isSymbolicLink(), "Operational-v2-Ausfuehrungsverzeichnis ist kein eigenes regulaeres Verzeichnis.");
  const executionPath = join(executionDirectory, process.platform === "win32" ? "validator.exe" : "validator");
  const executionAnchorPath = join(executionDirectory, ".validator.ownership-anchor");
  let preservedHandle;
  let executionHandle;
  let executionAnchorHandle;
  let executionCreated = false;
  let executionAnchorCreated = false;
  let failure;
  try {
    preservedHandle = await open(preservedPath, "r");
    const preservedBefore = await proofFromHandle(preservedHandle, "Operational-v2-preserved-Validator vor Ausfuehrung");
    const preservedPathBefore = await lstat(preservedPath, { bigint: true });
    invariant(preservedPathBefore.isFile() && !preservedPathBefore.isSymbolicLink() && sameIdentity(preservedBefore.identity, preservedPathBefore), "Operational-v2-preserved-Validatorpfad bindet nicht den gehaltenen Handle.");
    invariant(preservedBefore.proof.bytes === pins.validator.bytes && preservedBefore.proof.sha256 === pins.validator.sha256, "Operational-v2-preserved-Validator driftet von Execution-Pins.");
    executionHandle = await open(executionPath, "wx+", 0o700);
    executionCreated = true;
    const copied = await copyHeldFile(preservedHandle, executionHandle, "Operational-v2-Ausfuehrungskopie");
    invariant(copied.bytes === pins.validator.bytes && copied.sha256 === pins.validator.sha256, "Operational-v2-Ausfuehrungskopie driftet vom preserved Validator.");
    const executionBefore = await proofFromHandle(executionHandle, "Operational-v2-Ausfuehrungskopie vor Start");
    const executionPathBefore = await lstat(executionPath, { bigint: true });
    invariant(executionPathBefore.isFile() && !executionPathBefore.isSymbolicLink() && sameIdentity(executionBefore.identity, executionPathBefore), "Operational-v2-Ausfuehrungspfad bindet nicht den gehaltenen Copy-Handle.");
    await link(executionPath, executionAnchorPath);
    executionAnchorCreated = true;
    executionAnchorHandle = await open(executionAnchorPath, "r");
    const [anchorHandleBefore, anchorPathBefore] = await Promise.all([
      executionAnchorHandle.stat({ bigint: true }),
      lstat(executionAnchorPath, { bigint: true }),
    ]);
    invariant(anchorPathBefore.isFile() && !anchorPathBefore.isSymbolicLink()
      && sameIdentity(executionBefore.identity, anchorHandleBefore)
      && sameIdentity(anchorHandleBefore, anchorPathBefore),
    "Operational-v2-Ausfuehrungskopie besitzt keinen gehaltenen Ownership-Anker.");
    await executionHandle.close();
    executionHandle = undefined;
    executionHandle = await open(executionPath, "r");
    const [reopenedHandle, reopenedPath] = await Promise.all([
      executionHandle.stat({ bigint: true }),
      lstat(executionPath, { bigint: true }),
    ]);
    invariant(reopenedPath.isFile() && !reopenedPath.isSymbolicLink()
      && sameIdentity(executionBefore.identity, reopenedHandle)
      && sameIdentity(anchorHandleBefore, reopenedHandle)
      && sameIdentity(reopenedHandle, reopenedPath),
    "Operational-v2-Ausfuehrungspfad driftete beim Wechsel auf gehaltene Lesehandles.");
    await hooks.beforeValidatorSpawn?.({ executionPath, executionAnchorPath });
    const launchArguments = [...argumentPrefix, ...nativeArguments];
    let executionMode;
    let result;
    if (process.platform === "win32") {
      executionMode = "windows-exclusive-handle-launch-v1";
      const anchorHelperPath = resolvePortable(root, pins.runner.anchorHelper.file, "Operational-v2-Windows-Anchor-Helper");
      result = await executeWindowsExclusiveHandleValidator({
        executionPath,
        expected: executionBefore.proof,
        anchorHelperPath,
        anchorHelper: pins.runner.anchorHelper,
        arguments: launchArguments,
        cwd: root,
        maximumBytes: pins.command.stdoutMaxBytes,
      });
    } else if (process.platform === "linux") {
      executionMode = "linux-sealed-memfd-launch-v1";
      const binary = await bytesFromHandle(executionHandle, executionBefore.proof, "Operational-v2-Ausfuehrungskopie fuer versiegelten Linux-memfd-Start");
      result = await executeLinuxSealedMemfdValidator({
        binary,
        expected: executionBefore.proof,
        arguments: launchArguments,
        cwd: root,
        maximumBytes: pins.command.stdoutMaxBytes,
      });
    } else {
      throw new Error(`Operational-v2 besitzt fuer ${process.platform} keinen kausal bytegebundenen Validator-Launcher.`);
    }
    invariant(result.signal === null, `Nativer Operational-v2-Validator wurde durch Signal ${result.signal} abgebrochen.`);
    invariant(result.status === 0, `Nativer Operational-v2-Validator endete mit Exit ${result.status}.`);
    const structured = parseSingleStructuredStdout(result.stdout, pins.command.stdoutMaxBytes);
    const [preservedAfter, preservedPathAfter, executionAfter, anchorHandleAfter, executionPathAfter, anchorPathAfter, runnerAfter, argumentFilesAfter, executionPinsAfter] = await Promise.all([
      proofFromHandle(preservedHandle, "Operational-v2-preserved-Validator nach Ausfuehrung"),
      lstat(preservedPath, { bigint: true }),
      proofFromHandle(executionHandle, "Operational-v2-Ausfuehrungskopie nach Ausfuehrung"),
      executionAnchorHandle.stat({ bigint: true }),
      lstat(executionPath, { bigint: true }),
      lstat(executionAnchorPath, { bigint: true }),
      proveGermanyOperationalExecutionContext({ workspaceRoot: root, executionPins: pins, verifyCurrentInvocation: false }),
      Promise.all(pins.command.argumentFiles.map(async (expected) => {
        const source = await readPinnedRegularFile(resolvePortable(root, expected.file, `Operational-v2-Argumentdatei ${expected.file} nach Ausfuehrung`), `Operational-v2-Argumentdatei ${expected.file} nach Ausfuehrung`);
        const actual = { file: expected.file, ...source.proof };
        invariant(sameCanonical(actual, expected), `Operational-v2-Argumentdatei ${expected.file} driftet nach Ausfuehrung von ihrem unveraenderlichen Byte-Pin.`);
        return actual;
      })),
      readPinnedRegularFile(
        resolvePortable(root, executionPinsSource.proof.file, "Operational-v2-Execution-Pins nach Ausfuehrung"),
        "Operational-v2-Execution-Pins nach Ausfuehrung",
      ),
    ]);
    invariant(preservedPathAfter.isFile() && !preservedPathAfter.isSymbolicLink()
      && sameCanonical(preservedBefore.proof, preservedAfter.proof)
      && sameIdentity(preservedBefore.identity, preservedAfter.identity)
      && sameIdentity(preservedAfter.identity, preservedPathAfter),
    "Operational-v2-preserved-Validator driftete waehrend der Ausfuehrung.");
    invariant(sameCanonical(executionBefore.proof, executionAfter.proof) && sameIdentity(executionBefore.identity, executionAfter.identity), "Operational-v2-Ausfuehrungskopie driftete waehrend der Ausfuehrung.");
    invariant(executionPathAfter.isFile() && !executionPathAfter.isSymbolicLink()
      && anchorPathAfter.isFile() && !anchorPathAfter.isSymbolicLink()
      && sameIdentity(executionBefore.identity, anchorHandleAfter)
      && sameIdentity(anchorHandleAfter, executionPathAfter)
      && sameIdentity(executionPathAfter, anchorPathAfter),
    "Operational-v2-Ausfuehrungspfad oder Ownership-Anker driftete waehrend der Ausfuehrung.");
    invariant(sameCanonical(runnerProof, runnerAfter), "Operational-v2-Runner-/Importclosure driftete waehrend der Validator-Ausfuehrung.");
    invariant(sameCanonical(argumentFiles, argumentFilesAfter), "Operational-v2-Argumentdateien drifteten waehrend der Validator-Ausfuehrung.");
    invariant(sameCanonical(executionPinsSource.proof, {
      file: executionPinsSource.proof.file,
      ...executionPinsAfter.proof,
      schema: executionPinsSource.proof.schema,
    }), "Operational-v2-Execution-Pins drifteten waehrend der Validator-Ausfuehrung.");
    const proof = {
      schema: GERMANY_OPERATIONAL_EXECUTION_PROOF_SCHEMA,
      executionPinsSha256: executionPinsSource.proof.sha256,
      ...(annualLaunch === undefined ? {} : { annualLaunch }),
      runner: runnerProof,
      validator: {
        buildCommit: pins.validator.buildCommit,
        preserved: { file: pins.validator.file, ...preservedBefore.proof },
        executed: { mode: executionMode, ...executionBefore.proof },
      },
      rebuild: {
        specification: { ...validatorRebuild.specification },
        evidence: { ...validatorRebuild.evidence },
        sourceCommit: validatorRebuild.sourceCommit,
      },
      invocation: {
        command: pins.command.name,
        argumentPrefix: [...pins.command.argumentPrefix],
        argumentFiles,
        arguments: portableArguments,
      },
      stdout: structured.proof,
      exit: { code: 0, signal: null },
    };
    validateGermanyOperationalExecutionProofAgainstPins(proof, pins, { nativeReceipt: structured.value });
    return { nativeReceipt: structured.value, executionProof: proof };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    const knownEntries = new Set([basename(executionPath), basename(executionAnchorPath)]);
    if (executionHandle !== undefined) await executionHandle.close().catch((error) => cleanupErrors.push(error));
    if (executionAnchorHandle !== undefined) await executionAnchorHandle.close().catch((error) => cleanupErrors.push(error));
    if (preservedHandle !== undefined) await preservedHandle.close().catch((error) => cleanupErrors.push(error));
    await hooks.beforeExecutionDirectoryRetentionCheck?.({ executionDirectory }).catch((error) => cleanupErrors.push(error));
    let rootOwned = await lstat(executionDirectory, { bigint: true })
      .then((current) => current.isDirectory() && !current.isSymbolicLink() && sameNodeIdentity(current, executionDirectoryIdentity))
      .catch((error) => { cleanupErrors.push(error); return false; });
    if (!rootOwned) {
      cleanupErrors.push(new Error("Operational-v2-Ausfuehrungsverzeichnis wurde vor der retained-owned-Cleanup-Pruefung fremd ersetzt; kein Pfad wurde veraendert."));
    }
    const retainedEntries = rootOwned
      ? await readdir(executionDirectory).catch((error) => { cleanupErrors.push(error); rootOwned = false; return null; })
      : null;
    if (retainedEntries !== null && retainedEntries.some((entry) => !knownEntries.has(entry))) {
      cleanupErrors.push(new Error("Operational-v2-Ausfuehrungsverzeichnis enthaelt fremde Dateien und bleibt am unveraenderten Pfad vollstaendig erhalten."));
    }
    if (cleanupErrors.length > 0) {
      if (failure !== undefined) throw new AggregateError([failure, ...cleanupErrors], "Operational-v2-Ausfuehrung und owned-only Cleanup sind fehlgeschlagen.");
      throw new AggregateError(cleanupErrors, "Operational-v2-Ausfuehrungs-Cleanup ist fehlgeschlagen.");
    }
  }
}

export function integratedGermanyOperationalProvenance({ executionPinsProof, executionProof, nativeReceipt }) {
  const value = {
    schema: GERMANY_OPERATIONAL_PROVENANCE_SCHEMA,
    producerKind: GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND,
    releaseEvidenceEligible: true,
    productionActivationEligible: true,
    executionPins: { ...executionPinsProof },
    executionProof,
  };
  return validateGermanyOperationalProvenance(value, { nativeReceipt });
}

export function forensicGermanyOperationalProvenance(executionPinsProof) {
  return validateGermanyOperationalProvenance({
    schema: GERMANY_OPERATIONAL_PROVENANCE_SCHEMA,
    producerKind: GERMANY_OPERATIONAL_FORENSIC_PRODUCER_KIND,
    releaseEvidenceEligible: false,
    productionActivationEligible: false,
    executionPins: { ...executionPinsProof },
    executionProof: null,
  });
}
