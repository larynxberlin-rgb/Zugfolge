import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

const SPEC_SCHEMA = "zugfolge-operational-validator-rebuild-spec/v3";
const EVIDENCE_SCHEMA = "zugfolge-operational-validator-rebuild-evidence/v3";
const PROVENANCE_SCHEMA = "zugfolge-operational-validator-rebuild-provenance/v2";
const TOOLCHAIN_MANIFEST_SCHEMA = "zugfolge-operational-validator-toolchain-manifest/v1";
const PRODUCER_BUNDLE = "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs";
const PRODUCER_ENTRYPOINT = "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs";
const PRODUCER_EXECUTION_PINS = "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json";
const PRODUCER_IMPLEMENTATION = "tools/region-import/germany/operational-validator-rebuild-evidence.mjs";
const WINDOWS_ANCHOR_HELPER = "tools/region-import/germany/operational-windows-anchor-helper.dll";
const ANNUAL_DIRECT_CONTRACT = "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json";
const ANNUAL_PLAN_FILE = "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json";
const ANNUAL_EXECUTOR_START_EVIDENCE = "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json";
const ANNUAL_CREATE_NEW_COMPLETION_SUFFIX = ".zugfolge-complete.json";
const ANNUAL_PLAN_ARGUMENTS = Object.freeze([
  "plan",
  "tools/region-import/germany/release.annual-2026.5.config.json",
  "tools/region-import/germany/source-catalog.json",
  "tools/guards/quellenregister.json",
]);
const PRODUCER_IDS = Object.freeze(["bundle", "entrypoint", "executionPins", "implementation"]);
const MAX_BINARY_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 4 * 1024 * 1024;
const MAX_SPEC_BYTES = 1024 * 1024;
const MAX_PRODUCER_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_VENDOR_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_TOOLCHAIN_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_TREE_ENTRIES = 100_000;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_WINDOWS_ANCHOR_DIAGNOSTIC_BYTES = 512;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const PORTABLE_FILE = /^(?![A-Za-z]:)(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
const WINDOWS_RESERVED_SEGMENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const RELEASE_ID = /^infra-deutschland-20\d{2}\.[1-9]\d*$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const TARGET = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+$/;
const EXPECTED_BUILD_COMMAND = Object.freeze([
  "cargo",
  "--config",
  "$PINNED_CARGO_CONFIG",
  "build",
  "--manifest-path",
  "$PINNED_CARGO_MANIFEST",
  "--locked",
  "--offline",
  "--release",
  "-p",
  "zugfolge-infra",
  "--bin",
  "zugfolge-infra-release",
]);
export const WINDOWS_BUILD_ANCHOR_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public sealed class ZugfolgeNtCreateException : InvalidOperationException {
  public int Status { get; private set; }
  internal ZugfolgeNtCreateException(int status)
    : base("NtCreateFile ist fehlgeschlagen: 0x" + status.ToString("x8")) { Status = status; }
}
public sealed class ZugfolgeEphemeralAccount : IDisposable {
  private const uint ERROR_INVALID_PARAMETER = 87u;
  private const uint NERR_USER_NOT_FOUND = 2221u;
  private const uint USER_PRIV_USER = 1u;
  private const uint UF_SCRIPT = 0x00000001u;
  private const uint UF_NORMAL_ACCOUNT = 0x00000200u;
  [StructLayout(LayoutKind.Sequential)]
  private struct TOKEN_ELEVATION { public uint TokenIsElevated; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct USER_INFO_1 {
    [MarshalAs(UnmanagedType.LPWStr)] public string Name;
    [MarshalAs(UnmanagedType.LPWStr)] public string Password;
    public uint PasswordAge;
    public uint Privilege;
    [MarshalAs(UnmanagedType.LPWStr)] public string HomeDirectory;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public uint Flags;
    [MarshalAs(UnmanagedType.LPWStr)] public string ScriptPath;
  }
  [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetTokenInformation(IntPtr token, int informationClass,
    out TOKEN_ELEVATION information, uint informationBytes, out uint returnedBytes);
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = false)]
  private static extern uint NetUserAdd(string server, uint level, ref USER_INFO_1 user, out uint parameterError);
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = false)]
  private static extern uint NetUserDel(string server, string user);
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = false)]
  private static extern uint NetUserGetInfo(string server, string user, uint level, out IntPtr buffer);
  [DllImport("netapi32.dll", ExactSpelling = true, SetLastError = false)]
  private static extern uint NetApiBufferFree(IntPtr buffer);
  public string Username { get; private set; }
  public string Domain { get; private set; }
  public string Password { get; private set; }
  public string Sid { get; private set; }
  private bool active;
  private ZugfolgeEphemeralAccount() {}
  public static bool CurrentProcessHasElevatedAdministratorToken() {
    using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
      TOKEN_ELEVATION elevation;
      uint returnedBytes;
      if (!GetTokenInformation(identity.Token, 20, out elevation,
          (uint)Marshal.SizeOf(typeof(TOKEN_ELEVATION)), out returnedBytes)
          || returnedBytes != (uint)Marshal.SizeOf(typeof(TOKEN_ELEVATION))) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation(TokenElevation)");
      }
      return elevation.TokenIsElevated != 0
        && new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }
  }
  public static ZugfolgeEphemeralAccount Create() {
    ZugfolgeEphemeralAccount account = new ZugfolgeEphemeralAccount();
    account.Username = "zfrb" + Guid.NewGuid().ToString("N").Substring(0, 12);
    account.Domain = Environment.MachineName;
    byte[] random = new byte[32]; using (RandomNumberGenerator generator = RandomNumberGenerator.Create()) generator.GetBytes(random);
    account.Password = "Zf!1" + Convert.ToBase64String(random).Replace("/", "x").Replace("+", "y");
    // NetUserAdd level 1 requires USER_PRIV_USER and UF_SCRIPT.  Bind exactly
    // one documented account type; the one-shot lifetime makes persistent
    // password-control flags unnecessary and avoids their additional access
    // requirements.
    USER_INFO_1 user = new USER_INFO_1 {
      Name = account.Username, Password = account.Password, PasswordAge = 0, Privilege = USER_PRIV_USER,
      HomeDirectory = null, Comment = null, Flags = UF_SCRIPT | UF_NORMAL_ACCOUNT, ScriptPath = null,
    };
    uint parameterError; uint result = NetUserAdd(null, 1, ref user, out parameterError);
    if (result != 0) {
      string diagnostic = "ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_ADD status="
        + result.ToString(System.Globalization.CultureInfo.InvariantCulture);
      if (result == ERROR_INVALID_PARAMETER) diagnostic += " parameter="
        + parameterError.ToString(System.Globalization.CultureInfo.InvariantCulture);
      throw new InvalidOperationException(diagnostic);
    }
    account.active = true;
    try {
      account.Sid = ((SecurityIdentifier)new NTAccount(account.Domain, account.Username).Translate(typeof(SecurityIdentifier))).Value;
      return account;
    } catch { account.Dispose(); throw; }
  }
  public void Dispose() {
    if (!active) return;
    uint result = NetUserDel(null, Username);
    if (result != 0 && result != NERR_USER_NOT_FOUND) throw new InvalidOperationException(
      "ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_DELETE status="
      + result.ToString(System.Globalization.CultureInfo.InvariantCulture));
    IntPtr buffer = IntPtr.Zero;
    uint lookup = NetUserGetInfo(null, Username, 0, out buffer);
    try {
      if (lookup != NERR_USER_NOT_FOUND) throw new InvalidOperationException(
        "ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_DELETE_VERIFY status="
        + lookup.ToString(System.Globalization.CultureInfo.InvariantCulture));
    } finally {
      if (buffer != IntPtr.Zero) NetApiBufferFree(buffer);
    }
    active = false; Password = null;
  }
}
public sealed class ZugfolgeProtectedSecurityDescriptor : IDisposable {
  internal IntPtr Pointer { get; private set; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
    string securityDescriptor, uint revision, out IntPtr descriptor, out uint descriptorBytes);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);
  private ZugfolgeProtectedSecurityDescriptor(string sddl) {
    uint bytes;
    IntPtr descriptor;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out bytes)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "ConvertStringSecurityDescriptorToSecurityDescriptor");
    }
    Pointer = descriptor;
  }
  public static ZugfolgeProtectedSecurityDescriptor ReadExecute(string currentSid, string buildSid) {
    if (String.IsNullOrEmpty(currentSid) || String.IsNullOrEmpty(buildSid)) throw new ArgumentException("Current/Build SID fehlt.");
    const uint denied = 0x000d0156u;
    string sddl = "D:P(D;;0x" + denied.ToString("x8") + ";;;" + currentSid + ")"
      + "(D;;0x" + denied.ToString("x8") + ";;;S-1-3-4)"
      + "(A;;0x001200a9;;;" + currentSid + ")"
      + "(A;;0x001200a9;;;" + buildSid + ")"
      + "(A;;FA;;;SY)(A;;FA;;;BA)";
    return new ZugfolgeProtectedSecurityDescriptor(sddl);
  }
  public static ZugfolgeProtectedSecurityDescriptor IsolatedWritable(string currentSid, string buildSid) {
    if (String.IsNullOrEmpty(currentSid) || String.IsNullOrEmpty(buildSid)) throw new ArgumentException("Current/Build SID fehlt.");
    const uint denied = 0x000d0156u;
    string sddl = "D:P(D;OICI;0x" + denied.ToString("x8") + ";;;" + currentSid + ")"
      // OWNER_RIGHTS is intentionally root-only.  The Anchor creates the root,
      // so this removes the creator-owner WRITE_DAC escape from the runner
      // account.  Build-account-owned descendants must not inherit this deny,
      // otherwise Cargo could not update files it creates itself.
      + "(D;;0x" + denied.ToString("x8") + ";;;S-1-3-4)"
      + "(A;OICI;0x001200a9;;;" + currentSid + ")"
      + "(A;OICI;FA;;;" + buildSid + ")"
      + "(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
    return new ZugfolgeProtectedSecurityDescriptor(sddl);
  }
  public static ZugfolgeProtectedSecurityDescriptor ParentWritable(string currentSid) {
    if (String.IsNullOrEmpty(currentSid)) throw new ArgumentException("Current SID fehlt.");
    return new ZugfolgeProtectedSecurityDescriptor("D:P(A;OICI;FA;;;" + currentSid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
  }
  public void Dispose() {
    IntPtr pointer = Pointer; Pointer = IntPtr.Zero;
    if (pointer != IntPtr.Zero) LocalFree(pointer);
  }
}
public sealed class ZugfolgeHeldPublication : IDisposable {
  private readonly object gate = new object();
  private FileStream stream;
  private int state;
  public long Bytes { get; private set; }
  public string Sha256 { get; private set; }
  public string Identity { get; private set; }
  internal ZugfolgeHeldPublication(FileStream value, long bytes, string sha256, string identity) {
    stream = value; Bytes = bytes; Sha256 = sha256; Identity = identity; state = 0;
  }
  public void Commit() {
    lock (gate) {
      if (state == 1 || state == 3) return;
      if (state != 0) throw new InvalidOperationException("Publikation wurde bereits zurueckgerollt.");
      state = 1;
    }
  }
  public void Rollback() {
    lock (gate) {
      if (state == 2) return;
      if (state == 1) throw new InvalidOperationException("Committed Publikation darf nicht zurueckgerollt werden.");
      Exception dispositionError = null;
      try { ZugfolgeRelativeFs.MarkRegularFileDeletePending(stream.SafeFileHandle); }
      catch (Exception error) { dispositionError = error; }
      Exception closeError = null;
      try { stream.Dispose(); } catch (Exception error) { closeError = error; }
      state = 2;
      if (dispositionError != null && closeError != null) throw new AggregateException("Handle-relativer Publikationsrollback und Close sind fehlgeschlagen.", dispositionError, closeError);
      if (dispositionError != null) throw dispositionError;
      if (closeError != null) throw closeError;
    }
  }
  public void Dispose() {
    lock (gate) {
      if (state == 1) { stream.Dispose(); state = 3; return; }
      if (state != 0) return;
    }
    Rollback();
  }
}
public static class ZugfolgeRelativeFs {
  [StructLayout(LayoutKind.Sequential)]
  private struct UNICODE_STRING {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct OBJECT_ATTRIBUTES {
    public int Length;
    public IntPtr RootDirectory;
    public IntPtr ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor;
    public IntPtr SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IO_STATUS_BLOCK {
    public IntPtr Status;
    public UIntPtr Information;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(
    string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle handle, int informationClass, out FILE_ATTRIBUTE_TAG_INFO info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(
    SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(
    out SafeFileHandle handle, uint access, ref OBJECT_ATTRIBUTES attributes,
    out IO_STATUS_BLOCK status, IntPtr allocationSize, uint fileAttributes,
    uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryDirectoryFile(
    SafeFileHandle handle, IntPtr eventHandle, IntPtr apcRoutine, IntPtr apcContext,
    out IO_STATUS_BLOCK status, IntPtr information, uint length, int informationClass,
    [MarshalAs(UnmanagedType.U1)] bool returnSingleEntry, IntPtr fileName,
    [MarshalAs(UnmanagedType.U1)] bool restartScan);
  [DllImport("ntdll.dll")]
  private static extern int NtSetInformationFile(
    SafeFileHandle handle, out IO_STATUS_BLOCK status, IntPtr information, uint length, int informationClass);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
    string securityDescriptor, uint revision, out IntPtr descriptor, out uint descriptorBytes);
  [DllImport("advapi32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetSecurityDescriptorDacl(
    IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint SetSecurityInfo(
    IntPtr handle, int objectType, uint securityInformation,
    IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);

  public static SafeFileHandle OpenPlainDirectory(string path) {
    SafeFileHandle handle = CreateFile(path, 0x001200a1, 0x1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    FILE_ATTRIBUTE_TAG_INFO info;
    if (!GetFileInformationByHandleEx(handle, 9, out info, (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO)))) {
      int code = Marshal.GetLastWin32Error(); handle.Dispose(); throw new System.ComponentModel.Win32Exception(code);
    }
    if ((info.FileAttributes & 0x10) == 0 || (info.FileAttributes & 0x400) != 0) {
      handle.Dispose(); throw new InvalidOperationException("Directory-Handle ist kein reparsefreies Verzeichnis.");
    }
    return handle;
  }

  private static void RequirePlainType(SafeFileHandle handle, bool directory) {
    FILE_ATTRIBUTE_TAG_INFO info;
    if (!GetFileInformationByHandleEx(handle, 9, out info, (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO)))) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    bool actualDirectory = (info.FileAttributes & 0x10) != 0;
    if (actualDirectory != directory || (info.FileAttributes & 0x400) != 0) {
      throw new InvalidOperationException("Handle besitzt falschen Typ oder ist ein Reparse-Point.");
    }
  }

  private static SafeFileHandle Relative(SafeFileHandle parent, string leaf, bool directory, bool create, uint accessOverride, ZugfolgeProtectedSecurityDescriptor securityDescriptor) {
    if (parent == null || parent.IsInvalid || String.IsNullOrEmpty(leaf) || leaf == "." || leaf == ".." || leaf.IndexOfAny(new [] {'\\', '/'}) >= 0) {
      throw new ArgumentException("Ungueltiger relativer NT-Dateiname.");
    }
    IntPtr text = Marshal.StringToHGlobalUni(leaf);
    IntPtr unicodePointer = IntPtr.Zero;
    try {
      UNICODE_STRING unicode = new UNICODE_STRING {
        Length = checked((ushort)(leaf.Length * 2)),
        MaximumLength = checked((ushort)(leaf.Length * 2)),
        Buffer = text,
      };
      unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      Marshal.StructureToPtr(unicode, unicodePointer, false);
      OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES {
        Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
        RootDirectory = parent.DangerousGetHandle(),
        ObjectName = unicodePointer,
        Attributes = 0x40,
        SecurityDescriptor = create && securityDescriptor != null ? securityDescriptor.Pointer : IntPtr.Zero,
        SecurityQualityOfService = IntPtr.Zero,
      };
      IO_STATUS_BLOCK status;
      uint access = accessOverride != 0 ? accessOverride : (directory ? 0x001200a1u : (create ? 0x00160183u : 0x00120081u));
      uint options = (directory ? 0x1u : 0x40u) | 0x20u | 0x00200000u;
      SafeFileHandle result;
      int ntstatus = NtCreateFile(out result, access, ref attributes, out status, IntPtr.Zero, 0x80, 0x1, create ? 0x2u : 0x1u, options, IntPtr.Zero, 0);
      if (ntstatus < 0 || result == null || result.IsInvalid) {
        if (result != null) result.Dispose();
        throw new ZugfolgeNtCreateException(ntstatus);
      }
      RequirePlainType(result, directory);
      return result;
    } finally {
      if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
      Marshal.FreeHGlobal(text);
    }
  }

  public static SafeFileHandle CreateDirectory(SafeFileHandle parent, string leaf) {
    return Relative(parent, leaf, true, true, 0, null);
  }
  public static SafeFileHandle CreateProtectedDirectory(SafeFileHandle parent, string leaf, ZugfolgeProtectedSecurityDescriptor securityDescriptor) {
    if (securityDescriptor == null || securityDescriptor.Pointer == IntPtr.Zero) throw new ArgumentException("Protected Security Descriptor fehlt.");
    return Relative(parent, leaf, true, true, 0x001f01ffu, securityDescriptor);
  }
  public static SafeFileHandle CreateRegularFile(SafeFileHandle parent, string leaf) {
    return Relative(parent, leaf, false, true, 0, null);
  }
  public static SafeFileHandle CreateProtectedRegularFile(SafeFileHandle parent, string leaf, ZugfolgeProtectedSecurityDescriptor securityDescriptor) {
    if (securityDescriptor == null || securityDescriptor.Pointer == IntPtr.Zero) throw new ArgumentException("Protected Security Descriptor fehlt.");
    return Relative(parent, leaf, false, true, 0x001f01ffu, securityDescriptor);
  }
  public static SafeFileHandle OpenDirectory(SafeFileHandle parent, string leaf) {
    return Relative(parent, leaf, true, false, 0, null);
  }
  public static SafeFileHandle OpenRegularFile(SafeFileHandle parent, string leaf) {
    return Relative(parent, leaf, false, false, 0, null);
  }
  public static void MarkRegularFileDeletePending(SafeFileHandle handle) {
    if (handle == null || handle.IsInvalid) throw new ArgumentException("Delete-Handle ist ungueltig.");
    RequirePlainType(handle, false);
    IntPtr disposition = Marshal.AllocHGlobal(1);
    try {
      Marshal.WriteByte(disposition, 1);
      IO_STATUS_BLOCK status;
      int ntstatus = NtSetInformationFile(handle, out status, disposition, 1, 13);
      if (ntstatus < 0) throw new InvalidOperationException("NtSetInformationFile(FileDispositionInformation) ist fehlgeschlagen: 0x" + ntstatus.ToString("x8"));
    } finally { Marshal.FreeHGlobal(disposition); }
  }
  public static ZugfolgeHeldPublication PublishHeldCreateNew(Stream source, SafeFileHandle targetParent, string leaf,
      long expectedBytes, string expectedSha256, ZugfolgeProtectedSecurityDescriptor finalDescriptor) {
    if (source == null || !source.CanRead || !source.CanSeek || targetParent == null || targetParent.IsInvalid
        || expectedBytes <= 0 || expectedSha256 == null || expectedSha256.Length != 64
        || finalDescriptor == null || finalDescriptor.Pointer == IntPtr.Zero) {
      throw new ArgumentException("Held-Publication-Vertrag ist ungueltig.");
    }
    foreach (char character in expectedSha256) {
      if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) {
        throw new ArgumentException("Held-Publication-SHA-256 ist ungueltig.");
      }
    }
    source.Position = 0;
    SafeFileHandle fileHandle = CreateProtectedRegularFile(targetParent, leaf, finalDescriptor);
    FileStream output = new FileStream(fileHandle, FileAccess.ReadWrite, 1048576, false);
    SHA256 hash = SHA256.Create();
    try {
      byte[] buffer = new byte[1048576];
      long remaining = expectedBytes;
      while (remaining > 0) {
        int count = (int)Math.Min((long)buffer.Length, remaining);
        int read = source.Read(buffer, 0, count);
        if (read <= 0) throw new InvalidOperationException("Held-Publication-Quelle endet vor der erwarteten Bytezahl.");
        output.Write(buffer, 0, read);
        hash.TransformBlock(buffer, 0, read, null, 0);
        remaining -= read;
      }
      if (source.ReadByte() != -1) throw new InvalidOperationException("Held-Publication-Quelle besitzt Restdaten.");
      hash.TransformFinalBlock(new byte[0], 0, 0);
      string actual = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
      if (output.Length != expectedBytes || actual != expectedSha256) throw new InvalidOperationException("Held-Publication driftet von Bytezahl/SHA-256.");
      output.Flush(true);
      string identity = Identity(output.SafeFileHandle);
      source.Position = 0;
      return new ZugfolgeHeldPublication(output, expectedBytes, actual, identity);
    } catch (Exception primary) {
      Exception rollback = null;
      try { MarkRegularFileDeletePending(output.SafeFileHandle); } catch (Exception error) { rollback = error; }
      try { output.Dispose(); } catch (Exception error) { rollback = rollback == null ? error : new AggregateException(rollback, error); }
      if (rollback != null) throw new AggregateException("Held-Publication und handle-relativer Rollback sind fehlgeschlagen.", primary, rollback);
      throw;
    } finally {
      source.Position = 0;
      hash.Dispose();
    }
  }
  public static void FreezeReadExecute(SafeFileHandle handle, string currentSid) {
    if (handle == null || handle.IsInvalid || String.IsNullOrEmpty(currentSid)) throw new ArgumentException("Freeze-Handle/SID ist ungueltig.");
    const uint denied = 0x000d0156u;
    string sddl = "D:P(D;;0x" + denied.ToString("x8") + ";;;" + currentSid + ")"
      + "(D;;0x" + denied.ToString("x8") + ";;;S-1-3-4)"
      + "(A;;0x001200a9;;;" + currentSid + ")"
      + "(A;;FA;;;SY)(A;;FA;;;BA)";
    IntPtr descriptor = IntPtr.Zero;
    try {
      uint descriptorBytes;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out descriptorBytes)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "ConvertStringSecurityDescriptorToSecurityDescriptor");
      }
      bool present; bool defaulted; IntPtr dacl;
      if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present || dacl == IntPtr.Zero) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetSecurityDescriptorDacl");
      }
      uint result = SetSecurityInfo(handle.DangerousGetHandle(), 1, 0x80000004u, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      if (result != 0) throw new System.ComponentModel.Win32Exception(unchecked((int)result), "SetSecurityInfo(protected DACL)");
    } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
  }
  private static void RequireDenied(int status, string operation) {
    if (status == unchecked((int)0xc0000022)) return;
    if (status >= 0) throw new InvalidOperationException(operation + " war trotz geschuetzter DACL moeglich.");
    throw new InvalidOperationException(operation + " scheiterte nicht mit STATUS_ACCESS_DENIED, sondern 0x" + status.ToString("x8") + ".");
  }
  private static int ProbeRelative(SafeFileHandle parent, string leaf, bool directory, bool create, uint access) {
    SafeFileHandle result = null;
    try {
      result = Relative(parent, leaf, directory, create, access, null);
      return 0;
    } catch (InvalidOperationException error) {
      const string marker = "0x";
      int index = error.Message.LastIndexOf(marker, StringComparison.Ordinal);
      int status;
      if (index >= 0 && Int32.TryParse(error.Message.Substring(index + marker.Length), System.Globalization.NumberStyles.HexNumber, null, out status)) return status;
      throw;
    } finally { if (result != null) result.Dispose(); }
  }
  public static void AssertFrozenDirectoryEntry(SafeFileHandle parent, string leaf) {
    using (SafeFileHandle directory = Relative(parent, leaf, true, false, 0x00120081u, null)) {
      RequireDenied(ProbeRelative(directory, ".zugfolge-freeze-file-probe", false, true, 0x00160183u), "CreateFile in Inputverzeichnis");
      RequireDenied(ProbeRelative(directory, ".zugfolge-freeze-directory-probe", true, true, 0x00160081u), "CreateDirectory in Inputverzeichnis");
    }
  }
  public static void AssertFrozenEntry(SafeFileHandle parent, string leaf, bool directory) {
    RequireDenied(ProbeRelative(parent, leaf, directory, false, 0x00040000u), "WRITE_DAC-Reopen fuer Inputeintrag " + leaf);
    RequireDenied(ProbeRelative(parent, leaf, directory, false, 0x00010000u), "DELETE-/Rename-Reopen fuer Inputeintrag " + leaf);
    RequireDenied(ProbeRelative(parent, leaf, directory, false, 0x00000002u), "WRITE_DATA-/ADD_FILE-Reopen fuer Inputeintrag " + leaf);
    RequireDenied(ProbeRelative(parent, leaf, directory, false, 0x00000004u), "APPEND_DATA-/ADD_SUBDIRECTORY-Reopen fuer Inputeintrag " + leaf);
  }
  public static string[] EnumerateNames(SafeFileHandle directory) {
    List<string> names = new List<string>();
    IntPtr buffer = Marshal.AllocHGlobal(65536);
    try {
      bool restart = true;
      while (true) {
        IO_STATUS_BLOCK status;
        int result = NtQueryDirectoryFile(directory, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out status, buffer, 65536, 12, false, IntPtr.Zero, restart);
        restart = false;
        if (result == unchecked((int)0x80000006)) break;
        if (result < 0) throw new InvalidOperationException("NtQueryDirectoryFile ist fehlgeschlagen: 0x" + result.ToString("x8"));
        int offset = 0;
        while (true) {
          int next = Marshal.ReadInt32(buffer, offset);
          int nameBytes = Marshal.ReadInt32(buffer, offset + 8);
          string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 12), nameBytes / 2);
          if (name != "." && name != "..") names.Add(name);
          if (next == 0) break;
          offset += next;
        }
      }
    } finally { Marshal.FreeHGlobal(buffer); }
    names.Sort(StringComparer.Ordinal);
    return names.ToArray();
  }
  public static string Identity(SafeFileHandle handle) {
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(handle, out info)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    ulong fileIndex = ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow;
    return info.VolumeSerialNumber.ToString() + ":" + fileIndex.ToString();
  }
  private static string Quote(string value) {
    StringBuilder result = new StringBuilder(); result.Append('"');
    int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(character);
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  public static string QuoteArguments(string[] arguments) {
    StringBuilder result = new StringBuilder();
    for (int index = 0; index < arguments.Length; index++) {
      if (index > 0) result.Append(' ');
      result.Append(Quote(arguments[index]));
    }
    return result.ToString();
  }
}

