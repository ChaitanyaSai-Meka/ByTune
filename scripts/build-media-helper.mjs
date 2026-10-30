/**
 * Compiles the Windows media-session helper (electron/media-helper.cs) into
 * dist-electron/ByTuneMedia.exe with the C# compiler that ships with every
 * Windows 10/11 (.NET Framework 4.x) — no SDK or Visual Studio needed.
 * No-op elsewhere: the helper is Windows only (electron/media-controls.ts).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const windir = process.env.WINDIR || "C:\\Windows";
  const framework = path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319");
  const winmd = path.join(windir, "System32", "WinMetadata");
  execFileSync(
    path.join(framework, "csc.exe"),
    [
      "/nologo",
      "/target:winexe",
      "/optimize+",
      `/out:${path.join(root, "dist-electron", "ByTuneMedia.exe")}`,
      ...["Windows.Foundation.winmd", "Windows.Media.winmd", "Windows.Storage.winmd"].map((f) => `/reference:${path.join(winmd, f)}`),
      ...["System.Runtime.dll", "System.Runtime.InteropServices.WindowsRuntime.dll", "System.Web.Extensions.dll"].map(
        (f) => `/reference:${path.join(framework, f)}`
      ),
      path.join(root, "electron", "media-helper.cs"),
    ],
    { stdio: "inherit" }
  );
}
