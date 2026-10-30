// ByTune's Windows media session: the media flyout, lock screen and media
// keys. Chromium hands Windows the cover at 150x150; owning the session here
// lets the flyout show the full-size image. Driven by media-controls.ts with
// JSON lines on stdin and stdout; exits when stdin closes. Compiled by
// scripts/build-media-helper.mjs with the C# compiler that ships with
// Windows (.NET Framework 4.x), hence C# 5.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.IO;
using System.Web.Script.Serialization;
using Windows.Media;
using Windows.Media.Playback;
using Windows.Storage.Streams;

static class ByTuneMedia
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    static readonly object OutLock = new object();
    static SystemMediaTransportControls smtc;
    // Windows reads the thumbnail stream asynchronously; keep it alive.
    static InMemoryRandomAccessStream cover;

    static void Main(string[] args)
    {
        // The flyout names and badges the session from this ID's Start menu shortcut.
        SetCurrentProcessExplicitAppUserModelID(args.Length > 0 ? args[0] : "com.bytune.music");
        var player = new MediaPlayer();
        player.CommandManager.IsEnabled = false;
        smtc = player.SystemMediaTransportControls;
        smtc.IsPlayEnabled = true;
        smtc.IsPauseEnabled = true;
        smtc.IsNextEnabled = true;
        smtc.IsPreviousEnabled = true;
        smtc.ButtonPressed += OnButton;
        smtc.PlaybackPositionChangeRequested += OnSeek;

        var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = input.ReadLine()) != null)
        {
            try { Apply(json.Deserialize<Dictionary<string, object>>(line)); }
            catch (Exception e) { Console.Error.WriteLine(e.Message); }
        }
        GC.KeepAlive(player);
    }

    static void Apply(Dictionary<string, object> m)
    {
        switch ((string)m["type"])
        {
            case "display":
                var d = smtc.DisplayUpdater;
                d.Type = MediaPlaybackType.Music;
                d.MusicProperties.Title = (string)m["title"];
                d.MusicProperties.Artist = (string)m["artist"];
                d.MusicProperties.AlbumTitle = (string)m["album"];
                d.Thumbnail = Thumbnail((string)m["cover"]);
                d.Update();
                smtc.IsEnabled = true;
                break;
            case "clear":
                smtc.DisplayUpdater.ClearAll();
                smtc.DisplayUpdater.Update();
                smtc.IsEnabled = false;
                break;
            case "status":
                smtc.PlaybackStatus = (bool)m["playing"] ? MediaPlaybackStatus.Playing : MediaPlaybackStatus.Paused;
                break;
            case "timeline":
                var end = Seconds(m["duration"]);
                var t = new SystemMediaTransportControlsTimelineProperties();
                t.StartTime = TimeSpan.Zero;
                t.MinSeekTime = TimeSpan.Zero;
                t.EndTime = end;
                t.MaxSeekTime = end;
                t.Position = Seconds(m["position"]);
                smtc.UpdateTimelineProperties(t);
                break;
        }
    }

    static TimeSpan Seconds(object value)
    {
        return TimeSpan.FromSeconds(Convert.ToDouble(value, CultureInfo.InvariantCulture));
    }

    static RandomAccessStreamReference Thumbnail(string base64)
    {
        if (string.IsNullOrEmpty(base64)) return null;
        var stream = new InMemoryRandomAccessStream();
        var writer = new DataWriter(stream);
        writer.WriteBytes(Convert.FromBase64String(base64));
        // AsTask() would need the SDK's Windows.winmd; wait on the completion callback instead.
        var stored = new ManualResetEvent(false);
        writer.StoreAsync().Completed = delegate { stored.Set(); };
        stored.WaitOne();
        writer.DetachStream();
        stream.Seek(0);
        cover = stream;
        return RandomAccessStreamReference.CreateFromStream(stream);
    }

    static void OnButton(SystemMediaTransportControls sender, SystemMediaTransportControlsButtonPressedEventArgs e)
    {
        string name;
        switch (e.Button)
        {
            case SystemMediaTransportControlsButton.Play: name = "play"; break;
            case SystemMediaTransportControlsButton.Pause: name = "pause"; break;
            case SystemMediaTransportControlsButton.Next: name = "next"; break;
            case SystemMediaTransportControlsButton.Previous: name = "previous"; break;
            default: return;
        }
        Send("{\"type\":\"button\",\"button\":\"" + name + "\"}");
    }

    static void OnSeek(SystemMediaTransportControls sender, PlaybackPositionChangeRequestedEventArgs e)
    {
        Send("{\"type\":\"seek\",\"position\":" + e.RequestedPlaybackPosition.TotalSeconds.ToString("R", CultureInfo.InvariantCulture) + "}");
    }

    static void Send(string line)
    {
        lock (OutLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }
}