public sealed class ZugfolgeFileIdentityProof {
  public string Dev { get; private set; }
  public string Ino { get; private set; }
  internal ZugfolgeFileIdentityProof(string value) {
    string[] parts = value.Split(':');
    if (parts.Length != 2) throw new InvalidOperationException("File-ID ist ungueltig.");
    Dev = parts[0]; Ino = parts[1];
  }
}
public sealed class ZugfolgePublicationProof {
  public long Bytes { get; private set; }
  public string File { get; private set; }
  public ZugfolgeFileIdentityProof Identity { get; private set; }
  public string Sha256 { get; private set; }
  internal ZugfolgePublicationProof(string file, ZugfolgeHeldPublication publication) {
    File = file; Bytes = publication.Bytes; Sha256 = publication.Sha256;
    Identity = new ZugfolgeFileIdentityProof(publication.Identity);
  }
  internal ZugfolgePublicationProof(string file, long bytes, string sha256, string identity) {
    File = file; Bytes = bytes; Sha256 = sha256;
    Identity = new ZugfolgeFileIdentityProof(identity);
  }
}
public sealed class ZugfolgeAnnualArtifactPublicationPair : IDisposable {
  private readonly object gate = new object();
  private readonly ZugfolgeHeldPublication artifactPublication;
  private readonly ZugfolgeHeldPublication completionPublication;
  private readonly List<IDisposable> held;
  private int state;
  public ZugfolgePublicationProof Artifact { get; private set; }
  public ZugfolgePublicationProof Completion { get; private set; }
  internal ZugfolgeAnnualArtifactPublicationPair(string artifactFile, ZugfolgeHeldPublication artifact,
      string completionFile, ZugfolgeHeldPublication completion, List<IDisposable> resources) {
    artifactPublication = artifact; completionPublication = completion; held = resources; state = 0;
    Artifact = new ZugfolgePublicationProof(artifactFile, artifact);
    Completion = new ZugfolgePublicationProof(completionFile, completion);
  }
  internal ZugfolgeAnnualArtifactPublicationPair(ZugfolgePublicationProof artifactProof,
      ZugfolgeHeldPublication artifact, ZugfolgePublicationProof completionProof,
      ZugfolgeHeldPublication completion, List<IDisposable> resources) {
    Artifact = artifactProof; Completion = completionProof;
    artifactPublication = artifact; completionPublication = completion; held = resources; state = 0;
  }
  private Exception CloseHeld() {
    List<Exception> errors = new List<Exception>();
    for (int index = held.Count - 1; index >= 0; index--) {
      try { held[index].Dispose(); } catch (Exception error) { errors.Add(error); }
    }
    held.Clear();
    return errors.Count == 0 ? null : new AggregateException("Annual-Publisher konnte gehaltene Inputs/Parents nicht schliessen.", errors);
  }
  public void Commit() {
    lock (gate) {
      if (state == 1) return;
      if (state != 0) throw new InvalidOperationException("Annual-Publikationspaar wurde bereits zurueckgerollt.");
      if (artifactPublication != null) artifactPublication.Commit();
      if (completionPublication != null) completionPublication.Commit();
      Exception outputClose = null;
      try {
        if (completionPublication != null) completionPublication.Dispose();
        if (artifactPublication != null) artifactPublication.Dispose();
      }
      catch (Exception error) { outputClose = error; }
      Exception heldClose = CloseHeld();
      state = 1;
      if (outputClose != null && heldClose != null) throw new AggregateException("Annual-Publikationspaar-Commit konnte Handles nicht schliessen.", outputClose, heldClose);
      if (outputClose != null) throw outputClose;
      if (heldClose != null) throw heldClose;
    }
  }
  public void Rollback() {
    lock (gate) {
      if (state == 2) return;
      if (state == 1) throw new InvalidOperationException("Committed Annual-Publikationspaar darf nicht zurueckgerollt werden.");
      List<Exception> errors = new List<Exception>();
      if (completionPublication != null) try { completionPublication.Rollback(); } catch (Exception error) { errors.Add(error); }
      if (artifactPublication != null) try { artifactPublication.Rollback(); } catch (Exception error) { errors.Add(error); }
      Exception heldClose = CloseHeld(); if (heldClose != null) errors.Add(heldClose);
      state = 2;
      if (errors.Count > 0) throw new AggregateException("Annual-Publikationspaar-Rollback ist fehlgeschlagen.", errors);
    }
  }
  public void Dispose() {
    lock (gate) { if (state != 0) return; }
    Rollback();
  }
}
public sealed class ZugfolgeAnnualArtifactVerificationPair : IDisposable {
  private readonly object gate = new object();
  private readonly Action finalRecheck;
  private readonly List<IDisposable> held;
  private int state;
  public ZugfolgePublicationProof Artifact { get; private set; }
  public ZugfolgePublicationProof Completion { get; private set; }
  internal ZugfolgeAnnualArtifactVerificationPair(ZugfolgePublicationProof artifact,
      ZugfolgePublicationProof completion, Action recheck, List<IDisposable> resources) {
    Artifact = artifact; Completion = completion; finalRecheck = recheck; held = resources; state = 0;
  }
  private Exception CloseHeld() {
    List<Exception> errors = new List<Exception>();
    for (int index = held.Count - 1; index >= 0; index--) {
      try { held[index].Dispose(); } catch (Exception error) { errors.Add(error); }
    }
    held.Clear();
    return errors.Count == 0 ? null : new AggregateException("Annual-Verifier konnte gehaltene Outputs/Parents nicht schliessen.", errors);
  }
  public void Complete() {
    lock (gate) {
      if (state == 1) return;
      if (state != 0) throw new InvalidOperationException("Annual-Verifikationspaar besitzt einen ungueltigen Zustand.");
      Exception verificationError = null;
      try { finalRecheck(); } catch (Exception error) { verificationError = error; }
      Exception closeError = CloseHeld();
      state = 1;
      if (verificationError != null && closeError != null) throw new AggregateException("Annual-Verifikationspaar-Finalcheck und Handle-Close sind fehlgeschlagen.", verificationError, closeError);
      if (verificationError != null) throw verificationError;
      if (closeError != null) throw closeError;
    }
  }
  public void Dispose() { Complete(); }
}
public static class ZugfolgeAnnualArtifactPublisher {
  private const string COMPLETION_SCHEMA = "zugfolge-germany-annual-create-new-artifact-completion/v1";
  private const string COMPLETION_SUFFIX = ".zugfolge-complete.json";
  private static string FullDirectory(string value) {
    return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
  }
  private static SafeFileHandle OpenWorkspaceRoot(string workspaceRoot, List<IDisposable> held) {
    string full = FullDirectory(workspaceRoot);
    string volume = Path.GetPathRoot(full);
    SafeFileHandle current = ZugfolgeRelativeFs.OpenPlainDirectory(volume); held.Add(current);
    string remaining = full.Substring(volume.Length).Trim(Path.DirectorySeparatorChar);
    if (remaining.Length > 0) {
      foreach (string segment in remaining.Split(Path.DirectorySeparatorChar)) {
        current = ZugfolgeRelativeFs.OpenDirectory(current, segment); held.Add(current);
      }
    }
    return current;
  }
  private static string[] PortableSegments(string relativeFile) {
    if (String.IsNullOrEmpty(relativeFile) || Path.IsPathRooted(relativeFile) || relativeFile.IndexOf('\\') >= 0) {
      throw new ArgumentException("Annual-Publisher-Dateipfad ist nicht portabel relativ.");
    }
    string[] segments = relativeFile.Split('/');
    foreach (string segment in segments) {
      bool charactersValid = segment.Length > 0 && segment.Length <= 128;
      foreach (char character in segment) {
        charactersValid = charactersValid && ((character >= 'A' && character <= 'Z')
          || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')
          || character == '.' || character == '_' || character == '@' || character == '+' || character == '-');
      }
      string baseName = segment.Split('.')[0];
      bool reserved = baseName.Equals("CON", StringComparison.OrdinalIgnoreCase)
        || baseName.Equals("PRN", StringComparison.OrdinalIgnoreCase)
        || baseName.Equals("AUX", StringComparison.OrdinalIgnoreCase)
        || baseName.Equals("NUL", StringComparison.OrdinalIgnoreCase)
        || (baseName.Length == 4 && (baseName.StartsWith("COM", StringComparison.OrdinalIgnoreCase)
          || baseName.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) && baseName[3] >= '1' && baseName[3] <= '9');
      if (!charactersValid || segment == "." || segment == ".." || segment.EndsWith(".") || reserved) {
        throw new ArgumentException("Annual-Publisher-Dateipfad besitzt ein ungueltiges Segment.");
      }
    }
    return segments;
  }
  private static SafeFileHandle OpenRelativeParent(SafeFileHandle workspace, string[] segments, List<IDisposable> held) {
    SafeFileHandle current = workspace;
    for (int index = 0; index < segments.Length - 1; index++) {
      current = ZugfolgeRelativeFs.OpenDirectory(current, segments[index]); held.Add(current);
    }
    return current;
  }
  private static FileStream OpenHeldWorkspaceFile(string workspaceRoot, SafeFileHandle workspace, string path,
      List<IDisposable> held) {
    string fullRoot = FullDirectory(workspaceRoot);
    string full = Path.GetFullPath(path);
    string prefix = fullRoot + Path.DirectorySeparatorChar;
    if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Annual-Publisher-Stagingdatei verlaesst workspaceRoot.");
    string relative = full.Substring(prefix.Length).Replace(Path.DirectorySeparatorChar, '/');
    string[] segments = PortableSegments(relative);
    SafeFileHandle parent = OpenRelativeParent(workspace, segments, held);
    SafeFileHandle file = ZugfolgeRelativeFs.OpenRegularFile(parent, segments[segments.Length - 1]);
    FileStream stream = new FileStream(file, FileAccess.Read, 1048576, false); held.Add(stream);
    return stream;
  }
  private static byte[] ReadAndVerify(FileStream stream, long expectedBytes, string expectedSha256, bool retainBytes) {
    if (expectedBytes <= 0 || expectedSha256 == null || expectedSha256.Length != 64 || stream.Length != expectedBytes) {
      throw new InvalidOperationException("Annual-Publisher-Stagingproof ist ungueltig.");
    }
    stream.Position = 0;
    SHA256 hash = SHA256.Create();
    MemoryStream copy = retainBytes ? new MemoryStream() : null;
    try {
      byte[] buffer = new byte[1048576]; long remaining = expectedBytes;
      while (remaining > 0) {
        int count = (int)Math.Min((long)buffer.Length, remaining);
        int read = stream.Read(buffer, 0, count);
        if (read <= 0) throw new InvalidOperationException("Annual-Publisher-Stagingdatei endet vorzeitig.");
        hash.TransformBlock(buffer, 0, read, null, 0); if (copy != null) copy.Write(buffer, 0, read); remaining -= read;
      }
      if (stream.ReadByte() != -1) throw new InvalidOperationException("Annual-Publisher-Stagingdatei besitzt Restdaten.");
      hash.TransformFinalBlock(new byte[0], 0, 0);
      string actual = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
      if (actual != expectedSha256) throw new InvalidOperationException("Annual-Publisher-Staging-SHA-256 driftet.");
      return copy == null ? null : copy.ToArray();
    } finally { stream.Position = 0; hash.Dispose(); if (copy != null) copy.Dispose(); }
  }
  private static string JsonString(string value) {
    StringBuilder result = new StringBuilder(); result.Append('"');
    foreach (char character in value) {
      if (character == '"' || character == '\\') result.Append('\\').Append(character);
      else if (character == '\b') result.Append("\\b"); else if (character == '\f') result.Append("\\f");
      else if (character == '\n') result.Append("\\n"); else if (character == '\r') result.Append("\\r");
      else if (character == '\t') result.Append("\\t");
      else if (character < 0x20) result.Append("\\u").Append(((int)character).ToString("x4"));
      else result.Append(character);
    }
    return result.Append('"').ToString();
  }
  private static byte[] CanonicalCompletion(string artifactFile, long bytes, string sha256) {
    string json = "{\n  \"artifact\": {\n    \"bytes\": " + bytes.ToString(System.Globalization.CultureInfo.InvariantCulture)
      + ",\n    \"file\": " + JsonString(artifactFile) + ",\n    \"sha256\": \"" + sha256
      + "\"\n  },\n  \"schema\": \"" + COMPLETION_SCHEMA + "\"\n}\n";
    return Encoding.UTF8.GetBytes(json);
  }
  private static void RequireCanonicalCompletion(byte[] actual, string artifactFile, long bytes, string sha256) {
    byte[] expected = CanonicalCompletion(artifactFile, bytes, sha256);
    if (actual.Length != expected.Length) throw new InvalidOperationException("Annual-Completion ist nicht kanonisch.");
    for (int index = 0; index < actual.Length; index++) if (actual[index] != expected[index]) throw new InvalidOperationException("Annual-Completion ist nicht kanonisch.");
  }
  private const int STATUS_OBJECT_NAME_COLLISION = unchecked((int)0xc0000035);
  private static FileStream OpenHeldOutput(SafeFileHandle parent, string leaf, List<IDisposable> held) {
    SafeFileHandle handle = ZugfolgeRelativeFs.OpenRegularFile(parent, leaf);
    FileStream stream = new FileStream(handle, FileAccess.Read, 1048576, false); held.Add(stream);
    return stream;
  }
  private static ZugfolgeAnnualArtifactPublicationPair PublishPairInternal(string workspaceRoot, string stagedDataPath,
      string stagedCompletionPath, string outputRelativeFile, long expectedDataBytes, string expectedDataSha256,
      long expectedCompletionBytes, string expectedCompletionSha256, bool recoverExactExisting, Action afterArtifact) {
    List<IDisposable> held = new List<IDisposable>();
    ZugfolgeHeldPublication artifact = null; ZugfolgeHeldPublication completion = null;
    try {
      string[] artifactSegments = PortableSegments(outputRelativeFile);
      string completionFile = outputRelativeFile + COMPLETION_SUFFIX;
      string[] completionSegments = PortableSegments(completionFile);
      SafeFileHandle workspace = OpenWorkspaceRoot(workspaceRoot, held);
      FileStream dataSource = OpenHeldWorkspaceFile(workspaceRoot, workspace, stagedDataPath, held);
      FileStream completionSource = OpenHeldWorkspaceFile(workspaceRoot, workspace, stagedCompletionPath, held);
      ReadAndVerify(dataSource, expectedDataBytes, expectedDataSha256, false);
      byte[] actualCompletion = ReadAndVerify(completionSource, expectedCompletionBytes, expectedCompletionSha256, true);
      RequireCanonicalCompletion(actualCompletion, outputRelativeFile, expectedDataBytes, expectedDataSha256);
      SafeFileHandle artifactParent = OpenRelativeParent(workspace, artifactSegments, held);
      SafeFileHandle completionParent = OpenRelativeParent(workspace, completionSegments, held);
      string currentSid = WindowsIdentity.GetCurrent().User.Value;
      ZugfolgeProtectedSecurityDescriptor descriptor = ZugfolgeProtectedSecurityDescriptor.ParentWritable(currentSid); held.Add(descriptor);
      ZugfolgePublicationProof artifactProof;
      try {
        artifact = ZugfolgeRelativeFs.PublishHeldCreateNew(dataSource, artifactParent, artifactSegments[artifactSegments.Length - 1], expectedDataBytes, expectedDataSha256, descriptor);
        artifactProof = new ZugfolgePublicationProof(outputRelativeFile, artifact);
      } catch (ZugfolgeNtCreateException error) {
        if (!recoverExactExisting || error.Status != STATUS_OBJECT_NAME_COLLISION) throw;
        FileStream existing = OpenHeldOutput(artifactParent, artifactSegments[artifactSegments.Length - 1], held);
        ReadAndVerify(existing, expectedDataBytes, expectedDataSha256, false);
        artifactProof = new ZugfolgePublicationProof(outputRelativeFile, expectedDataBytes, expectedDataSha256,
          ZugfolgeRelativeFs.Identity(existing.SafeFileHandle));
      }
      if (afterArtifact != null) afterArtifact();
      ZugfolgePublicationProof completionProof;
      try {
        completion = ZugfolgeRelativeFs.PublishHeldCreateNew(completionSource, completionParent, completionSegments[completionSegments.Length - 1], expectedCompletionBytes, expectedCompletionSha256, descriptor);
        completionProof = new ZugfolgePublicationProof(completionFile, completion);
      } catch (ZugfolgeNtCreateException error) {
        if (!recoverExactExisting || error.Status != STATUS_OBJECT_NAME_COLLISION) throw;
        FileStream existing = OpenHeldOutput(completionParent, completionSegments[completionSegments.Length - 1], held);
        byte[] existingBytes = ReadAndVerify(existing, expectedCompletionBytes, expectedCompletionSha256, true);
        RequireCanonicalCompletion(existingBytes, outputRelativeFile, expectedDataBytes, expectedDataSha256);
        completionProof = new ZugfolgePublicationProof(completionFile, expectedCompletionBytes, expectedCompletionSha256,
          ZugfolgeRelativeFs.Identity(existing.SafeFileHandle));
      }
      return new ZugfolgeAnnualArtifactPublicationPair(artifactProof, artifact, completionProof, completion, held);
    } catch (Exception primary) {
      List<Exception> errors = new List<Exception>(); errors.Add(primary);
      if (completion != null) try { completion.Rollback(); } catch (Exception error) { errors.Add(error); }
      if (artifact != null) try { artifact.Rollback(); } catch (Exception error) { errors.Add(error); }
      for (int index = held.Count - 1; index >= 0; index--) try { held[index].Dispose(); } catch (Exception error) { errors.Add(error); }
      if (errors.Count == 1) throw;
      throw new AggregateException("Annual-PublishPair/Recovery und handle-relativer Rollback sind fehlgeschlagen.", errors);
    }
  }
  public static ZugfolgeAnnualArtifactPublicationPair PublishPair(string workspaceRoot, string stagedDataPath,
      string stagedCompletionPath, string outputRelativeFile, long expectedDataBytes, string expectedDataSha256,
      long expectedCompletionBytes, string expectedCompletionSha256) {
    return PublishPairInternal(workspaceRoot, stagedDataPath, stagedCompletionPath, outputRelativeFile,
      expectedDataBytes, expectedDataSha256, expectedCompletionBytes, expectedCompletionSha256, false, null);
  }
  public static ZugfolgeAnnualArtifactPublicationPair PublishOrRecoverPair(string workspaceRoot, string stagedDataPath,
      string stagedCompletionPath, string outputRelativeFile, long expectedDataBytes, string expectedDataSha256,
      long expectedCompletionBytes, string expectedCompletionSha256) {
    return PublishPairInternal(workspaceRoot, stagedDataPath, stagedCompletionPath, outputRelativeFile,
      expectedDataBytes, expectedDataSha256, expectedCompletionBytes, expectedCompletionSha256, true, null);
  }
  public static ZugfolgeAnnualArtifactPublicationPair PublishOrRecoverPairWithTestHook(string workspaceRoot,
      string stagedDataPath, string stagedCompletionPath, string outputRelativeFile, long expectedDataBytes,
      string expectedDataSha256, long expectedCompletionBytes, string expectedCompletionSha256, Action afterArtifact) {
    if (afterArtifact == null) throw new ArgumentException("Annual-Publisher-Testhook fehlt.");
    return PublishPairInternal(workspaceRoot, stagedDataPath, stagedCompletionPath, outputRelativeFile,
      expectedDataBytes, expectedDataSha256, expectedCompletionBytes, expectedCompletionSha256, true, afterArtifact);
  }
  public static ZugfolgeAnnualArtifactVerificationPair VerifyPair(string workspaceRoot, string outputRelativeFile,
      long expectedDataBytes, string expectedDataSha256, long expectedCompletionBytes, string expectedCompletionSha256) {
    List<IDisposable> held = new List<IDisposable>();
    try {
      string[] artifactSegments = PortableSegments(outputRelativeFile);
      string completionFile = outputRelativeFile + COMPLETION_SUFFIX;
      PortableSegments(completionFile);
      SafeFileHandle workspace = OpenWorkspaceRoot(workspaceRoot, held);
      string fullRoot = FullDirectory(workspaceRoot);
      FileStream artifact = OpenHeldWorkspaceFile(workspaceRoot, workspace,
        Path.Combine(fullRoot, outputRelativeFile.Replace('/', Path.DirectorySeparatorChar)), held);
      FileStream completion = OpenHeldWorkspaceFile(workspaceRoot, workspace,
        Path.Combine(fullRoot, completionFile.Replace('/', Path.DirectorySeparatorChar)), held);
      ReadAndVerify(artifact, expectedDataBytes, expectedDataSha256, false);
      byte[] completionBytes = ReadAndVerify(completion, expectedCompletionBytes, expectedCompletionSha256, true);
      RequireCanonicalCompletion(completionBytes, outputRelativeFile, expectedDataBytes, expectedDataSha256);
      ZugfolgePublicationProof artifactProof = new ZugfolgePublicationProof(outputRelativeFile, expectedDataBytes,
        expectedDataSha256, ZugfolgeRelativeFs.Identity(artifact.SafeFileHandle));
      ZugfolgePublicationProof completionProof = new ZugfolgePublicationProof(completionFile, expectedCompletionBytes,
        expectedCompletionSha256, ZugfolgeRelativeFs.Identity(completion.SafeFileHandle));
      Action recheck = delegate {
        ReadAndVerify(artifact, expectedDataBytes, expectedDataSha256, false);
        byte[] finalCompletion = ReadAndVerify(completion, expectedCompletionBytes, expectedCompletionSha256, true);
        RequireCanonicalCompletion(finalCompletion, outputRelativeFile, expectedDataBytes, expectedDataSha256);
      };
      return new ZugfolgeAnnualArtifactVerificationPair(artifactProof, completionProof, recheck, held);
    } catch (Exception primary) {
      List<Exception> errors = new List<Exception>(); errors.Add(primary);
      for (int index = held.Count - 1; index >= 0; index--) try { held[index].Dispose(); } catch (Exception error) { errors.Add(error); }
      if (errors.Count == 1) throw;
      throw new AggregateException("Annual-VerifyPair und Handle-Close sind fehlgeschlagen.", errors);
    }
  }
}

public sealed class ZugfolgeMitigatedProcessResult {
  public int ExitCode { get; private set; }
  public byte[] Stdout { get; private set; }
  public byte[] Stderr { get; private set; }
  internal ZugfolgeMitigatedProcessResult(int exitCode, byte[] stdout, byte[] stderr) {
    ExitCode = exitCode; Stdout = stdout; Stderr = stderr;
  }
}

public static class ZugfolgeMitigatedProcess {
  private const uint STARTF_USESTDHANDLES = 0x00000100;
  private const uint CREATE_SUSPENDED = 0x00000004;
  private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  private const uint CREATE_NO_WINDOW = 0x08000000;
  private const int ERROR_INVALID_HANDLE = 6;
  private const uint HANDLE_FLAG_INHERIT = 0x00000001;
  private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
  private const uint TOKEN_QUERY = 0x00000008;
  private const uint LOGON_WITHOUT_PROFILE = 0u;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const uint WAIT_OBJECT_0 = 0;
  private const uint WAIT_TIMEOUT = 258;
  private const uint WAIT_FAILED = 0xffffffff;
  private static readonly IntPtr PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY = new IntPtr(0x00020007);
  private static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
  private static readonly IntPtr PROC_THREAD_ATTRIBUTE_PARENT_PROCESS = new IntPtr(0x00020000);
  private const ulong BUILD_IMAGE_LOAD_POLICY =
    (1UL << 52) | (1UL << 56) | (1UL << 60);
  private const ulong STRICT_IMAGE_LOAD_POLICY =
    (1UL << 44) | BUILD_IMAGE_LOAD_POLICY;
  private static readonly object ActiveLock = new object();
  private static IntPtr ActiveJob = IntPtr.Zero;

