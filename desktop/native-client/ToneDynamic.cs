// Dedicated fixture only: a parent tone and a late child with a different executable name.
using System;
using System.IO;
using System.Media;
using System.Diagnostics;
using System.Threading;
class ToneDynamic {
    static void Main(string[] args) {
        double hz = double.Parse(args[0], System.Globalization.CultureInfo.InvariantCulture);
        Process child = null;
        Thread starter = null;
        if (args.Length > 1) {
            starter = new Thread(() => {
                Thread.Sleep(2500);
                child = Process.Start(new ProcessStartInfo(args[1], "880") {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true
                });
            });
            starter.Start();
        }
        using (var stream = new MemoryStream()) {
            var w = new BinaryWriter(stream);
            int rate = 48000, samples = rate * 2;
            w.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));w.Write(36+samples*2);w.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt "));
            w.Write(16);w.Write((short)1);w.Write((short)1);w.Write(rate);w.Write(rate*2);w.Write((short)2);w.Write((short)16);
            w.Write(System.Text.Encoding.ASCII.GetBytes("data"));w.Write(samples*2);
            for (int i=0;i<samples;i++) w.Write((short)(Math.Sin(2*Math.PI*hz*i/rate)*1500));
            stream.Position=0;
            using (var player = new SoundPlayer(stream)) {
                player.PlayLooping();Console.WriteLine("ready");Console.ReadLine();player.Stop();
            }
        }
        if (starter != null) starter.Join();
        if (child != null) {child.StandardInput.WriteLine();if (!child.WaitForExit(3000)) child.Kill();child.Dispose();}
    }
}
