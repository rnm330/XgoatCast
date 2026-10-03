using System;
using System.IO;
using System.Media;
using System.Threading;
class Tone {
    static void Main(string[] args) {
        double hz = double.Parse(args[0], System.Globalization.CultureInfo.InvariantCulture);
        using (var stream = new MemoryStream()) {
            var w = new BinaryWriter(stream);
            int rate = 48000, samples = rate * 2;
            w.Write(System.Text.Encoding.ASCII.GetBytes("RIFF")); w.Write(36+samples*2); w.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt "));
            w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(rate); w.Write(rate*2); w.Write((short)2); w.Write((short)16);
            w.Write(System.Text.Encoding.ASCII.GetBytes("data")); w.Write(samples*2);
            for (int i=0;i<samples;i++) w.Write((short)(Math.Sin(2*Math.PI*hz*i/rate)*1500));
            stream.Position=0;
            using (var player = new SoundPlayer(stream)) { player.PlayLooping(); Console.WriteLine("ready"); Console.ReadLine(); player.Stop(); }
        }
    }
}