  [StructLayout(LayoutKind.Sequential)]
  private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public uint dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
  }
  private sealed class OutputCounter { public long Value; }

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle,
    IntPtr targetProcess, out IntPtr targetHandle, uint desiredAccess,
    [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint options);
  [DllImport("kernelbase.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CompareObjectHandles(IntPtr first, IntPtr second);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetProcessMitigationPolicy(IntPtr process, int policy,
    out uint flags, IntPtr bytes);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr valueBytes, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  private static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateProcessWBasic(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateProcessWithLogonW(string username, string domain, string password, uint logonFlags,
    string application, StringBuilder commandLine, uint flags, IntPtr environment, string cwd,
    ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint bytes);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool QueryInformationJobObject(IntPtr job, int informationClass,
    out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint bytes, out uint returnedBytes);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CloseHandle(IntPtr handle);

  private static System.ComponentModel.Win32Exception Win32(string action) {
    return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), action);
  }
  private static string Quote(string value) {
    if (value.Length == 0) return "\"\"";
    bool needsQuotes = false;
    foreach (char character in value) if (Char.IsWhiteSpace(character) || character == '\"') { needsQuotes = true; break; }
    if (!needsQuotes) return value;
    StringBuilder result = new StringBuilder(); result.Append('\"'); int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '\"') { result.Append('\\', slashes * 2 + 1); result.Append('\"'); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(character);
    }
    result.Append('\\', slashes * 2); result.Append('\"'); return result.ToString();
  }
  private static SortedDictionary<string, string> NormalizedEnvironment(System.Collections.IDictionary environment) {
    if (environment == null) throw new ArgumentNullException("environment");
    SortedDictionary<string, string> sorted = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (System.Collections.DictionaryEntry entry in environment) {
      string key = entry.Key as string; string value = entry.Value as string;
      if (String.IsNullOrEmpty(key) || key.IndexOf('=') >= 0 || value == null || value.IndexOf('\0') >= 0)
        throw new InvalidOperationException("Windows-Kindumgebung enthaelt einen ungueltigen Eintrag.");
      sorted.Add(key, value);
    }
    return sorted;
  }
  private static IntPtr EnvironmentBlock(System.Collections.IDictionary environment) {
    SortedDictionary<string, string> sorted = NormalizedEnvironment(environment);
    StringBuilder block = new StringBuilder();
    foreach (KeyValuePair<string, string> entry in sorted) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
    if (sorted.Count == 0) block.Append('\0');
    block.Append('\0'); return Marshal.StringToHGlobalUni(block.ToString());
  }
  private static void Pipe(bool parentReads, out IntPtr child, out IntPtr parent) {
    SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = 0 };
    IntPtr read; IntPtr write;
    if (!CreatePipe(out read, out write, ref attributes, 0)) throw Win32("CreatePipe");
    child = parentReads ? write : read; parent = parentReads ? read : write;
  }
  private static IntPtr DuplicateInheritableToProcess(IntPtr process, IntPtr source, string label) {
    IntPtr remote;
    if (!DuplicateHandle(GetCurrentProcess(), source, process, out remote, 0, true, DUPLICATE_SAME_ACCESS))
      throw Win32("DuplicateHandle(anchor " + label + ")");
    return remote;
  }
  private static void AssertNotInheritable(IntPtr handle, string label) {
    uint flags;
    if (!GetHandleInformation(handle, out flags)) throw Win32("GetHandleInformation(" + label + ")");
    if ((flags & HANDLE_FLAG_INHERIT) != 0)
      throw new InvalidOperationException("Lokaler Windows-Handle ist unerwartet vererbbar: " + label);
  }
  private static void AssertAllowedHandleInherited(IntPtr process, IntPtr candidate, IntPtr expected, string label) {
    IntPtr duplicate;
    if (!DuplicateHandle(process, candidate, GetCurrentProcess(), out duplicate, 0, false, DUPLICATE_SAME_ACCESS))
      throw Win32("DuplicateHandle(inherited " + label + ")");
    try {
      if (!CompareObjectHandles(expected, duplicate))
        throw new InvalidOperationException("Windows-Kindprozess erbte nicht den freigegebenen " + label + "-Handle.");
    } finally { CloseRequired(ref duplicate, "inherited-" + label + "-verification"); }
  }
  private static void AssertSentinelNotInherited(IntPtr process, IntPtr candidate, IntPtr sentinel) {
    IntPtr duplicate;
    if (DuplicateHandle(process, candidate, GetCurrentProcess(), out duplicate, 0, false, DUPLICATE_SAME_ACCESS)) {
      bool inheritedSentinel = CompareObjectHandles(sentinel, duplicate);
      CloseRequired(ref duplicate, "sentinel-verification");
      if (inheritedSentinel) throw new InvalidOperationException("Windows-Kindprozess erbte einen nicht freigegebenen Sentinel-Handle.");
      return;
    }
    int status = Marshal.GetLastWin32Error();
    if (status != ERROR_INVALID_HANDLE)
      throw new System.ComponentModel.Win32Exception(status, "DuplicateHandle(non-inherited sentinel)");
  }
  private static string ProcessSid(IntPtr process) {
    IntPtr token = IntPtr.Zero;
    if (!OpenProcessToken(process, TOKEN_QUERY, out token)) throw Win32("OpenProcessToken(process identity)");
    try {
      using (WindowsIdentity identity = new WindowsIdentity(token)) {
        if (identity.User == null) throw new InvalidOperationException("Windows-Prozess besitzt keine pruefbare SID.");
        return identity.User.Value;
      }
    } finally { CloseRequired(ref token, "process-token"); }
  }
  private static void AssertProcessSid(IntPtr process, string expectedSid) {
    if (!String.Equals(ProcessSid(process), expectedSid, StringComparison.Ordinal))
      throw new InvalidOperationException("Windows-Prozess verwendet nicht die erwartete Identitaet.");
  }
  private static void AssertProcessInJob(IntPtr process, IntPtr job) {
    bool inJob;
    if (!IsProcessInJob(process, job, out inJob)) throw Win32("IsProcessInJob(anchor job)");
    if (!inJob) throw new InvalidOperationException("Windows-Kindprozess erbte den gehaltenen Anker-Job nicht.");
  }
  private static void RecordCleanupStatus(List<string> errors, string action, int status) {
    errors.Add(action + " status=" + unchecked((uint)status).ToString(System.Globalization.CultureInfo.InvariantCulture));
  }
  private static void CloseRequired(ref IntPtr handle, string label) {
    if (handle == IntPtr.Zero) return;
    IntPtr closing = handle;
    if (!CloseHandle(closing)) throw Win32("CloseHandle(" + label + ")");
    handle = IntPtr.Zero;
  }
  private static void CloseTracked(ref IntPtr handle, string label, List<string> errors) {
    if (handle == IntPtr.Zero) return;
    IntPtr closing = handle; handle = IntPtr.Zero;
    if (!CloseHandle(closing)) RecordCleanupStatus(errors, "CloseHandle(" + label + ")", Marshal.GetLastWin32Error());
  }
  private static void EnsureProcessTerminated(IntPtr process, string label, List<string> errors) {
    if (process == IntPtr.Zero) return;
    uint before = WaitForSingleObject(process, 0);
    if (before == WAIT_OBJECT_0) return;
    if (before == WAIT_FAILED) RecordCleanupStatus(errors, "WaitForSingleObject(" + label + ",pre)", Marshal.GetLastWin32Error());
    bool terminated = TerminateProcess(process, 95);
    int terminateStatus = terminated ? 0 : Marshal.GetLastWin32Error();
    uint wait = WaitForSingleObject(process, 5000);
    if (wait == WAIT_OBJECT_0) return;
    if (!terminated) RecordCleanupStatus(errors, "TerminateProcess(" + label + ")", terminateStatus);
    if (wait == WAIT_FAILED) RecordCleanupStatus(errors, "WaitForSingleObject(" + label + ",cleanup)", Marshal.GetLastWin32Error());
    else errors.Add("WaitForSingleObject(" + label + ",cleanup) result=" + wait.ToString(System.Globalization.CultureInfo.InvariantCulture));
  }
  private static string WaitForJobEmptyStatus(IntPtr job, int timeoutMilliseconds, string label) {
    System.Diagnostics.Stopwatch wait = System.Diagnostics.Stopwatch.StartNew();
    while (true) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
      uint returnedBytes;
      if (!QueryInformationJobObject(job, 1, out accounting,
          (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), out returnedBytes))
        return "QueryInformationJobObject(" + label + ") status="
          + unchecked((uint)Marshal.GetLastWin32Error()).ToString(System.Globalization.CultureInfo.InvariantCulture);
      if (returnedBytes != (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)))
        return "QueryInformationJobObject(" + label + ") bytes="
          + returnedBytes.ToString(System.Globalization.CultureInfo.InvariantCulture);
      if (accounting.ActiveProcesses == 0) return null;
      long remaining = timeoutMilliseconds - wait.ElapsedMilliseconds;
      if (remaining <= 0) return "QueryInformationJobObject(" + label + ") active="
        + accounting.ActiveProcesses.ToString(System.Globalization.CultureInfo.InvariantCulture);
      System.Threading.Thread.Sleep((int)Math.Min(10L, remaining));
    }
  }
  private static void AssertJobEmpty(IntPtr job, int timeoutMilliseconds, string label) {
    string failure = WaitForJobEmptyStatus(job, timeoutMilliseconds, label);
    if (failure != null) throw new InvalidOperationException("Windows-Job wurde nicht vollstaendig leer: " + failure);
  }
  private static void AssertMitigationPolicy(IntPtr process, ulong requested) {
    uint imageLoad;
    if (!GetProcessMitigationPolicy(process, 10, out imageLoad, new IntPtr(4)))
      throw Win32("GetProcessMitigationPolicy(ProcessImageLoadPolicy)");
    if ((imageLoad & 0x00000007u) != 0x00000007u)
      throw new InvalidOperationException("Windows-Kindprozess besitzt nicht die geforderte Image-Load-Mitigation.");
    if ((requested & (1UL << 44)) != 0) {
      uint signature;
      if (!GetProcessMitigationPolicy(process, 8, out signature, new IntPtr(4)))
        throw Win32("GetProcessMitigationPolicy(ProcessSignaturePolicy)");
      if ((signature & 0x00000001u) == 0)
        throw new InvalidOperationException("Windows-Kindprozess besitzt nicht die geforderte Microsoft-Signatur-Mitigation.");
    }
  }
  private static byte[] ReadBounded(Stream stream, int maximumBytes, IntPtr job, string label, OutputCounter total) {
    using (MemoryStream output = new MemoryStream()) {
      byte[] buffer = new byte[8192];
      while (true) {
        int read = stream.Read(buffer, 0, buffer.Length); if (read == 0) break;
        long combined = System.Threading.Interlocked.Add(ref total.Value, read);
        if (combined > maximumBytes) { TerminateJobObject(job, 93); throw new InvalidOperationException(label + " ueberschritt das kombinierte gepinnte Limit."); }
        output.Write(buffer, 0, read);
      }
      return output.ToArray();
    }
  }
  public static void AbortActive() {
    lock (ActiveLock) { if (ActiveJob != IntPtr.Zero) TerminateJobObject(ActiveJob, 94); }
  }
  public static ZugfolgeMitigatedProcessResult Run(string executable, string[] arguments, string cwd,
      System.Collections.IDictionary environment, byte[] stdin, int maximumBytes, int timeoutMilliseconds, Func<bool> cancelled) {
    return RunInternal(executable, arguments, cwd, environment, stdin, maximumBytes, timeoutMilliseconds, cancelled, null, BUILD_IMAGE_LOAD_POLICY);
  }
  public static ZugfolgeMitigatedProcessResult RunAs(string executable, string[] arguments, string cwd,
      System.Collections.IDictionary environment, byte[] stdin, int maximumBytes, int timeoutMilliseconds, Func<bool> cancelled, ZugfolgeEphemeralAccount account) {
    if (account == null) throw new ArgumentNullException("account");
    return RunInternal(executable, arguments, cwd, environment, stdin, maximumBytes, timeoutMilliseconds, cancelled, account, BUILD_IMAGE_LOAD_POLICY);
  }
  public static ZugfolgeMitigatedProcessResult RunStrict(string executable, string[] arguments, string cwd,
      System.Collections.IDictionary environment, byte[] stdin, int maximumBytes, int timeoutMilliseconds, Func<bool> cancelled) {
    return RunInternal(executable, arguments, cwd, environment, stdin, maximumBytes, timeoutMilliseconds, cancelled, null, STRICT_IMAGE_LOAD_POLICY);
  }
  public static ZugfolgeMitigatedProcessResult RunAsStrict(string executable, string[] arguments, string cwd,
      System.Collections.IDictionary environment, byte[] stdin, int maximumBytes, int timeoutMilliseconds, Func<bool> cancelled, ZugfolgeEphemeralAccount account) {
    if (account == null) throw new ArgumentNullException("account");
    return RunInternal(executable, arguments, cwd, environment, stdin, maximumBytes, timeoutMilliseconds, cancelled, account, STRICT_IMAGE_LOAD_POLICY);
  }
  private static ZugfolgeMitigatedProcessResult RunInternal(string executable, string[] arguments, string cwd,
      System.Collections.IDictionary environment, byte[] stdin, int maximumBytes, int timeoutMilliseconds, Func<bool> cancelled, ZugfolgeEphemeralAccount account,
      ulong imageLoadPolicy) {
    if (!Path.IsPathRooted(executable) || maximumBytes <= 0 || timeoutMilliseconds <= 0) throw new InvalidOperationException("Windows-Kindvertrag ist ungueltig.");
    if (arguments == null) arguments = new string[0]; if (stdin == null) stdin = new byte[0];
    System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    if (cancelled != null && cancelled()) throw new InvalidOperationException("Windows-Kindstart wurde vor CreateProcess monoton abgebrochen.");
    IntPtr childIn = IntPtr.Zero, parentIn = IntPtr.Zero, childOut = IntPtr.Zero, parentOut = IntPtr.Zero, childErr = IntPtr.Zero, parentErr = IntPtr.Zero;
    IntPtr sentinelChild = IntPtr.Zero, sentinelParent = IntPtr.Zero;
    IntPtr remoteChildIn = IntPtr.Zero, remoteChildOut = IntPtr.Zero, remoteChildErr = IntPtr.Zero, remoteSentinel = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, mitigation = IntPtr.Zero, handleList = IntPtr.Zero, parentProcess = IntPtr.Zero, env = IntPtr.Zero, job = IntPtr.Zero;
    bool attributesInitialized = false, processCreated = false, processCompleted = false;
    bool anchorCreated = false, anchorTerminated = false;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    PROCESS_INFORMATION anchor = new PROCESS_INFORMATION();
    Exception primaryError = null;
    try {
      Pipe(false, out childIn, out parentIn); Pipe(true, out childOut, out parentOut); Pipe(true, out childErr, out parentErr);
      Pipe(false, out sentinelChild, out sentinelParent);
      AssertNotInheritable(childIn, "child-stdin"); AssertNotInheritable(parentIn, "parent-stdin");
      AssertNotInheritable(childOut, "child-stdout"); AssertNotInheritable(parentOut, "parent-stdout");
      AssertNotInheritable(childErr, "child-stderr"); AssertNotInheritable(parentErr, "parent-stderr");
      AssertNotInheritable(sentinelChild, "sentinel-child"); AssertNotInheritable(sentinelParent, "sentinel-parent");
      StringBuilder command = new StringBuilder(Quote(executable));
      foreach (string argument in arguments) { if (argument == null || argument.IndexOf('\0') >= 0) throw new InvalidOperationException("Windows-Kindargument ist ungueltig."); command.Append(' ').Append(Quote(argument)); }
      env = EnvironmentBlock(environment);
      uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
      job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw Win32("CreateJobObject(anchor)");
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION anchorLimit = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      anchorLimit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (!SetInformationJobObject(job, 9, ref anchorLimit, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
        throw Win32("SetInformationJobObject(anchor)");
      string anchorExecutable = "C:\\Windows\\System32\\cmd.exe";
      StringBuilder anchorCommand = new StringBuilder(Quote(anchorExecutable) + " /D /Q /C exit 0");
      STARTUPINFO anchorStartup = new STARTUPINFO(); anchorStartup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      string expectedSid = account == null ? ProcessSid(GetCurrentProcess()) : account.Sid;
      bool anchored;
      if (account == null) {
        anchored = CreateProcessWBasic(anchorExecutable, anchorCommand, IntPtr.Zero, IntPtr.Zero, false,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env, cwd, ref anchorStartup, out anchor);
        if (!anchored) throw Win32("CreateProcessW(current identity anchor)");
      } else {
        // The identity anchor is never resumed. Let Windows construct its account
        // environment; the payload still receives the explicit env block below.
        anchored = CreateProcessWithLogonW(account.Username, account.Domain, account.Password, LOGON_WITHOUT_PROFILE,
          anchorExecutable, anchorCommand, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
          IntPtr.Zero, cwd, ref anchorStartup, out anchor);
        if (!anchored) {
          uint status = unchecked((uint)Marshal.GetLastWin32Error());
          throw new InvalidOperationException("ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_WITH_LOGON status="
            + status.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
      }
      anchorCreated = true;
      AssertProcessSid(anchor.hProcess, expectedSid);
      if (!AssignProcessToJobObject(job, anchor.hProcess)) throw Win32("AssignProcessToJobObject(anchor)");
      lock (ActiveLock) { ActiveJob = job; }
      if (cancelled != null && cancelled()) throw new InvalidOperationException("Windows-Kindstart wurde vor Anker-Duplizierung monoton abgebrochen.");
      remoteChildIn = DuplicateInheritableToProcess(anchor.hProcess, childIn, "stdin");
      remoteChildOut = DuplicateInheritableToProcess(anchor.hProcess, childOut, "stdout");
      remoteChildErr = DuplicateInheritableToProcess(anchor.hProcess, childErr, "stderr");
      remoteSentinel = DuplicateInheritableToProcess(anchor.hProcess, sentinelChild, "sentinel");
      if (remoteChildIn == remoteChildOut || remoteChildIn == remoteChildErr || remoteChildIn == remoteSentinel
          || remoteChildOut == remoteChildErr || remoteChildOut == remoteSentinel || remoteChildErr == remoteSentinel)
        throw new InvalidOperationException("Windows-Anker erzeugte keine eindeutigen Remote-Handles.");
      int attributeCount = 3;
      IntPtr attributeBytes = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref attributeBytes);
      if (attributeBytes == IntPtr.Zero) throw Win32("InitializeProcThreadAttributeList(size)");
      attributes = Marshal.AllocHGlobal(attributeBytes);
      if (!InitializeProcThreadAttributeList(attributes, attributeCount, 0, ref attributeBytes)) throw Win32("InitializeProcThreadAttributeList");
      attributesInitialized = true; mitigation = Marshal.AllocHGlobal(8); Marshal.WriteInt64(mitigation, unchecked((long)imageLoadPolicy));
      if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, mitigation, new IntPtr(8), IntPtr.Zero, IntPtr.Zero))
        throw Win32("UpdateProcThreadAttribute(MITIGATION_POLICY)");
      handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handleList, 0, remoteChildIn); Marshal.WriteIntPtr(handleList, IntPtr.Size, remoteChildOut); Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, remoteChildErr);
      if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
        throw Win32("UpdateProcThreadAttribute(HANDLE_LIST)");
      parentProcess = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(parentProcess, anchor.hProcess);
      if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, parentProcess, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
        throw Win32("UpdateProcThreadAttribute(PARENT_PROCESS)");
      STARTUPINFOEX startup = new STARTUPINFOEX(); startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = remoteChildIn; startup.StartupInfo.hStdOutput = remoteChildOut; startup.StartupInfo.hStdError = remoteChildErr; startup.lpAttributeList = attributes;
      bool created = CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, flags, env, cwd, ref startup, out process);
      if (!created) {
        if (account == null) throw Win32("CreateProcessW(mitigated)");
        uint status = unchecked((uint)Marshal.GetLastWin32Error());
        throw new InvalidOperationException("ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_FROM_ANCHOR status="
          + status.ToString(System.Globalization.CultureInfo.InvariantCulture));
      }
      processCreated = true;
      AssertAllowedHandleInherited(process.hProcess, remoteChildIn, childIn, "stdin");
      AssertAllowedHandleInherited(process.hProcess, remoteChildOut, childOut, "stdout");
      AssertAllowedHandleInherited(process.hProcess, remoteChildErr, childErr, "stderr");
      AssertSentinelNotInherited(process.hProcess, remoteSentinel, sentinelChild);
      AssertProcessSid(process.hProcess, expectedSid);
      AssertMitigationPolicy(process.hProcess, imageLoadPolicy);
      AssertProcessInJob(process.hProcess, job);
      CloseRequired(ref sentinelChild, "sentinel-child");
      CloseRequired(ref sentinelParent, "sentinel-parent");
      if (!TerminateProcess(anchor.hProcess, 98)) throw Win32("TerminateProcess(suspended identity anchor)");
      uint anchorWait = WaitForSingleObject(anchor.hProcess, 5000);
      if (anchorWait == WAIT_FAILED) throw Win32("WaitForSingleObject(suspended identity anchor)");
      if (anchorWait != WAIT_OBJECT_0)
        throw new TimeoutException("Suspendierter Windows-Identitaetsanker endete nicht rechtzeitig.");
      anchorTerminated = true;
      CloseRequired(ref anchor.hThread, "anchor-thread"); CloseRequired(ref anchor.hProcess, "anchor-process");
      if (cancelled != null && cancelled()) throw new InvalidOperationException("Windows-Kindstart wurde vor ResumeThread monoton abgebrochen.");
      if (clock.ElapsedMilliseconds > timeoutMilliseconds) throw new TimeoutException("Windows-Kindstart ueberschritt vor ResumeThread das gepinnte Zeitlimit.");
      if (ResumeThread(process.hThread) == 0xffffffff) throw Win32("ResumeThread");
      CloseRequired(ref childIn, "child-stdin"); CloseRequired(ref childOut, "child-stdout"); CloseRequired(ref childErr, "child-stderr");
      using (FileStream input = new FileStream(new SafeFileHandle(parentIn, true), FileAccess.Write, 4096, false))
      using (FileStream output = new FileStream(new SafeFileHandle(parentOut, true), FileAccess.Read, 4096, false))
      using (FileStream error = new FileStream(new SafeFileHandle(parentErr, true), FileAccess.Read, 4096, false)) {
        parentIn = IntPtr.Zero; parentOut = IntPtr.Zero; parentErr = IntPtr.Zero; OutputCounter total = new OutputCounter();
        System.Threading.Tasks.Task inputTask = System.Threading.Tasks.Task.Factory.StartNew(delegate { if (stdin.Length > 0) input.Write(stdin, 0, stdin.Length); input.Close(); },
          System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
        System.Threading.Tasks.Task<byte[]> stdoutTask = System.Threading.Tasks.Task.Factory.StartNew(delegate { return ReadBounded(output, maximumBytes, job, "stdout", total); },
          System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
        System.Threading.Tasks.Task<byte[]> stderrTask = System.Threading.Tasks.Task.Factory.StartNew(delegate { return ReadBounded(error, maximumBytes, job, "stderr", total); },
          System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
        while (true) {
          long remaining = timeoutMilliseconds - clock.ElapsedMilliseconds;
          if (remaining <= 0) { TerminateJobObject(job, 92); throw new TimeoutException("Windows-Kindprozessbaum ueberschritt das gepinnte Zeitlimit."); }
          uint wait = WaitForSingleObject(process.hProcess, (uint)Math.Min(25L, remaining));
          if (wait == WAIT_OBJECT_0) {
            if (clock.ElapsedMilliseconds > timeoutMilliseconds) { TerminateJobObject(job, 92); throw new TimeoutException("Windows-Kindprozessbaum ueberschritt das gepinnte Zeitlimit."); }
            break;
          }
          if (wait == WAIT_FAILED) throw Win32("WaitForSingleObject");
          if (wait != WAIT_TIMEOUT) throw new InvalidOperationException("Windows-Kindwait lieferte einen unbekannten Zustand.");
          if (cancelled != null && cancelled()) { TerminateJobObject(job, 94); throw new InvalidOperationException("Windows-Kindprozessbaum wurde nach monotoner Inputdrift beendet."); }
        }
        uint exitCode; if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw Win32("GetExitCodeProcess");
        // The root process may exit while a descendant still holds inherited
        // stdout/stderr pipe handles.  Close the causal process-tree boundary
        // before joining readers so no descendant can keep WaitAll alive or
        // perform a delayed post-root effect.
        if (!TerminateJobObject(job, 96)) throw Win32("TerminateJobObject(post-root descendants)");
        if (!System.Threading.Tasks.Task.WaitAll(new System.Threading.Tasks.Task[] { inputTask, stdoutTask, stderrTask }, 5000)) {
          TerminateJobObject(job, 97);
          throw new TimeoutException("Windows-Kindprozess-Pipes schlossen nach dem kausalen Job-Tree-Abbruch nicht rechtzeitig.");
        }
        CloseRequired(ref process.hThread, "payload-thread"); CloseRequired(ref process.hProcess, "payload-process");
        AssertJobEmpty(job, 5000, "post-root");
        processCompleted = true;
        return new ZugfolgeMitigatedProcessResult(unchecked((int)exitCode), stdoutTask.Result, stderrTask.Result);
      }
    } catch (Exception error) {
      primaryError = error;
      throw;
    } finally {
      List<string> cleanupErrors = new List<string>();
      if (!processCompleted && job != IntPtr.Zero && !TerminateJobObject(job, 95))
        RecordCleanupStatus(cleanupErrors, "TerminateJobObject(cleanup)", Marshal.GetLastWin32Error());
      if (processCreated && !processCompleted) EnsureProcessTerminated(process.hProcess, "payload", cleanupErrors);
      if (anchorCreated && !anchorTerminated) EnsureProcessTerminated(anchor.hProcess, "anchor", cleanupErrors);
      CloseTracked(ref process.hThread, "payload-thread", cleanupErrors); CloseTracked(ref process.hProcess, "payload-process", cleanupErrors);
      CloseTracked(ref anchor.hThread, "anchor-thread", cleanupErrors); CloseTracked(ref anchor.hProcess, "anchor-process", cleanupErrors);
      if (!processCompleted && job != IntPtr.Zero) {
        string jobFailure = WaitForJobEmptyStatus(job, 5000, "cleanup");
        if (jobFailure != null) cleanupErrors.Add(jobFailure);
      }
      lock (ActiveLock) { if (ActiveJob == job) ActiveJob = IntPtr.Zero; }
      CloseTracked(ref childIn, "child-stdin", cleanupErrors); CloseTracked(ref parentIn, "parent-stdin", cleanupErrors);
      CloseTracked(ref childOut, "child-stdout", cleanupErrors); CloseTracked(ref parentOut, "parent-stdout", cleanupErrors);
      CloseTracked(ref childErr, "child-stderr", cleanupErrors); CloseTracked(ref parentErr, "parent-stderr", cleanupErrors);
      CloseTracked(ref sentinelChild, "sentinel-child", cleanupErrors); CloseTracked(ref sentinelParent, "sentinel-parent", cleanupErrors);
      if (attributesInitialized) DeleteProcThreadAttributeList(attributes); if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (parentProcess != IntPtr.Zero) Marshal.FreeHGlobal(parentProcess); if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList); if (mitigation != IntPtr.Zero) Marshal.FreeHGlobal(mitigation);
      CloseTracked(ref job, "job", cleanupErrors); if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
      if (cleanupErrors.Count > 0) {
        Exception cleanupError = new InvalidOperationException("Windows-Kindcleanup war nicht vollstaendig: " + String.Join(" | ", cleanupErrors.ToArray()));
        if (primaryError == null) throw cleanupError;
        throw new AggregateException("Windows-Kindprozess- und Cleanupfehler traten gemeinsam auf.", primaryError, cleanupError);
      }
    }
  }
}

