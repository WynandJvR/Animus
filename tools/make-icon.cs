// Renders animus.ico (16..256 px, PNG-compressed frames) with the same mark the panel
// draws in its top rail (Animus.DrawLogo - keep the geometry in step). build-exe.ps1
// regenerates the icon when this file is newer than animus.ico.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

static class MakeIcon
{
    static GraphicsPath RoundPath(RectangleF r, float rad)
    {
        GraphicsPath p = new GraphicsPath();
        float d = rad * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    static byte[] Frame(int size)
    {
        using (Bitmap b = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(b))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.Transparent);
                float u = size / 32f;
                RectangleF r = new RectangleF(0.5f * u, 0.5f * u, size - 1f * u, size - 1f * u);
                using (GraphicsPath gp = RoundPath(r, 7 * u))
                using (LinearGradientBrush lb = new LinearGradientBrush(r, Color.FromArgb(0x8B, 0x7B, 0xFF),
                                                                      Color.FromArgb(0x4E, 0x3C, 0xD0), 45f))
                    g.FillPath(lb, gp);
                PointF c = new PointF(16 * u, 16.5f * u);
                PointF top = new PointF(c.X, c.Y - 10 * u), bot = new PointF(c.X, c.Y + 10 * u);
                PointF lt = new PointF(c.X - 9 * u, c.Y - 5 * u), rt = new PointF(c.X + 9 * u, c.Y - 5 * u);
                PointF lb2 = new PointF(c.X - 9 * u, c.Y + 5 * u), rb = new PointF(c.X + 9 * u, c.Y + 5 * u);
                using (SolidBrush face = new SolidBrush(Color.FromArgb(80, 255, 255, 255)))
                    g.FillPolygon(face, new PointF[] { top, rt, c, lt });
                using (Pen pen = new Pen(Color.White, Math.Max(1.2f, 2.2f * u)))
                {
                    pen.LineJoin = LineJoin.Round;
                    g.DrawPolygon(pen, new PointF[] { top, rt, rb, bot, lb2, lt });
                    g.DrawLine(pen, lt, c); g.DrawLine(pen, rt, c); g.DrawLine(pen, c, bot);
                }
            }
            using (MemoryStream ms = new MemoryStream()) { b.Save(ms, ImageFormat.Png); return ms.ToArray(); }
        }
    }

    static void Main(string[] a)
    {
        int[] sizes = { 16, 24, 32, 48, 64, 128, 256 };
        byte[][] imgs = new byte[sizes.Length][];
        for (int i = 0; i < sizes.Length; i++) imgs[i] = Frame(sizes[i]);
        using (BinaryWriter w = new BinaryWriter(File.Create(a[0])))
        {
            w.Write((short)0); w.Write((short)1); w.Write((short)sizes.Length);
            int off = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                int s = sizes[i];
                w.Write((byte)(s >= 256 ? 0 : s)); w.Write((byte)(s >= 256 ? 0 : s));
                w.Write((byte)0); w.Write((byte)0);
                w.Write((short)1); w.Write((short)32);
                w.Write(imgs[i].Length); w.Write(off);
                off += imgs[i].Length;
            }
            foreach (byte[] d in imgs) w.Write(d);
        }
    }
}
