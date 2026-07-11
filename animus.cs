// Animus control panel - a single native Windows GUI app (WinForms, dark theme).
// Left column: point the bot at YOUR server (writes bot/config.json), pick/pull the
// Ollama brain model, manage schematics, start/stop everything. Right column: the
// LIVE panel (replaces the old browser dashboard) - health/food/position/threat,
// inventory, the bot's activity log, a command console and the brain goal/toggle,
// all talking to the bot's local control API.
// Compiled to Animus.exe by build-exe.ps1 (uses the .NET Framework compiler that
// ships with Windows - no SDK needed).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

class Animus : Form
{
    static string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    static string BotDir  { get { return Path.Combine(Root, "bot"); } }
    static string CfgPath { get { return Path.Combine(BotDir, "config.json"); } }
    static string ModelFile { get { return Path.Combine(Root, "animus-model.txt"); } }
    const string DefaultModel = "qwen3:14b";
    const string Goal = "Stay near players, help when asked, and behave like a normal survival player.";

    // palette
    static Color Bg     = Color.FromArgb(0x16, 0x16, 0x1C);
    static Color Card   = Color.FromArgb(0x22, 0x22, 0x2C);
    static Color Input  = Color.FromArgb(0x2C, 0x2C, 0x38);
    static Color Txt    = Color.FromArgb(0xE6, 0xE6, 0xEC);
    static Color Muted  = Color.FromArgb(0x93, 0x93, 0xA0);
    static Color Accent = Color.FromArgb(0x6C, 0x5C, 0xE7);
    static Color AccentHi = Color.FromArgb(0x7D, 0x6D, 0xF0);
    static Color Ghost  = Color.FromArgb(0x33, 0x33, 0x40);
    static Color GhostHi = Color.FromArgb(0x3E, 0x3E, 0x4D);
    static Color Danger = Color.FromArgb(0xB5, 0x45, 0x45);
    static Color DangerHi = Color.FromArgb(0xC9, 0x50, 0x50);
    static Color Green  = Color.FromArgb(0x40, 0xC0, 0x57);
    static Color Amber  = Color.FromArgb(0xE3, 0xB3, 0x41);
    static Color Red    = Color.FromArgb(0xF8, 0x51, 0x49);
    static Color LogBg  = Color.FromArgb(0x12, 0x12, 0x18);

    TextBox tbHost, tbPort, tbUser, tbVer, tbOps, tbCmd, tbGoal, log;
    TextBox tbAliases, tbBedrock, tbFloodgate, tbCtlHost, tbCtlPort;
    ComboBox cbModel, cbSchem;
    Button btnOffline, btnMs, btnStop, btnBrainOn;
    string authValue = "offline";
    bool brainEnabled = true;
    Label lblTarget, lblOllama, lblBot, lblBrain;
    Label lvName, lvPos, lvBiome, lvTime, lvThreat, lvPlayers, lvHp, lvFood, lvInv, lvActivity;
    Panel hpFill, foodFill;
    System.Windows.Forms.Timer statusTimer, liveTimer;
    JavaScriptSerializer json = new JavaScriptSerializer();
    volatile bool livePolling = false;   // one in-flight live poll at a time
    volatile bool botUp = false;
    int liveTick = 0;
    string lastLogText = "";             // /log delta tracking
    List<string> cmdHistory = new List<string>();
    int histPos = -1;

    [STAThread]
    static void Main(string[] a)
    {
        Application.EnableVisualStyles();
        if (a.Length >= 2 && a[0] == "--shot")
        {
            try
            {
                Animus f = new Animus();
                f.StartPosition = FormStartPosition.Manual;
                f.Location = new Point(-4000, -4000); // off-screen so children realize + paint
                f.ShowInTaskbar = false;
                f.Show();
                for (int i = 0; i < 30; i++) { Application.DoEvents(); Thread.Sleep(120); } // long enough for a live poll to land
                Bitmap b = new Bitmap(f.ClientSize.Width, f.ClientSize.Height);
                f.DrawToBitmap(b, new Rectangle(0, 0, b.Width, b.Height));
                b.Save(a[1]);
                f.Close();
            }
            catch (Exception ex) { File.WriteAllText(a[1] + ".err", ex.ToString()); }
            return;
        }
        Application.Run(new Animus());
    }