public sealed class ZugfolgeIntegrityMonitor : IDisposable {
  private readonly FileSystemWatcher watcher;
  private readonly FileSystemWatcher metadataWatcher;
  private readonly string label;
  private int invalidated;
  private string detail = "";
  public bool Invalidated { get { return System.Threading.Volatile.Read(ref invalidated) != 0; } }
  public string Detail { get { return detail; } }
  public string Label { get { return label; } }
  public ZugfolgeIntegrityMonitor(string path, string label) {
    this.label = label;
    watcher = new FileSystemWatcher(path);
    watcher.IncludeSubdirectories = true;
    watcher.InternalBufferSize = 65536;
    watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.Security;
    watcher.Changed += Changed;
    watcher.Created += Changed;
    watcher.Deleted += Changed;
    watcher.Renamed += Renamed;
    watcher.Error += Error;
    watcher.EnableRaisingEvents = true;
    metadataWatcher = new FileSystemWatcher(path);
    metadataWatcher.IncludeSubdirectories = true;
    metadataWatcher.InternalBufferSize = 65536;
    metadataWatcher.NotifyFilter = NotifyFilters.Size | NotifyFilters.LastWrite;
    metadataWatcher.Changed += MetadataChanged;
    metadataWatcher.Error += Error;
    metadataWatcher.EnableRaisingEvents = true;
  }
  private void Record(string value) {
    if (System.Threading.Interlocked.Exchange(ref invalidated, 1) == 0) detail = value;
    ZugfolgeMitigatedProcess.AbortActive();
  }
  private void Changed(object sender, FileSystemEventArgs value) { Record(value.ChangeType + ":" + value.FullPath); }
  private void MetadataChanged(object sender, FileSystemEventArgs value) {
    try {
      if ((File.GetAttributes(value.FullPath) & FileAttributes.Directory) != 0) return;
    } catch { }
    Record("FileMetadata:" + value.FullPath);
  }
  private void Renamed(object sender, RenamedEventArgs value) { Record("Renamed:" + value.OldFullPath + "->" + value.FullPath); }
  private void Error(object sender, ErrorEventArgs value) { Record("ReadDirectoryChangesW-Overflow:" + value.GetException().Message); }
  public void Dispose() { metadataWatcher.Dispose(); watcher.Dispose(); }
}
`;
const WINDOWS_BUILD_ANCHOR = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$held = [System.Collections.Generic.List[System.IDisposable]]::new()
$publishedStreams = [System.Collections.Generic.List[object]]::new()
$publicationCommitted = $false
function Fail([string]$message) {
  [Console]::Error.WriteLine($message)
  exit 125
}
function Decode-Json([string]$line, [string]$label) {
  if ([string]::IsNullOrWhiteSpace($line)) { Fail "$label fehlt." }
  try {
    $bytes = [Convert]::FromBase64String($line)
    return [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  } catch { Fail "$label ist ungueltig: $($_.Exception.Message)" }
}
function Open-Held([string]$path, [Int64]$expectedBytes, [string]$expectedSha, [string]$label) {
  $stream = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -ne $expectedBytes) { Fail "$label besitzt die falsche Bytezahl." }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
    if ($actual -cne $expectedSha) { Fail "$label besitzt den falschen SHA-256." }
    $stream.Position = 0
    $held.Add($stream)
    return $stream
  } catch {
    $stream.Dispose()
    throw
  }
}
function Open-BuiltOutput([string]$path, [Int64]$expectedBytes, [string]$label) {
  $stream = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -ne $expectedBytes) { Fail "$label besitzt die falsche Bytezahl." }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
    $stream.Position = 0
    $identity = [ZugfolgeRelativeFs]::Identity($stream.SafeFileHandle).Split(':')
    if ($identity.Length -ne 2) { Fail "$label besitzt keine gueltige gehaltene Identitaet." }
    $held.Add($stream)
    return [ordered]@{
      proof = [ordered]@{
        bytes = [Int64]$stream.Length
        identity = [ordered]@{ dev = [string]$identity[0]; ino = [string]$identity[1] }
        sha256 = $actual
      }
      stream = $stream
    }
  } catch {
    $stream.Dispose()
    throw
  }
}
function Read-Held([IO.FileStream]$stream) {
  $stream.Position = 0
  $memory = [IO.MemoryStream]::new()
  try { $stream.CopyTo($memory); return ,$memory.ToArray() } finally { $memory.Dispose(); $stream.Position = 0 }
}
function Hash-Text([string]$value) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
function Open-HeldDirectory([string]$path, [string]$label) {
  try { $handle = [ZugfolgeRelativeFs]::OpenPlainDirectory($path) } catch { Fail "$label konnte nicht exklusiv gehalten werden: $($_.Exception.Message)" }
  $held.Add($handle)
  return $handle
}
function New-HeldDirectoryRelative([Microsoft.Win32.SafeHandles.SafeFileHandle]$parent, [string]$leaf, [string]$label, [object]$securityDescriptor = $null) {
  try {
    $handle = if ($null -eq $securityDescriptor) { [ZugfolgeRelativeFs]::CreateDirectory($parent, $leaf) } else { [ZugfolgeRelativeFs]::CreateProtectedDirectory($parent, $leaf, $securityDescriptor) }
  } catch { Fail "$label konnte nicht NT-relativ create-new erzeugt werden: $($_.Exception.Message)" }
  $held.Add($handle)
  return $handle
}
function Open-HeldDirectoryRelative([Microsoft.Win32.SafeHandles.SafeFileHandle]$parent, [string]$leaf, [string]$label) {
  try { $handle = [ZugfolgeRelativeFs]::OpenDirectory($parent, $leaf) } catch { Fail "$label konnte nicht NT-relativ und reparsefrei geoeffnet werden: $($_.Exception.Message)" }
  $held.Add($handle)
  return $handle
}
function Open-HeldPathRoot([string]$path, [string]$label) {
  $full = [IO.Path]::GetFullPath($path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $volume = [IO.Path]::GetPathRoot($full)
  $current = Open-HeldDirectory $volume "$label-Volume-Root"
  $remaining = $full.Substring($volume.Length).Trim([IO.Path]::DirectorySeparatorChar)
  if (-not [string]::IsNullOrEmpty($remaining)) {
    foreach ($segment in $remaining.Split([IO.Path]::DirectorySeparatorChar)) {
      $current = Open-HeldDirectoryRelative $current $segment "$label-Ahne $segment"
    }
  }
  return $current
}
function Open-HeldRelativeFile([Microsoft.Win32.SafeHandles.SafeFileHandle]$parent, [string]$leaf, [Int64]$expectedBytes, [string]$expectedSha, [string]$label) {
  try { $fileHandle = [ZugfolgeRelativeFs]::OpenRegularFile($parent, $leaf) } catch { Fail "$label konnte nicht NT-relativ und reparsefrei geoeffnet werden: $($_.Exception.Message)" }
  $stream = [IO.FileStream]::new($fileHandle, [IO.FileAccess]::Read, 1048576, $false)
  try {
    if ($stream.Length -ne $expectedBytes) { Fail "$label besitzt die falsche Bytezahl." }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
    if ($actual -cne $expectedSha) { Fail "$label besitzt den falschen SHA-256." }
    $stream.Position = 0
    $held.Add($stream)
    return $stream
  } catch {
    $stream.Dispose()
    throw
  }
}
function Add-ExpectedChild([hashtable]$expectedChildren, [string]$parent, [string]$leaf) {
  if (-not $expectedChildren.ContainsKey($parent)) { $expectedChildren[$parent] = [Collections.Generic.List[string]]::new() }
  $expectedChildren[$parent].Add($leaf)
}
function Assert-ExactHeldTree([hashtable]$directories, [hashtable]$expectedChildren, [string]$label) {
  foreach ($directory in $directories.Keys) {
    if (-not $expectedChildren.ContainsKey($directory)) { Fail "$label besitzt kein Kindermanifest fuer '$directory'." }
    $actual = @([ZugfolgeRelativeFs]::EnumerateNames($directories[$directory]))
    $expected = @($expectedChildren[$directory])
    [Array]::Sort($expected, [StringComparer]::Ordinal)
    if ($actual.Count -ne $expected.Count) { Fail "$label-Verzeichnis '$directory' driftet von der exakten Kindermenge." }
    for ($index = 0; $index -lt $actual.Count; $index++) {
      if ($actual[$index] -cne $expected[$index]) { Fail "$label-Verzeichnis '$directory' driftet von der exakten Kindermenge." }
    }
  }
}
function New-IntegrityWatcher([string]$path, [string]$label) {
  $monitor = [ZugfolgeIntegrityMonitor]::new($path, $label)
  $held.Add($monitor)
  return $monitor
}
function Assert-MonitorsClean([object[]]$monitors, [string]$label) {
  foreach ($monitor in $monitors) {
    if ($monitor.Invalidated) { Fail "$($label): $($monitor.Label) driftete monoton erkannt ($($monitor.Detail))." }
  }
}
function Extract-AuditedPlan([IO.FileStream]$archive, [object]$plan, [hashtable]$directories, [hashtable]$files, [hashtable]$expectedChildren, [object]$securityDescriptor, [string]$label) {
  foreach ($directory in $plan.directories) {
    $segments = ([string]$directory).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    if (-not $directories.ContainsKey($parentName) -or $directories.ContainsKey([string]$directory)) { Fail "$label-Verzeichnisplan ist nicht streng parentgebunden/create-new." }
    $directories[[string]$directory] = New-HeldDirectoryRelative $directories[$parentName] $leaf "$label-Verzeichnis $directory" $securityDescriptor
    Add-ExpectedChild $expectedChildren $parentName $leaf
    $expectedChildren[[string]$directory] = [Collections.Generic.List[string]]::new()
  }
  foreach ($entry in $plan.files) {
    $segments = ([string]$entry.file).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    if (-not $directories.ContainsKey($parentName)) { Fail "$label-Dateiplan besitzt keinen gehaltenen Parent." }
    Add-ExpectedChild $expectedChildren $parentName $leaf
    $archive.Position = [Int64]$entry.offset
    $remaining = [Int64]$entry.bytes
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $fileHandle = [ZugfolgeRelativeFs]::CreateProtectedRegularFile($directories[$parentName], $leaf, $securityDescriptor) } catch { Fail "$label-Datei $($entry.file) konnte nicht NT-relativ create-new erzeugt werden: $($_.Exception.Message)" }
    $output = [IO.FileStream]::new($fileHandle, [IO.FileAccess]::ReadWrite, 1048576, $false)
    try {
      $buffer = [byte[]]::new(1048576)
      while ($remaining -gt 0) {
        $count = [Math]::Min([Int64]$buffer.Length, $remaining)
        $read = $archive.Read($buffer, 0, [int]$count)
        if ($read -le 0) { Fail "$label-Datei $($entry.file) endet vor dem auditierten Slice." }
        $output.Write($buffer, 0, $read)
        [void]$hash.TransformBlock($buffer, 0, $read, $null, 0)
        $remaining -= $read
      }
      [void]$hash.TransformFinalBlock([byte[]]::new(0), 0, 0)
      $actual = [BitConverter]::ToString($hash.Hash).Replace('-', '').ToLowerInvariant()
      if ($output.Length -ne [Int64]$entry.bytes -or $actual -cne [string]$entry.sha256) { Fail "$label-Datei $($entry.file) driftet vom auditierten Slice." }
      $output.Flush($true)
      $output.Dispose()
      $output = $null
      $files[[string]$entry.file] = Open-HeldRelativeFile $directories[$parentName] $leaf $entry.bytes $entry.sha256 "$label-Datei $($entry.file) nach create-new"
    } finally {
      $hash.Dispose()
      if ($null -ne $output) { $output.Dispose() }
    }
  }
}
function Copy-HeldFile([IO.FileStream]$input, [Microsoft.Win32.SafeHandles.SafeFileHandle]$parent, [string]$leaf, [Int64]$expectedBytes, [string]$expectedSha, [object]$securityDescriptor, [string]$label) {
  $input.Position = 0
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $fileHandle = [ZugfolgeRelativeFs]::CreateProtectedRegularFile($parent, $leaf, $securityDescriptor) } catch { Fail "$label konnte nicht NT-relativ create-new erzeugt werden: $($_.Exception.Message)" }
  $output = [IO.FileStream]::new($fileHandle, [IO.FileAccess]::ReadWrite, 1048576, $false)
  try {
    $buffer = [byte[]]::new(1048576)
    [Int64]$remaining = $expectedBytes
    while ($remaining -gt 0) {
      $count = [Math]::Min([Int64]$buffer.Length, $remaining)
      $read = $input.Read($buffer, 0, [int]$count)
      if ($read -le 0) { Fail "$label endet vor der gehaltenen Bytezahl." }
      $output.Write($buffer, 0, $read)
      [void]$hash.TransformBlock($buffer, 0, $read, $null, 0)
      $remaining -= $read
    }
    if ($input.ReadByte() -ne -1) { Fail "$label besitzt hinter der gehaltenen Bytezahl Restdaten." }
    [void]$hash.TransformFinalBlock([byte[]]::new(0), 0, 0)
    $actual = [BitConverter]::ToString($hash.Hash).Replace('-', '').ToLowerInvariant()
    if ($output.Length -ne $expectedBytes -or $actual -cne $expectedSha) { Fail "$label driftet waehrend der privaten Toolchain-Kopie." }
    $output.Flush($true)
    $output.Dispose()
    $output = $null
    return Open-HeldRelativeFile $parent $leaf $expectedBytes $expectedSha "$label nach create-new"
  } finally {
    $input.Position = 0
    $hash.Dispose()
    if ($null -ne $output) { $output.Dispose() }
  }
}
function Publish-HeldFile([IO.Stream]$input, [object]$request, [string]$label) {
  $propertyNames = @($request.PSObject.Properties.Name | Sort-Object)
  if (($propertyNames -join ',') -cne 'bytes,file,sha256') { Fail "$label besitzt unerwartete Publikationsfelder." }
  $full = [IO.Path]::GetFullPath([string]$request.file)
  $parentPath = [IO.Path]::GetDirectoryName($full).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $parentKey = $parentPath.ToUpperInvariant()
  $leaf = [IO.Path]::GetFileName($full)
  if ([string]::IsNullOrEmpty($leaf) -or -not $anchoredParentHandles.ContainsKey($parentKey) -or
      [IO.Path]::GetFullPath([IO.Path]::Combine($parentPath, $leaf)) -cne $full) {
    Fail "$label verlaesst die gehaltene Output-Parent-Menge."
  }
  $expectedBytes = [Int64]$request.bytes
  $expectedSha = [string]$request.sha256
  if ($expectedBytes -le 0 -or $expectedSha -cnotmatch '^[a-f0-9]{64}$') { Fail "$label besitzt keine gueltige Byte-/SHA-Bindung." }
  try { $published = [ZugfolgeRelativeFs]::PublishHeldCreateNew($input, $anchoredParentHandles[$parentKey], $leaf, $expectedBytes, $expectedSha, $parentWritableDescriptor) }
  catch { Fail "$label konnte nicht handle-relativ create-new publiziert werden: $($_.Exception.Message)" }
  $held.Add($published)
  $publishedStreams.Add($published)
  $identity = ([string]$published.Identity).Split(':')
  if ($identity.Length -ne 2) { Fail "$label besitzt keine gueltige gehaltene Identitaet." }
  return [ordered]@{
    bytes = [Int64]$published.Bytes
    identity = [ordered]@{ dev = [string]$identity[0]; ino = [string]$identity[1] }
    sha256 = [string]$published.Sha256
  }
}
function Rollback-Published {
  $errors = [Collections.Generic.List[string]]::new()
  for ($index = $publishedStreams.Count - 1; $index -ge 0; $index--) {
    try { $publishedStreams[$index].Rollback() } catch { $errors.Add($_.Exception.Message) }
  }
  $publishedStreams.Clear()
  if ($errors.Count -gt 0) { throw [InvalidOperationException]::new('Handle-relativer Publikationsrollback scheiterte: ' + [string]::Join(' | ', $errors)) }
}
function Commit-Published {
  foreach ($publication in $publishedStreams) { $publication.Commit() }
  $publishedStreams.Clear()
}
function Freeze-HeldTree([hashtable]$directories, [hashtable]$files, [hashtable]$expectedChildren, [Microsoft.Win32.SafeHandles.SafeFileHandle]$rootParent, [string]$rootLeaf, [string]$currentSid, [string]$label) {
  foreach ($file in @($files.Keys | Sort-Object)) { [ZugfolgeRelativeFs]::FreezeReadExecute($files[$file].SafeFileHandle, $currentSid) }
  foreach ($directory in @($directories.Keys | Sort-Object { $_.Split('/').Length } -Descending)) { [ZugfolgeRelativeFs]::FreezeReadExecute($directories[$directory], $currentSid) }
  Assert-ExactHeldTree $directories $expectedChildren "$label nach DACL-Freeze"
  foreach ($directory in @($directories.Keys | Sort-Object)) {
    if ($directory -eq '') {
      [ZugfolgeRelativeFs]::AssertFrozenDirectoryEntry($rootParent, $rootLeaf)
      [ZugfolgeRelativeFs]::AssertFrozenEntry($rootParent, $rootLeaf, $true)
    } else {
      $segments = ([string]$directory).Split('/')
      $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
      [ZugfolgeRelativeFs]::AssertFrozenDirectoryEntry($directories[$parentName], $segments[$segments.Length - 1])
      [ZugfolgeRelativeFs]::AssertFrozenEntry($directories[$parentName], $segments[$segments.Length - 1], $true)
    }
  }
  foreach ($file in @($files.Keys | Sort-Object)) {
    $segments = ([string]$file).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    [ZugfolgeRelativeFs]::AssertFrozenEntry($directories[$parentName], $segments[$segments.Length - 1], $false)
  }
}
function Invoke-Bound([string]$file, [string[]]$arguments, [string]$cwd, [hashtable]$environment, [object[]]$monitors, [int]$maximumBytes, [int]$timeoutMilliseconds, [object]$account) {
  $cancelled = [Func[bool]]{
    foreach ($monitor in $monitors) { if ($monitor.Invalidated) { return $true } }
    return $false
  }
  try {
    $process = [ZugfolgeMitigatedProcess]::RunAs($file, $arguments, $cwd, $environment, [byte[]]@(), $maximumBytes, $timeoutMilliseconds, $cancelled, $account)
    return [ordered]@{
      code = $process.ExitCode
      stderr = [Convert]::ToBase64String($process.Stderr)
      stdout = [Convert]::ToBase64String($process.Stdout)
    }
  } catch {
    $diagnostic = [string]$_.Exception.GetBaseException().Message
    if ($diagnostic -match '^ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=(PROCESS_WITH_LOGON|PROCESS_FROM_ANCHOR) status=[1-9][0-9]{0,9}$') {
      [Console]::Error.WriteLine($diagnostic)
      exit 125
    }
    Fail "Gebundener mitigierter Prozess schlug fail-closed fehl."
  }
}
try {
  $request = Decode-Json ([Console]::In.ReadLine()) 'Anchor-Request'
  $helper = Open-Held $request.helper.path $request.helper.bytes $request.helper.sha256 'Gepinnte Anchor-Helper-Assembly'
  $helperBytes = Read-Held $helper
  try { [void][Reflection.Assembly]::Load($helperBytes) } catch { Fail "Gepinnte Anchor-Helper-Assembly konnte nicht aus den gehaltenen Bytes geladen werden: $($_.Exception.Message)" }
  $anchoredParentHandles = @{}
  $anchoredParentProofs = [Collections.Generic.List[object]]::new()
  foreach ($entry in @($request.anchoredParents)) {
    $parentPath = [IO.Path]::GetFullPath([string]$entry.path).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $parentKey = $parentPath.ToUpperInvariant()
    if ($anchoredParentHandles.ContainsKey($parentKey)) { Fail "Output-Elternverzeichnis ist doppelt: $parentPath" }
    $parentHandle = Open-HeldPathRoot $parentPath 'Output-Parent'
    $actualIdentity = [ZugfolgeRelativeFs]::Identity($parentHandle)
    $expectedIdentity = ([string]$entry.identity.dev) + ':' + ([string]$entry.identity.ino)
    if ($actualIdentity -cne $expectedIdentity) { Fail "Output-Elternverzeichnis driftet vor dem Anchor-Handschlag: $parentPath" }
    $anchoredParentHandles[$parentKey] = $parentHandle
    $anchoredParentProofs.Add([ordered]@{
      identity = [ordered]@{ dev = [string]$entry.identity.dev; ino = [string]$entry.identity.ino }
      path = $parentPath
    })
  }
  $buildParentPath = [IO.Path]::GetFullPath([string]$request.buildParent.path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $buildParentKey = $buildParentPath.ToUpperInvariant()
  if (-not $anchoredParentHandles.ContainsKey($buildParentKey)) { Fail 'Buildroot-Parent fehlt in der gehaltenen Output-Parent-Menge.' }
  $expectedBuildParentIdentity = ([string]$request.buildParent.identity.dev) + ':' + ([string]$request.buildParent.identity.ino)
  if ([ZugfolgeRelativeFs]::Identity($anchoredParentHandles[$buildParentKey]) -cne $expectedBuildParentIdentity) { Fail 'Buildroot-Parent driftet vom expliziten Request.' }
  $buildRootLeaf = [string]$request.buildRootLeaf
  $buildRoot = [IO.Path]::GetFullPath([IO.Path]::Combine($buildParentPath, $buildRootLeaf))
  if ([IO.Path]::GetDirectoryName($buildRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) -cne $buildParentPath) { Fail 'Buildroot-Leaf verlaesst seinen gehaltenen Parent.' }
  $source = Open-Held $request.source.path $request.source.bytes $request.source.sha256 'Source-TAR'
  $vendor = Open-Held $request.vendor.path $request.vendor.bytes $request.vendor.sha256 'Vendor-TAR'
  $manifestStream = Open-Held $request.manifest.path $request.manifest.bytes $request.manifest.sha256 'Toolchain-Manifest'
  $manifestBytes = Read-Held $manifestStream
  $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
  if ($manifest.schema -cne 'zugfolge-operational-validator-toolchain-manifest/v1') { Fail 'Toolchain-Manifest besitzt ein unbekanntes Schema.' }
  $root = [IO.Path]::GetFullPath([string]$request.toolchainRoot)
  $toolchainRootHandle = Open-HeldPathRoot $root 'Toolchain'
  $toolchainDirectories = @{ '' = $toolchainRootHandle }
  $toolchainFiles = @{}
  $expectedChildren = @{}
  $expectedChildren[''] = [Collections.Generic.List[string]]::new()
  foreach ($directory in $manifest.directories) {
    $segments = ([string]$directory).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    if (-not $toolchainDirectories.ContainsKey($parentName) -or $toolchainDirectories.ContainsKey([string]$directory)) { Fail 'Toolchain-Verzeichnismanifest ist nicht streng parentgebunden.' }
    $toolchainDirectories[[string]$directory] = Open-HeldDirectoryRelative $toolchainDirectories[$parentName] $leaf "Toolchain-Verzeichnis $directory"
    if (-not $expectedChildren.ContainsKey($parentName)) { $expectedChildren[$parentName] = [Collections.Generic.List[string]]::new() }
    $expectedChildren[$parentName].Add($leaf)
    $expectedChildren[[string]$directory] = [Collections.Generic.List[string]]::new()
  }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $manifest.files) {
    $segments = ([string]$entry.file).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    if (-not $toolchainDirectories.ContainsKey($parentName) -or -not $seen.Add([string]$entry.file)) { Fail 'Toolchain-Dateimanifest besitzt einen ungueltigen oder kollidierenden Pfad.' }
    $toolchainFiles[[string]$entry.file] = Open-HeldRelativeFile $toolchainDirectories[$parentName] $leaf $entry.bytes $entry.sha256 "Toolchain-Datei $($entry.file)"
    $expectedChildren[$parentName].Add($leaf)
  }
  Assert-ExactHeldTree $toolchainDirectories $expectedChildren 'Toolchain'
  if (-not $seen.Contains([string]$request.cargoPath) -or -not $seen.Contains([string]$request.rustcPath)) { Fail 'Toolchain-Manifest bindet cargo/rustc nicht.' }
  $readyJson = ([ordered]@{ anchoredParents = @($anchoredParentProofs); buildRoot = $buildRoot } | ConvertTo-Json -Depth 8 -Compress)
  [Console]::Out.WriteLine('ANCHOR_READY ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($readyJson)))
  [Console]::Out.Flush()
  $extract = Decode-Json ([Console]::In.ReadLine()) 'Extraktionsplan'
  # The privileged local principal is unnecessary while the parent/input/toolchain
  # handles are being established and audited.  Create it only once an extraction
  # request has been received; aborting before extraction therefore needs no admin
  # side effect while all original input bytes remain exclusively held.
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $account = [ZugfolgeEphemeralAccount]::Create()
  $held.Add($account)
  $readExecuteDescriptor = [ZugfolgeProtectedSecurityDescriptor]::ReadExecute($currentSid, $account.Sid)
  $isolatedWritableDescriptor = [ZugfolgeProtectedSecurityDescriptor]::IsolatedWritable($currentSid, $account.Sid)
  $parentWritableDescriptor = [ZugfolgeProtectedSecurityDescriptor]::ParentWritable($currentSid)
  $held.Add($readExecuteDescriptor)
  $held.Add($isolatedWritableDescriptor)
  $held.Add($parentWritableDescriptor)
  $buildRootHandle = New-HeldDirectoryRelative $anchoredParentHandles[$buildParentKey] $buildRootLeaf 'Privater Buildroot' $readExecuteDescriptor
  if ([ZugfolgeRelativeFs]::EnumerateNames($buildRootHandle).Length -ne 0) { Fail 'Create-new Buildroot ist nicht leer.' }
  $buildRootIdentityParts = [ZugfolgeRelativeFs]::Identity($buildRootHandle).Split(':')
  if ($buildRootIdentityParts.Length -ne 2) { Fail 'Create-new Buildroot besitzt keine gueltige gehaltene Identitaet.' }
  $buildDirectories = @{ '' = $buildRootHandle }
  $sourceHandle = New-HeldDirectoryRelative $buildDirectories[''] 'source' 'Private Source-Wurzel' $readExecuteDescriptor
  $sourceDirectories = @{ '' = $sourceHandle }
  $sourceFiles = @{}
  $sourceExpectedChildren = @{ '' = [Collections.Generic.List[string]]::new() }
  Extract-AuditedPlan $source $extract.source $sourceDirectories $sourceFiles $sourceExpectedChildren $readExecuteDescriptor 'Source'
  Extract-AuditedPlan $vendor $extract.vendor $sourceDirectories $sourceFiles $sourceExpectedChildren $readExecuteDescriptor 'Vendor'
  $privateToolchainHandle = New-HeldDirectoryRelative $buildDirectories[''] 'toolchain' 'Private Toolchain-Wurzel' $readExecuteDescriptor
  $privateToolchainDirectories = @{ '' = $privateToolchainHandle }
  $privateToolchainFiles = @{}
  $privateToolchainExpectedChildren = @{ '' = [Collections.Generic.List[string]]::new() }
  foreach ($directory in $manifest.directories) {
    $segments = ([string]$directory).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    $privateToolchainDirectories[[string]$directory] = New-HeldDirectoryRelative $privateToolchainDirectories[$parentName] $leaf "Private Toolchain-Verzeichnis $directory" $readExecuteDescriptor
    Add-ExpectedChild $privateToolchainExpectedChildren $parentName $leaf
    $privateToolchainExpectedChildren[[string]$directory] = [Collections.Generic.List[string]]::new()
  }
  foreach ($entry in $manifest.files) {
    $segments = ([string]$entry.file).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    Add-ExpectedChild $privateToolchainExpectedChildren $parentName $leaf
    $privateToolchainFiles[[string]$entry.file] = Copy-HeldFile $toolchainFiles[[string]$entry.file] $privateToolchainDirectories[$parentName] $leaf $entry.bytes $entry.sha256 $readExecuteDescriptor "Private Toolchain-Datei $($entry.file)"
  }
  $targetHandle = New-HeldDirectoryRelative $buildDirectories[''] 'target' 'Privates Cargo-Target' $isolatedWritableDescriptor
  $cargoHomeHandle = New-HeldDirectoryRelative $buildDirectories[''] 'cargo-home' 'Privates Cargo-Home' $isolatedWritableDescriptor
  $tempHandle = New-HeldDirectoryRelative $buildDirectories[''] 'temp' 'Privates Temp' $isolatedWritableDescriptor
  $publicationHandle = New-HeldDirectoryRelative $buildDirectories[''] 'publication' 'Privates Publikations-Staging' $parentWritableDescriptor
  $sourcePath = [IO.Path]::Combine($buildRoot, 'source')
  $vendorPath = [IO.Path]::Combine($sourcePath, 'vendor')
  $privateToolchainPath = [IO.Path]::Combine($buildRoot, 'toolchain')
  $cargoPath = [IO.Path]::GetFullPath([IO.Path]::Combine($privateToolchainPath, ([string]$request.cargoPath).Replace('/', [IO.Path]::DirectorySeparatorChar)))
  $rustcPath = [IO.Path]::GetFullPath([IO.Path]::Combine($privateToolchainPath, ([string]$request.rustcPath).Replace('/', [IO.Path]::DirectorySeparatorChar)))
  Freeze-HeldTree $sourceDirectories $sourceFiles $sourceExpectedChildren $buildRootHandle 'source' $currentSid 'Source-und-Vendor'
  Freeze-HeldTree $privateToolchainDirectories $privateToolchainFiles $privateToolchainExpectedChildren $buildRootHandle 'toolchain' $currentSid 'Private Toolchain'
  foreach ($entry in @('target', 'cargo-home', 'temp')) {
    [ZugfolgeRelativeFs]::AssertFrozenDirectoryEntry($buildRootHandle, $entry)
    [ZugfolgeRelativeFs]::AssertFrozenEntry($buildRootHandle, $entry, $true)
  }
  $monitors = @(
    (New-IntegrityWatcher $sourcePath 'Sourcebaum'),
    (New-IntegrityWatcher $vendorPath 'Vendorbaum'),
    (New-IntegrityWatcher $privateToolchainPath 'Privater Toolchainbaum')
  )
  Assert-ExactHeldTree $sourceDirectories $sourceExpectedChildren 'Source-und-Vendor'
  Assert-ExactHeldTree $toolchainDirectories $expectedChildren 'Gepinnter Toolchain-Input'
  Assert-ExactHeldTree $privateToolchainDirectories $privateToolchainExpectedChildren 'Private Toolchain'
  Assert-MonitorsClean $monitors 'Vor Build'
  $extractedJson = ([ordered]@{
    buildRootIdentity = [ordered]@{ dev = [string]$buildRootIdentityParts[0]; ino = [string]$buildRootIdentityParts[1] }
  } | ConvertTo-Json -Depth 4 -Compress)
  [Console]::Out.WriteLine('EXTRACTED ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($extractedJson)))
  [Console]::Out.Flush()
  $run = Decode-Json ([Console]::In.ReadLine()) 'Build-Request'
  if ($run.command[0] -cne 'cargo') { Fail 'Build-Request besitzt keinen Cargo-Befehl.' }
  $expectedSource = [IO.Path]::GetFullPath($sourcePath)
  $expectedCargoHome = [IO.Path]::GetFullPath([IO.Path]::Combine($buildRoot, 'cargo-home'))
  $expectedTarget = [IO.Path]::GetFullPath([IO.Path]::Combine($buildRoot, 'target'))
  $expectedTemp = [IO.Path]::GetFullPath([IO.Path]::Combine($buildRoot, 'temp'))
  $expectedConfig = [IO.Path]::GetFullPath([IO.Path]::Combine($expectedSource, '.cargo', 'config.toml'))
  $expectedManifest = [IO.Path]::GetFullPath([IO.Path]::Combine($expectedSource, 'Cargo.toml'))
  if ([IO.Path]::GetFullPath([string]$run.sourceDirectory) -cne $expectedSource -or
      [IO.Path]::GetFullPath([string]$run.cargoHome) -cne $expectedCargoHome -or
      [IO.Path]::GetFullPath([string]$run.targetDirectory) -cne $expectedTarget -or
      [IO.Path]::GetFullPath([string]$run.tempDirectory) -cne $expectedTemp -or
      [IO.Path]::GetFullPath([string]$run.cargoConfig) -cne $expectedConfig -or
      [IO.Path]::GetFullPath([string]$run.cargoManifest) -cne $expectedManifest) {
    Fail 'Build-Request driftet von den NT-relativ erzeugten privaten Pfaden.'
  }
  $buildArguments = [Collections.Generic.List[string]]::new()
  foreach ($argument in @($run.command | Select-Object -Skip 1)) {
    if ([string]$argument -ceq '$PINNED_CARGO_CONFIG') { $buildArguments.Add($expectedConfig) }
    elseif ([string]$argument -ceq '$PINNED_CARGO_MANIFEST') { $buildArguments.Add($expectedManifest) }
    else { $buildArguments.Add([string]$argument) }
  }
  $environment = @{
    'CARGO_BUILD_JOBS' = '1'
    'CARGO_ENCODED_RUSTFLAGS' = '--remap-path-prefix=' + $vendorPath + '=' + [string]$request.vendorRemapPrefix
    'CARGO_HOME' = [string]$run.cargoHome
    'CARGO_INCREMENTAL' = '0'
    'CARGO_NET_OFFLINE' = 'true'
    'CARGO_TARGET_DIR' = [string]$run.targetDirectory
    'CARGO_TERM_COLOR' = 'never'
    'COMSPEC' = 'C:\Windows\System32\cmd.exe'
    'HOMEDRIVE' = 'C:'
    'HOMEPATH' = '\Windows\System32'
    'PATH' = "$($privateToolchainPath)\bin;$($privateToolchainPath)\lib\rustlib\x86_64-pc-windows-gnu\bin;$($privateToolchainPath)\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained;C:\Windows\System32;C:\Windows"
    'PATHEXT' = '.COM;.EXE;.BAT;.CMD'
    'PROMPT' = '$P$G'
    'RUSTC' = $rustcPath
    'SYSTEMROOT' = 'C:\Windows'
    'TEMP' = [string]$run.tempDirectory
    'TMP' = [string]$run.tempDirectory
    'WINDIR' = 'C:\Windows'
  }
  $trustedCwd = 'C:\Windows\System32'
  Assert-MonitorsClean $monitors 'Vor Cargo-Probe'
  $cargoProbe = Invoke-Bound $cargoPath @('-vV') $trustedCwd $environment $monitors ([int]$request.processLimits.maxOutputBytes) ([int]$request.processLimits.timeoutMilliseconds) $account
  Assert-MonitorsClean $monitors 'Nach Cargo-Probe'
  $rustcProbe = Invoke-Bound $rustcPath @('-vV') $trustedCwd $environment $monitors ([int]$request.processLimits.maxOutputBytes) ([int]$request.processLimits.timeoutMilliseconds) $account
  Assert-MonitorsClean $monitors 'Nach rustc-Probe'
  $build = Invoke-Bound $cargoPath @($buildArguments) $trustedCwd $environment $monitors ([int]$request.processLimits.maxOutputBytes) ([int]$request.processLimits.timeoutMilliseconds) $account
  Assert-MonitorsClean $monitors 'Nach Cargo-Build'
  $outputProof = $null
  $builtOutput = $null
  if ($cargoProbe.code -eq 0 -and $rustcProbe.code -eq 0 -and $build.code -eq 0) {
    $builtPath = [IO.Path]::GetFullPath([IO.Path]::Combine($expectedTarget, ([string]$run.targetOutputFile).Replace('/', [IO.Path]::DirectorySeparatorChar)))
    if (-not $builtPath.StartsWith($expectedTarget + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Fail 'Build-Output verlaesst das private Cargo-Target.' }
    $builtOutput = Open-BuiltOutput $builtPath ([Int64]$run.expectedOutputBytes) 'Tatsaechlich gebauter Operational-Validator'
    $outputProof = $builtOutput.proof
  }
  $result = [ordered]@{
    build = $build
    cargo = $cargoProbe
    isolation = [ordered]@{ mode = 'ephemeral-local-build-account-v1'; principalSidSha256 = Hash-Text $account.Sid }
    output = $outputProof
    rustc = $rustcProbe
  }
  $json = $result | ConvertTo-Json -Depth 20 -Compress
  [Console]::Out.WriteLine('RESULT ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
  [Console]::Out.Flush()
  if ($cargoProbe.code -ne 0 -or $rustcProbe.code -ne 0 -or $build.code -ne 0) { exit $(if ($build.code -ne 0) { $build.code } else { 124 }) }
  $publicationLine = [Console]::In.ReadLine()
  if ($publicationLine -ceq 'ABORT') { exit 124 }
  if ([string]::IsNullOrEmpty($publicationLine) -or -not $publicationLine.StartsWith('PUBLISH ')) { Fail 'Windows-Build-Anker erhielt keinen handle-relativen Publikationsauftrag.' }
  $publication = Decode-Json $publicationLine.Substring(8) 'Publikationsauftrag'
  $publicationNames = @($publication.PSObject.Properties.Name | Sort-Object)
  if (($publicationNames -join ',') -cne 'binary,provenance,receipt') { Fail 'Publikationsauftrag besitzt unerwartete Ausgaben.' }
  foreach ($id in @('provenance', 'receipt')) {
    $names = @($publication.$id.PSObject.Properties.Name | Sort-Object)
    if (($names -join ',') -cne 'base64,bytes,file,sha256') { Fail "Publikationsauftrag.$id besitzt unerwartete Felder." }
  }
  if ([Int64]$publication.binary.bytes -ne [Int64]$outputProof.bytes -or [string]$publication.binary.sha256 -cne [string]$outputProof.sha256) {
    Fail 'Publikationsauftrag bindet nicht den gehaltenen Cargo-Output.'
  }
  try {
    $provenanceBytes = [Convert]::FromBase64String([string]$publication.provenance.base64)
    $receiptBytes = [Convert]::FromBase64String([string]$publication.receipt.base64)
  } catch { Fail "Publikationsauftrag enthaelt ungueltige Base64-Bytes: $($_.Exception.Message)" }
  $provenanceInput = [IO.MemoryStream]::new($provenanceBytes, $false)
  $receiptInput = [IO.MemoryStream]::new($receiptBytes, $false)
  try {
    $published = [ordered]@{
      provenance = Publish-HeldFile $provenanceInput ([pscustomobject]@{ bytes = [Int64]$publication.provenance.bytes; file = [string]$publication.provenance.file; sha256 = [string]$publication.provenance.sha256 }) 'Build-Provenienz'
      binary = Publish-HeldFile $builtOutput.stream $publication.binary 'Operational-Validator-Rebuild'
      receipt = Publish-HeldFile $receiptInput ([pscustomobject]@{ bytes = [Int64]$publication.receipt.bytes; file = [string]$publication.receipt.file; sha256 = [string]$publication.receipt.sha256 }) 'Rebuild-Receipt'
    }
  } finally {
    $receiptInput.Dispose()
    $provenanceInput.Dispose()
  }
  $publishedJson = $published | ConvertTo-Json -Depth 12 -Compress
  [Console]::Out.WriteLine('PUBLISHED ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($publishedJson)))
  [Console]::Out.Flush()
  $completion = [Console]::In.ReadLine()
  if ($completion -ceq 'ABORT') { Rollback-Published; exit 124 }
  if ($completion -cne 'PUBLICATION_COMPLETE') { Fail 'Windows-Build-Anker erhielt keinen erfolgreichen Publikationsabschluss.' }
  Commit-Published
  $publicationCommitted = $true
} catch {
  Fail $_.Exception.Message
} finally {
  $disposeErrors = [Collections.Generic.List[string]]::new()
  if (-not $publicationCommitted -and $publishedStreams.Count -gt 0) {
    try { Rollback-Published } catch { $disposeErrors.Add($_.Exception.Message) }
  }
  for ($index = $held.Count - 1; $index -ge 0; $index--) {
    try { $held[$index].Dispose() } catch { $disposeErrors.Add($_.Exception.Message) }
  }
  if ($disposeErrors.Count -gt 0) {
    [Console]::Error.WriteLine('Windows-Build-Anker konnte gehaltene Ressourcen oder den ephemeren Build-Account nicht vollstaendig freigeben: ' + [string]::Join(' | ', $disposeErrors))
    exit 125
  }
}
`;
const EXPECTED_NORMALIZATION_FIELDS = Object.freeze([
  Object.freeze({ name: "coff-time-date-stamp", offset: 136, bytes: 4 }),
  Object.freeze({ name: "optional-header-checksum", offset: 216, bytes: 4 }),
]);
const EXPECTED_SECTIONS = Object.freeze([
  Object.freeze({ name: ".text", rawData: "non-empty" }),
  Object.freeze({ name: ".data", rawData: "non-empty" }),
  Object.freeze({ name: ".rdata", rawData: "non-empty" }),
  Object.freeze({ name: ".pdata", rawData: "non-empty" }),
  Object.freeze({ name: ".xdata", rawData: "non-empty" }),
  Object.freeze({ name: ".bss", rawData: "empty" }),
  Object.freeze({ name: ".idata", rawData: "non-empty" }),
  Object.freeze({ name: ".CRT", rawData: "non-empty" }),
  Object.freeze({ name: ".tls", rawData: "non-empty" }),
  Object.freeze({ name: ".reloc", rawData: "non-empty" }),
]);
const ALLOWED_INHERITED_ENVIRONMENT = Object.freeze([]);
const CLEARED_BUILD_ENVIRONMENT = Object.freeze([
  "AR", "CARGO_BUILD_RUSTC", "CARGO_BUILD_RUSTC_WRAPPER", "CARGO_BUILD_TARGET", "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_PROFILE_RELEASE_CODEGEN_UNITS", "CARGO_PROFILE_RELEASE_DEBUG", "CARGO_PROFILE_RELEASE_LTO",
  "CARGO_PROFILE_RELEASE_OPT_LEVEL", "CARGO_PROFILE_RELEASE_PANIC", "CARGO_TARGET_DIR", "CC", "CFLAGS", "CXX",
  "CXXFLAGS", "LDFLAGS", "RUSTC", "RUSTC_BOOTSTRAP", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER",
  "RUSTDOCFLAGS", "RUSTFLAGS", "RUSTUP_TOOLCHAIN", "SOURCE_DATE_EPOCH",
]);
const FIXED_BUILD_ENVIRONMENT = Object.freeze({
  CARGO_BUILD_JOBS: "1",
  CARGO_ENCODED_RUSTFLAGS: "--remap-path-prefix=$HELD_VENDOR_ROOT=$ANNUAL_VENDOR_REMAP_PREFIX",
  CARGO_INCREMENTAL: "0",
  CARGO_NET_OFFLINE: "true",
  CARGO_TERM_COLOR: "never",
});
const WINDOWS_TOOLCHAIN_ANCHOR_MODE = "windows-powershell-held-helper-private-dacl-mitigated-v3";
const WINDOWS_TOOLCHAIN_PLATFORM = "win32";
const WORKFLOW_AUTHORITY = Object.freeze({
  annualExecutorPlan: Object.freeze({
    arguments: ANNUAL_PLAN_ARGUMENTS,
    directContractFile: ANNUAL_DIRECT_CONTRACT,
    maxOutputBytes: 4 * 1024 * 1024,
    mode: "held-helper-independent-supervisor-plan-only-v1",
    planFile: ANNUAL_PLAN_FILE,
    startEvidenceFile: ANNUAL_EXECUTOR_START_EVIDENCE,
    startEvidenceSchema: "zugfolge-operational-validator-annual-executor-start-evidence/v1",
    timeoutMilliseconds: 120_000,
  }),
  artifactAttestation: "github-sigstore-build-provenance-required-v1",
  attestation: Object.freeze({
    bundleFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json",
    predicateType: "https://slsa.dev/provenance/v1",
    verification: Object.freeze({
      command: "gh attestation verify",
      denySelfHostedRunners: true,
      signerWorkflow: "larynxberlin-rgb/Zugfolge/.github/workflows/operational-validator-rebuild-evidence.yml",
    }),
  }),
  environment: "github-hosted-fresh-windows-vm-v1",
  event: "workflow_dispatch",
  repository: "larynxberlin-rgb/Zugfolge",
  requiredRef: "refs/heads/main",
  runnerImages: Object.freeze(["windows-2025", "windows-2022"]),
  workflowFile: ".github/workflows/operational-validator-rebuild-evidence.yml",
});
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\\(?:[^<>:"|?*\x00-\x1f\\/]+\\)*[^<>:"|?*\x00-\x1f\\/]+$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  invariant(Object.keys(value).sort().join(",") === [...keys].sort().join(","), `${label} besitzt unerwartete oder fehlende Felder.`);
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function sameCanonicalValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validatePortableFile(value, label) {
  invariant(typeof value === "string" && PORTABLE_FILE.test(value), `${label} muss ein sicherer relativer POSIX-Dateipfad sein.`);
  for (const segment of value.split("/")) {
    invariant(!segment.endsWith(".") && !WINDOWS_RESERVED_SEGMENT.test(segment), `${label} muss auch unter Windows ein eindeutiger regulaerer Dateipfad sein.`);
  }
  return value;
}

function portableFileSystemKey(value, label) {
  validatePortableFile(value, label);
  return value.split("/").map((segment) => segment.toLowerCase()).join("/");
}

function validateSha256(value, label) {
  invariant(typeof value === "string" && SHA256.test(value), `${label} muss ein kleingeschriebener SHA-256 sein.`);
  return value;
}

function validatePositiveBytes(value, label, maximum = MAX_BINARY_BYTES) {
  invariant(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${label} muss eine positive Bytezahl bis ${maximum} sein.`);
  return value;
}

function validateProof(value, label, maximum = MAX_BINARY_BYTES, { file = false } = {}) {
  exactKeys(value, file ? ["bytes", "file", "sha256"] : ["bytes", "sha256"], label);
  if (file) validatePortableFile(value.file, `${label}.file`);
  validatePositiveBytes(value.bytes, `${label}.bytes`, maximum);
  validateSha256(value.sha256, `${label}.sha256`);
  return value;
}

function validateStringArray(value, expected, label) {
  invariant(Array.isArray(value) && value.length === expected.length, `${label} besitzt die falsche Laenge.`);
  invariant(value.every((entry, index) => entry === expected[index]), `${label} driftet vom festgelegten Wert.`);
  return value;
}

function validateRustcIdentity(value, label = "toolchain.rustc") {
  exactKeys(value, ["commitHash", "host", "llvmVersion", "release"], label);
  invariant(typeof value.release === "string" && VERSION.test(value.release), `${label}.release ist ungueltig.`);
  invariant(typeof value.commitHash === "string" && GIT_COMMIT.test(value.commitHash), `${label}.commitHash ist ungueltig.`);
  invariant(typeof value.host === "string" && TARGET.test(value.host), `${label}.host ist ungueltig.`);
  invariant(typeof value.llvmVersion === "string" && VERSION.test(value.llvmVersion), `${label}.llvmVersion ist ungueltig.`);
  return value;
}

function validateCargoIdentity(value, label = "toolchain.cargo") {
  exactKeys(value, ["commitHash", "host", "release"], label);
  invariant(typeof value.release === "string" && VERSION.test(value.release), `${label}.release ist ungueltig.`);
  invariant(typeof value.commitHash === "string" && GIT_COMMIT.test(value.commitHash), `${label}.commitHash ist ungueltig.`);
  invariant(typeof value.host === "string" && TARGET.test(value.host), `${label}.host ist ungueltig.`);
  return value;
}

function validateTreeProof(value, label, maximumEntries = MAX_SOURCE_TREE_ENTRIES) {
  exactKeys(value, ["fileCount", "manifestSha256", "totalBytes"], label);
  invariant(Number.isSafeInteger(value.fileCount) && value.fileCount > 0 && value.fileCount <= maximumEntries, `${label}.fileCount ist ungueltig.`);
  invariant(Number.isSafeInteger(value.totalBytes) && value.totalBytes > 0, `${label}.totalBytes ist ungueltig.`);
  validateSha256(value.manifestSha256, `${label}.manifestSha256`);
  return value;
}

function validateArchiveProof(value, label, maximumBytes) {
  exactKeys(value, ["bytes", "file", "format", "sha256"], label);
  invariant(value.format === "tar", `${label}.format muss tar sein.`);
  validatePortableFile(value.file, `${label}.file`);
  validatePositiveBytes(value.bytes, `${label}.bytes`, maximumBytes);
  validateSha256(value.sha256, `${label}.sha256`);
  return value;
}

function validateToolchainSpec(value) {
  exactKeys(value, ["anchor", "cargo", "cargoPath", "manifest", "platform", "root", "rustc", "rustcPath"], "toolchain");
  exactKeys(value.anchor, ["helperAssembly", "mode"], "toolchain.anchor");
  invariant(value.anchor.mode === WINDOWS_TOOLCHAIN_ANCHOR_MODE, "toolchain.anchor.mode ist ungueltig.");
  validateProof(value.anchor.helperAssembly, "toolchain.anchor.helperAssembly", MAX_PRODUCER_BYTES, { file: true });
  invariant(value.anchor.helperAssembly.file === WINDOWS_ANCHOR_HELPER, "toolchain.anchor.helperAssembly.file muss das tracked, deterministisch reproduzierbare Helper-Artefakt binden.");
  invariant(value.platform === WINDOWS_TOOLCHAIN_PLATFORM, "Operational-Validator-Rebuild materialisiert PE32+ ausschliesslich auf win32.");
  invariant(typeof value.root === "string" && win32.isAbsolute(value.root) && /^[A-Za-z]:[\\/]/u.test(value.root), "toolchain.root muss ein expliziter absoluter Windows-Pfad sein.");
  validatePortableFile(value.cargoPath, "toolchain.cargoPath");
  validatePortableFile(value.rustcPath, "toolchain.rustcPath");
  invariant(value.cargoPath.toLowerCase().endsWith("/cargo.exe") && value.rustcPath.toLowerCase().endsWith("/rustc.exe"), "toolchain cargo/rustc muessen echte relative EXE-Pfade sein.");
  validateProof(value.manifest, "toolchain.manifest", MAX_TOOLCHAIN_MANIFEST_BYTES, { file: true });
  validateCargoIdentity(value.cargo);
  validateRustcIdentity(value.rustc);
  return value;
}

export function validateOperationalValidatorRebuildSpec(spec) {
  exactKeys(spec, ["authority", "binaries", "build", "pe", "producer", "provenance", "receipt", "releaseId", "schema", "source", "toolchain"], "Operational-Validator-Rebuild-Spec");
  invariant(spec.schema === SPEC_SCHEMA, "Operational-Validator-Rebuild-Spec besitzt ein unbekanntes Schema.");
  invariant(typeof spec.releaseId === "string" && RELEASE_ID.test(spec.releaseId), "Operational-Validator-Rebuild-Spec.releaseId ist ungueltig.");
  const expectedAuthority = {
    ...WORKFLOW_AUTHORITY,
    attestation: {
      ...WORKFLOW_AUTHORITY.attestation,
      subjects: [
        spec?.binaries?.rebuilt?.file,
        spec?.provenance?.file,
        spec?.receipt?.file,
        spec?.binaries?.preserved?.file,
        WORKFLOW_AUTHORITY.annualExecutorPlan.directContractFile,
        WORKFLOW_AUTHORITY.annualExecutorPlan.planFile,
        `${WORKFLOW_AUTHORITY.annualExecutorPlan.planFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
        WORKFLOW_AUTHORITY.annualExecutorPlan.startEvidenceFile,
        `${WORKFLOW_AUTHORITY.annualExecutorPlan.startEvidenceFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
      ],
    },
  };
  invariant(sameCanonicalValue(spec.authority, expectedAuthority), "Operational-Validator-Rebuild-Spec.authority driftet vom GitHub-Actions-Trust-Root oder von den Spec-gebundenen Subjects.");
  exactKeys(spec.source, ["archive", "cargoLock", "commit", "tree", "vendor"], "source");
  validateArchiveProof(spec.source.archive, "source.archive", MAX_ARCHIVE_BYTES);
  invariant(typeof spec.source.commit === "string" && GIT_COMMIT.test(spec.source.commit), "source.commit ist ungueltig.");
  validateProof(spec.source.cargoLock, "source.cargoLock", MAX_SPEC_BYTES, { file: true });
  validateTreeProof(spec.source.tree, "source.tree");
  exactKeys(spec.source.vendor, ["archive", "cargoConfig", "remapPrefix", "tree"], "source.vendor");
  validateArchiveProof(spec.source.vendor.archive, "source.vendor.archive", MAX_VENDOR_ARCHIVE_BYTES);
  validateProof(spec.source.vendor.cargoConfig, "source.vendor.cargoConfig", MAX_SPEC_BYTES, { file: true });
  invariant(spec.source.vendor.cargoConfig.file === ".cargo/config.toml", "source.vendor.cargoConfig muss die gepinnte .cargo/config.toml binden.");
  invariant(typeof spec.source.vendor.remapPrefix === "string" && WINDOWS_ABSOLUTE_PATH.test(spec.source.vendor.remapPrefix), "source.vendor.remapPrefix muss den exakten absoluten Annual-Quellpraefix binden.");
  validateTreeProof(spec.source.vendor.tree, "source.vendor.tree");
  exactKeys(spec.build, ["command", "environmentPolicy", "processLimits", "profile", "targetOutputFile"], "build");
  validateStringArray(spec.build.command, EXPECTED_BUILD_COMMAND, "build.command");
  invariant(spec.build.profile === "release", "build.profile muss release sein.");
  invariant(spec.build.targetOutputFile === "release/zugfolge-infra-release.exe", "build.targetOutputFile driftet vom externen Cargo-Release-Output.");
  exactKeys(spec.build.environmentPolicy, ["allowedInherited", "cleared", "fixed", "targetDirectory"], "build.environmentPolicy");
  validateStringArray(spec.build.environmentPolicy.allowedInherited, ALLOWED_INHERITED_ENVIRONMENT, "build.environmentPolicy.allowedInherited");
  validateStringArray(spec.build.environmentPolicy.cleared, CLEARED_BUILD_ENVIRONMENT, "build.environmentPolicy.cleared");
  invariant(sameCanonicalValue(spec.build.environmentPolicy.fixed, FIXED_BUILD_ENVIRONMENT), "build.environmentPolicy.fixed driftet vom Offline-Buildvertrag.");
  invariant(spec.build.environmentPolicy.targetDirectory === "external-empty-create-new", "build.environmentPolicy.targetDirectory ist ungueltig.");
  exactKeys(spec.build.processLimits, ["maxOutputBytes", "timeoutMilliseconds"], "build.processLimits");
  invariant(spec.build.processLimits.maxOutputBytes === MAX_PROCESS_OUTPUT_BYTES, `build.processLimits.maxOutputBytes muss ${MAX_PROCESS_OUTPUT_BYTES} sein.`);
  invariant(Number.isSafeInteger(spec.build.processLimits.timeoutMilliseconds) && spec.build.processLimits.timeoutMilliseconds >= 100 && spec.build.processLimits.timeoutMilliseconds <= 900_000, "build.processLimits.timeoutMilliseconds ist ungueltig.");
  validateToolchainSpec(spec.toolchain);
  exactKeys(spec.binaries, ["preserved", "rebuilt"], "binaries");
  validateProof(spec.binaries.preserved, "binaries.preserved", MAX_BINARY_BYTES, { file: true });
  exactKeys(spec.binaries.rebuilt, ["expectedBytes", "file"], "binaries.rebuilt");
  validatePortableFile(spec.binaries.rebuilt.file, "binaries.rebuilt.file");
  validatePositiveBytes(spec.binaries.rebuilt.expectedBytes, "binaries.rebuilt.expectedBytes");
  invariant(spec.binaries.preserved.bytes === spec.binaries.rebuilt.expectedBytes, "Preserved und official rebuild muessen dieselbe Bytezahl besitzen.");
  invariant(spec.binaries.preserved.file !== spec.binaries.rebuilt.file, "Preserved und official rebuild muessen getrennte Pfade besitzen.");
  exactKeys(spec.pe, ["allowedNormalizationFields", "format", "machine", "maxBinaryBytes", "normalizedSha256", "sections"], "pe");
  invariant(spec.pe.format === "PE32+" && spec.pe.machine === 0x8664, "pe muss AMD64 PE32+ sein.");
  invariant(spec.pe.maxBinaryBytes === MAX_BINARY_BYTES, `pe.maxBinaryBytes muss ${MAX_BINARY_BYTES} sein.`);
  validateSha256(spec.pe.normalizedSha256, "pe.normalizedSha256");
  invariant(sameCanonicalValue(spec.pe.allowedNormalizationFields, EXPECTED_NORMALIZATION_FIELDS), "pe.allowedNormalizationFields muss exakt die PE-Felder bei 136/216 umfassen.");
  invariant(sameCanonicalValue(spec.pe.sections, EXPECTED_SECTIONS), "pe.sections muss die zehn festgelegten Sections enthalten.");
  exactKeys(spec.producer, PRODUCER_IDS, "producer");
  for (const [id, file] of [["bundle", PRODUCER_BUNDLE], ["entrypoint", PRODUCER_ENTRYPOINT], ["executionPins", PRODUCER_EXECUTION_PINS], ["implementation", PRODUCER_IMPLEMENTATION]]) {
    validateProof(spec.producer[id], `producer.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant(spec.producer[id].file === file, `producer.${id}.file driftet.`);
  }
  exactKeys(spec.provenance, ["file"], "provenance");
  validatePortableFile(spec.provenance.file, "provenance.file");
  exactKeys(spec.receipt, ["file"], "receipt");
  validatePortableFile(spec.receipt.file, "receipt.file");
  invariant(sameCanonicalValue(spec.authority.attestation.subjects, [
    spec.binaries.rebuilt.file,
    spec.provenance.file,
    spec.receipt.file,
    spec.binaries.preserved.file,
    spec.authority.annualExecutorPlan.directContractFile,
    spec.authority.annualExecutorPlan.planFile,
    `${spec.authority.annualExecutorPlan.planFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
    spec.authority.annualExecutorPlan.startEvidenceFile,
    `${spec.authority.annualExecutorPlan.startEvidenceFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
  ]), "authority.attestation.subjects muss exakt Rebuild, preserved Executor, Direct-Contract, Annual-Plan/Completion und Startbeleg/Completion binden.");
  const files = [
    spec.binaries.preserved.file, spec.binaries.rebuilt.file, spec.source.archive.file, spec.source.vendor.archive.file,
    spec.toolchain.anchor.helperAssembly.file, spec.toolchain.manifest.file, spec.provenance.file, spec.receipt.file,
    spec.authority.attestation.bundleFile, spec.authority.annualExecutorPlan.directContractFile,
    spec.authority.annualExecutorPlan.planFile,
    `${spec.authority.annualExecutorPlan.planFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
    spec.authority.annualExecutorPlan.startEvidenceFile,
    `${spec.authority.annualExecutorPlan.startEvidenceFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
  ];
  invariant(new Set(files.map((file) => portableFileSystemKey(file, `Spec-Dateipfad ${file}`))).size === files.length, "Binary-, Input-, Manifest- und Provenienzpfade muessen getrennt sein.");
  return spec;
}

function workflowAuthorityReceipt(spec) {
  const env = process.env;
  invariant(env.GITHUB_ACTIONS === "true", "Releasefaehiger Rebuild-Evidence-v3 darf nur in GitHub Actions materialisiert werden.");
  invariant(env.GITHUB_REPOSITORY === spec.authority.repository, "GitHub-Actions-Repository driftet vom Annual-Trust-Root.");
  invariant(env.GITHUB_EVENT_NAME === spec.authority.event, "GitHub-Actions-Event ist fuer den Release-Rebuild nicht autorisiert.");
  invariant(env.GITHUB_REF === spec.authority.requiredRef && env.GITHUB_REF_PROTECTED === "true", "Release-Rebuild muss auf dem geschuetzten Annual-Ref laufen.");
  invariant(env.RUNNER_ENVIRONMENT === "github-hosted" && env.RUNNER_OS === "Windows" && env.RUNNER_ARCH === "X64", "Release-Rebuild benoetigt eine frische GitHub-hosted Windows-x64-VM.");
  invariant(spec.authority.runnerImages.includes(env.ZUGFOLGE_REBUILD_RUNNER_IMAGE), "GitHub-Runner-Image driftet vom Annual-Vertrag.");
  invariant(typeof env.GITHUB_SHA === "string" && GIT_COMMIT.test(env.GITHUB_SHA), "GitHub-Actions-Commit ist nicht vollstaendig gebunden.");
  invariant(typeof env.GITHUB_RUN_ID === "string" && /^[1-9]\d*$/u.test(env.GITHUB_RUN_ID), "GitHub-Actions-Run-ID ist ungueltig.");
  invariant(typeof env.GITHUB_RUN_ATTEMPT === "string" && /^[1-9]\d*$/u.test(env.GITHUB_RUN_ATTEMPT), "GitHub-Actions-Run-Attempt ist ungueltig.");
  const expectedWorkflowPrefix = `${spec.authority.repository}/${spec.authority.workflowFile}@`;
  invariant(typeof env.GITHUB_WORKFLOW_REF === "string" && env.GITHUB_WORKFLOW_REF.startsWith(expectedWorkflowPrefix), "GitHub-Actions-Workflow-Ref driftet vom Annual-Vertrag.");
  return {
    artifactAttestation: spec.authority.artifactAttestation,
    attestation: spec.authority.attestation,
    attestationState: "pending-external-verification",
    artifactName: `operational-validator-rebuild-${spec.releaseId}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    commit: env.GITHUB_SHA,
    environment: spec.authority.environment,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    repository: env.GITHUB_REPOSITORY,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    runId: env.GITHUB_RUN_ID,
    runnerImage: env.ZUGFOLGE_REBUILD_RUNNER_IMAGE,
    workflowRef: env.GITHUB_WORKFLOW_REF,
  };
}

function validateWorkflowAuthorityReceipt(value, spec, label) {
  exactKeys(value, ["artifactAttestation", "artifactName", "attestation", "attestationState", "commit", "environment", "event", "ref", "repository", "runAttempt", "runId", "runnerImage", "workflowRef"], label);
  invariant(value.artifactAttestation === spec.authority.artifactAttestation && value.environment === spec.authority.environment, `${label} besitzt den falschen Attestation-/Umgebungsvertrag.`);
  invariant(value.attestationState === "pending-external-verification" && sameCanonicalValue(value.attestation, spec.authority.attestation), `${label} behauptet keine ehrliche externe Attestierungsgrenze.`);
  invariant(value.repository === spec.authority.repository && value.event === spec.authority.event && value.ref === spec.authority.requiredRef, `${label} bindet falsches Repository, Event oder Ref.`);
  invariant(typeof value.commit === "string" && GIT_COMMIT.test(value.commit), `${label}.commit ist ungueltig.`);
  invariant(typeof value.runId === "string" && /^[1-9]\d*$/u.test(value.runId) && Number.isSafeInteger(value.runAttempt) && value.runAttempt > 0, `${label} bindet keinen gueltigen Workflow-Lauf.`);
  invariant(spec.authority.runnerImages.includes(value.runnerImage), `${label}.runnerImage ist ungueltig.`);
  invariant(value.workflowRef.startsWith(`${spec.authority.repository}/${spec.authority.workflowFile}@`), `${label}.workflowRef ist ungueltig.`);
  invariant(value.artifactName === `operational-validator-rebuild-${spec.releaseId}-${value.runId}-${value.runAttempt}`, `${label}.artifactName driftet vom gebundenen Lauf.`);
  return value;
}

function pathKey(path) {
  const value = resolve(path).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedIdentity(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameIdentitySizeMtime(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function filesystemIdentity(metadata) {
  return { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
}

function validateFilesystemIdentity(value, label) {
  exactKeys(value, ["dev", "ino"], label);
  invariant(typeof value.dev === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value.dev), `${label}.dev ist ungueltig.`);
  invariant(typeof value.ino === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value.ino), `${label}.ino ist ungueltig.`);
  return value;
}

function matchesFilesystemIdentity(metadata, value) {
  return metadata.dev.toString() === value.dev && metadata.ino.toString() === value.ino;
}

function isContained(rootInput, targetInput, { allowRoot = false } = {}) {
  const value = relative(resolve(rootInput), resolve(targetInput));
  return (allowRoot && value === "") || (value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function regularDirectorySnapshot(pathInput, label) {
  const path = resolve(pathInput);
  const metadata = await lstat(path, { bigint: true });
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} muss ein regulaeres Verzeichnis ohne Symlink/Junction sein.`);
  invariant(pathKey(await realpath(path)) === pathKey(path), `${label} enthaelt einen Symlink-/Junction-Pfad.`);
  return { path, metadata };
}

async function assertDirectoryIdentity(path, expected, label) {
  const actual = await lstat(path, { bigint: true });
  invariant(actual.isDirectory() && !actual.isSymbolicLink() && sameIdentity(actual, expected), `${label} wurde fremd ersetzt.`);
}

async function assertRegularDirectorySnapshot(snapshot, label) {
  const actual = await lstat(snapshot.path, { bigint: true });
  invariant(
    actual.isDirectory()
      && !actual.isSymbolicLink()
      && sameIdentity(actual, snapshot.metadata)
      && pathKey(await realpath(snapshot.path)) === pathKey(snapshot.path),
    `${label} wurde fremd ersetzt oder ueber einen Symlink/Junction umgebunden.`,
  );
}

async function assertNoSymlinkPath(rootInput, targetInput, label, { leafMayBeMissing = false } = {}) {
  const root = resolve(rootInput);
  const target = resolve(targetInput);
  invariant(isContained(root, target, { allowRoot: true }), `${label} verlaesst seine Wurzel.`);
  const parts = relative(root, target).split(sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = resolve(cursor, parts[index]);
    let metadata;
    try {
      metadata = await lstat(cursor, { bigint: true });
    } catch (error) {
      if (leafMayBeMissing && index === parts.length - 1 && error?.code === "ENOENT") return;
      throw error;
    }
    invariant(!metadata.isSymbolicLink(), `${label} enthaelt einen Symlink/Junction: ${cursor}`);
    if (index < parts.length - 1) invariant(metadata.isDirectory(), `${label} besitzt einen ungueltigen Elternpfad.`);
  }
}

function resolveWorkspaceFile(workspaceRoot, portableFile, label) {
  validatePortableFile(portableFile, label);
  const value = resolve(workspaceRoot, ...portableFile.split("/"));
  invariant(isContained(workspaceRoot, value), `${label} verlaesst workspaceRoot.`);
  return value;
}

async function regularFileSnapshot(root, pathInput, label, maximumBytes, { allowEmpty = false, retainHandle = false } = {}) {
  const path = resolve(pathInput);
  await assertNoSymlinkPath(root, path, label);
  const pathBefore = await lstat(path, { bigint: true });
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink(), `${label} muss eine regulaere Datei sein.`);
  invariant((allowEmpty ? pathBefore.size >= 0n : pathBefore.size > 0n) && pathBefore.size <= BigInt(maximumBytes), `${label} ist leer oder ueberschreitet ${maximumBytes} Bytes.`);
  const handle = await open(path, "r");
  let retained = false;
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && sameIdentity(pathBefore, before), `${label} wurde vor dem Lesen ersetzt.`);
    const bytes = Buffer.alloc(Number(before.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    invariant(bytesRead === bytes.length, `${label} wurde nicht vollstaendig gelesen.`);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    invariant(unchangedIdentity(before, after) && unchangedIdentity(after, pathAfter), `${label} wurde waehrend des Lesens veraendert.`);
    const result = { bytes, identity: after, path, proof: { bytes: bytes.length, sha256: sha256(bytes) } };
    if (retainHandle) {
      result.handle = handle;
      retained = true;
    }
    return result;
  } finally {
    if (!retained) await handle.close();
  }
}

function proofMatches(actual, expected, label) {
  invariant(
    actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
    `${label} driftet von seiner Byte-/SHA-256-Bindung (actual ${actual.bytes}/${actual.sha256}, expected ${expected.bytes}/${expected.sha256}).`,
  );
}

async function assertCreateNewTarget(pathInput, label) {
  const path = resolve(pathInput);
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return path;
    throw error;
  }
  const error = new Error(`${label} existiert bereits und darf nicht ersetzt werden: ${path}`);
  error.code = "EEXIST";
  throw error;
}


function encodedOutput(bytes) {
  return { base64: bytes.toString("base64"), bytes: bytes.length, sha256: sha256(bytes) };
}

function validateEncodedOutput(value, label) {
  exactKeys(value, ["base64", "bytes", "sha256"], label);
  invariant(typeof value.base64 === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value.base64), `${label}.base64 ist ungueltig.`);
  invariant(Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= MAX_PROCESS_OUTPUT_BYTES, `${label}.bytes ist ungueltig.`);
  validateSha256(value.sha256, `${label}.sha256`);
  const bytes = Buffer.from(value.base64, "base64");
  invariant(bytes.length === value.bytes && sha256(bytes) === value.sha256, `${label} besitzt keine konsistente Bindung.`);
}

function parseKeyedVerboseVersion(stdout, label) {
  const lines = stdout.toString("utf8").replace(/\r\n/g, "\n").trim().split("\n");
  invariant(lines.length >= 2, `${label} -vV ist unvollstaendig.`);
  const values = new Map();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return { firstLine: lines[0], values };
}

function validateToolchainManifest(value, spec) {
  exactKeys(value, ["directories", "files", "id", "schema"], "Toolchain-Manifest");
  invariant(value.schema === TOOLCHAIN_MANIFEST_SCHEMA && typeof value.id === "string" && value.id.length > 0, "Toolchain-Manifest besitzt falsches Schema oder ID.");
  invariant(Array.isArray(value.directories) && value.directories.length > 0 && value.directories.length <= 10_000, "Toolchain-Manifest.directories ist ungueltig.");
  invariant(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 10_000, "Toolchain-Manifest.files ist ungueltig.");
  const seen = new Set();
  let previous = "";
  for (const directory of value.directories) {
    validatePortableFile(directory, `Toolchain-Manifest-Verzeichnis ${directory}`);
    const key = portableFileSystemKey(directory, `Toolchain-Manifest-Verzeichnis ${directory}`);
    invariant(!seen.has(key), `Toolchain-Manifest besitzt einen kollidierenden Verzeichnispfad: ${directory}`);
    invariant(previous === "" || previous.localeCompare(directory, "en") < 0, "Toolchain-Manifest.directories muss streng kanonisch sortiert sein.");
    const segments = directory.split("/");
    if (segments.length > 1) invariant(seen.has(portableFileSystemKey(segments.slice(0, -1).join("/"), "Toolchain-Manifest-Verzeichnis-Parent")), `Toolchain-Manifest-Verzeichnis ${directory} besitzt keinen manifestierten Parent.`);
    seen.add(key);
    previous = directory;
  }
  const directoryKeys = new Set(seen);
  previous = "";
  let totalBytes = 0;
  for (const entry of value.files) {
    validateProof(entry, "Toolchain-Manifest.files[]", MAX_TOOL_BYTES, { file: true });
    const key = portableFileSystemKey(entry.file, `Toolchain-Datei ${entry.file}`);
    invariant(!seen.has(key), `Toolchain-Manifest besitzt einen kollidierenden Pfad: ${entry.file}`);
    invariant(previous === "" || previous.localeCompare(entry.file, "en") < 0, "Toolchain-Manifest.files muss streng kanonisch sortiert sein.");
    seen.add(key);
    const segments = entry.file.split("/");
    if (segments.length > 1) invariant(directoryKeys.has(portableFileSystemKey(segments.slice(0, -1).join("/"), "Toolchain-Datei-Parent")), `Toolchain-Datei ${entry.file} besitzt keinen manifestierten Parent.`);
    previous = entry.file;
    totalBytes += entry.bytes;
    invariant(Number.isSafeInteger(totalBytes), "Toolchain-Manifest-Gesamtgroesse ist ungueltig.");
  }
  invariant(seen.has(portableFileSystemKey(spec.toolchain.cargoPath, "toolchain.cargoPath")), "Toolchain-Manifest enthaelt cargo nicht.");
  invariant(seen.has(portableFileSystemKey(spec.toolchain.rustcPath, "toolchain.rustcPath")), "Toolchain-Manifest enthaelt rustc nicht.");
  return { directoryCount: value.directories.length, fileCount: value.files.length, id: value.id, manifestSha256: sha256(canonicalBytes({ directories: value.directories, files: value.files })), totalBytes };
}

function decodeAnchorProcessResult(value, label) {
  exactKeys(value, ["code", "stderr", "stdout"], label);
  invariant(Number.isSafeInteger(value.code), `${label}.code ist ungueltig.`);
  invariant(typeof value.stderr === "string" && typeof value.stdout === "string", `${label} besitzt ungueltige Ausgaben.`);
  const stderr = Buffer.from(value.stderr, "base64");
  const stdout = Buffer.from(value.stdout, "base64");
  invariant(stderr.length + stdout.length <= MAX_PROCESS_OUTPUT_BYTES, `${label}-Ausgabe ist unerwartet gross.`);
  return { code: value.code, stderr, stdout };
}

function windowsBuildAnchorRequestLine(value) {
  return `${Buffer.from(JSON.stringify(value), "utf8").toString("base64")}\n`;
}

function windowsBuildAnchorSafeDiagnostic(chunks) {
  const bytes = Buffer.concat(chunks);
  const tail = bytes.subarray(Math.max(0, bytes.length - MAX_WINDOWS_ANCHOR_DIAGNOSTIC_BYTES)).toString("utf8");
  const lines = tail.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const match = /^(?:ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=(NET_USER_ADD|NET_USER_DELETE|NET_USER_DELETE_VERIFY) status=([1-9][0-9]{0,9})(?: parameter=(0|[1-9][0-9]{0,9}))?|ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=(PROCESS_WITH_LOGON|PROCESS_FROM_ANCHOR) status=([1-9][0-9]{0,9}))$/u.exec(line);
    if (match === null) continue;
    const code = match[1] ?? match[4];
    const status = Number(match[2] ?? match[5]);
    const parameter = match[3] === undefined ? undefined : Number(match[3]);
    if (status > 0 && status <= 0xffff_ffff
      && (parameter === undefined || parameter <= 0xffff_ffff)
      && ((code === "NET_USER_ADD" && (status === 87) === (parameter !== undefined))
        || ((code === "NET_USER_DELETE" || code === "NET_USER_DELETE_VERIFY" || code === "PROCESS_WITH_LOGON" || code === "PROCESS_FROM_ANCHOR")
          && parameter === undefined))) return line;
  }
  return "";
}

