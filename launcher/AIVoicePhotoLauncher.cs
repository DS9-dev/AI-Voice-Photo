// AI Voice Photo launcher (AVP-04 closing): starts the app without any console window.
//
// Same as start.bat ("electron ." in the project folder), but as a Windows GUI program with
// the app icon. It lives in the project folder and uses the environments, models and
// dependencies that are already there; it installs and changes nothing.
// Build: launcher\build_launcher.bat  ->  "AI Voice Photo.exe" in the project folder.
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("AI Voice Photo")]
[assembly: System.Reflection.AssemblyProduct("AI Voice Photo")]
[assembly: System.Reflection.AssemblyDescription("Launcher for AI Voice Photo (local voice conversation with an animated photo)")]
[assembly: System.Reflection.AssemblyVersion("0.4.0.0")]

static class Launcher
{
    const string Title = "AI Voice Photo";

    [STAThread]
    static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string electron = Path.Combine(root, "node_modules", "electron", "dist", "electron.exe");
        if (!File.Exists(Path.Combine(root, "package.json")))
        {
            Fail("Лаунчер должен лежать в папке проекта AI Voice Photo (рядом с package.json).");
            return 1;
        }
        if (!File.Exists(electron))
        {
            Fail("Electron не установлен. Запустите setup.bat в папке проекта, затем повторите.");
            return 1;
        }
        try
        {
            var psi = new ProcessStartInfo(electron, ".")
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            // the app writes nothing useful to a console; keep the same environment as start.bat
            psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            Process.Start(psi);
            return 0;
        }
        catch (Exception ex)
        {
            Fail("Не удалось запустить приложение: " + ex.Message);
            return 1;
        }
    }

    static void Fail(string message)
    {
        MessageBox.Show(message, Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}