    Animus()
    {
        // Hand-placed layout: disable font/DPI auto-scaling so the exact pixel
        // coordinates are honored on scaled displays (125%/150%) instead of being
        // reflowed into an overlapping mess.
        AutoScaleMode = AutoScaleMode.None;
        Text = "Animus";
        ClientSize = new Size(1064, 872);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        BackColor = Bg;
        Font = new Font("Segoe UI", 9f);

        Label title = new Label();
        title.Text = "ANIMUS"; title.ForeColor = Txt;
        title.Font = new Font("Segoe UI", 17f, FontStyle.Bold);
        title.SetBounds(24, 14, 160, 34); title.BackColor = Color.Transparent;
        Controls.Add(title);

        lblTarget = new Label();
        lblTarget.ForeColor = Muted; lblTarget.BackColor = Color.Transparent;
        lblTarget.SetBounds(26, 50, 460, 18);
        Controls.Add(lblTarget);

        // status dots live in the header now - always visible, next to what they describe
        lblOllama = MakeStatus(560, 24, "Ollama");
        lblBot    = MakeStatus(670, 24, "Bot");
        lblBrain  = MakeStatus(760, 24, "Brain");

        // =====================================================================
        // LEFT COLUMN - setup & lifecycle
        // =====================================================================
        // ---- SERVER CONNECTION card ----------------------------------------
        Panel c1 = MakeCard(24, 76, 460, 372);
        AddHeader(c1, "SERVER CONNECTION");
        AddFieldLabel(c1, "Server host / IP", 16, 38);
        tbHost = MakeInput(c1, 16, 56, 428, Cfg("host", "127.0.0.1"));
        AddFieldLabel(c1, "Port", 16, 96);
        tbPort = MakeInput(c1, 16, 114, 92, Cfg("port", "25565"));
        AddFieldLabel(c1, "Version", 122, 96);
        tbVer = MakeInput(c1, 122, 114, 110, Cfg("version", "1.21.11"));
        AddFieldLabel(c1, "Bot username (blank = account name)", 246, 96);
        tbUser = MakeInput(c1, 246, 114, 198, Cfg("username", "Claudebot"));
        AddFieldLabel(c1, "Auth", 16, 154);
        btnOffline = MakeToggle(c1, "offline", 16, 172, 78, 30);
        btnMs = MakeToggle(c1, "microsoft", 100, 172, 90, 30);
        btnOffline.Click += delegate { SelectAuth("offline"); };
        btnMs.Click += delegate { SelectAuth("microsoft"); };
        SelectAuth(Cfg("auth", "offline"));
        AddFieldLabel(c1, "Operators (comma-separated names)", 204, 154);
        tbOps = MakeInput(c1, 204, 172, 240, CfgArray("operators"));
        AddFieldLabel(c1, "Aliases - extra names it answers to in chat (comma-separated)", 16, 212);
        tbAliases = MakeInput(c1, 16, 230, 428, CfgArray("aliases"));
        AddFieldLabel(c1, "Bedrock port", 16, 270);
        tbBedrock = MakeInput(c1, 16, 288, 92, Cfg("bedrockPort", "19132"));
        AddFieldLabel(c1, "Bedrock prefix", 122, 270);
        tbFloodgate = MakeInput(c1, 122, 288, 92, Cfg("floodgatePrefix", "."));
        AddFieldLabel(c1, "Control API host : port", 246, 270);
        tbCtlHost = MakeInput(c1, 246, 288, 130, Cfg("controlHost", "127.0.0.1"));
        tbCtlPort = MakeInput(c1, 384, 288, 60, Cfg("controlPort", "3001"));
        MakeBtn(c1, "Save", 196, 328, 96, 32, Ghost, GhostHi, Txt, delegate { SaveConnection(false); });
        MakeBtn(c1, "Save + Reconnect", 300, 328, 144, 32, Accent, AccentHi, Color.White, delegate { SaveConnection(true); });

        // ---- BRAIN card -----------------------------------------------------
        Panel c2 = MakeCard(24, 460, 460, 176);
        AddHeader(c2, "BRAIN");
        AddFieldLabel(c2, "Model (Ollama)", 16, 36);
        cbModel = MakeCombo(c2, 16, 54, 244);
        cbModel.DropDownStyle = ComboBoxStyle.DropDown;
        cbModel.Text = LoadModel();
        MakeBtn(c2, "Refresh", 270, 53, 76, 28, Ghost, GhostHi, Txt, delegate { RunBg(RefreshModels); });
        MakeBtn(c2, "Use / Pull", 354, 53, 90, 28, Ghost, GhostHi, Txt, delegate {
            string m = cbModel.Text.Trim(); RunBg(delegate { UseModel(m); });
        });
        AddFieldLabel(c2, "Goal - what it does when idle (applies live)", 16, 92);
        tbGoal = MakeInput(c2, 16, 110, 428, Goal);
        btnBrainOn = MakeToggle(c2, "brain on", 16, 148, 96, 22);
        btnBrainOn.Click += delegate { brainEnabled = !brainEnabled; StyleToggle(btnBrainOn, brainEnabled); RunBg(ApplyBrain); };
        StyleToggle(btnBrainOn, brainEnabled);
        MakeBtn(c2, "Apply goal", 354, 144, 90, 26, Ghost, GhostHi, Txt, delegate { RunBg(ApplyBrain); });

        // ---- SCHEMATICS card -----------------------------------------------
        Panel c3 = MakeCard(24, 648, 460, 92);
        AddHeader(c3, "SCHEMATICS  (build in-game with !schematic)");
        cbSchem = MakeCombo(c3, 16, 44, 240);
        cbSchem.DropDownStyle = ComboBoxStyle.DropDownList;
        MakeBtn(c3, "Add file...", 270, 42, 80, 30, Ghost, GhostHi, Txt, delegate { AddSchem(); });
        MakeBtn(c3, "Open folder", 358, 42, 86, 30, Ghost, GhostHi, Txt, delegate { OpenSchemFolder(); });

        // ---- lifecycle buttons ----------------------------------------------
        MakeBtn(this, "Start Bot + Brain", 24, 756, 280, 48, Accent, AccentHi, Color.White, delegate {
            SetStop("Stop", Danger); // reset the stop button when (re)starting
            string m = cbModel.Text.Trim(); RunBg(delegate { StartBot(); StartBrain(m); });
        });
        btnStop = MakeBtn(this, "Stop", 316, 756, 168, 48, Danger, DangerHi, Color.White, delegate { RunBg(StopAll); });

        Label hint = new Label();
        hint.Text = "Bot + brain run in their own terminal windows; closing this panel leaves them running.";
        hint.ForeColor = Muted; hint.BackColor = Color.Transparent;
        hint.Font = new Font("Segoe UI", 8.25f);
        hint.SetBounds(26, 812, 460, 30);
        Controls.Add(hint);

        // ---- GUI log (panel's own messages) ---------------------------------
        log = new TextBox();
        log.SetBounds(24, 840, 460, 26);
        log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.None;
        log.BorderStyle = BorderStyle.None;
        log.BackColor = Bg; log.ForeColor = Muted;
        log.Font = new Font("Segoe UI", 8.5f);
        Controls.Add(log);

        // =====================================================================
        // RIGHT COLUMN - the LIVE panel (was the browser dashboard)
        // =====================================================================
        // ---- LIVE STATUS card ------------------------------------------------
        Panel s = MakeCard(500, 76, 540, 250);
        AddHeader(s, "LIVE");
        lvName = new Label();
        lvName.Text = "bot offline - press Start"; lvName.ForeColor = Muted; lvName.BackColor = Color.Transparent;
        lvName.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
        lvName.SetBounds(60, 10, 460, 20);
        s.Controls.Add(lvName);

        AddFieldLabel(s, "Health", 16, 40);
        lvHp = AddValueLabel(s, 430, 40, 94);
        hpFill = MakeBar(s, 16, 58, 508);
        AddFieldLabel(s, "Food", 16, 78);
        lvFood = AddValueLabel(s, 430, 78, 94);
        foodFill = MakeBar(s, 16, 96, 508);

        lvPos     = AddInfoRow(s, "Position", 16, 122);
        lvBiome   = AddInfoRow(s, "Biome", 16, 144);
        lvTime    = AddInfoRow(s, "Time", 280, 122);
        lvThreat  = AddInfoRow(s, "Threat", 280, 144);
        lvPlayers = AddInfoRow(s, "Players near", 16, 166);
        lvActivity = AddInfoRow(s, "Doing", 16, 188);

        AddFieldLabel(s, "Inventory", 16, 212);
        lvInv = new Label();
        lvInv.Text = "-"; lvInv.ForeColor = Txt; lvInv.BackColor = Color.Transparent;
        lvInv.Font = new Font("Segoe UI", 8.5f);
        lvInv.SetBounds(84, 211, 440, 34);
        s.Controls.Add(lvInv);

        // ---- ACTIVITY card ----------------------------------------------------
        Panel a = MakeCard(500, 338, 540, 524);
        AddHeader(a, "ACTIVITY + COMMANDS");
        TextBox live = new TextBox();
        live.SetBounds(16, 36, 508, 388);
        live.Multiline = true; live.ReadOnly = true; live.ScrollBars = ScrollBars.Vertical;
        live.BorderStyle = BorderStyle.None;
        live.BackColor = LogBg; live.ForeColor = Color.Gainsboro;
        live.Font = new Font("Consolas", 8.5f);
        a.Controls.Add(live);
        liveLog = live;

        tbCmd = MakeInput(a, 16, 434, 424, "");
        SetPlaceholder(tbCmd, "command…  e.g. come · follow Steve · gather oak_log 10 · autobuild here");
        tbCmd.KeyDown += CmdKeyDown;
        MakeBtn(a, "Send", 448, 434, 76, 32, Accent, AccentHi, Color.White, delegate { SendCmd(); });

        // quick actions - one click for the commands you use every session
        string[] quick = { "come", "stop", "follow", "state", "inventory", "eat", "sleep" };
        int qx = 16;
        for (int i = 0; i < quick.Length; i++)
        {
            string q = quick[i];
            int w = 20 + q.Length * 7;
            MakeBtn(a, q, qx, 478, w, 26, Ghost, GhostHi, Muted, delegate { SendQuick(q); });
            qx += w + 6;
        }

        RefreshTarget();
        RefreshSchem();
        Log("Ready. Set your server, pick a model, then Start Bot + Brain.");
        RunBg(RefreshModels);

        statusTimer = new System.Windows.Forms.Timer();
        statusTimer.Interval = 2000;
        statusTimer.Tick += delegate { RefreshStatus(); };
        statusTimer.Start();
        RefreshStatus();

        liveTimer = new System.Windows.Forms.Timer();
        liveTimer.Interval = 1000;
        liveTimer.Tick += delegate { if (!livePolling) RunBg(PollLive); };
        liveTimer.Start();
    }