async function startWindowsBuildAnchor({ anchoredParents, buildParent, buildRootLeaf, hooks, spec, workspaceRoot }) {
  invariant(process.platform === "win32", "Operational-Validator-Rebuild-Materialisierung ist fuer PE32+ ausschliesslich auf win32 zulaessig.");
  invariant(Array.isArray(anchoredParents) && anchoredParents.length > 0, "Windows-Build-Anker benoetigt mindestens einen Output-Parent.");
  invariant(typeof buildRootLeaf === "string" && /^\.operational-validator-rebuild-v3-[a-f0-9-]{36}$/u.test(buildRootLeaf), "Windows-Build-Anker erhielt keinen gueltigen create-new Buildroot-Leaf.");
  const parentRequests = anchoredParents
    .map((parent) => ({ identity: filesystemIdentity(parent.metadata), path: resolve(parent.path) }))
    .sort((left, right) => pathKey(left.path).localeCompare(pathKey(right.path)));
  invariant(new Set(parentRequests.map(({ path }) => pathKey(path))).size === parentRequests.length, "Windows-Build-Anker erhielt doppelte Output-Parents.");
  const buildParentRequest = { identity: filesystemIdentity(buildParent.metadata), path: resolve(buildParent.path) };
  invariant(parentRequests.some((entry) => pathKey(entry.path) === pathKey(buildParentRequest.path) && sameCanonicalValue(entry.identity, buildParentRequest.identity)), "Buildroot-Parent fehlt in der verankerten Parentmenge.");
  const buildRoot = resolve(buildParent.path, buildRootLeaf);
  invariant(dirname(buildRoot) === resolve(buildParent.path), "Create-new Buildroot-Leaf verlaesst seinen Parent.");
  const paths = {
    helper: resolveWorkspaceFile(workspaceRoot, spec.toolchain.anchor.helperAssembly.file, "toolchain.anchor.helperAssembly.file"),
    manifest: resolveWorkspaceFile(workspaceRoot, spec.toolchain.manifest.file, "toolchain.manifest.file"),
    source: resolveWorkspaceFile(workspaceRoot, spec.source.archive.file, "source.archive.file"),
    vendor: resolveWorkspaceFile(workspaceRoot, spec.source.vendor.archive.file, "source.vendor.archive.file"),
  };
  for (const [id, path] of Object.entries(paths)) await assertNoSymlinkPath(workspaceRoot, path, `${id}-Input`);
  if (hooks.beforeWindowsBuildAnchor) await hooks.beforeWindowsBuildAnchor({ paths: { ...paths }, toolchainRoot: spec.toolchain.root });
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const compressedAnchor = gzipSync(Buffer.from(WINDOWS_BUILD_ANCHOR, "utf8"), { level: 9 });
  const bootstrap = `$s=[Console]::OpenStandardInput();$h=[byte[]]::new(4);$o=0;while($o-lt 4){$n=$s.Read($h,$o,4-$o);if($n-le 0){throw 'Anchor-Laengenheader fehlt.'};$o+=$n};$l=[BitConverter]::ToInt32($h,0);if($l-le 0-or$l-gt 4194304){throw 'Anchor-Laenge ist ungueltig.'};$b=[byte[]]::new($l);$o=0;while($o-lt$l){$n=$s.Read($b,$o,$l-$o);if($n-le 0){throw 'Anchor-Payload endet vorzeitig.'};$o+=$n};$m=[IO.MemoryStream]::new($b);$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);try{& ([ScriptBlock]::Create($r.ReadToEnd()))}finally{$r.Dispose();$g.Dispose();$m.Dispose()}`;
  const encodedCommand = Buffer.from(bootstrap, "utf16le").toString("base64");
  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand], {
    env: {
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Windows\\System32;C:\\Windows",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Windows\\System32",
      TMP: "C:\\Windows\\System32",
      WINDIR: "C:\\Windows",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_PROCESS_OUTPUT_BYTES) stderr.push(chunk);
    else child.kill();
  });
  const lines = [];
  const waiters = [];
  let pending = "";
  let closed;
  let protocolError;
  let stdoutBytes = 0;
  const closePromise = new Promise((resolveClose, rejectClose) => {
    child.once("error", (error) => {
      protocolError ??= error;
      while (waiters.length > 0) waiters.shift().reject(protocolError);
      rejectClose(error);
    });
    child.once("close", (code, signal) => {
      closed = { code, signal };
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (protocolError) waiter.reject(protocolError);
        else waiter.resolve(undefined);
      }
      resolveClose(closed);
    });
  });
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
      protocolError ??= new Error("Windows-Build-Anker-Ausgabe ist unerwartet gross.");
      child.kill();
      return;
    }
    pending += chunk.toString("utf8");
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      pending = pending.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
    }
  });
  const nextLine = () => {
    if (protocolError) return Promise.reject(protocolError);
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolveLine, rejectLine) => waiters.push({ reject: rejectLine, resolve: resolveLine }));
  };
  const nextLineBounded = async (label) => {
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`${label} ueberschritt das Anchor-Zeitlimit.`);
        protocolError ??= error;
        child.kill();
        reject(error);
      }, spec.build.processLimits.timeoutMilliseconds);
    });
    try { return await Promise.race([nextLine(), timeoutPromise]); }
    finally { clearTimeout(timeout); }
  };
  child.stdin.on("error", () => {});
  try {
  const anchorHeader = Buffer.alloc(4);
  anchorHeader.writeUInt32LE(compressedAnchor.length, 0);
  child.stdin.write(anchorHeader);
  child.stdin.write(compressedAnchor);
  child.stdin.write(windowsBuildAnchorRequestLine({
    anchoredParents: parentRequests,
    buildParent: buildParentRequest,
    buildRootLeaf,
    cargoPath: spec.toolchain.cargoPath,
    helper: { path: paths.helper, bytes: spec.toolchain.anchor.helperAssembly.bytes, sha256: spec.toolchain.anchor.helperAssembly.sha256 },
    manifest: { path: paths.manifest, bytes: spec.toolchain.manifest.bytes, sha256: spec.toolchain.manifest.sha256 },
    processLimits: spec.build.processLimits,
    rustcPath: spec.toolchain.rustcPath,
    source: { path: paths.source, bytes: spec.source.archive.bytes, sha256: spec.source.archive.sha256 },
    toolchainRoot: spec.toolchain.root,
    vendor: { path: paths.vendor, bytes: spec.source.vendor.archive.bytes, sha256: spec.source.vendor.archive.sha256 },
    vendorRemapPrefix: spec.source.vendor.remapPrefix,
  }));
  const ready = await nextLineBounded("Windows-Build-Anker-Handshake");
  if (typeof ready !== "string" || !ready.startsWith("ANCHOR_READY ")) {
    child.stdin.end();
    const end = await closePromise;
    const details = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(`Windows-Build-Anker band Inputs/Toolchain nicht fail-closed (${end.code ?? end.signal ?? "unknown"})${details ? `: ${details}` : ""}`);
  }
  const readyEnvelope = parseJson(Buffer.from(ready.slice("ANCHOR_READY ".length), "base64"), "Windows-Build-Anker-Ready");
  exactKeys(readyEnvelope, ["anchoredParents", "buildRoot"], "Windows-Build-Anker-Ready");
  invariant(resolve(readyEnvelope.buildRoot) === buildRoot, "Windows-Build-Anker meldete einen falschen create-new Buildroot-Pfad.");
  invariant(Array.isArray(readyEnvelope.anchoredParents) && readyEnvelope.anchoredParents.length === parentRequests.length, "Windows-Build-Anker meldete eine falsche Output-Parent-Menge.");
  for (let index = 0; index < parentRequests.length; index += 1) {
    const actual = readyEnvelope.anchoredParents[index];
    exactKeys(actual, ["identity", "path"], `Windows-Build-Anker-Ready.anchoredParents[${index}]`);
    validateFilesystemIdentity(actual.identity, `Windows-Build-Anker-Ready.anchoredParents[${index}].identity`);
    invariant(pathKey(actual.path) === pathKey(parentRequests[index].path) && sameCanonicalValue(actual.identity, parentRequests[index].identity), "Windows-Build-Anker band nicht exakt die angeforderte Output-Parent-Menge.");
  }
  if (hooks.afterWindowsBuildAnchorReady) await hooks.afterWindowsBuildAnchorReady({ anchoredParents: parentRequests, buildRoot, paths: { ...paths }, toolchainRoot: spec.toolchain.root });
  const [helperSource, source, vendor, manifestSource] = await Promise.all([
    regularFileSnapshot(workspaceRoot, paths.helper, "Exklusiv gehaltene Anchor-Helper-Assembly", MAX_PRODUCER_BYTES),
    regularFileSnapshot(workspaceRoot, paths.source, "Exklusiv gehaltenes Source-TAR", MAX_ARCHIVE_BYTES),
    regularFileSnapshot(workspaceRoot, paths.vendor, "Exklusiv gehaltenes Vendor-TAR", MAX_VENDOR_ARCHIVE_BYTES),
    regularFileSnapshot(workspaceRoot, paths.manifest, "Exklusiv gehaltenes Toolchain-Manifest", MAX_TOOLCHAIN_MANIFEST_BYTES),
  ]);
  proofMatches(helperSource.proof, spec.toolchain.anchor.helperAssembly, "Exklusiv gehaltene Anchor-Helper-Assembly");
  proofMatches(source.proof, spec.source.archive, "Exklusiv gehaltenes Source-TAR");
  proofMatches(vendor.proof, spec.source.vendor.archive, "Exklusiv gehaltenes Vendor-TAR");
  proofMatches(manifestSource.proof, spec.toolchain.manifest, "Exklusiv gehaltenes Toolchain-Manifest");
  const manifest = parseJson(manifestSource.bytes, "Toolchain-Manifest");
  invariant(manifestSource.bytes.equals(canonicalBytes(manifest)), "Toolchain-Manifest ist nicht kanonisch.");
  const manifestInventory = validateToolchainManifest(manifest, spec);
  let finished = false;
  let extracted = false;
  let publication = false;
  let buildRootIdentity;
  const closeAnchorBounded = async (label) => {
    let timeout;
    let timedOut = false;
    const timeoutPromise = new Promise((resolveTimeout) => {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
        resolveTimeout(undefined);
      }, 5_000);
    });
    const end = await Promise.race([closePromise, timeoutPromise]);
    clearTimeout(timeout);
    if (timedOut) {
      const killed = await closePromise;
      throw new Error(`${label} schloss den Windows-Build-Anker nicht innerhalb von 5000 ms (${killed.code ?? killed.signal ?? "unknown"}).`);
    }
    return end;
  };
  return {
    buildRoot,
    get buildRootIdentity() { return buildRootIdentity; },
    inputs: { helper: helperSource, manifest: { ...spec.toolchain.manifest, ...manifestInventory }, source, vendor },
    async abort() {
      if (finished) return;
      finished = true;
      let hookError;
      if (publication && hooks.beforeWindowsAnchoredPublicationRollback) {
        try { await hooks.beforeWindowsAnchoredPublicationRollback(); } catch (error) { hookError = error; }
      }
      child.stdin.write("ABORT\n");
      child.stdin.end();
      let closeError;
      try { await closeAnchorBounded("Windows-Build-Anker-Abbruch"); } catch (error) { closeError = error; }
      if (hookError && closeError) throw new AggregateError([hookError, closeError], "Publikations-Rollback-Hook und Anchor-Abbruch sind fehlgeschlagen.");
      if (hookError) throw hookError;
      if (closeError) throw closeError;
    },
    async extract({ sourceAudit, vendorAudit }) {
      invariant(!finished && !extracted, "Windows-Build-Anker erhielt einen doppelten Extraktionsplan.");
      const plan = (audit) => ({
        directories: audit.directories,
        files: audit.files.map((entry) => ({ bytes: entry.bytes, file: entry.file, offset: entry.offset, sha256: entry.sha256 })),
      });
      if (hooks.beforeWindowsAnchoredExtraction) await hooks.beforeWindowsAnchoredExtraction({ buildRoot: resolve(buildRoot) });
      child.stdin.write(windowsBuildAnchorRequestLine({ source: plan(sourceAudit), vendor: plan(vendorAudit) }));
      const line = await nextLineBounded("Windows-Build-Anker-Extraktion");
      if (typeof line !== "string" || !line.startsWith("EXTRACTED ")) {
        child.stdin.end();
        const end = await closeAnchorBounded("Windows-Build-Anker-Extraktionsfehler");
        finished = true;
        const diagnostic = windowsBuildAnchorSafeDiagnostic(stderr);
        throw new Error(`Windows-Build-Anker bestaetigte die interne Slice-Extraktion nicht (${end.code ?? end.signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}.`);
      }
      const envelope = parseJson(Buffer.from(line.slice("EXTRACTED ".length), "base64"), "Windows-Build-Anker-Extraktion");
      exactKeys(envelope, ["buildRootIdentity"], "Windows-Build-Anker-Extraktion");
      validateFilesystemIdentity(envelope.buildRootIdentity, "Windows-Build-Anker-Extraktion.buildRootIdentity");
      buildRootIdentity = envelope.buildRootIdentity;
      extracted = true;
      return { buildRoot, buildRootIdentity };
    },
    async run({ cargoHome, sourceDirectory, targetDirectory, tempDirectory }) {
      invariant(!finished && extracted, "Windows-Build-Anker wurde bereits abgeschlossen oder hat nicht extrahiert.");
      if (hooks.beforeWindowsAnchoredBuild) await hooks.beforeWindowsAnchoredBuild({ cargoHome, sourceDirectory, targetDirectory, tempDirectory });
      child.stdin.write(windowsBuildAnchorRequestLine({
        cargoConfig: resolve(sourceDirectory, ...spec.source.vendor.cargoConfig.file.split("/")),
        cargoHome,
        cargoManifest: resolve(sourceDirectory, "Cargo.toml"),
        command: spec.build.command,
        expectedOutputBytes: spec.binaries.rebuilt.expectedBytes,
        sourceDirectory,
        targetOutputFile: spec.build.targetOutputFile,
        targetDirectory,
        tempDirectory,
      }));
      const line = await nextLineBounded("Windows-Build-Anker-Build");
      if (typeof line !== "string" || !line.startsWith("RESULT ")) {
        child.stdin.end();
        const end = await closePromise;
        finished = true;
        const diagnostic = windowsBuildAnchorSafeDiagnostic(stderr);
        throw new Error(`Windows-Build-Anker lieferte kein Ergebnis (${end.code ?? end.signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}.`);
      }
      const envelope = parseJson(Buffer.from(line.slice("RESULT ".length), "base64"), "Windows-Build-Anker-Ergebnis");
      exactKeys(envelope, ["build", "cargo", "isolation", "output", "rustc"], "Windows-Build-Anker-Ergebnis");
      exactKeys(envelope.isolation, ["mode", "principalSidSha256"], "Windows-Build-Anker.isolation");
      invariant(envelope.isolation.mode === "ephemeral-local-build-account-v1", "Windows-Build-Anker verwendete keine getrennte Build-Identitaet.");
      validateSha256(envelope.isolation.principalSidSha256, "Windows-Build-Anker.isolation.principalSidSha256");
      const result = {
        build: decodeAnchorProcessResult(envelope.build, "Windows-Build-Anker.build"),
        cargo: decodeAnchorProcessResult(envelope.cargo, "Windows-Build-Anker.cargo"),
        isolation: envelope.isolation,
        output: null,
        rustc: decodeAnchorProcessResult(envelope.rustc, "Windows-Build-Anker.rustc"),
      };
      if (result.build.code !== 0 || result.cargo.code !== 0 || result.rustc.code !== 0) {
        child.stdin.end();
        const end = await closePromise;
        finished = true;
        const tail = result.build.stderr.toString("utf8").slice(-4096).trim() || Buffer.concat(stderr).toString("utf8").slice(-4096).trim();
        const error = new Error(`Exklusiv verankerter Windows-Rebuild endete mit ${result.build.code}${tail ? `: ${tail}` : ""}`);
        error.result = result;
        throw error;
      }
      exactKeys(envelope.output, ["bytes", "identity", "sha256"], "Windows-Build-Anker.output");
      invariant(envelope.output.bytes === spec.binaries.rebuilt.expectedBytes, "Windows-Build-Anker.output.bytes driftet.");
      validateSha256(envelope.output.sha256, "Windows-Build-Anker.output.sha256");
      validateFilesystemIdentity(envelope.output.identity, "Windows-Build-Anker.output.identity");
      result.output = envelope.output;
      return result;
    },
    async publish({ binary, provenance, receipt }) {
      invariant(!finished && extracted && !publication, "Windows-Build-Anker kann die Outputs nicht publizieren.");
      for (const [id, value] of Object.entries({ binary, provenance, receipt })) {
        exactKeys(value, id === "binary" ? ["bytes", "path", "sha256"] : ["bytes", "bytesValue", "path", "sha256"], `Windows-Build-Anker-Publikation.${id}`);
        invariant(Number.isSafeInteger(value.bytes) && value.bytes > 0, `Windows-Build-Anker-Publikation.${id}.bytes ist ungueltig.`);
        validateSha256(value.sha256, `Windows-Build-Anker-Publikation.${id}.sha256`);
        invariant(isAbsolute(value.path), `Windows-Build-Anker-Publikation.${id}.path ist nicht absolut.`);
        if (id !== "binary") {
          invariant(Buffer.isBuffer(value.bytesValue) && value.bytesValue.length === value.bytes && sha256(value.bytesValue) === value.sha256,
            `Windows-Build-Anker-Publikation.${id} driftet von seinen gehaltenen Bytes.`);
        }
      }
      const request = {
        binary: { bytes: binary.bytes, file: resolve(binary.path), sha256: binary.sha256 },
        provenance: { base64: provenance.bytesValue.toString("base64"), bytes: provenance.bytes, file: resolve(provenance.path), sha256: provenance.sha256 },
        receipt: { base64: receipt.bytesValue.toString("base64"), bytes: receipt.bytes, file: resolve(receipt.path), sha256: receipt.sha256 },
      };
      if (hooks.beforeWindowsAnchoredPublication) await hooks.beforeWindowsAnchoredPublication({ request });
      child.stdin.write(`PUBLISH ${Buffer.from(JSON.stringify(request), "utf8").toString("base64")}\n`);
      const line = await nextLineBounded("Windows-Build-Anker-Publikation");
      invariant(typeof line === "string" && line.startsWith("PUBLISHED "), "Windows-Build-Anker bestaetigte die handle-relative Publikation nicht.");
      const envelope = parseJson(Buffer.from(line.slice("PUBLISHED ".length), "base64"), "Windows-Build-Anker-Publikation");
      exactKeys(envelope, ["binary", "provenance", "receipt"], "Windows-Build-Anker-Publikation");
      for (const [id, expected] of Object.entries({ binary, provenance, receipt })) {
        exactKeys(envelope[id], ["bytes", "identity", "sha256"], `Windows-Build-Anker-Publikation.${id}`);
        validateFilesystemIdentity(envelope[id].identity, `Windows-Build-Anker-Publikation.${id}.identity`);
        proofMatches(envelope[id], expected, `Windows-Build-Anker-Publikation.${id}`);
      }
      publication = true;
      if (hooks.afterWindowsAnchoredPublication) await hooks.afterWindowsAnchoredPublication({ publication: envelope });
      return envelope;
    },
    async completePublication() {
      invariant(!finished && extracted && publication, "Windows-Build-Anker kann die Publikation nicht mehr abschliessen.");
      child.stdin.write("PUBLICATION_COMPLETE\n");
      child.stdin.end();
      const end = await closeAnchorBounded("Windows-Build-Anker-Publikationsabschluss");
      finished = true;
      const details = Buffer.concat(stderr).toString("utf8").slice(-8192).trim();
      invariant(!end.signal && end.code === 0, `Windows-Build-Anker konnte gehaltene Inputs/Outputs nicht sauber abschliessen (${end.code ?? end.signal ?? "unknown"})${details ? `: ${details}` : ""}.`);
    },
  };
  } catch (error) {
    child.stdin.end();
    child.kill();
    let closeError;
    try { await closePromise; } catch (failure) { closeError = failure; }
    if (closeError && closeError !== error) throw new AggregateError([error, closeError], "Windows-Build-Anker-Handshake und Child-Close sind fehlgeschlagen.");
    throw error;
  }
}

function toolchainReceiptFromAnchor(result, spec, manifest, runnerAnchorHelper) {
  const rustcVerbose = parseKeyedVerboseVersion(result.rustc.stdout, "rustc");
  const cargoVerbose = parseKeyedVerboseVersion(result.cargo.stdout, "cargo");
  const rustcIdentity = { commitHash: rustcVerbose.values.get("commit-hash"), host: rustcVerbose.values.get("host"), llvmVersion: rustcVerbose.values.get("LLVM version"), release: rustcVerbose.values.get("release") };
  const cargoIdentity = { commitHash: cargoVerbose.values.get("commit-hash"), host: cargoVerbose.values.get("host"), release: cargoVerbose.values.get("release") };
  invariant(rustcVerbose.firstLine.startsWith(`rustc ${rustcIdentity.release} (${String(rustcIdentity.commitHash).slice(0, 9)} `), "rustc -vV besitzt eine inkonsistente Kopfzeile.");
  invariant(cargoVerbose.firstLine.startsWith(`cargo ${cargoIdentity.release} (${String(cargoIdentity.commitHash).slice(0, 9)} `), "cargo -vV besitzt eine inkonsistente Kopfzeile.");
  invariant(sameCanonicalValue(rustcIdentity, spec.toolchain.rustc), "rustc-Toolchain driftet von der Rebuild-Spec.");
  invariant(sameCanonicalValue(cargoIdentity, spec.toolchain.cargo), "cargo-Toolchain driftet von der Rebuild-Spec.");
  return {
    anchor: {
      buildPrincipal: result.isolation,
      helperAssembly: spec.toolchain.anchor.helperAssembly,
      inputIsolation: "private-create-new-owner-rights-protected-dacl-read-execute-v1",
      mode: spec.toolchain.anchor.mode,
      mutationMonitoring: "read-directory-changes-monotonic-subtree-v1",
      processTreeMitigation: "identity-anchor-parent-handle-list-no-local-inherit-no-low-label-prefer-system32-job-empty-v4",
      runnerAnchorHelper,
    },
    cargo: { command: ["cargo", "-vV"], identity: cargoIdentity, output: encodedOutput(result.cargo.stdout), relativePath: spec.toolchain.cargoPath },
    manifest,
    platform: spec.toolchain.platform,
    rootPathSha256: sha256(Buffer.from(pathKey(spec.toolchain.root), "utf8")),
    rustc: { command: ["rustc", "-vV"], identity: rustcIdentity, output: encodedOutput(result.rustc.stdout), relativePath: spec.toolchain.rustcPath },
  };
}

function readUInt16(buffer, offset, label) {
  invariant(Number.isSafeInteger(offset) && offset >= 0 && offset + 2 <= buffer.length, `${label} liegt ausserhalb der PE-Datei.`);
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset, label) {
  invariant(Number.isSafeInteger(offset) && offset >= 0 && offset + 4 <= buffer.length, `${label} liegt ausserhalb der PE-Datei.`);
  return buffer.readUInt32LE(offset);
}

function parseSectionName(buffer, offset) {
  const raw = buffer.subarray(offset, offset + 8);
  const zero = raw.indexOf(0);
  const name = (zero === -1 ? raw : raw.subarray(0, zero)).toString("ascii");
  invariant(name.length > 0 && /^[.A-Za-z0-9_$]+$/.test(name), "PE enthaelt einen ungueltigen Section-Namen.");
  return name;
}

function inspectPe(buffer, label, expectedMachine) {
  invariant(buffer.length >= 512 && buffer.subarray(0, 2).equals(Buffer.from("MZ", "ascii")), `${label} ist kein MZ/PE-Binary.`);
  const peOffset = readUInt32(buffer, 0x3c, `${label}.peOffset`);
  invariant(peOffset >= 0x40 && peOffset + 24 <= buffer.length && buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0])), `${label} besitzt keinen gueltigen PE-Header.`);
  const coffOffset = peOffset + 4;
  const machine = readUInt16(buffer, coffOffset, `${label}.machine`);
  const numberOfSections = readUInt16(buffer, coffOffset + 2, `${label}.numberOfSections`);
  const timeDateStampOffset = coffOffset + 4;
  const sizeOfOptionalHeader = readUInt16(buffer, coffOffset + 16, `${label}.sizeOfOptionalHeader`);
  const optionalHeaderOffset = coffOffset + 20;
  const optionalHeaderMagic = readUInt16(buffer, optionalHeaderOffset, `${label}.optionalHeaderMagic`);
  const checkSumOffset = optionalHeaderOffset + 64;
  invariant(machine === expectedMachine && optionalHeaderMagic === 0x20b && sizeOfOptionalHeader >= 68, `${label} ist nicht das erwartete AMD64 PE32+.`);
  invariant(numberOfSections > 0 && numberOfSections <= 96, `${label} besitzt eine unplausible Section-Anzahl.`);
  const sectionTableOffset = optionalHeaderOffset + sizeOfOptionalHeader;
  invariant(sectionTableOffset + numberOfSections * 40 <= buffer.length, `${label}.Section-Tabelle liegt ausserhalb der Datei.`);
  const sections = [];
  for (let index = 0; index < numberOfSections; index += 1) {
    const offset = sectionTableOffset + index * 40;
    const name = parseSectionName(buffer, offset);
    const virtualSize = readUInt32(buffer, offset + 8, `${label}.${name}.virtualSize`);
    const virtualAddress = readUInt32(buffer, offset + 12, `${label}.${name}.virtualAddress`);
    const rawDataBytes = readUInt32(buffer, offset + 16, `${label}.${name}.rawDataBytes`);
    const rawDataPointer = readUInt32(buffer, offset + 20, `${label}.${name}.rawDataPointer`);
    invariant(rawDataBytes === 0 || (rawDataPointer > 0 && rawDataPointer + rawDataBytes <= buffer.length), `${label}.${name} besitzt einen ungueltigen Raw-Bereich.`);
    const raw = rawDataBytes === 0 ? Buffer.alloc(0) : buffer.subarray(rawDataPointer, rawDataPointer + rawDataBytes);
    sections.push({ index, name, rawDataBytes, rawDataPointer, rawSha256: sha256(raw), virtualAddress, virtualSize });
  }
  invariant(new Set(sections.map(({ name }) => name)).size === sections.length, `${label} besitzt doppelte Section-Namen.`);
  return {
    header: {
      coffTimeDateStamp: { offset: timeDateStampOffset, value: readUInt32(buffer, timeDateStampOffset, `${label}.coffTimeDateStamp`) },
      dosSignature: "MZ", machine, numberOfSections,
      optionalHeaderCheckSum: { offset: checkSumOffset, value: readUInt32(buffer, checkSumOffset, `${label}.optionalHeaderCheckSum`) },
      optionalHeaderMagic, peOffset, peSignature: "PE\\0\\0", sectionTableOffset, sizeOfOptionalHeader,
    },
    sections,
  };
}