    TextBox liveLog;

    // dark title bar on Win10/11
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try { int on = 1; DwmSetWindowAttribute(Handle, 20, ref on, 4); } catch { }
    }

    // ---- styled control factories ------------------------------------------
    Panel MakeCard(int x, int y, int w, int h)
    {
        Panel p = new Panel();
        p.SetBounds(x, y, w, h); p.BackColor = Card;
        Controls.Add(p); Round(p, 12);
        return p;
    }

    void AddHeader(Control parent, string text)
    {
        Label l = new Label();
        l.Text = text; l.ForeColor = Accent;
        l.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
        l.SetBounds(16, 12, 460, 16); l.BackColor = Color.Transparent;
        parent.Controls.Add(l);
    }

    void AddFieldLabel(Control parent, string text, int x, int y)
    {
        Label l = new Label();
        l.Text = text; l.ForeColor = Muted;
        l.Font = new Font("Segoe UI", 8.25f);
        l.SetBounds(x, y, 380, 15); l.BackColor = Color.Transparent;
        parent.Controls.Add(l);
    }

    Label AddValueLabel(Control parent, int x, int y, int w)
    {
        Label l = new Label();
        l.Text = "-"; l.ForeColor = Txt; l.BackColor = Color.Transparent;
        l.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
        l.TextAlign = ContentAlignment.TopRight;
        l.SetBounds(x, y, w, 15);
        parent.Controls.Add(l);
        return l;
    }

    // "Label  value" info row; returns the value label
    Label AddInfoRow(Control parent, string name, int x, int y)
    {
        AddFieldLabel(parent, name, x, y);
        Label v = new Label();
        v.Text = "-"; v.ForeColor = Txt; v.BackColor = Color.Transparent;
        v.Font = new Font("Segoe UI", 8.75f);
        v.SetBounds(x + 84, y - 1, (x > 200 ? 160 : 168), 17);
        parent.Controls.Add(v);
        return v;
    }

    Panel MakeBar(Control parent, int x, int y, int w)
    {
        Panel track = new Panel();
        track.SetBounds(x, y, w, 9); track.BackColor = Input;
        parent.Controls.Add(track); Round(track, 5);
        Panel fill = new Panel();
        fill.SetBounds(0, 0, 0, 9); fill.BackColor = Green;
        track.Controls.Add(fill);
        return fill;
    }

    void SetBar(Panel fill, double v, double max)
    {
        int w = (int)Math.Round(Math.Max(0, Math.Min(1, v / max)) * fill.Parent.Width);
        fill.Width = w;
        fill.BackColor = v > max * 0.6 ? Green : v > max * 0.3 ? Amber : Red;
    }

    TextBox MakeInput(Control parent, int x, int y, int w, string val)
    {
        Panel wrap = new Panel();
        wrap.SetBounds(x, y, w, 32); wrap.BackColor = Input;
        parent.Controls.Add(wrap); Round(wrap, 8);
        TextBox tb = new TextBox();
        tb.BorderStyle = BorderStyle.None; tb.BackColor = Input; tb.ForeColor = Txt;
        tb.Font = new Font("Segoe UI", 10f); tb.Text = val == null ? "" : val;
        tb.SetBounds(10, 8, w - 20, 20);
        wrap.Controls.Add(tb);
        return tb;
    }

    // grey hint text that clears on focus (WinForms has no native placeholder)
    void SetPlaceholder(TextBox tb, string hint)
    {
        bool[] showing = { tb.Text.Length == 0 };
        if (showing[0]) { tb.Text = hint; tb.ForeColor = Muted; }
        tb.GotFocus += delegate { if (showing[0]) { tb.Text = ""; tb.ForeColor = Txt; showing[0] = false; } };
        tb.LostFocus += delegate { if (tb.Text.Length == 0) { tb.Text = hint; tb.ForeColor = Muted; showing[0] = true; } };
    }

    ComboBox MakeCombo(Control parent, int x, int y, int w)
    {
        ComboBox c = new ComboBox();
        c.SetBounds(x, y, w, 26); c.FlatStyle = FlatStyle.Flat;
        c.BackColor = Input; c.ForeColor = Txt; c.Font = new Font("Segoe UI", 10f);
        c.DrawMode = DrawMode.OwnerDrawFixed; c.ItemHeight = 22;
        c.DrawItem += ComboDraw;
        parent.Controls.Add(c);
        return c;
    }

    void ComboDraw(object s, DrawItemEventArgs e)
    {
        ComboBox cb = (ComboBox)s;
        bool sel = (e.State & DrawItemState.Selected) != 0;
        using (SolidBrush b = new SolidBrush(sel ? Accent : Input)) e.Graphics.FillRectangle(b, e.Bounds);
        if (e.Index >= 0)
        {
            string t = cb.Items[e.Index].ToString();
            TextRenderer.DrawText(e.Graphics, t, cb.Font, e.Bounds, Txt,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
        }
    }

    Button MakeBtn(Control parent, string text, int x, int y, int w, int h, Color bg, Color hi, Color fg, EventHandler onClick)
    {
        Button b = new Button();
        b.Text = text; b.SetBounds(x, y, w, h);
        b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderSize = 0;
        b.BackColor = bg; b.ForeColor = fg; b.Cursor = Cursors.Hand;
        b.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
        b.FlatAppearance.MouseOverBackColor = hi;
        b.Click += onClick;
        Round(b, 10);
        parent.Controls.Add(b);
        return b;
    }

    Button MakeToggle(Control parent, string text, int x, int y, int w, int h)
    {
        Button b = new Button();
        b.Text = text; b.SetBounds(x, y, w, h);
        b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderSize = 0; b.Cursor = Cursors.Hand;
        b.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
        Round(b, 8); parent.Controls.Add(b);
        return b;
    }

    void SelectAuth(string v)
    {
        authValue = (v == "microsoft") ? "microsoft" : "offline";
        StyleToggle(btnOffline, authValue == "offline");
        StyleToggle(btnMs, authValue == "microsoft");
    }

    void StyleToggle(Button b, bool on)
    {
        b.BackColor = on ? Accent : Ghost;
        b.ForeColor = on ? Color.White : Muted;
        b.FlatAppearance.MouseOverBackColor = on ? AccentHi : GhostHi;
    }

    Label MakeStatus(int x, int y, string name)
    {
        Label l = new Label();
        l.Text = "● " + name; l.ForeColor = Muted; l.BackColor = Color.Transparent;
        l.Font = new Font("Segoe UI", 9.5f);
        l.SetBounds(x, y, 105, 22);
        Controls.Add(l);
        return l;
    }

    static void Round(Control c, int r)
    {
        GraphicsPath p = new GraphicsPath();
        int w = c.Width, h = c.Height;
        p.AddArc(0, 0, r, r, 180, 90);
        p.AddArc(w - r, 0, r, r, 270, 90);
        p.AddArc(w - r, h - r, r, r, 0, 90);
        p.AddArc(0, h - r, r, r, 90, 90);
        p.CloseAllFigures();
        c.Region = new Region(p);
    }

    // ---- live panel ----------------------------------------------------------
    static string ControlPort { get { return Cfg("controlPort", "3001"); } }
    static string ApiBase { get { return "http://127.0.0.1:" + ControlPort; } }

    void PollLive()
    {
        livePolling = true;
        try
        {
            string stateTxt = WebGet(ApiBase + "/state");
            botUp = stateTxt != null;
            if (!botUp)
            {
                BeginInvoke((MethodInvoker)delegate {
                    lvName.Text = "bot offline - press Start";
                    lvName.ForeColor = Muted;
                });
                return;
            }
            Dictionary<string, object> st = null;
            try { st = json.Deserialize<Dictionary<string, object>>(stateTxt); } catch { }
            string logTxt = WebGet(ApiBase + "/log");
            liveTick++;
            string brainTxt = (liveTick % 4 == 1) ? WebGet(ApiBase + "/brain") : null;
            BeginInvoke((MethodInvoker)delegate { ApplyLive(st, logTxt, brainTxt); });
        }
        catch { }
        finally { livePolling = false; }
    }

    void ApplyLive(Dictionary<string, object> st, string logTxt, string brainTxt)
    {
        if (st != null)
        {
            lvName.Text = S(st, "name") + "  ·  " + S(st, "dimension") + "  ·  " + S(st, "gameMode");
            lvName.ForeColor = Txt;
            double hp = D(st, "health"), food = D(st, "food");
            lvHp.Text = (hp % 1 == 0 ? hp.ToString("0") : hp.ToString("0.#")) + " / 20";
            lvFood.Text = food.ToString("0") + " / 20";
            SetBar(hpFill, hp, 20); SetBar(foodFill, food, 20);
            Dictionary<string, object> pos = st.ContainsKey("pos") ? st["pos"] as Dictionary<string, object> : null;
            lvPos.Text = pos == null ? "-" : ((int)D(pos, "x")) + ", " + ((int)D(pos, "y")) + ", " + ((int)D(pos, "z"));
            lvBiome.Text = S(st, "biome");
            bool day = st.ContainsKey("isDay") && st["isDay"] is bool && (bool)st["isDay"];
            bool rain = st.ContainsKey("isRaining") && st["isRaining"] is bool && (bool)st["isRaining"];
            lvTime.Text = (day ? "day" : "night") + (rain ? " · raining" : "");
            lvTime.ForeColor = day ? Txt : Amber;
            Dictionary<string, object> threat = st.ContainsKey("threat") ? st["threat"] as Dictionary<string, object> : null;
            lvThreat.Text = threat == null ? "none" : S(threat, "type") + " (" + S(threat, "dist") + "m)";
            lvThreat.ForeColor = threat == null ? Muted : Red;
            // NOTE: JavaScriptSerializer hands nested JSON arrays back as ArrayList,
            // not object[] - cast through IList or every list reads as null/empty.
            System.Collections.IList players = st.ContainsKey("players") ? st["players"] as System.Collections.IList : null;
            if (players != null && players.Count > 0)
            {
                List<string> names = new List<string>();
                foreach (object p in players)
                {
                    Dictionary<string, object> pd = p as Dictionary<string, object>;
                    if (pd != null) names.Add(S(pd, "name"));
                }
                lvPlayers.Text = string.Join(", ", names.ToArray());
            }
            else lvPlayers.Text = "alone";
            Dictionary<string, object> act = st.ContainsKey("activity") ? st["activity"] as Dictionary<string, object> : null;
            lvActivity.Text = act == null ? "idle" : S(act, "name") + " · " + S(act, "detail") + " · " + S(act, "forSec") + "s";
            lvActivity.ForeColor = act == null ? Muted : Txt;
            System.Collections.IList inv = st.ContainsKey("inventory") ? st["inventory"] as System.Collections.IList : null;
            if (inv != null && inv.Count > 0)
            {
                string[] items = new string[inv.Count];
                for (int i = 0; i < inv.Count; i++) items[i] = "" + inv[i];
                string t = string.Join("  ·  ", items);
                if (t.Length > 180) t = t.Substring(0, 177) + "…";
                lvInv.Text = t;
            }
            else lvInv.Text = "empty";
        }
        if (logTxt != null && logTxt != lastLogText)
        {
            // append only the new tail so the box doesn't jump while you're reading
            string add = logTxt.StartsWith(lastLogText) && lastLogText.Length > 0
                ? logTxt.Substring(lastLogText.Length) : logTxt;
            lastLogText = logTxt;
            bool nearBottom = liveLog.SelectionStart >= liveLog.TextLength - 5 || liveLog.TextLength == 0;
            liveLog.AppendText(add.TrimStart('\n').Replace("\n", "\r\n") + "\r\n");
            if (liveLog.TextLength > 60000) // keep the box bounded
            { liveLog.Text = liveLog.Text.Substring(liveLog.TextLength - 40000); liveLog.SelectionStart = liveLog.TextLength; }
            if (nearBottom) { liveLog.SelectionStart = liveLog.TextLength; liveLog.ScrollToCaret(); }
        }
        if (brainTxt != null)
        {
            try
            {
                Dictionary<string, object> b = json.Deserialize<Dictionary<string, object>>(brainTxt);
                Dictionary<string, object> cfg = b != null && b.ContainsKey("settings") ? b["settings"] as Dictionary<string, object> : null;
                if (cfg != null)
                {
                    bool en = cfg.ContainsKey("enabled") && cfg["enabled"] is bool && (bool)cfg["enabled"];
                    if (en != brainEnabled) { brainEnabled = en; StyleToggle(btnBrainOn, brainEnabled); }
                    if (!tbGoal.Focused && cfg.ContainsKey("goal") && cfg["goal"] != null) tbGoal.Text = "" + cfg["goal"];
                }
            }
            catch { }
        }
    }

    static string S(Dictionary<string, object> d, string k)
    { return d != null && d.ContainsKey(k) && d[k] != null ? d[k].ToString() : "-"; }
    static double D(Dictionary<string, object> d, string k)
    {
        if (d == null || !d.ContainsKey(k) || d[k] == null) return 0;
        try { return Convert.ToDouble(d[k]); } catch { return 0; }
    }

    // ---- command console -----------------------------------------------------
    void CmdKeyDown(object s, KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; SendCmd(); }
        else if (e.KeyCode == Keys.Up && cmdHistory.Count > 0)
        {
            e.SuppressKeyPress = true;
            histPos = Math.Max(0, histPos < 0 ? cmdHistory.Count - 1 : histPos - 1);
            tbCmd.Text = cmdHistory[histPos]; tbCmd.SelectionStart = tbCmd.TextLength;
        }
        else if (e.KeyCode == Keys.Down && histPos >= 0)
        {
            e.SuppressKeyPress = true;
            histPos++;
            if (histPos >= cmdHistory.Count) { histPos = -1; tbCmd.Text = ""; }
            else { tbCmd.Text = cmdHistory[histPos]; tbCmd.SelectionStart = tbCmd.TextLength; }
        }
    }

    void SendCmd()
    {
        string c = tbCmd.Text.Trim();
        if (c.Length == 0 || c.StartsWith("command…")) return;
        cmdHistory.Add(c); histPos = -1;
        tbCmd.Text = ""; tbCmd.Focus();
        SendQuick(c);
    }

    void SendQuick(string c)
    {
        if (!botUp) { Log("Bot is offline - press Start first."); return; }
        RunBg(delegate {
            string r = WebPost(ApiBase + "/op/cmd", c);
            if (r == null) Log("Command failed - bot not responding.");
            // the reply also lands in the activity log via the bot's own (ui-cmd) line
        });
    }

    void ApplyBrain()
    {
        if (!botUp) { Log("Brain settings apply live once the bot is running."); return; }
        string goal = "";
        tbGoal.Invoke((MethodInvoker)delegate { goal = tbGoal.Text.Trim(); });
        string body = json.Serialize(new Dictionary<string, object> {
            { "model", cbModel.Text.Trim() }, { "goal", goal }, { "enabled", brainEnabled } });
        string r = WebPost(ApiBase + "/brain", body);
        Log(r != null ? ("Brain " + (brainEnabled ? "on" : "paused") + ", goal applied.") : "Could not reach the bot to apply brain settings.");
    }

    // ---- tiny HTTP (short timeouts so a dead bot never freezes the UI) -------
    class QuickClient : WebClient
    {
        protected override WebRequest GetWebRequest(Uri address)
        {
            WebRequest r = base.GetWebRequest(address);
            r.Timeout = 1500;
            return r;
        }
    }

    static string WebGet(string url)
    {
        try { using (QuickClient c = new QuickClient()) return c.DownloadString(url); }
        catch { return null; }
    }

    static string WebPost(string url, string body)
    {
        try
        {
            using (QuickClient c = new QuickClient())
            {
                c.Encoding = Encoding.UTF8;
                return c.UploadString(url, body);
            }
        }
        catch { return null; }
    }

    // ---- status + log ------------------------------------------------------
    void RefreshTarget()
    {
        lblTarget.Text = "bot -> " + Cfg("host", "?") + ":" + Cfg("port", "?") +
                         "   auth=" + Cfg("auth", "?") + "   version=" + Cfg("version", "?");
    }

    void RefreshStatus()
    {
        SetDot(lblOllama, "Ollama", PortOpen(11434));
        SetDot(lblBot, "Bot", botUp || IsRunning("Animus BOT"));
        SetDot(lblBrain, "Brain", IsRunning("Animus BRAIN"));
    }

    void SetDot(Label l, string name, bool up)
    {
        l.Text = "● " + name;
        l.ForeColor = up ? Green : Muted;
    }

    void Log(string msg)
    {
        if (log.InvokeRequired) { log.BeginInvoke((MethodInvoker)delegate { Log(msg); }); return; }
        log.Text = msg; // single-line status strip; the live activity box carries history
    }

    static void RunBg(ThreadStart work)
    {
        ThreadPool.QueueUserWorkItem(delegate { try { work(); } catch (Exception e) { Debug.WriteLine(e); } });
    }

    // ---- config writing ----------------------------------------------------
    static List<string> SplitNames(string csv)
    {
        List<string> outp = new List<string>();
        foreach (string s in csv.Split(',')) { string t = s.Trim(); if (t.Length > 0) outp.Add(t); }
        return outp;
    }

    void SaveConnection(bool reconnect)
    {
        string host = tbHost.Text.Trim(), port = tbPort.Text.Trim(), user = tbUser.Text.Trim();
        string ver = tbVer.Text.Trim(), auth = authValue;
        string bedrock = tbBedrock.Text.Trim(), floodgate = tbFloodgate.Text.Trim();
        string ctlHost = tbCtlHost.Text.Trim(), ctlPort = tbCtlPort.Text.Trim();
        List<string> ops = SplitNames(tbOps.Text);
        List<string> aliases = SplitNames(tbAliases.Text);
        if (!Regex.IsMatch(port, "^\\d+$")) { Log("Port must be a number."); return; }
        if (bedrock.Length > 0 && !Regex.IsMatch(bedrock, "^\\d+$")) { Log("Bedrock port must be a number."); return; }
        if (ctlPort.Length > 0 && !Regex.IsMatch(ctlPort, "^\\d+$")) { Log("Control port must be a number."); return; }
        // A RUNNING bot applies the change itself (and restarts if asked) via POST /config;
        // otherwise edit config.json directly for the next start.
        if (botUp)
        {
            Dictionary<string, object> body = new Dictionary<string, object> {
                { "host", host }, { "port", port }, { "version", ver },
                { "auth", auth }, { "username", user }, { "operators", ops },
                { "aliases", aliases }, { "bedrockPort", bedrock }, { "floodgatePrefix", floodgate },
                { "controlHost", ctlHost }, { "controlPort", ctlPort },
                { "reconnect", reconnect } };
            string b = json.Serialize(body);
            RunBg(delegate {
                string r = WebPost(ApiBase + "/config", b);
                Log(r == null ? "Could not reach the bot to save." :
                    reconnect ? "Saved - bot is reconnecting with the new settings..." : "Saved to the running bot.");
                BeginInvoke((MethodInvoker)RefreshTarget);
            });
            return;
        }
        try
        {
            string txt = File.ReadAllText(CfgPath);
            txt = SetStr(txt, "host", host);
            txt = SetNum(txt, "port", port);
            txt = SetStr(txt, "username", user);
            txt = SetStr(txt, "version", ver);
            txt = SetStr(txt, "auth", auth);
            txt = SetArr(txt, "operators", ops);
            txt = SetArr(txt, "aliases", aliases);
            if (bedrock.Length > 0) txt = SetNum(txt, "bedrockPort", bedrock);
            txt = SetStr(txt, "floodgatePrefix", floodgate);
            if (ctlHost.Length > 0) txt = SetStr(txt, "controlHost", ctlHost);
            if (ctlPort.Length > 0) txt = SetNum(txt, "controlPort", ctlPort);
            File.WriteAllText(CfgPath, txt);
            RefreshTarget();
            Log("Saved. Settings apply when you press Start.");
        }
        catch (Exception e) { Log("Could not save config: " + e.Message); }
    }

    static string SetStr(string txt, string key, string val)
    {
        string pat = "(\"" + Regex.Escape(key) + "\"\\s*:\\s*\")[^\"]*(\")";
        string rep = JsonEsc(val);
        return Regex.Replace(txt, pat, delegate(Match m) { return m.Groups[1].Value + rep + m.Groups[2].Value; });
    }
    static string SetNum(string txt, string key, string num)
    {
        string pat = "(\"" + Regex.Escape(key) + "\"\\s*:\\s*)\\d+";
        return Regex.Replace(txt, pat, delegate(Match m) { return m.Groups[1].Value + num; });
    }
    static string SetArr(string txt, string key, List<string> items)
    {
        string[] q = new string[items.Count];
        for (int i = 0; i < items.Count; i++) q[i] = "\"" + JsonEsc(items[i]) + "\"";
        string arr = "[" + string.Join(", ", q) + "]";
        string pat = "(\"" + Regex.Escape(key) + "\"\\s*:\\s*)\\[[^\\]]*\\]";
        return Regex.Replace(txt, pat, delegate(Match m) { return m.Groups[1].Value + arr; });
    }
    static string JsonEsc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }

    // ---- model management --------------------------------------------------
    void RefreshModels()
    {
        EnsureOllama();
        string list = RunCapture("ollama", "list");
        if (list == null) { Log("Could not reach Ollama to list models."); return; }
        List<string> names = ParseModelNames(list);
        string current = cbModel.Text;
        cbModel.BeginInvoke((MethodInvoker)delegate {
            cbModel.Items.Clear();
            foreach (string n in names) cbModel.Items.Add(n);
            if (current != null && current.Trim().Length > 0) cbModel.Text = current;
            else if (names.Count > 0) cbModel.Text = names[0];
        });
        Log(names.Count == 0 ? "No models installed - type a name and hit Use / Pull." : ("Models: " + string.Join(", ", names.ToArray())));
    }

    void UseModel(string m)
    {
        if (m == null || m.Trim().Length == 0) { Log("Type or pick a model first."); return; }
        m = m.Trim();
        EnsureOllama();
        string list = RunCapture("ollama", "list");
        bool installed = list != null && list.IndexOf(m, StringComparison.OrdinalIgnoreCase) >= 0;
        if (!installed)
        {
            Log("Pulling " + m + " ... (progress shows in the pull window)");
            RunSync("cmd.exe", "/c ollama pull " + m, Root);
            list = RunCapture("ollama", "list");
            installed = list != null && list.IndexOf(m, StringComparison.OrdinalIgnoreCase) >= 0;
        }
        if (installed) { SaveModel(m); Log("Brain model set to " + m + "."); RefreshModels(); if (botUp) ApplyBrain(); }
        else Log("Pull failed - '" + m + "' is not in 'ollama list'. Keeping " + LoadModel() + ".");
    }

    static List<string> ParseModelNames(string list)
    {
        List<string> names = new List<string>();
        if (list == null) return names;
        string[] lines = list.Replace("\r", "").Split('\n');
        foreach (string line in lines)
        {
            string t = line.Trim();
            if (t.Length == 0 || t.StartsWith("NAME")) continue;
            string[] parts = Regex.Split(t, "\\s+");
            if (parts.Length > 0 && parts[0].Contains(":")) names.Add(parts[0]);
        }
        return names;
    }

    static string LoadModel()
    {
        try { if (File.Exists(ModelFile)) { string m = File.ReadAllText(ModelFile).Trim(); if (m.Length > 0) return m; } }
        catch { }
        return DefaultModel;
    }
    static void SaveModel(string m) { try { File.WriteAllText(ModelFile, m.Trim()); } catch { } }

    void EnsureOllama()
    {
        if (PortOpen(11434)) return;
        if (!OnPath("ollama")) { Log("WARNING: 'ollama' is not on your PATH. Install Ollama."); return; }
        Log("Starting Ollama server...");
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("ollama", "serve");
            psi.UseShellExecute = false; psi.CreateNoWindow = true;
            Process.Start(psi);
        }
        catch (Exception e) { Log("Could not start Ollama: " + e.Message); }
        for (int i = 0; i < 20 && !PortOpen(11434); i++) Thread.Sleep(500);
        Log(PortOpen(11434) ? "Ollama up." : "Ollama still not responding on :11434.");
    }

    // ---- launch actions ----------------------------------------------------
    void StartBot()
    {
        if (IsRunning("Animus BOT")) { Log("Bot already running."); return; }
        if (!OnPath("node")) { Log("ERROR: 'node' is not on your PATH. Install Node.js and retry."); return; }
        if (!Directory.Exists(Path.Combine(BotDir, "node_modules")))
        { Log("Installing bot dependencies (first run)..."); RunSync("cmd.exe", "/c npm install", BotDir); }
        string auth = Cfg("auth", "?");
        Log("Starting bot -> " + Cfg("host", "?") + ":" + Cfg("port", "?") + " (auth=" + auth + ")...");
        if (auth == "microsoft") Log("First run: a microsoft.com/link CODE appears in the BOT window - open it to log in.");
        SpawnWindow("Set-Location '" + BotDir + "'; $host.UI.RawUI.WindowTitle='Animus BOT'; node run.js");
        if (WaitPort(int.Parse(ControlPort), 300)) Log("Bot up - live panel is on.");
        else Log("Bot didn't come up on :" + ControlPort + " - check the 'Animus BOT' window (host/port/version/login).");
    }

    void StartBrain(string model)
    {
        if (IsRunning("Animus BRAIN")) { Log("Brain already running."); return; }
        if (model == null || model.Trim().Length == 0) model = LoadModel();
        model = model.Trim();
        EnsureOllama();
        string list = RunCapture("ollama", "list");
        if (list != null && list.IndexOf(model, StringComparison.OrdinalIgnoreCase) < 0)
        { Log(model + " isn't pulled yet - pulling it first..."); UseModel(model); }
        Log("Starting brain (" + model + ")...");
        string cmd =
            "Set-Location '" + BotDir + "'; $host.UI.RawUI.WindowTitle='Animus BRAIN'; " +
            "$env:LLM_URL='http://127.0.0.1:11434/api/chat'; $env:OLLAMA_NATIVE='1'; " +
            "$env:LLM_MODEL='" + model + "'; $env:BOT_URL='" + ApiBase + "'; " +
            "$env:GOAL='" + Goal + "'; node brain-llm.js";
        SpawnWindow(cmd);
    }

    // ---- schematics --------------------------------------------------------
    static string SchemDir { get { return Path.Combine(BotDir, "schematics"); } }

    void RefreshSchem()
    {
        cbSchem.Items.Clear();
        try
        {
            if (Directory.Exists(SchemDir))
                foreach (string f in Directory.GetFiles(SchemDir, "*.schem"))
                    cbSchem.Items.Add(Path.GetFileNameWithoutExtension(f));
        }
        catch { }
        if (cbSchem.Items.Count > 0) cbSchem.SelectedIndex = 0;
        else cbSchem.Text = "(none yet - add one)";
    }

    void AddSchem()
    {
        OpenFileDialog dlg = new OpenFileDialog();
        dlg.Title = "Add a schematic the bot can build";
        dlg.Filter = "Schematics (*.schem;*.litematic;*.nbt)|*.schem;*.litematic;*.nbt|All files (*.*)|*.*";
        dlg.Multiselect = true;
        if (dlg.ShowDialog() != DialogResult.OK) return;
        try
        {
            if (!Directory.Exists(SchemDir)) Directory.CreateDirectory(SchemDir);
            int n = 0;
            foreach (string src in dlg.FileNames)
            {
                string dest = Path.Combine(SchemDir, Path.GetFileName(src));
                File.Copy(src, dest, true); n++;
            }
            Log("Added " + n + " schematic(s). Build in-game: !schematic load <name>, then !schematic build here");
            RefreshSchem();
        }
        catch (Exception e) { Log("Could not add schematic: " + e.Message); }
    }

    void OpenSchemFolder()
    {
        try
        {
            if (!Directory.Exists(SchemDir)) Directory.CreateDirectory(SchemDir);
            Process.Start(new ProcessStartInfo(SchemDir) { UseShellExecute = true });
        }
        catch (Exception e) { Log("Could not open folder: " + e.Message); }
    }

    void StopAll()
    {
        Log("Stopping bot + brain...");
        string[] titles = { "Animus BOT", "Animus BRAIN" };
        int killed = 0;
        foreach (Process p in Process.GetProcesses())
        { try { if (Array.IndexOf(titles, p.MainWindowTitle) >= 0) { p.Kill(); killed++; } } catch { } }
        Log(killed > 0 ? ("Closed " + killed + " window(s).") : "Nothing was running.");
        SetStop("Stopped", Ghost);
        botUp = false;
    }

    void SetStop(string text, Color bg)
    {
        if (btnStop.InvokeRequired) { btnStop.BeginInvoke((MethodInvoker)delegate { SetStop(text, bg); }); return; }
        btnStop.Text = text; btnStop.BackColor = bg;
    }

    // ---- low-level helpers -------------------------------------------------
    static void SpawnWindow(string psCommand)
    {
        ProcessStartInfo psi = new ProcessStartInfo("powershell", "-NoExit -Command \"" + psCommand + "\"");
        psi.UseShellExecute = true;
        Process.Start(psi);
    }

    static bool IsRunning(string title)
    {
        foreach (Process p in Process.GetProcesses())
        { try { if (p.MainWindowTitle == title) return true; } catch { } }
        return false;
    }

    static bool PortOpen(int port)
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult r = c.BeginConnect("127.0.0.1", port, null, null);
                bool ok = r.AsyncWaitHandle.WaitOne(300);
                if (ok) { c.EndConnect(r); return true; }
                return false;
            }
        }
        catch { return false; }
    }

    static bool WaitPort(int port, int seconds)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < deadline) { if (PortOpen(port)) return true; Thread.Sleep(600); }
        return false;
    }

    static bool OnPath(string exe)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c where " + exe);
            psi.UseShellExecute = false; psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
            Process p = Process.Start(psi); p.WaitForExit();
            return p.ExitCode == 0;
        }
        catch { return false; }
    }

    static void RunSync(string file, string args, string workDir)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(file, args);
            psi.UseShellExecute = false; psi.WorkingDirectory = workDir;
            Process p = Process.Start(psi); p.WaitForExit();
        }
        catch { }
    }

    static string RunCapture(string file, string args)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(file, args);
            psi.UseShellExecute = false; psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
            Process p = Process.Start(psi);
            string outp = p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            return outp;
        }
        catch { return null; }
    }

    static string Cfg(string key, string dflt)
    {
        try
        {
            string txt = File.ReadAllText(CfgPath);
            Match m = Regex.Match(txt, "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
            if (m.Success) return m.Groups[1].Value;
            m = Regex.Match(txt, "\"" + key + "\"\\s*:\\s*(\\d+)");
            if (m.Success) return m.Groups[1].Value;
        }
        catch { }
        return dflt;
    }

    // read a string array like "operators": ["A","B"] back into "A, B"
    static string CfgArray(string key)
    {
        try
        {
            string txt = File.ReadAllText(CfgPath);
            Match m = Regex.Match(txt, "\"" + key + "\"\\s*:\\s*\\[([^\\]]*)\\]");
            if (m.Success)
            {
                List<string> outp = new List<string>();
                foreach (Match v in Regex.Matches(m.Groups[1].Value, "\"([^\"]*)\"")) outp.Add(v.Groups[1].Value);
                return string.Join(", ", outp.ToArray());
            }
        }
        catch { }
        return "";
    }
}