function inspectPePair(preservedBytes, rebuiltBytes, spec) {
  invariant(preservedBytes.length === rebuiltBytes.length, "Preserved und official rebuilt Validator besitzen verschiedene Dateilaengen.");
  const preserved = inspectPe(preservedBytes, "Preserved Validator", spec.pe.machine);
  const rebuilt = inspectPe(rebuiltBytes, "Official Rebuilt Validator", spec.pe.machine);
  invariant(preserved.header.coffTimeDateStamp.offset === 136 && rebuilt.header.coffTimeDateStamp.offset === 136, "COFF TimeDateStamp liegt nicht bei Offset 136.");
  invariant(preserved.header.optionalHeaderCheckSum.offset === 216 && rebuilt.header.optionalHeaderCheckSum.offset === 216, "OptionalHeader CheckSum liegt nicht bei Offset 216.");
  invariant(preserved.sections.length === EXPECTED_SECTIONS.length && rebuilt.sections.length === EXPECTED_SECTIONS.length, "PE besitzt nicht exakt zehn erwartete Sections.");
  const sections = preserved.sections.map((left, index) => {
    const right = rebuilt.sections[index];
    const expected = EXPECTED_SECTIONS[index];
    invariant(left.name === expected.name && right.name === expected.name, `PE-Section ${index} driftet in Name oder Reihenfolge.`);
    invariant(left.rawDataBytes === right.rawDataBytes && left.virtualSize === right.virtualSize, `PE-Section ${left.name} driftet in Groesse.`);
    invariant(left.rawSha256 === right.rawSha256, `PE-Section ${left.name} besitzt verschiedene Raw-SHA-256.`);
    invariant(expected.rawData === "empty" ? left.rawDataBytes === 0 : left.rawDataBytes > 0, `PE-Section ${left.name} verletzt ihren Raw-Datenvertrag.`);
    return { index, name: left.name, preservedRawSha256: left.rawSha256, rawDataBytes: left.rawDataBytes, rawDataPointer: left.rawDataPointer, rebuiltRawSha256: right.rawSha256, virtualAddress: left.virtualAddress, virtualSize: left.virtualSize };
  });
  const allowed = new Set(EXPECTED_NORMALIZATION_FIELDS.flatMap((field) => Array.from({ length: field.bytes }, (_, index) => field.offset + index)));
  const differingOffsets = [];
  for (let offset = 0; offset < preservedBytes.length; offset += 1) {
    if (preservedBytes[offset] === rebuiltBytes[offset]) continue;
    invariant(allowed.has(offset), `Validator-Binaries unterscheiden sich am nicht erlaubten Offset ${offset}.`);
    differingOffsets.push(offset);
  }
  const normalizedPreserved = Buffer.from(preservedBytes);
  const normalizedRebuilt = Buffer.from(rebuiltBytes);
  for (const field of EXPECTED_NORMALIZATION_FIELDS) {
    normalizedPreserved.fill(0, field.offset, field.offset + field.bytes);
    normalizedRebuilt.fill(0, field.offset, field.offset + field.bytes);
  }
  invariant(normalizedPreserved.equals(normalizedRebuilt), "Validator-Binaries sind ausserhalb der PE-Normalisierungsfelder nicht bytegleich.");
  const preservedNormalizedSha256 = sha256(normalizedPreserved);
  const rebuiltNormalizedSha256 = sha256(normalizedRebuilt);
  invariant(preservedNormalizedSha256 === spec.pe.normalizedSha256 && rebuiltNormalizedSha256 === spec.pe.normalizedSha256, "Normalisierter Validator-SHA-256 driftet von der Spec.");
  return { allowedNormalizationFields: EXPECTED_NORMALIZATION_FIELDS, differingOffsets, headers: { preserved: preserved.header, rebuilt: rebuilt.header }, normalized: { expectedSha256: spec.pe.normalizedSha256, preservedSha256: preservedNormalizedSha256, rebuiltSha256: rebuiltNormalizedSha256 }, sections };
}

async function auditExtractedTree(rootInput) {
  const root = resolve(rootInput);
  const manifest = [];
  async function visit(directory, prefix) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const portable = prefix ? `${prefix}/${entry.name}` : entry.name;
      validatePortableFile(portable, `Git-Archivpfad ${portable}`);
      const metadata = await lstat(path, { bigint: true });
      invariant(!metadata.isSymbolicLink(), `Git-Archiv enthaelt einen Symlink: ${portable}`);
      if (metadata.isDirectory()) await visit(path, portable);
      else {
        invariant(metadata.isFile() && metadata.size <= BigInt(MAX_SOURCE_FILE_BYTES), `Git-Archivdatei ${portable} ist unzulaessig.`);
        const source = await regularFileSnapshot(root, path, `Archivdatei ${portable}`, MAX_SOURCE_FILE_BYTES, { allowEmpty: true });
        manifest.push({ bytes: source.proof.bytes, file: portable, sha256: source.proof.sha256 });
      }
    }
  }
  await visit(root, "");
  invariant(manifest.length > 0 && manifest.length <= 100_000, "Extrahierter Git-Tree besitzt eine unplausible Dateianzahl.");
  manifest.sort((left, right) => left.file.localeCompare(right.file, "en"));
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0);
  invariant(Number.isSafeInteger(totalBytes), "Extrahierter Git-Tree ist zu gross.");
  return { fileCount: manifest.length, manifestSha256: sha256(canonicalBytes(manifest)), totalBytes };
}

function tarText(bytes, offset, length) {
  const field = bytes.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return (zero < 0 ? field : field.subarray(0, zero)).toString("utf8");
}

function tarOctal(bytes, offset, length, label) {
  const text = tarText(bytes, offset, length).replace(/^\s+|\s+$/g, "");
  invariant(/^[0-7]+$/.test(text), `${label} ist kein kanonisches Oktalfeld.`);
  const value = Number.parseInt(text, 8);
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} ist ausserhalb des sicheren Zahlenbereichs.`);
  return value;
}

function parsePaxRecords(bytes, label) {
  const records = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    invariant(space > offset, `${label} besitzt einen ungueltigen Record-Laengenprefix.`);
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    invariant(/^[1-9][0-9]*$/.test(lengthText), `${label} besitzt eine ungueltige Record-Laenge.`);
    const length = Number(lengthText);
    invariant(Number.isSafeInteger(length) && length > space - offset + 3 && offset + length <= bytes.length, `${label} Record liegt ausserhalb des PAX-Headers.`);
    const record = bytes.subarray(space + 1, offset + length);
    invariant(record.at(-1) === 0x0a, `${label} Record endet nicht mit LF.`);
    const payload = record.subarray(0, -1).toString("utf8");
    const equals = payload.indexOf("=");
    invariant(equals > 0, `${label} Record besitzt kein Schluessel/Wert-Paar.`);
    const key = payload.slice(0, equals);
    invariant(!Object.hasOwn(records, key), `${label} besitzt einen doppelten PAX-Schluessel ${key}.`);
    records[key] = payload.slice(equals + 1);
    offset += length;
  }
  invariant(offset === bytes.length, `${label} besitzt nach dem letzten Record Restbytes.`);
  return records;
}

function auditPinnedRegularTar(bytes, { archive, expectedComment, expectedTree, label, requiredFile }) {
  invariant(bytes.length === archive.bytes && sha256(bytes) === archive.sha256, `${label} driftet vom Spec-Pin.`);
  invariant(bytes.length % 512 === 0, `${label} besitzt keine vollstaendige 512-Byte-Blockstruktur.`);
  const manifest = [];
  const files = [];
  const directories = new Set();
  const explicitPaths = new Map();
  const observedPathSpellings = new Map();
  const pathsWithDescendants = new Set();
  let globalPaxComment;
  let sawGlobalPax = false;
  let localPax;
  let offset = 0;
  let headerCount = 0;
  let sawEnd = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      invariant(bytes.length - offset >= 1024, `${label} besitzt weniger als zwei Endmarker-Bloecke.`);
      invariant(bytes.subarray(offset).every((byte) => byte === 0), `${label} besitzt Nicht-Null-Restdaten hinter dem Endmarker.`);
      break;
    }
    headerCount += 1;
    invariant(headerCount <= MAX_SOURCE_TREE_ENTRIES, `${label} besitzt zu viele Header-Eintraege.`);
    invariant(tarText(header, 257, 6) === "ustar" && tarText(header, 263, 2) === "00", `${label} besitzt keinen kanonischen ustar-Header.`);
    const storedChecksum = tarOctal(header, 148, 8, "TAR.checksum");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    invariant(checksum === storedChecksum, `${label} besitzt einen ungueltigen Header-Checksum.`);
    const headerSize = tarOctal(header, 124, 12, "TAR.size");
    const type = String.fromCharCode(header[156] || 0x30);
    const dataOffset = offset + 512;
    invariant(dataOffset + headerSize <= bytes.length, `${label}-Eintrag liegt ausserhalb des Archivs.`);
    const data = bytes.subarray(dataOffset, dataOffset + headerSize);
    const paddedEnd = dataOffset + Math.ceil(headerSize / 512) * 512;
    invariant(paddedEnd <= bytes.length, `${label}-Eintrag besitzt keinen vollstaendigen Padding-Block.`);
    invariant(bytes.subarray(dataOffset + headerSize, paddedEnd).every((byte) => byte === 0), `${label}-Eintrag besitzt Nicht-Null-Padding.`);
    if (type === "g") {
      invariant(!sawGlobalPax && offset === 0 && localPax === undefined, `${label} besitzt einen doppelten oder falsch positionierten globalen PAX-Header.`);
      const records = parsePaxRecords(data, "Globaler PAX-Header");
      exactKeys(records, ["comment"], "Globaler PAX-Header");
      globalPaxComment = records.comment;
      sawGlobalPax = true;
    } else if (type === "x") {
      invariant(localPax === undefined, `${label} besitzt verschachtelte lokale PAX-Header.`);
      localPax = parsePaxRecords(data, "Lokaler PAX-Header");
      exactKeys(localPax, ["path"], "Lokaler PAX-Header");
    } else {
      const prefix = tarText(header, 345, 155);
      const headerName = tarText(header, 0, 100);
      const file = localPax?.path ?? (prefix ? `${prefix}/${headerName}` : headerName);
      localPax = undefined;
      invariant(typeof file === "string" && file.length > 0, `${label} besitzt einen leeren Pfad.`);
      const directoryMarker = file.endsWith("/");
      const normalizedFile = directoryMarker ? file.slice(0, -1) : file;
      const normalizedKey = portableFileSystemKey(normalizedFile, `${label}-Pfad ${file}`);
      invariant(tarText(header, 157, 100) === "", `${label} ${file} besitzt ein unerwartetes Linkziel.`);
      invariant(type === "0" || type === "5", `${label} besitzt einen verbotenen Eintragstyp ${type} fuer ${file}.`);
      invariant(type === "5" ? directoryMarker && data.length === 0 : !directoryMarker, `${label} ${file} besitzt keinen kanonischen Datei-/Verzeichnispfad.`);
      invariant(!explicitPaths.has(normalizedKey), `${label} besitzt einen unter Windows doppelten oder kollidierenden Datei- oder Verzeichniseintrag: ${normalizedFile}`);
      invariant(!observedPathSpellings.has(normalizedKey) || observedPathSpellings.get(normalizedKey) === normalizedFile, `${label} verwendet fuer denselben Windows-Pfad verschiedene Schreibweisen: ${normalizedFile}`);
      observedPathSpellings.set(normalizedKey, normalizedFile);
      const segments = normalizedFile.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const ancestor = segments.slice(0, index).join("/");
        const ancestorKey = portableFileSystemKey(ancestor, `${label}-Vorfahre ${ancestor}`);
        invariant(!observedPathSpellings.has(ancestorKey) || observedPathSpellings.get(ancestorKey) === ancestor, `${label} verwendet fuer denselben Windows-Vorfahren verschiedene Schreibweisen: ${ancestor}`);
        observedPathSpellings.set(ancestorKey, ancestor);
        invariant(explicitPaths.get(ancestorKey) !== "file", `${label} besitzt einen Pfad unter der regulaeren Datei ${ancestor}.`);
        pathsWithDescendants.add(ancestorKey);
        directories.add(ancestor);
      }
      if (type === "0") invariant(!pathsWithDescendants.has(normalizedKey), `${label}-Datei ${normalizedFile} kollidiert mit bereits vorhandenen Nachfahren.`);
      explicitPaths.set(normalizedKey, type === "0" ? "file" : "directory");
      if (type === "0") {
        invariant(data.length <= MAX_SOURCE_FILE_BYTES, `${label}-Datei ${normalizedFile} ueberschreitet ${MAX_SOURCE_FILE_BYTES} Bytes.`);
        manifest.push({ bytes: data.length, file: normalizedFile, sha256: sha256(data) });
        files.push({ bytes: data.length, file: normalizedFile, offset: dataOffset, sha256: sha256(data) });
        invariant(manifest.length <= MAX_SOURCE_TREE_ENTRIES, `${label} besitzt zu viele regulaere Dateien.`);
      } else directories.add(normalizedFile);
    }
    offset = paddedEnd;
  }
  invariant(sawEnd && manifest.length > 0 && localPax === undefined, `${label} besitzt keinen vollstaendigen Endmarker oder Dateibaum.`);
  invariant(globalPaxComment === expectedComment, `${label}-PAX-Kommentar bindet nicht den Spec-Pin.`);
  manifest.sort((left, right) => left.file.localeCompare(right.file, "en"));
  files.sort((left, right) => left.file.localeCompare(right.file, "en"));
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0);
  const extractedTree = { fileCount: manifest.length, manifestSha256: sha256(canonicalBytes(manifest)), totalBytes };
  invariant(sameCanonicalValue(extractedTree, expectedTree), `${label}-Tree driftet vom vollstaendigen Spec-Manifest.`);
  let required;
  if (requiredFile) {
    required = manifest.find(({ file }) => file === requiredFile.file);
    invariant(required !== undefined, `${label} enthaelt ${requiredFile.file} nicht.`);
    proofMatches({ bytes: required.bytes, sha256: required.sha256 }, requiredFile, `${label} ${requiredFile.file}`);
  }
  return {
    directories: [...directories].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right, "en")),
    extractedTree,
    files,
    manifest,
    required,
  };
}

function auditPinnedSourceArchive(bytes, spec) {
  const audit = auditPinnedRegularTar(bytes, {
    archive: spec.source.archive,
    expectedComment: spec.source.commit,
    expectedTree: spec.source.tree,
    label: "Commit-TAR",
    requiredFile: spec.source.cargoLock,
  });
  return { ...audit, cargoLock: { file: audit.required.file, bytes: audit.required.bytes, sha256: audit.required.sha256 } };
}

function auditPinnedVendorArchive(bytes, spec) {
  return auditPinnedRegularTar(bytes, {
    archive: spec.source.vendor.archive,
    expectedComment: "cargo-vendor-tree-v1",
    expectedTree: spec.source.vendor.tree,
    label: "Cargo-Vendor-TAR",
    requiredFile: spec.source.vendor.cargoConfig,
  });
}

async function validateProducerProofs({ producerProofs, spec, workspaceRoot: _workspaceRoot }) {
  exactKeys(producerProofs, PRODUCER_IDS, "producerProofs");
  const result = {};
  for (const id of PRODUCER_IDS) {
    validateProof(producerProofs[id], `producerProofs.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant(sameCanonicalValue(producerProofs[id], spec.producer[id]), `producerProofs.${id} driftet vom externen Spec-Pin.`);
    result[id] = { ...producerProofs[id] };
  }
  return result;
}

async function validateSpecInputs({ spec, specBytes, specFile, workspaceRoot }) {
  validateOperationalValidatorRebuildSpec(spec);
  const supplied = Buffer.from(specBytes);
  invariant(supplied.length > 0 && supplied.length <= MAX_SPEC_BYTES && supplied.equals(canonicalBytes(spec)), "specBytes ist nicht die kanonische Rebuild-Spec.");
  const path = resolve(specFile);
  invariant(isContained(workspaceRoot, path), "specFile verlaesst workspaceRoot.");
  return { bytes: supplied.length, file: relative(workspaceRoot, path).split(sep).join("/"), path, sha256: sha256(supplied) };
}

function sourceArchiveEvidence({ sourceAudit, sourceProof, spec, vendorAudit, vendorProof }) {
  return {
    archive: { embeddedCommit: spec.source.commit, file: spec.source.archive.file, format: spec.source.archive.format, ...sourceProof },
    cargoLock: { ...sourceAudit.cargoLock },
    extractedTree: sourceAudit.extractedTree,
    materialization: {
      commit: spec.source.commit,
      mode: "pinned-preexisting-archive",
      treeManifestSha256: sourceAudit.extractedTree.manifestSha256,
    },
    vendor: {
      archive: { file: spec.source.vendor.archive.file, format: spec.source.vendor.archive.format, ...vendorProof },
      cargoConfig: { ...spec.source.vendor.cargoConfig },
      extractedTree: vendorAudit.extractedTree,
      materialization: {
        mode: "pinned-preexisting-cargo-vendor-archive",
        treeManifestSha256: vendorAudit.extractedTree.manifestSha256,
      },
      remapPrefix: spec.source.vendor.remapPrefix,
    },
  };
}

async function pathExists(path) {
  try { await lstat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function cleanupOwnedBuildRoot(parent, stagingRoot, stagingIdentity, hooks = {}) {
  await assertDirectoryIdentity(parent.path, parent.metadata, "Build-Elternverzeichnis vor konservativer Retention");
  const current = await lstat(stagingRoot, { bigint: true });
  invariant(current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, stagingIdentity), "Privater Buildbaum driftete; Retention laesst alle Pfade unangetastet.");
  if (hooks.beforeBuildRootRetention) await hooks.beforeBuildRootRetention({ stagingRoot });
  const final = await lstat(stagingRoot, { bigint: true });
  invariant(unchangedIdentity(current, final), "Privater Buildbaum driftete waehrend der konservativen Retention; alle Pfade bleiben unangetastet.");
  await assertDirectoryIdentity(parent.path, parent.metadata, "Build-Elternverzeichnis nach konservativer Retention");
  return { mode: "private-build-root-retained-v1", path: stagingRoot };
}


function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch (error) { throw new Error(`${label} ist kein gueltiges JSON.`, { cause: error }); }
}

function validateToolchainReceipt(toolchain, spec) {
  exactKeys(toolchain, ["anchor", "cargo", "manifest", "platform", "rootPathSha256", "rustc"], "Receipt.toolchain");
  exactKeys(toolchain.anchor, ["buildPrincipal", "helperAssembly", "inputIsolation", "mode", "mutationMonitoring", "processTreeMitigation", "runnerAnchorHelper"], "Receipt.toolchain.anchor");
  exactKeys(toolchain.anchor.buildPrincipal, ["mode", "principalSidSha256"], "Receipt.toolchain.anchor.buildPrincipal");
  invariant(toolchain.anchor.buildPrincipal.mode === "ephemeral-local-build-account-v1", "Receipt.toolchain.anchor.buildPrincipal.mode driftet.");
  validateSha256(toolchain.anchor.buildPrincipal.principalSidSha256, "Receipt.toolchain.anchor.buildPrincipal.principalSidSha256");
  invariant(sameCanonicalValue(toolchain.anchor.helperAssembly, spec.toolchain.anchor.helperAssembly), "Receipt.toolchain.anchor.helperAssembly driftet.");
  validateProof(toolchain.anchor.runnerAnchorHelper, "Receipt.toolchain.anchor.runnerAnchorHelper", MAX_PRODUCER_BYTES, { file: true });
  invariant(sameCanonicalValue(toolchain.anchor.runnerAnchorHelper, spec.toolchain.anchor.helperAssembly), "Receipt.toolchain.anchor.runnerAnchorHelper driftet von derselben Annual-gepinnten Helper-Assembly.");
  invariant(toolchain.anchor.inputIsolation === "private-create-new-owner-rights-protected-dacl-read-execute-v1", "Receipt.toolchain.anchor.inputIsolation driftet.");
  invariant(toolchain.anchor.mode === spec.toolchain.anchor.mode, "Receipt.toolchain.anchor.mode driftet.");
  invariant(toolchain.anchor.mutationMonitoring === "read-directory-changes-monotonic-subtree-v1", "Receipt.toolchain.anchor.mutationMonitoring driftet.");
  invariant(toolchain.anchor.processTreeMitigation === "identity-anchor-parent-handle-list-no-local-inherit-no-low-label-prefer-system32-job-empty-v4", "Receipt.toolchain.anchor.processTreeMitigation driftet.");
  invariant(toolchain.platform === spec.toolchain.platform, "Receipt.toolchain.platform driftet.");
  validateSha256(toolchain.rootPathSha256, "Receipt.toolchain.rootPathSha256");
  invariant(toolchain.rootPathSha256 === sha256(Buffer.from(pathKey(spec.toolchain.root), "utf8")), "Receipt.toolchain.rootPathSha256 driftet.");
  exactKeys(toolchain.manifest, ["bytes", "directoryCount", "file", "fileCount", "id", "manifestSha256", "sha256", "totalBytes"], "Receipt.toolchain.manifest");
  validateProof({ bytes: toolchain.manifest.bytes, file: toolchain.manifest.file, sha256: toolchain.manifest.sha256 }, "Receipt.toolchain.manifest.fileProof", MAX_TOOLCHAIN_MANIFEST_BYTES, { file: true });
  invariant(sameCanonicalValue({ bytes: toolchain.manifest.bytes, file: toolchain.manifest.file, sha256: toolchain.manifest.sha256 }, spec.toolchain.manifest), "Receipt.toolchain.manifest driftet vom Spec-Pin.");
  invariant(Number.isSafeInteger(toolchain.manifest.directoryCount) && toolchain.manifest.directoryCount > 0, "Receipt.toolchain.manifest.directoryCount ist ungueltig.");
  invariant(Number.isSafeInteger(toolchain.manifest.fileCount) && toolchain.manifest.fileCount > 0, "Receipt.toolchain.manifest.fileCount ist ungueltig.");
  invariant(Number.isSafeInteger(toolchain.manifest.totalBytes) && toolchain.manifest.totalBytes > 0, "Receipt.toolchain.manifest.totalBytes ist ungueltig.");
  invariant(typeof toolchain.manifest.id === "string" && toolchain.manifest.id.length > 0, "Receipt.toolchain.manifest.id ist ungueltig.");
  validateSha256(toolchain.manifest.manifestSha256, "Receipt.toolchain.manifest.manifestSha256");
  exactKeys(toolchain.cargo, ["command", "identity", "output", "relativePath"], "Receipt.toolchain.cargo");
  validateStringArray(toolchain.cargo.command, ["cargo", "-vV"], "Receipt.toolchain.cargo.command");
  invariant(toolchain.cargo.relativePath === spec.toolchain.cargoPath, "Receipt.toolchain.cargo.relativePath driftet.");
  validateCargoIdentity(toolchain.cargo.identity, "Receipt.toolchain.cargo.identity");
  invariant(sameCanonicalValue(toolchain.cargo.identity, spec.toolchain.cargo), "Receipt bindet die falsche Cargo-Toolchain.");
  validateEncodedOutput(toolchain.cargo.output, "Receipt.toolchain.cargo.output");
  exactKeys(toolchain.rustc, ["command", "identity", "output", "relativePath"], "Receipt.toolchain.rustc");
  validateStringArray(toolchain.rustc.command, ["rustc", "-vV"], "Receipt.toolchain.rustc.command");
  invariant(toolchain.rustc.relativePath === spec.toolchain.rustcPath, "Receipt.toolchain.rustc.relativePath driftet.");
  validateRustcIdentity(toolchain.rustc.identity, "Receipt.toolchain.rustc.identity");
  invariant(sameCanonicalValue(toolchain.rustc.identity, spec.toolchain.rustc), "Receipt bindet die falsche Rustc-Toolchain.");
  validateEncodedOutput(toolchain.rustc.output, "Receipt.toolchain.rustc.output");
}

function validateEnvironmentReceipt(value, spec) {
  exactKeys(value, ["allowedInherited", "cargoConfiguration", "cleared", "fixed", "targetDirectory"], "Receipt.build.environment");
  invariant(Array.isArray(value.allowedInherited) && value.allowedInherited.length === spec.build.environmentPolicy.allowedInherited.length, "Receipt.build.environment.allowedInherited muss alle erlaubten Namen binden.");
  for (const [index, entry] of value.allowedInherited.entries()) {
    invariant(entry?.name === spec.build.environmentPolicy.allowedInherited[index], "Receipt bindet Umgebungsvariablen nicht in der festgelegten Reihenfolge.");
    if (entry.present === false) {
      exactKeys(entry, ["name", "present"], "Receipt.build.environment.allowedInherited[]");
      continue;
    }
    exactKeys(entry, ["bytes", "name", "present", "sha256"], "Receipt.build.environment.allowedInherited[]");
    invariant(entry.present === true, `Receipt.build.environment.${entry.name}.present ist ungueltig.`);
    validatePositiveBytes(entry.bytes, `Receipt.build.environment.${entry.name}.bytes`, 64 * 1024);
    validateSha256(entry.sha256, `Receipt.build.environment.${entry.name}.sha256`);
  }
  invariant(value.allowedInherited.length === 0, "Receipt.build.environment darf keine Umgebung erben.");
  exactKeys(value.cargoConfiguration, ["cargoHomeMode", "configDiscovery", "registryPolicy", "sourceReplacement", "vendorPathRemap"], "Receipt.build.environment.cargoConfiguration");
  invariant(value.cargoConfiguration.cargoHomeMode === "private-empty-create-new-v1", "Receipt.build.environment.cargoConfiguration.cargoHomeMode ist ungueltig.");
  invariant(value.cargoConfiguration.configDiscovery === "trusted-system32-cwd-explicit-pinned-config-v1", "Receipt.build.environment.cargoConfiguration.configDiscovery ist ungueltig.");
  invariant(value.cargoConfiguration.registryPolicy === "no-ambient-registry-index-src-or-git-v1", "Receipt.build.environment.cargoConfiguration.registryPolicy ist ungueltig.");
  invariant(value.cargoConfiguration.sourceReplacement === "pinned-vendor-tree-only-v1", "Receipt.build.environment.cargoConfiguration.sourceReplacement ist ungueltig.");
  exactKeys(value.cargoConfiguration.vendorPathRemap, ["from", "to"], "Receipt.build.environment.cargoConfiguration.vendorPathRemap");
  invariant(value.cargoConfiguration.vendorPathRemap.from === "$HELD_SOURCE/vendor" && value.cargoConfiguration.vendorPathRemap.to === spec.source.vendor.remapPrefix, "Receipt.build.environment.cargoConfiguration.vendorPathRemap driftet.");
  validateStringArray(value.cleared, spec.build.environmentPolicy.cleared, "Receipt.build.environment.cleared");
  invariant(sameCanonicalValue(value.fixed, spec.build.environmentPolicy.fixed), "Receipt.build.environment.fixed driftet.");
  invariant(value.targetDirectory === spec.build.environmentPolicy.targetDirectory, "Receipt.build.environment.targetDirectory driftet.");
}

function validateSourceReceipt(value, spec) {
  exactKeys(value, ["archive", "cargoLock", "extractedTree", "materialization", "vendor"], "Receipt.source");
  exactKeys(value.archive, ["bytes", "embeddedCommit", "file", "format", "sha256"], "Receipt.source.archive");
  validatePositiveBytes(value.archive.bytes, "Receipt.source.archive.bytes", MAX_ARCHIVE_BYTES);
  validateSha256(value.archive.sha256, "Receipt.source.archive.sha256");
  invariant(value.archive.file === spec.source.archive.file && value.archive.format === spec.source.archive.format && value.archive.embeddedCommit === spec.source.commit, "Receipt.source.archive bindet falsches Format, Datei oder Commit.");
  proofMatches({ bytes: value.archive.bytes, sha256: value.archive.sha256 }, spec.source.archive, "Receipt.source.archive-Spec-Pin");
  validateProof(value.cargoLock, "Receipt.source.cargoLock", MAX_SPEC_BYTES, { file: true });
  invariant(sameCanonicalValue(value.cargoLock, spec.source.cargoLock), "Receipt.source.cargoLock driftet.");
  validateTreeProof(value.extractedTree, "Receipt.source.extractedTree");
  invariant(sameCanonicalValue(value.extractedTree, spec.source.tree), "Receipt.source.extractedTree driftet vom Spec-Pin.");
  exactKeys(value.materialization, ["commit", "mode", "treeManifestSha256"], "Receipt.source.materialization");
  invariant(value.materialization.commit === spec.source.commit && value.materialization.mode === "pinned-preexisting-archive", "Receipt.source.materialization ist ungueltig.");
  invariant(value.materialization.treeManifestSha256 === spec.source.tree.manifestSha256, "Receipt.source.materialization bindet den falschen Tree.");
  exactKeys(value.vendor, ["archive", "cargoConfig", "extractedTree", "materialization", "remapPrefix"], "Receipt.source.vendor");
  exactKeys(value.vendor.archive, ["bytes", "file", "format", "sha256"], "Receipt.source.vendor.archive");
  invariant(value.vendor.archive.file === spec.source.vendor.archive.file && value.vendor.archive.format === "tar", "Receipt.source.vendor.archive driftet.");
  proofMatches(value.vendor.archive, spec.source.vendor.archive, "Receipt.source.vendor.archive");
  invariant(sameCanonicalValue(value.vendor.cargoConfig, spec.source.vendor.cargoConfig), "Receipt.source.vendor.cargoConfig driftet.");
  validateTreeProof(value.vendor.extractedTree, "Receipt.source.vendor.extractedTree");
  invariant(sameCanonicalValue(value.vendor.extractedTree, spec.source.vendor.tree), "Receipt.source.vendor.extractedTree driftet.");
  exactKeys(value.vendor.materialization, ["mode", "treeManifestSha256"], "Receipt.source.vendor.materialization");
  invariant(value.vendor.materialization.mode === "pinned-preexisting-cargo-vendor-archive" && value.vendor.materialization.treeManifestSha256 === spec.source.vendor.tree.manifestSha256, "Receipt.source.vendor.materialization ist ungueltig.");
  invariant(value.vendor.remapPrefix === spec.source.vendor.remapPrefix, "Receipt.source.vendor.remapPrefix driftet vom Annual-Pin.");
}

function buildProvenanceChain(value) {
  const sourceSha256 = sha256(canonicalBytes({
    authority: value.authority,
    producer: value.producer,
    releaseId: value.releaseId,
    source: value.source,
    specification: value.specification,
  }));
  const buildSha256 = sha256(canonicalBytes({ previousSha256: sourceSha256, build: value.build, toolchain: value.toolchain }));
  const outputSha256 = sha256(canonicalBytes({ previousSha256: buildSha256, binaries: value.binaries, pe: value.pe }));
  return { algorithm: "sha256-canonical-json-chain/v1", buildSha256, outputSha256, sourceSha256 };
}

function createBuildProvenance({ authority, binaries, build, pe, producer, releaseId, source, specification, toolchain }) {
  const value = { authority, binaries, build, pe, producer, releaseId, schema: PROVENANCE_SCHEMA, source, specification, toolchain };
  return { ...value, chain: buildProvenanceChain(value) };
}

function validateBuildProvenance(value, spec) {
  exactKeys(value, ["authority", "binaries", "build", "chain", "pe", "producer", "releaseId", "schema", "source", "specification", "toolchain"], "Build-Provenienz");
  invariant(value.schema === PROVENANCE_SCHEMA && value.releaseId === spec.releaseId, "Build-Provenienz besitzt falsches Schema oder Release-ID.");
  exactKeys(value.chain, ["algorithm", "buildSha256", "outputSha256", "sourceSha256"], "Build-Provenienz.chain");
  for (const name of ["buildSha256", "outputSha256", "sourceSha256"]) validateSha256(value.chain[name], `Build-Provenienz.chain.${name}`);
  invariant(sameCanonicalValue(value.chain, buildProvenanceChain(value)), "Build-Provenienz besitzt eine ungueltige Hash-Kette.");
  validateWorkflowAuthorityReceipt(value.authority, spec, "Build-Provenienz.authority");
  validateProof(value.specification, "Build-Provenienz.specification", MAX_SPEC_BYTES, { file: true });
  validateSourceReceipt(value.source, spec);
  validateToolchainReceipt(value.toolchain, spec);
  exactKeys(value.build, ["command", "environment", "exitCode", "logs", "output", "processLimits", "profile", "targetDirectory"], "Build-Provenienz.build");
  validateStringArray(value.build.command, spec.build.command, "Build-Provenienz.build.command");
  invariant(value.build.profile === spec.build.profile && value.build.exitCode === 0, "Build-Provenienz.build besitzt falsches Profil oder Exitcode.");
  invariant(sameCanonicalValue(value.build.processLimits, spec.build.processLimits), "Build-Provenienz.build.processLimits driftet.");
  validateEnvironmentReceipt(value.build.environment, spec);
  exactKeys(value.build.logs, ["stderr", "stdout"], "Build-Provenienz.build.logs");
  validateEncodedOutput(value.build.logs.stderr, "Build-Provenienz.build.logs.stderr");
  validateEncodedOutput(value.build.logs.stdout, "Build-Provenienz.build.logs.stdout");
  validateProof(value.build.output, "Build-Provenienz.build.output", MAX_BINARY_BYTES, { file: true });
  exactKeys(value.build.targetDirectory, ["initiallyEmpty", "mode"], "Build-Provenienz.build.targetDirectory");
  exactKeys(value.binaries, ["preserved", "rebuilt"], "Build-Provenienz.binaries");
  validateProof(value.binaries.preserved, "Build-Provenienz.binaries.preserved", MAX_BINARY_BYTES, { file: true });
  validateProof(value.binaries.rebuilt, "Build-Provenienz.binaries.rebuilt", MAX_BINARY_BYTES, { file: true });
  exactKeys(value.producer, PRODUCER_IDS, "Build-Provenienz.producer");
  for (const id of PRODUCER_IDS) {
    validateProof(value.producer[id], `Build-Provenienz.producer.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant(sameCanonicalValue(value.producer[id], spec.producer[id]), `Build-Provenienz.producer.${id} driftet vom Spec-Pin.`);
  }
  invariant(value.build.output.file === spec.binaries.rebuilt.file, "Build-Provenienz.build.output bindet den falschen Binary-Pfad.");
  invariant(sameCanonicalValue(value.binaries.preserved, { ...spec.binaries.preserved }), "Build-Provenienz bindet das falsche Preserved-Binary.");
  invariant(value.binaries.rebuilt.file === spec.binaries.rebuilt.file && value.binaries.rebuilt.bytes === spec.binaries.rebuilt.expectedBytes, "Build-Provenienz bindet das falsche Rebuild-Binary.");
  return value;
}

function validateReceiptEnvelope(receipt, spec) {
  exactKeys(receipt, ["authority", "binaries", "build", "pe", "producer", "provenance", "releaseId", "schema", "source", "specification", "toolchain"], "Operational-Validator-Rebuild-Receipt");
  invariant(receipt.schema === EVIDENCE_SCHEMA && receipt.releaseId === spec.releaseId, "Receipt besitzt falsches Schema oder Release-ID.");
  validateProof(receipt.specification, "Receipt.specification", MAX_SPEC_BYTES, { file: true });
  validateWorkflowAuthorityReceipt(receipt.authority, spec, "Receipt.authority");
  validateSourceReceipt(receipt.source, spec);
  exactKeys(receipt.build, ["command", "environment", "exitCode", "logs", "output", "processLimits", "profile", "targetDirectory"], "Receipt.build");
  validateStringArray(receipt.build.command, spec.build.command, "Receipt.build.command");
  invariant(receipt.build.profile === spec.build.profile && receipt.build.exitCode === 0, "Receipt.build besitzt falsches Profil oder Exitcode.");
  invariant(sameCanonicalValue(receipt.build.processLimits, spec.build.processLimits), "Receipt.build.processLimits driftet.");
  validateEnvironmentReceipt(receipt.build.environment, spec);
  exactKeys(receipt.build.logs, ["stderr", "stdout"], "Receipt.build.logs");
  validateEncodedOutput(receipt.build.logs.stdout, "Receipt.build.logs.stdout");
  validateEncodedOutput(receipt.build.logs.stderr, "Receipt.build.logs.stderr");
  validateProof(receipt.build.output, "Receipt.build.output", MAX_BINARY_BYTES, { file: true });
  invariant(receipt.build.output.file === spec.binaries.rebuilt.file, "Receipt.build.output bindet den falschen Pfad.");
  exactKeys(receipt.build.targetDirectory, ["initiallyEmpty", "mode"], "Receipt.build.targetDirectory");
  invariant(receipt.build.targetDirectory.initiallyEmpty === true && receipt.build.targetDirectory.mode === "external-empty-create-new", "Receipt.build.targetDirectory ist ungueltig.");
  validateToolchainReceipt(receipt.toolchain, spec);
  exactKeys(receipt.binaries, ["preserved", "rebuilt"], "Receipt.binaries");
  validateProof(receipt.binaries.preserved, "Receipt.binaries.preserved", MAX_BINARY_BYTES, { file: true });
  validateProof(receipt.binaries.rebuilt, "Receipt.binaries.rebuilt", MAX_BINARY_BYTES, { file: true });
  invariant(receipt.binaries.preserved.file === spec.binaries.preserved.file && receipt.binaries.rebuilt.file === spec.binaries.rebuilt.file, "Receipt.binaries bindet falsche Pfade.");
  invariant(receipt.binaries.rebuilt.bytes === spec.binaries.rebuilt.expectedBytes, "Receipt.binaries.rebuilt besitzt die falsche Bytezahl.");
  exactKeys(receipt.producer, PRODUCER_IDS, "Receipt.producer");
  for (const id of PRODUCER_IDS) {
    validateProof(receipt.producer[id], `Receipt.producer.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant(sameCanonicalValue(receipt.producer[id], spec.producer[id]), `Receipt.producer.${id} driftet vom Spec-Pin.`);
  }
  validateProof(receipt.provenance, "Receipt.provenance", MAX_PROVENANCE_BYTES, { file: true });
  invariant(receipt.provenance.file === spec.provenance.file, "Receipt.provenance bindet den falschen Pfad.");
  return receipt;
}

export async function materializeOperationalValidatorRebuildEvidence({ spec, specBytes, specFile, workspaceRoot, sourceRoot: _sourceRoot, outputPath, producerProofs, runnerAnchorHelperProof, recoveryOnly = false, hooks = {} }) {
  validateOperationalValidatorRebuildSpec(spec);
  const workspace = await regularDirectorySnapshot(workspaceRoot, "workspaceRoot");
  const receiptOutput = resolve(outputPath);
  invariant(isContained(workspace.path, receiptOutput), "outputPath verlaesst workspaceRoot.");
  invariant(pathKey(receiptOutput) === pathKey(resolveWorkspaceFile(workspace.path, spec.receipt.file, "receipt.file")),
    "outputPath driftet vom Annual-gepinnten Receiptpfad.");
  const outputs = {
    archive: resolveWorkspaceFile(workspace.path, spec.source.archive.file, "source.archive.file"),
    binary: resolveWorkspaceFile(workspace.path, spec.binaries.rebuilt.file, "binaries.rebuilt.file"),
    provenance: resolveWorkspaceFile(workspace.path, spec.provenance.file, "provenance.file"),
    receipt: receiptOutput,
  };
  for (const [id, path] of Object.entries(outputs)) {
    await assertNoSymlinkPath(workspace.path, path, id, { leafMayBeMissing: true });
  }
  const specification = await validateSpecInputs({ spec, specBytes, specFile, workspaceRoot: workspace.path });
  const producer = await validateProducerProofs({ producerProofs, spec, workspaceRoot: workspace.path });
  validateProof(runnerAnchorHelperProof, "runnerAnchorHelperProof", MAX_PRODUCER_BYTES, { file: true });
  invariant(sameCanonicalValue(runnerAnchorHelperProof, spec.toolchain.anchor.helperAssembly),
    "Gehaltene Runner-Anchor-Helper-Assembly driftet von der Rebuild-v3-Spec.");
  const authority = workflowAuthorityReceipt(spec);
  invariant(!recoveryOnly, "Rebuild-Evidence-v3 besitzt bewusst keine pfadbasierte Recovery; private Buildbaeume werden konservativ behalten.");
  for (const id of ["binary", "provenance", "receipt"]) await assertCreateNewTarget(outputs[id], `Operational-Validator-Rebuild-${id}`);
  const preservedPath = resolveWorkspaceFile(workspace.path, spec.binaries.preserved.file, "binaries.preserved.file");
  const preserved = await regularFileSnapshot(workspace.path, preservedPath, "Preserved Validator", spec.pe.maxBinaryBytes);
  proofMatches(preserved.proof, spec.binaries.preserved, "Preserved Validator");
  const parentSnapshots = new Map();
  for (const path of [outputs.binary, outputs.provenance, outputs.receipt]) {
    const parentPath = dirname(path);
    if (!parentSnapshots.has(pathKey(parentPath))) parentSnapshots.set(pathKey(parentPath), await regularDirectorySnapshot(parentPath, "Rebuild-Output-Elternverzeichnis"));
  }
  const binaryParent = parentSnapshots.get(pathKey(dirname(outputs.binary)));
  const buildRootLeaf = `.operational-validator-rebuild-v3-${randomUUID()}`;
  const stagingRoot = resolve(binaryParent.path, buildRootLeaf);
  await assertCreateNewTarget(stagingRoot, "Privater Rebuild-Baum");
  let staging;
  let publicationProofs;
  let primaryError;
  let result;
  let buildAnchor;
  try {
    buildAnchor = await startWindowsBuildAnchor({
      anchoredParents: [...parentSnapshots.values()],
      buildParent: binaryParent,
      buildRootLeaf,
      hooks,
      spec,
      workspaceRoot: workspace.path,
    });
    const sourceAudit = auditPinnedSourceArchive(buildAnchor.inputs.source.bytes, spec);
    const vendorAudit = auditPinnedVendorArchive(buildAnchor.inputs.vendor.bytes, spec);
    if (hooks.afterPinnedInputAuditBeforeExtraction) await hooks.afterPinnedInputAuditBeforeExtraction({ stagingRoot });
    const extraction = await buildAnchor.extract({ sourceAudit, vendorAudit });
    staging = await regularDirectorySnapshot(stagingRoot, "Create-new Windows-Buildroot");
    invariant(matchesFilesystemIdentity(staging.metadata, extraction.buildRootIdentity), "Create-new Windows-Buildroot driftet von der im Anchor gehaltenen Identitaet.");
    if (hooks.afterStagingCreated) await hooks.afterStagingCreated({ stagingRoot });
    const sourceDirectory = resolve(stagingRoot, "source");
    const targetDirectory = resolve(stagingRoot, "target");
    const cargoHome = resolve(stagingRoot, "cargo-home");
    const tempDirectory = resolve(stagingRoot, "temp");
    const source = sourceArchiveEvidence({
      sourceAudit,
      sourceProof: buildAnchor.inputs.source.proof,
      spec,
      vendorAudit,
      vendorProof: buildAnchor.inputs.vendor.proof,
    });
    const archive = buildAnchor.inputs.source;
    invariant((await readdir(targetDirectory)).length === 0, "Externer Cargo-Target-Pfad wurde vor dem Build beschrieben.");
    if (hooks.beforeBuild) await hooks.beforeBuild({ command: spec.build.command, sourceDirectory, targetDirectory });
    const anchorResult = await buildAnchor.run({ cargoHome, sourceDirectory, targetDirectory, tempDirectory });
    const buildResult = anchorResult.build;
    if (hooks.afterBuild) await hooks.afterBuild({ buildResult, sourceDirectory, targetDirectory });
    const cargoLockAfterBuild = await regularFileSnapshot(sourceDirectory, resolveWorkspaceFile(sourceDirectory, spec.source.cargoLock.file, "source.cargoLock.file"), "Archiviertes Cargo.lock nach Build", MAX_SPEC_BYTES);
    proofMatches(cargoLockAfterBuild.proof, spec.source.cargoLock, "Archiviertes Cargo.lock nach Build");
    const cargoConfigAfterBuild = await regularFileSnapshot(sourceDirectory, resolveWorkspaceFile(sourceDirectory, spec.source.vendor.cargoConfig.file, "source.vendor.cargoConfig.file"), "Gepinnte Cargo-Vendor-Konfiguration nach Build", MAX_SPEC_BYTES);
    proofMatches(cargoConfigAfterBuild.proof, spec.source.vendor.cargoConfig, "Gepinnte Cargo-Vendor-Konfiguration nach Build");
    const built = await regularFileSnapshot(targetDirectory, resolveWorkspaceFile(targetDirectory, spec.build.targetOutputFile, "build.targetOutputFile"), "Tatsaechlich gebauter Operational-Validator", spec.pe.maxBinaryBytes);
    proofMatches(built.proof, { bytes: anchorResult.output.bytes, sha256: anchorResult.output.sha256 }, "Im Anchor gehaltener Operational-Validator");
    invariant(matchesFilesystemIdentity(built.identity, anchorResult.output.identity), "Tatsaechlich gebauter Operational-Validator driftet von der im Anchor gehaltenen Identitaet.");
    invariant(built.proof.bytes === spec.binaries.rebuilt.expectedBytes, "Tatsaechlich gebauter Operational-Validator besitzt die falsche Bytezahl.");
    const pe = inspectPePair(preserved.bytes, built.bytes, spec);
    const toolchain = toolchainReceiptFromAnchor(anchorResult, spec, buildAnchor.inputs.manifest, { ...runnerAnchorHelperProof });
    const environmentReceipt = {
      allowedInherited: [],
      cargoConfiguration: {
        cargoHomeMode: "private-empty-create-new-v1",
        configDiscovery: "trusted-system32-cwd-explicit-pinned-config-v1",
        registryPolicy: "no-ambient-registry-index-src-or-git-v1",
        sourceReplacement: "pinned-vendor-tree-only-v1",
        vendorPathRemap: { from: "$HELD_SOURCE/vendor", to: spec.source.vendor.remapPrefix },
      },
      cleared: spec.build.environmentPolicy.cleared,
      fixed: { ...spec.build.environmentPolicy.fixed },
      targetDirectory: spec.build.environmentPolicy.targetDirectory,
    };
    const binaries = { preserved: { file: spec.binaries.preserved.file, ...preserved.proof }, rebuilt: { file: spec.binaries.rebuilt.file, ...built.proof } };
    const build = {
      command: spec.build.command, environment: environmentReceipt, exitCode: buildResult.code,
      logs: { stderr: encodedOutput(buildResult.stderr), stdout: encodedOutput(buildResult.stdout) },
      output: { file: spec.binaries.rebuilt.file, ...built.proof }, processLimits: spec.build.processLimits, profile: spec.build.profile,
      targetDirectory: { initiallyEmpty: true, mode: spec.build.environmentPolicy.targetDirectory },
    };
    const specificationProof = { bytes: specification.bytes, file: specification.file, sha256: specification.sha256 };
    const provenanceValue = createBuildProvenance({ authority, binaries, build, pe, producer, releaseId: spec.releaseId, source, specification: specificationProof, toolchain });
    const provenanceBytes = canonicalBytes(provenanceValue);
    invariant(provenanceBytes.length <= MAX_PROVENANCE_BYTES, "Build-Provenienz ist unerwartet gross.");
    const provenanceProof = { bytes: provenanceBytes.length, sha256: sha256(provenanceBytes) };
    const receipt = { ...provenanceValue, provenance: { file: spec.provenance.file, ...provenanceProof }, schema: EVIDENCE_SCHEMA };
    delete receipt.chain;
    const receiptBytes = canonicalBytes(receipt);
    invariant(receiptBytes.length <= MAX_JSON_BYTES, "Operational-Validator-Rebuild-Receipt ist unerwartet gross.");
    const receiptProof = { bytes: receiptBytes.length, sha256: sha256(receiptBytes) };
    publicationProofs = await buildAnchor.publish({
      binary: { path: outputs.binary, ...built.proof },
      provenance: { bytesValue: provenanceBytes, path: outputs.provenance, ...provenanceProof },
      receipt: { bytesValue: receiptBytes, path: outputs.receipt, ...receiptProof },
    });
    const publishedSnapshots = {};
    for (const [id, maximum] of Object.entries({ binary: MAX_BINARY_BYTES, provenance: MAX_PROVENANCE_BYTES, receipt: MAX_JSON_BYTES })) {
      const parent = parentSnapshots.get(pathKey(dirname(outputs[id])));
      await assertDirectoryIdentity(parent.path, parent.metadata, `Output-Elternverzeichnis nach handle-relativer ${id}-Publikation`);
      publishedSnapshots[id] = await regularFileSnapshot(workspace.path, outputs[id], `Handle-relativ publiziertes ${id}`, maximum);
      proofMatches(publishedSnapshots[id].proof, publicationProofs[id], `Handle-relativ publiziertes ${id}`);
      invariant(matchesFilesystemIdentity(publishedSnapshots[id].identity, publicationProofs[id].identity), `Handle-relativ publiziertes ${id} driftet von der gehaltenen File-ID.`);
      if (id === "binary" && hooks.afterBuiltOutputLink) await hooks.afterBuiltOutputLink({ binaryOutput: outputs.binary, builtPath: built.path });
      if (id === "receipt" && hooks.afterReceiptLink) await hooks.afterReceiptLink({ binaryOutput: outputs.binary, receiptOutput });
      if (hooks.afterPublicationLink) await hooks.afterPublicationLink({ id, output: outputs[id], stagedPath: null });
    }
    const verification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
    invariant(verification.receipt.binaries.rebuilt.sha256 === built.proof.sha256, "Publiziertes Receipt bindet nicht den Build.");
    result = {
      archive: { path: outputs.archive, ...archive.proof }, binary: { path: outputs.binary, ...built.proof }, path: receiptOutput,
      proof: verification.proof, provenance: { path: outputs.provenance, ...provenanceProof }, receipt: verification.receipt,
    };
  } catch (error) { primaryError = error; }
  let cleanupError;
  if (staging) {
    try {
      await cleanupOwnedBuildRoot(binaryParent, stagingRoot, staging.metadata, hooks);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (!primaryError && !cleanupError) {
    try {
      if (hooks.afterBuildRootCleanupBeforeFinalAudit) await hooks.afterBuildRootCleanupBeforeFinalAudit({ outputs: { ...outputs } });
      for (const parent of parentSnapshots.values()) await assertDirectoryIdentity(parent.path, parent.metadata, "Output-Elternverzeichnis unmittelbar nach Cleanup");
      for (const [id, maximum] of Object.entries({ binary: MAX_BINARY_BYTES, provenance: MAX_PROVENANCE_BYTES, receipt: MAX_JSON_BYTES })) {
        const snapshot = await regularFileSnapshot(workspace.path, outputs[id], `Post-Retention ${id}`, maximum);
        proofMatches(snapshot.proof, publicationProofs[id], `Post-Retention ${id}`);
        invariant(matchesFilesystemIdentity(snapshot.identity, publicationProofs[id].identity), `Post-Retention ${id} driftet von der im Anchor gehaltenen File-ID.`);
      }
      const verification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
      result.proof = verification.proof;
      result.receipt = verification.receipt;
    } catch (error) { primaryError = error; }
  }
  if (primaryError || cleanupError) {
    let anchorAbortError;
    if (buildAnchor) {
      try { await buildAnchor.abort(); } catch (error) { anchorAbortError = error; }
    }
    let rollbackAuditError;
    try {
      for (const id of ["binary", "provenance", "receipt"]) {
        invariant(!(await pathExists(outputs[id])), `Handle-relativer Fehler-Rollback hinterliess ${id} am finalen Pfad.`);
      }
    } catch (error) { rollbackAuditError = error; }
    const errors = [primaryError, cleanupError, anchorAbortError, rollbackAuditError].filter(Boolean);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Rebuild, konservative Retention oder handle-relativer Publikationsrollback ist fehlgeschlagen; der private Baum bleibt fuer forensische Recovery erhalten.");
  }
  try {
    const finalVerification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
    result.proof = finalVerification.proof;
    result.receipt = finalVerification.receipt;
    await buildAnchor.completePublication();
  } catch (error) {
    let abortError;
    try { await buildAnchor.abort(); } catch (failure) { abortError = failure; }
    if (abortError) throw new AggregateError([error, abortError], "Rebuild-Abschluss und Anchor-Abort sind fehlgeschlagen.");
    throw error;
  }
  return result;
}

export async function verifyOperationalValidatorRebuildEvidence({ spec, receiptPath, workspaceRoot }) {
  validateOperationalValidatorRebuildSpec(spec);
  const workspace = await regularDirectorySnapshot(workspaceRoot, "workspaceRoot");
  const receiptFile = resolve(receiptPath);
  invariant(isContained(workspace.path, receiptFile), "receiptPath verlaesst workspaceRoot.");
  invariant(pathKey(receiptFile) === pathKey(resolveWorkspaceFile(workspace.path, spec.receipt.file, "receipt.file")),
    "receiptPath driftet vom Annual-gepinnten Receiptpfad.");
  const source = await regularFileSnapshot(workspace.path, receiptFile, "Operational-Validator-Rebuild-Receipt", MAX_JSON_BYTES);
  const receipt = validateReceiptEnvelope(parseJson(source.bytes, "Operational-Validator-Rebuild-Receipt"), spec);
  invariant(source.bytes.equals(canonicalBytes(receipt)), "Operational-Validator-Rebuild-Receipt ist nicht kanonisch serialisiert.");
  const specificationPath = resolveWorkspaceFile(workspace.path, receipt.specification.file, "Receipt.specification.file");
  const specification = await regularFileSnapshot(workspace.path, specificationPath, "Rebuild-Spec", MAX_SPEC_BYTES);
  proofMatches(specification.proof, receipt.specification, "Rebuild-Spec");
  invariant(specification.bytes.equals(canonicalBytes(spec)), "Aktuelle Rebuild-Spec ist nicht kanonisch oder driftet.");
  const preservedPath = resolveWorkspaceFile(workspace.path, spec.binaries.preserved.file, "binaries.preserved.file");
  const rebuiltPath = resolveWorkspaceFile(workspace.path, spec.binaries.rebuilt.file, "binaries.rebuilt.file");
  const archivePath = resolveWorkspaceFile(workspace.path, spec.source.archive.file, "source.archive.file");
  const vendorPath = resolveWorkspaceFile(workspace.path, spec.source.vendor.archive.file, "source.vendor.archive.file");
  const toolchainManifestPath = resolveWorkspaceFile(workspace.path, spec.toolchain.manifest.file, "toolchain.manifest.file");
  const provenancePath = resolveWorkspaceFile(workspace.path, spec.provenance.file, "provenance.file");
  const [preserved, rebuilt, archive, vendor, toolchainManifestSource, provenanceSource] = await Promise.all([
    regularFileSnapshot(workspace.path, preservedPath, "Preserved Validator", spec.pe.maxBinaryBytes),
    regularFileSnapshot(workspace.path, rebuiltPath, "Official Rebuilt Validator", spec.pe.maxBinaryBytes),
    regularFileSnapshot(workspace.path, archivePath, "Persistiertes Commit-Archiv", MAX_ARCHIVE_BYTES),
    regularFileSnapshot(workspace.path, vendorPath, "Persistiertes Cargo-Vendor-TAR", MAX_VENDOR_ARCHIVE_BYTES),
    regularFileSnapshot(workspace.path, toolchainManifestPath, "Persistiertes Toolchain-Manifest", MAX_TOOLCHAIN_MANIFEST_BYTES),
    regularFileSnapshot(workspace.path, provenancePath, "Persistierte Build-Provenienz", MAX_PROVENANCE_BYTES),
  ]);
  proofMatches(preserved.proof, spec.binaries.preserved, "Preserved Validator");
  proofMatches(preserved.proof, receipt.binaries.preserved, "Receipt-Preserved-Validator");
  proofMatches(rebuilt.proof, receipt.binaries.rebuilt, "Receipt-Official-Rebuilt-Validator");
  proofMatches(rebuilt.proof, receipt.build.output, "Receipt-Build-Output");
  invariant(rebuilt.proof.bytes === spec.binaries.rebuilt.expectedBytes, "Official Rebuilt Validator besitzt die falsche Bytezahl.");
  proofMatches(archive.proof, spec.source.archive, "Persistiertes Commit-Archiv");
  proofMatches(archive.proof, { bytes: receipt.source.archive.bytes, sha256: receipt.source.archive.sha256 }, "Receipt-Commit-Archiv");
  const archiveAudit = auditPinnedSourceArchive(archive.bytes, spec);
  invariant(sameCanonicalValue(archiveAudit.cargoLock, receipt.source.cargoLock), "Receipt-Cargo.lock driftet vom nativ auditierten Commit-TAR.");
  invariant(sameCanonicalValue(archiveAudit.extractedTree, receipt.source.extractedTree), "Receipt-Source-Tree driftet vom nativ auditierten Commit-TAR.");
  proofMatches(vendor.proof, spec.source.vendor.archive, "Persistiertes Cargo-Vendor-TAR");
  const vendorAudit = auditPinnedVendorArchive(vendor.bytes, spec);
  invariant(sameCanonicalValue(vendorAudit.extractedTree, receipt.source.vendor.extractedTree), "Receipt-Vendor-Tree driftet vom nativ auditierten Vendor-TAR.");
  proofMatches(toolchainManifestSource.proof, spec.toolchain.manifest, "Persistiertes Toolchain-Manifest");
  const toolchainManifest = parseJson(toolchainManifestSource.bytes, "Toolchain-Manifest");
  invariant(toolchainManifestSource.bytes.equals(canonicalBytes(toolchainManifest)), "Toolchain-Manifest ist nicht kanonisch serialisiert.");
  const toolchainInventory = validateToolchainManifest(toolchainManifest, spec);
  invariant(sameCanonicalValue({ ...spec.toolchain.manifest, ...toolchainInventory }, receipt.toolchain.manifest), "Receipt-Toolchain-Manifestinventar driftet.");
  proofMatches(provenanceSource.proof, receipt.provenance, "Receipt-Build-Provenienz");
  invariant(provenanceSource.bytes.equals(canonicalBytes(parseJson(provenanceSource.bytes, "Build-Provenienz"))), "Build-Provenienz ist nicht kanonisch serialisiert.");
  const provenance = validateBuildProvenance(parseJson(provenanceSource.bytes, "Build-Provenienz"), spec);
  for (const field of ["authority", "binaries", "build", "pe", "producer", "source", "specification", "toolchain"]) {
    invariant(sameCanonicalValue(provenance[field], receipt[field]), `Receipt.${field} driftet von der content-addressed Build-Provenienz.`);
  }
  const pe = inspectPePair(preserved.bytes, rebuilt.bytes, spec);
  invariant(sameCanonicalValue(pe, receipt.pe), "Receipt-PE-Evidenz driftet von den aktuellen Binaries.");
  for (const id of PRODUCER_IDS) {
    const path = resolveWorkspaceFile(workspace.path, spec.producer[id].file, `producer.${id}.file`);
    const producer = await regularFileSnapshot(workspace.path, path, `Producer ${id}`, MAX_PRODUCER_BYTES);
    proofMatches(producer.proof, receipt.producer[id], `Receipt-Producer ${id}`);
  }
  return { proof: source.proof, receipt };
}
