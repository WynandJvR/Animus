// Animus control panel - a single native Windows GUI app (WinForms, dark theme).
// Left column: point the bot at YOUR server (writes bot/config.json), pick/pull the
// Ollama brain model, manage schematics, start/stop everything. Right column: the
// LIVE panel (health/food/position/threat, inventory), a live BOT POV view rendered
// from the bot's /pov raycast frames, and the activity log + command console.
// The header band carries the current goal and a chip naming the subsystem that is
// currently driving the body (threat > hazard > maneuver > stuck > job > activity).
//
// Layout: hand-placed absolute pixels driven by ONE central Relayout() on a 12-column
// grid (AutoScaleMode.None stays - exact pixels on 125%/150% displays). Everything
// lives in a Dock=Fill AutoScroll host so the window is freely resizable and scrolls
// instead of clipping below the 980x720 minimum client size.
// Spacing scale: 4/8/12/16/24. Type scale: FTitle/FHeader/FBody/FLabel/FValue/FMono/FSmall.
// Button tiers: Primary h=36, Secondary h=32, Chip h=26.
//
// Compiled to Animus.exe by build-exe.ps1 (uses the .NET Framework compiler that
// ships with Windows - no SDK needed).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
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

    // ---- spacing scale (4.1) - every offset in layout code comes from here -----
    const int S1 = 4, S2 = 8, S3 = 12, S4 = 16, S6 = 24;
    const int LabelW  = 96;   // fixed label column (4.4)
    const int RowH    = 22;   // info row pitch
    const int InputH  = 32;
    const int BtnPrim = 36, BtnSec = 32, BtnChip = 26;
    const int MinCW   = 980, MinCH = 720;
    const int HeaderH = 64, FooterH = 24;
    const int PovH    = 224;  // POV canvas height (16:9 image letterboxed inside)
    const int MinActH = 200;

    // ---- type scale (4.2) - the only fonts in the file ------------------------
    static Font FTitle  = new Font("Segoe UI Semibold", 16f);
    static Font FHeader = new Font("Segoe UI", 8.5f, FontStyle.Bold);
    static Font FBody   = new Font("Segoe UI", 9.75f);
    static Font FBodyB  = new Font("Segoe UI", 9.75f, FontStyle.Bold);
    static Font FLabel  = new Font("Segoe UI", 8.25f);
    static Font FValue  = new Font("Segoe UI Semibold", 9f);
    static Font FMono   = new Font("Consolas", 8.75f);
    static Font FSmall  = new Font("Segoe UI", 8f);
    static Font FSmallB = new Font("Segoe UI", 8f, FontStyle.Bold);

    // ---- palette (4.5) --------------------------------------------------------
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
    // POV staleness chip (GUI-POV-V3 §4) — exact colours from the design table.
    static Color PovLive  = Color.FromArgb(110, 199, 132);
    static Color PovWarn  = Color.FromArgb(224, 177, 88);
    static Color PovStale = Color.FromArgb(224, 102, 102);
    static Color Amber  = Color.FromArgb(0xE3, 0xB3, 0x41);
    static Color Red    = Color.FromArgb(0xF8, 0x51, 0x49);
    static Color LogBg  = Color.FromArgb(0x12, 0x12, 0x18);

    // ---- controls -------------------------------------------------------------
    Panel rootScroll;
    Panel cServer, cBrain, cSchem, cLive, cPov, cAct;
    Label title, lblTarget, lblOllama, lblBot, lblBrain, lblStatus, lblGoal, chip;
    TextBox tbHost, tbPort, tbUser, tbVer, tbOps, tbCmd, tbGoal;
    TextBox tbAliases, tbBedrock, tbFloodgate, tbCtlHost, tbCtlPort;
    Label lbHost, lbPort, lbVer, lbUser, lbAuth, lbOps, lbAliases, lbBed, lbPre, lbApiH, lbApiP;
    Label lbModel, lbBrainGoal, lbInvHead;
    Button btnSave, btnSaveRe, btnRefresh, btnUse, btnApplyGoal, btnAddSchem, btnOpenSchem;
    Button btnStart, btnStop, btnSend;
    ComboBox cbModel, cbSchem;
    Button btnOffline, btnMs, btnBrainOn;
    Label lvName, lvPos, lvBiome, lvTime, lvThreat, lvPlayers, lvHp, lvFood, lvInv, lvActivity;
    Label lkPos, lkBiome, lkTime, lkThreat, lkPlayers, lkActivity, lkHp, lkFood;
    Panel hpTrack, foodTrack, hpFill, foodFill;
    TextBox liveLog;
    Canvas pov;
    List<Button> quickBtns = new List<Button>();
    ToolTip tips = new ToolTip();

    string authValue = "offline";
    bool brainEnabled = true;
    string brainGoal = "";
    string goalText = "Goal: —";
    string chipText = "OFFLINE";
    int overlayRight = 0;

    System.Windows.Forms.Timer statusTimer, liveTimer, povTimer;
    JavaScriptSerializer json = new JavaScriptSerializer();
    volatile bool livePolling = false;   // one in-flight live poll at a time
    volatile bool povBusy = false;
    volatile bool botUp = false;
    volatile int stateFails = 0;         // consecutive /state failures (offline after 3)
    int liveTick = 0;
    string lastLogText = "";             // /log delta tracking
    List<string> cmdHistory = new List<string>();
    int histPos = -1;

    // POV state (povFront is only swapped/disposed on the UI thread)
    Bitmap povFront;
    string povMode = "no signal — bot offline";
    string povHud = "";
    // v3 §4: staleness chip + achieved-fps readout.
    string povChip = "";
    Color povChipCol = Color.FromArgb(110, 199, 132);
    // Achieved-fps ring: distinct frame builds (unix ms), touched only on the POV
    // background thread (one poll in flight at a time, guarded by povBusy).
    long[] povBuilds = new long[16];
    int povBuildAt = 0;
    long povLastBuilt = 0;
    bool laidOut = false;
    bool inLayout = false;

    [STAThread]
    static void Main(string[] a)
    {
        // Process-wide, set once before any WebClient exists: the .NET Framework
        // default of 2 connections per host throttled /state+/log+/brain+/pov and
        // showed up as intermittent false "offline" (GUI-POV-V2 §2.2).
        ServicePointManager.DefaultConnectionLimit = 16;
        Application.EnableVisualStyles();
        if (a.Length >= 2 && a[0] == "--shot")
        {
            try
            {
                Animus f = new Animus();
                f.StartPosition = FormStartPosition.Manual;
                f.Location = new Point(-4000, -4000); // off-screen so children realize + paint
                f.ShowInTaskbar = false;
                if (a.Length >= 3)
                {
                    Match m = Regex.Match(a[2], "^(\\d+)x(\\d+)$");
                    if (m.Success) f.ClientSize = new Size(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value));
                }
                f.Show();
                for (int i = 0; i < 30; i++) { Application.DoEvents(); Thread.Sleep(120); } // long enough for a live poll to land
                Bitmap b = new Bitmap(f.Width, f.Height);
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
        // reflowed into an overlapping mess. Relayout() does all the arithmetic.
        AutoScaleMode = AutoScaleMode.None;
        Text = "Animus";
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        BackColor = Bg;
        Font = FBody;
        tips.AutoPopDelay = 10000; tips.InitialDelay = 400; tips.ReshowDelay = 100;

        // minimum window = the OS size whose CLIENT area is 980x720
        ClientSize = new Size(MinCW, MinCH);
        MinimumSize = Size;
        ClientSize = new Size(1120, 940);

        rootScroll = new Panel();
        rootScroll.Dock = DockStyle.Fill;
        rootScroll.AutoScroll = true;
        rootScroll.BackColor = Bg;
        Controls.Add(rootScroll);
        DarkScroll(rootScroll);

        BuildHeader();
        BuildServerCard();
        BuildBrainCard();
        BuildSchemCard();
        BuildLifecycle();
        BuildLiveCard();
        BuildPovCard();
        BuildActivityCard();
        BuildFooter();

        rootScroll.Resize += delegate { Relayout(); };
        Relayout();
        laidOut = true;

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
        // Guard is set at QUEUE time, not inside the worker: a delayed ThreadPool
        // dispatch could otherwise let a second tick queue a concurrent poller.
        liveTimer.Tick += delegate { if (!livePolling) { livePolling = true; RunBg(PollLive); } };
        liveTimer.Start();

        povTimer = new System.Windows.Forms.Timer();
        povTimer.Interval = 300;
        povTimer.Tick += delegate { if (!povBusy) { povBusy = true; RunBg(PollPov); } };
        povTimer.Start();
    }

    // =========================================================================
    // CONSTRUCTION
    // =========================================================================
    void BuildHeader()
    {
        title = Lbl(rootScroll, "ANIMUS", FTitle, Txt);
        lblTarget = Lbl(rootScroll, "", FLabel, Muted);

        lblOllama = MakeStatus("Ollama");
        lblBot    = MakeStatus("Bot");
        lblBrain  = MakeStatus("Brain");

        lblGoal = Lbl(rootScroll, goalText, FValue, Txt);
        lblGoal.TextAlign = ContentAlignment.MiddleRight;
        lblGoal.AutoEllipsis = true;

        chip = Lbl(rootScroll, chipText, FSmallB, Muted);
        chip.TextAlign = ContentAlignment.MiddleCenter;
        chip.BackColor = Mix(Bg, Muted, 0.25);
        chip.Height = 22;
        Round(chip, 8);
    }

    void BuildServerCard()
    {
        cServer = MakeCard();
        AddHeader(cServer, "SERVER CONNECTION");
        lbHost = FieldLabel(cServer, "Server host / IP");
        tbHost = MakeInput(cServer, Cfg("host", "127.0.0.1"));
        lbPort = FieldLabel(cServer, "Port");
        tbPort = MakeInput(cServer, Cfg("port", "25565"));
        lbVer  = FieldLabel(cServer, "Version");
        tbVer  = MakeInput(cServer, Cfg("version", "1.21.11"));
        lbUser = FieldLabel(cServer, "Bot username");
        tbUser = MakeInput(cServer, Cfg("username", "Claudebot"));
        lbAuth = FieldLabel(cServer, "Auth");
        btnOffline = MakeToggle(cServer, "offline");
        btnMs = MakeToggle(cServer, "microsoft");
        btnOffline.Click += delegate { SelectAuth("offline"); };
        btnMs.Click += delegate { SelectAuth("microsoft"); };
        SelectAuth(Cfg("auth", "offline"));
        lbOps = FieldLabel(cServer, "Operators (comma-separated)");
        tbOps = MakeInput(cServer, CfgArray("operators"));
        lbAliases = FieldLabel(cServer, "Aliases — extra names it answers to in chat (comma-separated)");
        tbAliases = MakeInput(cServer, CfgArray("aliases"));
        lbBed = FieldLabel(cServer, "Bedrock port");
        tbBedrock = MakeInput(cServer, Cfg("bedrockPort", "19132"));
        lbPre = FieldLabel(cServer, "Bedrock prefix");
        tbFloodgate = MakeInput(cServer, Cfg("floodgatePrefix", "."));
        lbApiH = FieldLabel(cServer, "API host");
        tbCtlHost = MakeInput(cServer, Cfg("controlHost", "127.0.0.1"));
        lbApiP = FieldLabel(cServer, "API port");
        tbCtlPort = MakeInput(cServer, Cfg("controlPort", "3001"));
        btnSave   = Secondary(cServer, "Save", delegate { SaveConnection(false); });
        btnSaveRe = Primary(cServer, "Save + Reconnect", Accent, AccentHi, delegate { SaveConnection(true); });
    }

    void BuildBrainCard()
    {
        cBrain = MakeCard();
        AddHeader(cBrain, "BRAIN");
        lbModel = FieldLabel(cBrain, "Model (Ollama)");
        cbModel = MakeCombo(cBrain);
        cbModel.DropDownStyle = ComboBoxStyle.DropDown;
        cbModel.Text = LoadModel();
        btnRefresh = Secondary(cBrain, "Refresh", delegate { RunBg(RefreshModels); });
        btnUse = Secondary(cBrain, "Use / Pull", delegate {
            string m = cbModel.Text.Trim(); RunBg(delegate { UseModel(m); });
        });
        lbBrainGoal = FieldLabel(cBrain, "Goal — what it does when idle (applies live)");
        tbGoal = MakeInput(cBrain, Goal);
        btnBrainOn = MakeToggle(cBrain, "brain on");
        btnBrainOn.Click += delegate { brainEnabled = !brainEnabled; StyleToggle(btnBrainOn, brainEnabled); RunBg(ApplyBrain); };
        StyleToggle(btnBrainOn, brainEnabled);
        btnApplyGoal = Secondary(cBrain, "Apply goal", delegate { RunBg(ApplyBrain); });
    }

    void BuildSchemCard()
    {
        cSchem = MakeCard();
        AddHeader(cSchem, "SCHEMATICS  ·  BUILD IN-GAME WITH !SCHEMATIC");
        cbSchem = MakeCombo(cSchem);
        cbSchem.DropDownStyle = ComboBoxStyle.DropDownList;
        btnAddSchem = Secondary(cSchem, "Add file…", delegate { AddSchem(); });
        btnOpenSchem = Secondary(cSchem, "Open folder", delegate { OpenSchemFolder(); });
    }

    void BuildLifecycle()
    {
        btnStart = Primary(rootScroll, "Start Bot + Brain", Accent, AccentHi, delegate {
            SetStop("Stop", Danger); // reset the stop button when (re)starting
            string m = cbModel.Text.Trim(); RunBg(delegate { StartBot(); StartBrain(m); });
        });
        tips.SetToolTip(btnStart, "Bot + brain run in their own terminal windows; closing this panel leaves them running.");
        btnStop = Primary(rootScroll, "Stop", Danger, DangerHi, delegate { RunBg(StopAll); });
    }

    void BuildLiveCard()
    {
        cLive = MakeCard();
        AddHeader(cLive, "LIVE");
        lvName = Lbl(cLive, "bot offline — press Start", FValue, Muted);
        lvName.AutoEllipsis = true;
        lkHp = FieldLabel(cLive, "Health");
        lvHp = ValueLabel(cLive); lvHp.TextAlign = ContentAlignment.MiddleRight;
        hpFill = MakeBar(cLive, out hpTrack);
        lkFood = FieldLabel(cLive, "Food");
        lvFood = ValueLabel(cLive); lvFood.TextAlign = ContentAlignment.MiddleRight;
        foodFill = MakeBar(cLive, out foodTrack);
        lkPos = FieldLabel(cLive, "Position");     lvPos = ValueLabel(cLive);
        lkTime = FieldLabel(cLive, "Time");        lvTime = ValueLabel(cLive);
        lkBiome = FieldLabel(cLive, "Biome");      lvBiome = ValueLabel(cLive);
        lkThreat = FieldLabel(cLive, "Threat");    lvThreat = ValueLabel(cLive);
        lkPlayers = FieldLabel(cLive, "Players near"); lvPlayers = ValueLabel(cLive);
        lkActivity = FieldLabel(cLive, "Doing");   lvActivity = ValueLabel(cLive);
        lbInvHead = FieldLabel(cLive, "Inventory");
        lvInv = Lbl(cLive, "—", FSmall, Txt);
    }

    void BuildPovCard()
    {
        cPov = MakeCard();
        AddHeader(cPov, "BOT POV");
        pov = new Canvas();
        pov.BackColor = LogBg;
        cPov.Controls.Add(pov);
        Round(pov, 8);
        pov.Paint += PovPaint;
    }

    void BuildActivityCard()
    {
        cAct = MakeCard();
        AddHeader(cAct, "ACTIVITY + COMMANDS");
        liveLog = new TextBox();
        liveLog.Multiline = true; liveLog.ReadOnly = true; liveLog.ScrollBars = ScrollBars.Vertical;
        liveLog.BorderStyle = BorderStyle.None;
        liveLog.BackColor = LogBg; liveLog.ForeColor = Color.Gainsboro;
        liveLog.Font = FMono;
        cAct.Controls.Add(liveLog);
        DarkScroll(liveLog);

        tbCmd = MakeInput(cAct, "");
        SetPlaceholder(tbCmd, "command…   e.g. come · follow Steve · gather oak_log 10 · autobuild here");
        tbCmd.KeyDown += CmdKeyDown;
        btnSend = Primary(cAct, "Send", Accent, AccentHi, delegate { SendCmd(); });

        // quick actions - one click for the commands you use every session
        string[] quick = { "come", "stop", "follow", "state", "inventory", "eat", "sleep" };
        for (int i = 0; i < quick.Length; i++)
        {
            string q = quick[i];
            Button b = MakeBtn(cAct, q, BtnChip, Ghost, GhostHi, Muted, FSmallB, 8, delegate { SendQuick(q); });
            quickBtns.Add(b);
        }
    }

    void BuildFooter()
    {
        lblStatus = Lbl(rootScroll, "", FSmall, Muted);
        lblStatus.AutoEllipsis = true;
        lblStatus.TextAlign = ContentAlignment.MiddleLeft;
    }

    // =========================================================================
    // LAYOUT - the single source of truth for every coordinate (4.3)
    // =========================================================================
    void Relayout()
    {
        if (rootScroll == null || inLayout) return;
        inLayout = true;
        rootScroll.SuspendLayout();
        try
        {
            // Grid width follows the scroll VIEWPORT (which already excludes the vertical
            // scrollbar), floored just under the 980 minimum client so a vertical scrollbar
            // never provokes a horizontal one.
            int floorW = MinCW - SystemInformation.VerticalScrollBarWidth;
            int CW = Math.Max(rootScroll.ClientSize.Width, floorW) - 2 * S6;
            int colW = (CW - 11 * S4) / 12;
            int LW = 5 * colW + 4 * S4;
            int RW = CW - S4 - LW;
            int X0 = S6, X1 = S6 + LW + S4;

            // ---- header band -------------------------------------------------
            title.SetBounds(X0, 14, 200, 30);
            int ovW = 360, ovX = X0 + CW - ovW;
            lblGoal.SetBounds(ovX, S2, ovW, 20);
            overlayRight = ovX + ovW;
            PlaceChip();

            bool compact = ClientSize.Width < 1100;
            int dotW = compact ? 22 : 84;
            int dotsX = ovX - S6 - 3 * dotW;
            if (dotsX < X0 + 300) { compact = true; dotW = 22; dotsX = ovX - S6 - 3 * dotW; }
            PlaceDot(lblOllama, "Ollama", dotsX, dotW, compact);
            PlaceDot(lblBot, "Bot", dotsX + dotW, dotW, compact);
            PlaceDot(lblBrain, "Brain", dotsX + 2 * dotW, dotW, compact);
            lblTarget.SetBounds(X0 + 2, 44, Math.Max(120, dotsX - X0 - S4), 16);

            // ---- left column heights ------------------------------------------
            int serverH = LayServer(LW - 2 * S4) + S4;
            int brainH  = LayBrain(LW - 2 * S4) + S4;
            int schemH  = LaySchem(LW - 2 * S4) + S4;
            int liveH   = LayLive(RW - 2 * S4) + S4;
            int povCardH = 40 + PovH + S4;

            int y = HeaderH;
            cServer.SetBounds(X0, y, LW, serverH); y += serverH + S4;
            cBrain.SetBounds(X0, y, LW, brainH);   y += brainH + S4;
            cSchem.SetBounds(X0, y, LW, schemH);   y += schemH + S4;
            int stopW = 140;
            btnStart.SetBounds(X0, y, LW - S4 - stopW, BtnPrim);
            btnStop.SetBounds(X0 + LW - stopW, y, stopW, BtnPrim);
            int leftBottom = y + BtnPrim;

            // ---- right column ---------------------------------------------------
            int ry = HeaderH;
            cLive.SetBounds(X1, ry, RW, liveH); ry += liveH + S4;
            cPov.SetBounds(X1, ry, RW, povCardH);
            pov.SetBounds(S4, 40, RW - 2 * S4, PovH);
            ry += povCardH + S4;

            // the activity card is the one vertical slack absorber
            int viewH = Math.Max(rootScroll.ClientSize.Height, MinCH);
            int contentBottom = viewH - S4 - FooterH - S4;
            int actH = Math.Max(MinActH, contentBottom - ry);
            cAct.SetBounds(X1, ry, RW, actH);
            LayAct(RW - 2 * S4, actH);
            int rightBottom = ry + actH;

            // ---- footer + virtual size -------------------------------------------
            int bodyBottom = Math.Max(leftBottom, rightBottom);
            int totalH = Math.Max(viewH, bodyBottom + S4 + FooterH + S4);
            lblStatus.SetBounds(X0, totalH - S4 - FooterH, CW, FooterH);
            rootScroll.AutoScrollMinSize = new Size(0, totalH);   // vertical scroll only
        }
        finally { rootScroll.ResumeLayout(); inLayout = false; }
    }

    void PlaceDot(Label l, string name, int x, int w, bool compact)
    {
        l.SetBounds(x, 26, w, 20);
        l.Text = compact ? "●" : "● " + name;
        tips.SetToolTip(l, name);
    }

    void PlaceChip()
    {
        int w = TextRenderer.MeasureText(chip.Text, FSmallB).Width + 20;
        if (w < 76) w = 76;
        chip.SetBounds(overlayRight - w, 32, w, 22);
    }

    // ---- per-card layouts (return the y of the last control's bottom) ---------
    int LayServer(int inner)
    {
        int y = 40;
        lbHost.SetBounds(S4, y, inner, 15);
        PlaceInput(tbHost, S4, y + 18, inner);
        y += 62;

        int w3 = (inner - 2 * S2) / 3;
        lbPort.SetBounds(S4, y, w3, 15); PlaceInput(tbPort, S4, y + 18, w3);
        lbVer.SetBounds(S4 + w3 + S2, y, w3, 15); PlaceInput(tbVer, S4 + w3 + S2, y + 18, w3);
        lbUser.SetBounds(S4 + 2 * (w3 + S2), y, inner - 2 * (w3 + S2), 15);
        PlaceInput(tbUser, S4 + 2 * (w3 + S2), y + 18, inner - 2 * (w3 + S2));
        y += 62;

        lbAuth.SetBounds(S4, y, 168, 15);
        btnOffline.SetBounds(S4, y + 18, 76, BtnSec);
        btnMs.SetBounds(S4 + 76 + S2, y + 18, 84, BtnSec);
        int opsX = S4 + 168 + S3;
        lbOps.SetBounds(opsX, y, inner - 168 - S3, 15);
        PlaceInput(tbOps, opsX, y + 18, inner - 168 - S3);
        y += 62;

        lbAliases.SetBounds(S4, y, inner, 15);
        PlaceInput(tbAliases, S4, y + 18, inner);
        y += 62;

        int w4 = (inner - 3 * S2) / 4;
        lbBed.SetBounds(S4, y, w4, 15); PlaceInput(tbBedrock, S4, y + 18, w4);
        lbPre.SetBounds(S4 + w4 + S2, y, w4, 15); PlaceInput(tbFloodgate, S4 + w4 + S2, y + 18, w4);
        lbApiH.SetBounds(S4 + 2 * (w4 + S2), y, w4, 15); PlaceInput(tbCtlHost, S4 + 2 * (w4 + S2), y + 18, w4);
        int lastX = S4 + 3 * (w4 + S2), lastW = inner - 3 * (w4 + S2);
        lbApiP.SetBounds(lastX, y, lastW, 15); PlaceInput(tbCtlPort, lastX, y + 18, lastW);
        y += 62;

        int saveW = 96, reW = 152;
        btnSave.SetBounds(S4 + inner - reW - S2 - saveW, y + 2, saveW, BtnSec);
        btnSaveRe.SetBounds(S4 + inner - reW, y, reW, BtnPrim);
        return y + BtnPrim;
    }

    int LayBrain(int inner)
    {
        int y = 40;
        lbModel.SetBounds(S4, y, inner, 15);
        int bw1 = 80, bw2 = 96;
        int cw = inner - bw1 - bw2 - 2 * S2;
        PlaceCombo(cbModel, S4, y + 18, cw);
        btnRefresh.SetBounds(S4 + cw + S2, y + 18, bw1, BtnSec);
        btnUse.SetBounds(S4 + cw + S2 + bw1 + S2, y + 18, bw2, BtnSec);
        y += 62;

        lbBrainGoal.SetBounds(S4, y, inner, 15);
        PlaceInput(tbGoal, S4, y + 18, inner);
        y += 62;

        btnBrainOn.SetBounds(S4, y, 96, BtnSec);
        btnApplyGoal.SetBounds(S4 + inner - 96, y, 96, BtnSec);
        return y + BtnSec;
    }

    int LaySchem(int inner)
    {
        int y = 40;
        int bw1 = 88, bw2 = 100;
        int cw = inner - bw1 - bw2 - 2 * S2;
        PlaceCombo(cbSchem, S4, y, cw);
        btnAddSchem.SetBounds(S4 + cw + S2, y, bw1, BtnSec);
        btnOpenSchem.SetBounds(S4 + cw + S2 + bw1 + S2, y, bw2, BtnSec);
        return y + BtnSec;
    }

    int LayLive(int inner)
    {
        int y = 40;
        lvName.SetBounds(S4, y, inner, 20);
        y = 66;
        lkHp.SetBounds(S4, y, LabelW, 15);
        lvHp.SetBounds(S4 + inner - 96, y, 96, 15);
        hpTrack.SetBounds(S4, y + 18, inner, 8);
        y = 98;
        lkFood.SetBounds(S4, y, LabelW, 15);
        lvFood.SetBounds(S4 + inner - 96, y, 96, 15);
        foodTrack.SetBounds(S4, y + 18, inner, 8);

        int half = (inner - S4) / 2;
        int vx = LabelW + S2;
        y = 132;
        Row(lkPos, lvPos, S4, y, half);
        Row(lkTime, lvTime, S4 + half + S4, y, inner - half - S4);
        y += RowH;
        Row(lkBiome, lvBiome, S4, y, half);
        Row(lkThreat, lvThreat, S4 + half + S4, y, inner - half - S4);
        y += RowH;
        Row(lkPlayers, lvPlayers, S4, y, inner);
        y += RowH;
        Row(lkActivity, lvActivity, S4, y, inner);
        y += RowH + S2;

        lbInvHead.SetBounds(S4, y, LabelW, 15);
        lvInv.SetBounds(S4 + vx, y - 2, inner - vx, 45);
        return y + 45;
    }

    void Row(Label k, Label v, int x, int y, int w)
    {
        k.SetBounds(x, y, LabelW, 15);
        v.SetBounds(x + LabelW + S2, y - 1, Math.Max(40, w - LabelW - S2), 17);
    }

    void LayAct(int inner, int cardH)
    {
        int quickY = cardH - S4 - BtnChip;
        int cmdY = quickY - S2 - InputH;
        int logH = Math.Max(48, cmdY - S2 - 40);
        liveLog.SetBounds(S4, 40, inner, logH);
        int sendW = 84;
        PlaceInput(tbCmd, S4, cmdY, inner - S2 - sendW);
        btnSend.SetBounds(S4 + inner - sendW, cmdY - 2, sendW, BtnPrim);
        int qx = S4;
        for (int i = 0; i < quickBtns.Count; i++)
        {
            Button b = quickBtns[i];
            int w = TextRenderer.MeasureText(b.Text, FSmallB).Width + 2 * S3;
            w = ((w + 3) / 4) * 4;
            if (w < 76) w = 76;
            b.SetBounds(qx, quickY, w, BtnChip);
            qx += w + S2;
        }
    }

    // =========================================================================
    // FACTORIES
    // =========================================================================
    Label Lbl(Control parent, string text, Font f, Color c)
    {
        Label l = new Label();
        l.Text = text; l.Font = f; l.ForeColor = c;
        l.BackColor = Color.Transparent; l.AutoSize = false;
        l.SetBounds(0, 0, 100, 16);
        parent.Controls.Add(l);
        return l;
    }

    Panel MakeCard()
    {
        Panel p = new Panel();
        p.BackColor = Card;
        p.SetBounds(0, 0, 200, 100);
        rootScroll.Controls.Add(p); Round(p, 12);
        return p;
    }

    void AddHeader(Control parent, string text)
    {
        Label l = Lbl(parent, text.ToUpperInvariant(), FHeader, Accent);
        l.SetBounds(S4, S3, 460, 16);
    }

    Label FieldLabel(Control parent, string text)
    {
        Label l = Lbl(parent, text, FLabel, Muted);
        l.AutoEllipsis = true;
        return l;
    }

    Label ValueLabel(Control parent)
    {
        Label l = Lbl(parent, "—", FValue, Txt);
        l.AutoEllipsis = true;
        l.TextAlign = ContentAlignment.MiddleLeft;
        return l;
    }

    Panel MakeBar(Control parent, out Panel track)
    {
        track = new Panel();
        track.SetBounds(0, 0, 100, 8); track.BackColor = Input;
        parent.Controls.Add(track); Round(track, 4);
        Panel fill = new Panel();
        fill.SetBounds(0, 0, 0, 8); fill.BackColor = Green;
        track.Controls.Add(fill);
        return fill;
    }

    void SetBar(Panel fill, double v, double max)
    {
        fill.Height = fill.Parent.Height;
        int w = (int)Math.Round(Math.Max(0, Math.Min(1, v / max)) * fill.Parent.Width);
        fill.Width = w;
        fill.BackColor = v > max * 0.6 ? Green : v > max * 0.3 ? Amber : Red;
    }

    TextBox MakeInput(Control parent, string val)
    {
        Panel wrap = new Panel();
        wrap.SetBounds(0, 0, 100, InputH); wrap.BackColor = Input;
        parent.Controls.Add(wrap); Round(wrap, 8);
        TextBox tb = new TextBox();
        tb.BorderStyle = BorderStyle.None; tb.BackColor = Input; tb.ForeColor = Txt;
        tb.Font = FBody; tb.Text = val == null ? "" : val;
        tb.SetBounds(S3, S2, 80, 20);
        wrap.Controls.Add(tb);
        return tb;
    }

    static void PlaceInput(TextBox tb, int x, int y, int w)
    {
        Panel wrap = tb.Parent as Panel;
        if (wrap == null) return;
        if (w < 40) w = 40;
        wrap.SetBounds(x, y, w, InputH);
        tb.SetBounds(S3, S2, w - 2 * S3, 20);
    }

    // grey hint text that clears on focus (WinForms has no native placeholder)
    void SetPlaceholder(TextBox tb, string hint)
    {
        bool[] showing = { tb.Text.Length == 0 };
        if (showing[0]) { tb.Text = hint; tb.ForeColor = Muted; }
        tb.GotFocus += delegate { if (showing[0]) { tb.Text = ""; tb.ForeColor = Txt; showing[0] = false; } };
        tb.LostFocus += delegate { if (tb.Text.Length == 0) { tb.Text = hint; tb.ForeColor = Muted; showing[0] = true; } };
    }

    ComboBox MakeCombo(Control parent)
    {
        ComboBox c = new ComboBox();
        c.SetBounds(0, 0, 100, 26); c.FlatStyle = FlatStyle.Flat;
        c.BackColor = Input; c.ForeColor = Txt; c.Font = FBody;
        c.DrawMode = DrawMode.OwnerDrawFixed; c.ItemHeight = 22;
        c.DrawItem += ComboDraw;
        parent.Controls.Add(c);
        return c;
    }

    static void PlaceCombo(ComboBox c, int x, int y, int w)
    {
        if (w < 60) w = 60;
        c.SetBounds(x, y + (InputH - c.Height) / 2, w, c.Height);
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

    Button MakeBtn(Control parent, string text, int h, Color bg, Color hi, Color fg, Font f, int radius, EventHandler onClick)
    {
        Button b = new Button();
        b.Text = text; b.SetBounds(0, 0, 76, h);
        b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderSize = 0;
        b.BackColor = bg; b.ForeColor = fg; b.Cursor = Cursors.Hand;
        b.Font = f;
        b.FlatAppearance.MouseOverBackColor = hi;
        b.Click += onClick;
        Round(b, radius);
        parent.Controls.Add(b);
        return b;
    }

    Button Primary(Control parent, string text, Color bg, Color hi, EventHandler onClick)
    { return MakeBtn(parent, text, BtnPrim, bg, hi, Color.White, FBodyB, 10, onClick); }

    Button Secondary(Control parent, string text, EventHandler onClick)
    { return MakeBtn(parent, text, BtnSec, Ghost, GhostHi, Txt, FBodyB, 8, onClick); }

    Button MakeToggle(Control parent, string text)
    {
        Button b = new Button();
        b.Text = text; b.SetBounds(0, 0, 76, BtnSec);
        b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderSize = 0; b.Cursor = Cursors.Hand;
        b.Font = FBodyB;
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

    Label MakeStatus(string name)
    {
        Label l = Lbl(rootScroll, "● " + name, FBody, Muted);
        l.TextAlign = ContentAlignment.MiddleLeft;
        return l;
    }

    static Color Mix(Color a, Color b, double t)
    {
        return Color.FromArgb(
            (int)Math.Round(a.R + (b.R - a.R) * t),
            (int)Math.Round(a.G + (b.G - a.G) * t),
            (int)Math.Round(a.B + (b.B - a.B) * t));
    }

    // ---- rounded corners that survive resize (1.6) ---------------------------
    static void Round(Control c, int r)
    {
        ApplyRound(c, r);
        c.Resize += delegate { ApplyRound(c, r); };
    }

    static void ApplyRound(Control c, int r)
    {
        int w = c.Width, h = c.Height;
        if (w <= r || h <= r) return;
        GraphicsPath p = new GraphicsPath();
        p.AddArc(0, 0, r, r, 180, 90);
        p.AddArc(w - r, 0, r, r, 270, 90);
        p.AddArc(w - r, h - r, r, r, 0, 90);
        p.AddArc(0, h - r, r, r, 90, 90);
        p.CloseAllFigures();
        Region old = c.Region;
        c.Region = new Region(p);
        p.Dispose();
        if (old != null) old.Dispose();
    }

    // ---- dark OS scrollbars (1.5) -------------------------------------------
    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    static extern int SetWindowTheme(IntPtr hWnd, string appName, string idList);

    static void DarkScroll(Control c)
    {
        c.HandleCreated += delegate { try { SetWindowTheme(c.Handle, "DarkMode_Explorer", null); } catch { } };
        if (c.IsHandleCreated) { try { SetWindowTheme(c.Handle, "DarkMode_Explorer", null); } catch { } }
    }

    // dark title bar on Win10/11
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try { int on = 1; DwmSetWindowAttribute(Handle, 20, ref on, 4); } catch { }
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (laidOut) Relayout();
    }

    // =========================================================================
    // LIVE PANEL
    // =========================================================================
    static string ControlPort { get { return Cfg("controlPort", "3001"); } }
    static string ApiBase { get { return "http://127.0.0.1:" + ControlPort; } }

    void PollLive()
    {
        // livePolling was already set at queue time by the timer tick.
        try
        {
            string stateTxt = WebGet(ApiBase + "/state");
            if (stateTxt != null) { stateFails = 0; botUp = true; }
            else
            {
                stateFails++;
                // Hysteresis: offline only after 3 consecutive failures, online after 1
                // success. Absorbs a dropped request or a 1-2 s pathfinder stall.
                if (stateFails < 3 && botUp) return;
                botUp = false;
            }
            if (!botUp)
            {
                BeginInvoke((MethodInvoker)delegate {
                    lvName.Text = "bot offline — press Start";
                    lvName.ForeColor = Muted;
                    SetChip("OFFLINE", Muted);
                    lblGoal.ForeColor = Muted;
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
        if (brainTxt != null)
        {
            try
            {
                Dictionary<string, object> b = json.Deserialize<Dictionary<string, object>>(brainTxt);
                Dictionary<string, object> cfg = Obj(b, "settings");
                if (cfg != null)
                {
                    bool en = cfg.ContainsKey("enabled") && cfg["enabled"] is bool && (bool)cfg["enabled"];
                    if (en != brainEnabled) { brainEnabled = en; StyleToggle(btnBrainOn, brainEnabled); }
                    if (cfg.ContainsKey("goal") && cfg["goal"] != null)
                    {
                        brainGoal = "" + cfg["goal"];
                        if (!tbGoal.Focused) tbGoal.Text = brainGoal;
                    }
                }
            }
            catch { }
        }
        if (st != null)
        {
            lvName.Text = S(st, "name") + "  ·  " + S(st, "dimension") + "  ·  " + S(st, "gameMode");
            lvName.ForeColor = Txt;
            double hp = D(st, "health"), food = D(st, "food");
            lvHp.Text = (hp % 1 == 0 ? hp.ToString("0") : hp.ToString("0.#")) + " / 20";
            lvFood.Text = food.ToString("0") + " / 20";
            SetBar(hpFill, hp, 20); SetBar(foodFill, food, 20);
            Dictionary<string, object> pos = Obj(st, "pos");
            SetVal(lvPos, pos == null ? "—" : ((int)D(pos, "x")) + ", " + ((int)D(pos, "y")) + ", " + ((int)D(pos, "z")));
            SetVal(lvBiome, S(st, "biome"));
            bool day = B(st, "isDay");
            bool rain = B(st, "isRaining");
            SetVal(lvTime, (day ? "day" : "night") + (rain ? " · raining" : ""));
            lvTime.ForeColor = day ? Txt : Amber;
            Dictionary<string, object> threat = Obj(st, "threat");
            SetVal(lvThreat, threat == null ? "none" : S(threat, "type") + " (" + S(threat, "dist") + "m)");
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
                SetVal(lvPlayers, string.Join(", ", names.ToArray()));
            }
            else SetVal(lvPlayers, "alone");
            Dictionary<string, object> act = Obj(st, "activity");
            SetVal(lvActivity, act == null ? "idle" : S(act, "name") + " · " + S(act, "detail") + " · " + S(act, "forSec") + "s");
            lvActivity.ForeColor = act == null ? Muted : Txt;
            System.Collections.IList inv = st.ContainsKey("inventory") ? st["inventory"] as System.Collections.IList : null;
            if (inv != null && inv.Count > 0)
            {
                string[] items = new string[inv.Count];
                for (int i = 0; i < inv.Count; i++) items[i] = "" + inv[i];
                string t = string.Join("  ·  ", items);
                string full = t.Length > 1000 ? t.Substring(0, 1000) + "…" : t;
                if (t.Length > 400) t = t.Substring(0, 399) + "…";
                lvInv.Text = t;
                tips.SetToolTip(lvInv, full);
            }
            else { lvInv.Text = "empty"; tips.SetToolTip(lvInv, "empty"); }

            UpdateOverlay(st);
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
    }

    void SetVal(Label l, string v)
    {
        l.Text = v;
        tips.SetToolTip(l, v);
    }

    // ---- overlay: goal line + firing-subsystem chip (3.1 / 3.2) --------------
    void UpdateOverlay(Dictionary<string, object> st)
    {
        Dictionary<string, object> checklist = Obj(st, "checklist");
        Dictionary<string, object> activity  = Obj(st, "activity");
        Dictionary<string, object> maneuver  = Obj(st, "maneuver");
        Dictionary<string, object> stuck     = Obj(st, "stuck");
        Dictionary<string, object> threat    = Obj(st, "threat");
        Dictionary<string, object> hazards   = Obj(st, "hazards");
        Dictionary<string, object> progress  = Obj(st, "progress");
        bool busy = B(st, "busy"), moving = B(st, "moving");
        string goal = st.ContainsKey("goal") && st["goal"] != null ? "" + st["goal"] : "";

        // --- goal line (3.2) ---
        if (checklist != null)
            goalText = "Goal: " + S(checklist, "step") + "  (" + S(checklist, "n") + "/" + S(checklist, "of") + ")";
        else if (brainGoal.Length > 0) goalText = "Goal: " + brainGoal;
        else goalText = "Goal: —";
        lblGoal.Text = goalText;
        lblGoal.ForeColor = Txt;
        tips.SetToolTip(lblGoal, goalText);

        // --- firing subsystem (3.1) - first match wins ---
        if (threat != null) { SetChip("THREAT · " + S(threat, "type") + " " + S(threat, "dist") + "m", Red); return; }
        if (hazards != null && (B(hazards, "inLava") || B(hazards, "onFire") || B(hazards, "drowning")))
        {
            string h = B(hazards, "inLava") ? "lava" : B(hazards, "onFire") ? "fire" : "drowning";
            SetChip("HAZARD · " + h, Red); return;
        }
        if (maneuver != null)
        {
            string tier = S(maneuver, "tier");
            Color c = tier == "SURVIVE" ? Red : tier == "PRESERVE" ? Amber : tier == "PROGRESS" ? Accent : Muted;
            SetChip(S(maneuver, "label"), c); return;
        }
        if (stuck != null) { SetChip("STUCK " + S(stuck, "forSec") + "s", Amber); return; }
        if (progress != null && B(progress, "stalled")) { SetChip("STALLED", Amber); return; }
        if (busy && checklist != null)
        { SetChip("JOB " + S(checklist, "n") + "/" + S(checklist, "of") + " · " + S(checklist, "step"), Accent); return; }
        if (activity != null)
        { SetChip(S(activity, "name") + " · " + S(activity, "detail") + " (" + S(activity, "forSec") + "s)", Accent); return; }
        if (moving && goal.Length > 0) { SetChip("moving · " + goal, Accent); return; }
        SetChip(brainEnabled ? "idle · brain on" : "idle", Muted);
    }

    void SetChip(string text, Color c)
    {
        if (text == null || text.Trim().Length == 0) text = "idle";
        if (text.Length > 46) text = text.Substring(0, 45) + "…";
        chipText = text;
        chip.Text = text;
        chip.ForeColor = c;
        chip.BackColor = Mix(Bg, c, 0.25);
        tips.SetToolTip(chip, text);
        PlaceChip();
    }

    static string S(Dictionary<string, object> d, string k)
    { return d != null && d.ContainsKey(k) && d[k] != null ? d[k].ToString() : "—"; }
    static double D(Dictionary<string, object> d, string k)
    {
        if (d == null || !d.ContainsKey(k) || d[k] == null) return 0;
        try { return Convert.ToDouble(d[k]); } catch { return 0; }
    }
    static bool B(Dictionary<string, object> d, string k)
    { return d != null && d.ContainsKey(k) && d[k] is bool && (bool)d[k]; }
    static Dictionary<string, object> Obj(Dictionary<string, object> d, string k)
    { return d != null && d.ContainsKey(k) ? d[k] as Dictionary<string, object> : null; }

    // =========================================================================
    // BOT POV (2.6 / 2.7)
    // =========================================================================
    class Canvas : Panel
    {
        public Canvas()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        }
    }

    void PollPov()
    {
        // povBusy was already set at queue time by the timer tick.
        try
        {
            int status;
            string body = WebGet(ApiBase + "/pov", out status, 1000);
            if (body == null || status != 200)
            {
                // The POV panel never makes its own liveness judgement: a connect
                // failure while botUp is still true is transient (the /state
                // hysteresis owns the verdict) — hold the last frame and retry.
                if (status == 0 && botUp) return;
                string mode = status == 404 ? "POV unavailable — older bot (no /pov)"
                            : status == 0 ? "no signal — bot offline"
                            : "no signal — bot not spawned";
                BeginInvoke((MethodInvoker)delegate { povMode = mode; povChip = ""; povTimer.Interval = 2000; pov.Invalidate(); });
                return;
            }
            PovInfo info;
            Bitmap bmp = DecodeFrame(body, out info);
            if (bmp == null)
            {
                // Back off too: a permanently bad decoder pairing used to hot-loop at 300 ms.
                BeginInvoke((MethodInvoker)delegate { povMode = "no signal — bad frame"; povChip = ""; povTimer.Interval = 2000; pov.Invalidate(); });
                return;
            }
            BeginInvoke((MethodInvoker)delegate {
                Bitmap old = povFront;
                povFront = bmp; povHud = info.Hud; povMode = null;
                povChip = info.Chip; povChipCol = info.ChipCol;
                tips.SetToolTip(pov, info.Tip);
                povTimer.Interval = 300;
                if (old != null) old.Dispose();
                pov.Invalidate();
            });
        }
        catch { }
        finally { povBusy = false; }
    }

    // Vanilla Minecraft's directional light multipliers, indexed by face:
    // 0 = top, 1 = bottom, 2 = X side (east/west), 3 = Z side (north/south).
    static readonly double[] FaceMul = { 1.00, 0.50, 0.60, 0.80 };

    // Background-thread decode: header JSON + pixel plane (+ optional v2 face plane)
    // -> 32bpp Bitmap. v1 frames (no "v" in the header, or a missing/short face
    // plane) render flat, exactly as before — a new GUI never garbles an old bot.
    // Everything the HUD strip needs out of one decode (v3 §4). A small carrier
    // class keeps DecodeFrame's signature from growing four more `out` params.
    class PovInfo
    {
        public string Hud = "";
        public string Chip = "";
        public Color ChipCol = Color.FromArgb(110, 199, 132);
        public string Tip = "";
    }

    Bitmap DecodeFrame(string body, out PovInfo info)
    {
        info = new PovInfo();
        int nl = body.IndexOf('\n');
        if (nl <= 0) return null;
        string head = body.Substring(0, nl);
        string rest = body.Substring(nl + 1).Trim();
        JavaScriptSerializer js = new JavaScriptSerializer();
        Dictionary<string, object> h = js.Deserialize<Dictionary<string, object>>(head);
        if (h == null) return null;
        int w = (int)D(h, "w"), ht = (int)D(h, "h");
        if (w <= 0 || ht <= 0) return null;
        int px = 2 * w * ht, fp = w * ht;

        int ver = h.ContainsKey("v") ? (int)D(h, "v") : 1;
        string data = rest;
        string faces = null;
        if (ver >= 2 && rest.Length >= px + 1 + fp && rest[px] == '\n')
        {
            data = rest.Substring(0, px);
            faces = rest.Substring(px + 1, fp);
        }
        if (data.Length < px) return null;
        double fovH = D(h, "fovH"); if (fovH <= 0) fovH = 70;
        double maxDist = D(h, "maxDist"); if (maxDist <= 0) maxDist = 32;
        double pitch = D(h, "pitch"), yaw = D(h, "yaw");
        bool day = B(h, "day");
        int ageMs = (int)D(h, "ageMs");
        // v3 §3.4: additive header keys. Both are optional — an older bot sends
        // neither, and D()/B() already return 0/false for absent keys, so the
        // ContainsKey guard below only distinguishes "0 ms" from "not reported".
        bool busy = B(h, "busy");
        int buildMs = h.ContainsKey("buildMs") ? (int)D(h, "buildMs") : -1;
        Dictionary<string, object> pos = Obj(h, "pos");

        System.Collections.IList pal = h.ContainsKey("palette") ? h["palette"] as System.Collections.IList : null;
        Color[] palCol = new Color[64];
        for (int i = 0; i < 64; i++) palCol[i] = Color.FromArgb(138, 130, 120);
        if (pal != null)
            for (int i = 0; i < pal.Count && i < 62; i++) palCol[i] = ColorForBlock("" + pal[i]);

        Color skyTop = day ? Color.FromArgb(96, 148, 210) : Color.FromArgb(12, 14, 24);
        Color skyHor = day ? Color.FromArgb(160, 190, 225) : Color.FromArgb(28, 32, 48);
        Color voidC  = Color.FromArgb(18, 18, 22);

        double tanHalfV = Math.Tan(fovH * Math.PI / 360.0) * ht / (double)w;
        double maxElev = pitch + Math.Atan(tanHalfV);

        Bitmap bmp = new Bitmap(w, ht, PixelFormat.Format32bppRgb);
        BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, ht), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
        try
        {
            byte[] buf = new byte[bd.Stride * ht];
            for (int row = 0; row < ht; row++)
            {
                double ndcY = 1.0 - 2.0 * (row + 0.5) / ht;
                double elev = pitch + Math.Atan(ndcY * tanHalfV);
                Color rowSky;
                if (elev > 0 && maxElev > 0)
                {
                    double t = elev / maxElev; if (t > 1) t = 1;
                    rowSky = Mix(skyHor, skyTop, t);
                }
                // Below-horizon misses used to paint near-black voidC, which put black
                // blotches in downhill vistas where the eye expects haze.
                else rowSky = Mix(skyHor, voidC, 0.35);
                int o = row * bd.Stride;
                for (int col = 0; col < w; col++)
                {
                    int k = 2 * (row * w + col);
                    int pi = B64(data[k]);
                    int qd = B64(data[k + 1]);
                    Color c;
                    if (pi == 63) c = rowSky;
                    else
                    {
                        c = palCol[pi];
                        if (faces != null)
                        {
                            // Face shading BEFORE fog: every edge where two faces meet
                            // gets a guaranteed brightness step, so geometry reads.
                            int fi = B64(faces[row * w + col]);
                            if (fi < 0 || fi > 3) fi = 0;
                            double m = FaceMul[fi];
                            if (m < 1.0)
                                c = Color.FromArgb((int)(c.R * m), (int)(c.G * m), (int)(c.B * m));
                        }
                        double d = (qd >= 63 ? 63 : qd) / 63.0;
                        double f = 0.60 * Math.Pow(d, 1.5);
                        c = Mix(c, skyHor, f);
                    }
                    int p = o + col * 4;
                    buf[p] = c.B; buf[p + 1] = c.G; buf[p + 2] = c.R; buf[p + 3] = 255;
                }
            }
            Marshal.Copy(buf, 0, bd.Scan0, buf.Length);
        }
        finally { bmp.UnlockBits(bd); }

        string ps = pos == null ? "—" : ((int)D(pos, "x")) + ", " + ((int)D(pos, "y")) + ", " + ((int)D(pos, "z"));
        int yawDeg = (int)Math.Round(yaw * 180.0 / Math.PI);
        double fps = NoteBuild(ageMs);
        info.Hud = ps + "  ·  yaw " + yawDeg + "°  ·  " + Fmt1(fps) + " fps";

        // Staleness chip (v3 §4). The raw ms number is gone: a bare "6000" told
        // the user nothing, so freshness now reads as a word plus seconds, and a
        // deliberate body-first backoff says "busy" rather than looking broken.
        string secs = Fmt1(ageMs / 1000.0) + "s";
        if (ageMs <= 700) { info.Chip = "live"; info.ChipCol = PovLive; }
        else if (ageMs <= 2500) { info.Chip = (busy ? "busy " : "lag ") + secs; info.ChipCol = PovWarn; }
        else { info.Chip = "stale " + secs; info.ChipCol = PovStale; }

        string tip = "POV frame age " + ageMs + " ms — how old the picture is.\r\n"
                   + "live ≤ 0.7s  ·  lag / busy ≤ 2.5s  ·  stale > 2.5s\r\n";
        if (busy)
            tip += "busy: the bot is deliberately slowing POV to keep its body responsive — "
                 + "a choppy panel here is correct.\r\n";
        tip += "achieved " + Fmt1(fps) + " fps";
        if (buildMs >= 0) tip += "  ·  last frame took " + buildMs + " ms to build";
        info.Tip = tip;
        return bmp;
    }

    static string Fmt1(double v)
    { return v.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture); }

    // Achieved framerate, measured GUI-side (v3 §4) — never assumed from the poll
    // interval. builtAt is reconstructed as now - ageMs, so repeated polls that are
    // served the SAME cached frame collapse onto one value; only distinct builds
    // are counted. 60 ms of tolerance absorbs clock/serialisation jitter while
    // staying far below the ~300 ms gap between real builds.
    double NoteBuild(int ageMs)
    {
        long nowMs = DateTime.UtcNow.Ticks / 10000L;
        long builtAt = nowMs - ageMs;
        if (povLastBuilt == 0 || Math.Abs(builtAt - povLastBuilt) > 60)
        {
            povLastBuilt = builtAt;
            povBuilds[povBuildAt] = builtAt;
            povBuildAt = (povBuildAt + 1) % povBuilds.Length;
        }
        int n = 0;
        for (int i = 0; i < povBuilds.Length; i++)
            if (povBuilds[i] != 0 && nowMs - povBuilds[i] <= 3000) n++;
        return n / 3.0;
    }

    static int B64(char c)
    {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '-') return 62;
        return 63;
    }

    void PovPaint(object sender, PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        Rectangle r = pov.ClientRectangle;
        using (SolidBrush b = new SolidBrush(LogBg)) g.FillRectangle(b, r);
        Bitmap f = povFront;
        if (f != null)
        {
            // letterbox the 16:9 frame inside the panel, nearest-neighbour (crisp voxels)
            double ar = f.Width / (double)f.Height;
            int dw = r.Width, dh = (int)Math.Round(dw / ar);
            if (dh > r.Height) { dh = r.Height; dw = (int)Math.Round(dh * ar); }
            Rectangle dst = new Rectangle(r.X + (r.Width - dw) / 2, r.Y + (r.Height - dh) / 2, dw, dh);
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(f, dst);
            if (povMode != null)
                using (SolidBrush dim = new SolidBrush(Color.FromArgb(165, 0, 0, 0))) g.FillRectangle(dim, r);
            int cx = r.X + r.Width / 2, cy = r.Y + r.Height / 2;
            using (Pen p = new Pen(Color.FromArgb(160, 255, 255, 255)))
            {
                g.DrawLine(p, cx - 4, cy, cx + 4, cy);
                g.DrawLine(p, cx, cy - 4, cx, cy + 4);
            }
            Rectangle strip = new Rectangle(r.X + S2, r.Bottom - 20, r.Width - S4, 16);
            // Both HUD runs sit on a dark backing plate: the colour of the chip IS
            // the message, so an amber "busy" or a red "stale" — and the fps figure
            // beside it — must stay readable over a bright sky or a snow field,
            // which plain 60%-white text does not.
            if (povHud.Length > 0)
            {
                Size hs = TextRenderer.MeasureText(g, povHud, FSmall);
                PovPlate(g, new Rectangle(strip.X - S1, strip.Y - 1, hs.Width + S1, strip.Height + 2));
                TextRenderer.DrawText(g, povHud, FSmall, strip,
                    Color.FromArgb(196, 255, 255, 255), TextFormatFlags.Left);
            }
            if (povChip.Length > 0)
            {
                Size cs = TextRenderer.MeasureText(g, povChip, FSmallB);
                PovPlate(g, new Rectangle(strip.Right - cs.Width - S1, strip.Y - 1,
                                          cs.Width + S1 * 2, strip.Height + 2));
                TextRenderer.DrawText(g, povChip, FSmallB, strip,
                    Color.FromArgb(235, povChipCol.R, povChipCol.G, povChipCol.B),
                    TextFormatFlags.Right);
            }
        }
        if (povMode != null)
            TextRenderer.DrawText(g, povMode, FSmall, r, Muted,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
    }

    static void PovPlate(Graphics g, Rectangle box)
    {
        using (SolidBrush b = new SolidBrush(Color.FromArgb(120, 0, 0, 0))) g.FillRectangle(b, box);
    }

    // ---- block name -> colour (2.7 rule table, first match wins) -------------
    static Regex[] PovRx;
    static Color[] PovCol;
    static Dictionary<string, Color> DyeMap;
    static Regex DyeRx = new Regex("^(white|light_gray|gray|black|brown|red|orange|yellow|lime|green|cyan|light_blue|blue|purple|magenta|pink)_(wool|concrete|terracotta|carpet|bed)", RegexOptions.Compiled);

    static void InitPovColors()
    {
        if (PovRx != null) return;
        // First match wins, so order matters: soul_sand MUST precede sand|sandstone
        // (it used to fall through and render as bright beach sand in the nether).
        string[] pats = {
            "^(water|bubble_column|kelp|seagrass|tall_seagrass)", "lava", "^grass_block$",
            "^(short_grass|grass|tall_grass|fern|large_fern)$",
            "^(dirt|coarse_dirt|rooted_dirt|farmland|mud|podzol)", "red_sand",
            "soul_sand|soul_soil", "sand|sandstone",
            "gravel", "snow", "ice", "(_log|_wood|_stem|_hyphae)$", "leaves$", "planks$",
            "deepslate", "obsidian|blackstone|basalt", "netherrack", "coal_ore", "iron_ore",
            "copper_ore", "gold_ore", "redstone_ore", "diamond_ore", "emerald_ore", "lapis_ore",
            "^(stone|cobblestone|stone_bricks|mossy_cobblestone|andesite|tuff|bedrock|smooth_stone|infested)",
            "^moss_|^cactus$|^vine$|^lily_pad$",
            "diorite|calcite|quartz", "granite", "glass",
            "torch|lantern|fire|glowstone|shroomlight|campfire",
            "^(wheat|carrots|potatoes|beetroots|sugar_cane|bamboo)",
            "poppy|tulip|dandelion|orchid|allium|daisy|cornflower|lily",
            "chest|barrel|crafting_table|bookshelf|fence|ladder", "^clay$" };
        int[,] rgb = {
            {47,86,166},{226,110,26},{110,162,64},{92,132,60},{134,96,67},{190,102,33},
            {84,62,50},{219,207,163},{104,99,94},{240,244,248},{145,183,253},{87,63,38},
            {60,110,40},{162,130,78},{78,78,84},{24,20,32},{114,58,57},{72,72,72},
            {205,178,154},{175,112,82},{214,190,100},{160,60,60},{98,219,214},{70,190,110},
            {60,90,180},{125,125,125},{66,124,50},{200,200,198},{149,103,85},{168,200,220},
            {255,200,90},{140,160,70},{196,156,170},{162,130,78},{158,164,176} };
        PovRx = new Regex[pats.Length];
        PovCol = new Color[pats.Length];
        for (int i = 0; i < pats.Length; i++)
        {
            PovRx[i] = new Regex(pats[i], RegexOptions.Compiled);
            PovCol[i] = Color.FromArgb(rgb[i, 0], rgb[i, 1], rgb[i, 2]);
        }
        DyeMap = new Dictionary<string, Color>();
        DyeMap["white"] = Color.FromArgb(233, 236, 236);
        DyeMap["light_gray"] = Color.FromArgb(142, 142, 134);
        DyeMap["gray"] = Color.FromArgb(62, 68, 71);
        DyeMap["black"] = Color.FromArgb(20, 21, 25);
        DyeMap["brown"] = Color.FromArgb(96, 59, 31);
        DyeMap["red"] = Color.FromArgb(161, 39, 34);
        DyeMap["orange"] = Color.FromArgb(240, 118, 19);
        DyeMap["yellow"] = Color.FromArgb(248, 197, 39);
        DyeMap["lime"] = Color.FromArgb(112, 185, 25);
        DyeMap["green"] = Color.FromArgb(84, 109, 27);
        DyeMap["cyan"] = Color.FromArgb(21, 137, 145);
        DyeMap["light_blue"] = Color.FromArgb(58, 175, 217);
        DyeMap["blue"] = Color.FromArgb(53, 57, 157);
        DyeMap["purple"] = Color.FromArgb(121, 42, 172);
        DyeMap["magenta"] = Color.FromArgb(189, 68, 179);
        DyeMap["pink"] = Color.FromArgb(237, 141, 172);
    }

    static Color ColorForBlock(string name)
    {
        InitPovColors();
        if (name == null) return Color.FromArgb(138, 130, 120);
        string n = name.ToLowerInvariant();
        int c = n.IndexOf(':');
        if (c >= 0) n = n.Substring(c + 1);
        for (int i = 0; i < PovRx.Length; i++) if (PovRx[i].IsMatch(n)) return PovCol[i];
        Match m = DyeRx.Match(n);
        if (m.Success && DyeMap.ContainsKey(m.Groups[1].Value)) return DyeMap[m.Groups[1].Value];
        return Color.FromArgb(138, 130, 120);
    }

    // =========================================================================
    // COMMAND CONSOLE
    // =========================================================================
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
        if (!botUp) { Log("Bot is offline — press Start first."); return; }
        RunBg(delegate {
            string r = WebPost(ApiBase + "/op/cmd", c);
            if (r == null) Log("Command failed — bot not responding.");
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
        readonly int ms;
        public QuickClient() : this(3000) { }
        public QuickClient(int timeoutMs) { ms = timeoutMs; }
        protected override WebRequest GetWebRequest(Uri address)
        {
            WebRequest r = base.GetWebRequest(address);
            r.Timeout = ms;
            return r;
        }
    }

    static string WebGet(string url)
    {
        int status;
        return WebGet(url, out status);
    }

    // Returns the body, and the HTTP status via out (0 = connect/timeout failure).
    // c.Encoding = UTF8 so «», … and → from /log and /state don't decode as ANSI.
    // Liveness endpoints use the 3000 ms default (a real bot can block its loop for
    // 1 s+); /pov passes its own 1000 ms budget since it is cosmetic.
    static string WebGet(string url, out int status)
    {
        return WebGet(url, out status, 3000);
    }

    static string WebGet(string url, out int status, int timeoutMs)
    {
        status = 0;
        try
        {
            using (QuickClient c = new QuickClient(timeoutMs))
            {
                c.Encoding = Encoding.UTF8;
                string s = c.DownloadString(url);
                status = 200;
                return s;
            }
        }
        catch (WebException ex)
        {
            try
            {
                HttpWebResponse hr = ex.Response as HttpWebResponse;
                if (hr != null) status = (int)hr.StatusCode;
            }
            catch { }
            return null;
        }
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
        lblTarget.Text = "bot → " + Cfg("host", "?") + ":" + Cfg("port", "?") +
                         "   auth=" + Cfg("auth", "?") + "   version=" + Cfg("version", "?");
        tips.SetToolTip(lblTarget, lblTarget.Text);
    }

    void RefreshStatus()
    {
        SetDot(lblOllama, PortOpen(11434));
        SetDot(lblBot, botUp || IsRunning("Animus BOT"));
        SetDot(lblBrain, IsRunning("Animus BRAIN"));
    }

    void SetDot(Label l, bool up)
    {
        l.ForeColor = up ? Green : Muted;
    }

    void Log(string msg)
    {
        if (lblStatus.InvokeRequired) { lblStatus.BeginInvoke((MethodInvoker)delegate { Log(msg); }); return; }
        lblStatus.Text = msg;              // single-line status strip; hover for the full text
        tips.SetToolTip(lblStatus, msg);   // the live activity box carries the history
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
                    reconnect ? "Saved — bot is reconnecting with the new settings…" : "Saved to the running bot.");
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
        Log(names.Count == 0 ? "No models installed — type a name and hit Use / Pull." : ("Models: " + string.Join(", ", names.ToArray())));
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
            Log("Pulling " + m + " … (progress shows in the pull window)");
            RunSync("cmd.exe", "/c ollama pull " + m, Root);
            list = RunCapture("ollama", "list");
            installed = list != null && list.IndexOf(m, StringComparison.OrdinalIgnoreCase) >= 0;
        }
        if (installed) { SaveModel(m); Log("Brain model set to " + m + "."); RefreshModels(); if (botUp) ApplyBrain(); }
        else Log("Pull failed — '" + m + "' is not in 'ollama list'. Keeping " + LoadModel() + ".");
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
        Log("Starting Ollama server…");
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
        { Log("Installing bot dependencies (first run)…"); RunSync("cmd.exe", "/c npm install", BotDir); }
        string auth = Cfg("auth", "?");
        Log("Starting bot → " + Cfg("host", "?") + ":" + Cfg("port", "?") + " (auth=" + auth + ")…");
        if (auth == "microsoft") Log("First run: a microsoft.com/link CODE appears in the BOT window - open it to log in.");
        SpawnWindow("Set-Location '" + BotDir + "'; $host.UI.RawUI.WindowTitle='Animus BOT'; node run.js");
        if (WaitPort(int.Parse(ControlPort), 300)) Log("Bot up — live panel is on.");
        else Log("Bot didn't come up on :" + ControlPort + " — check the 'Animus BOT' window (host/port/version/login).");
    }

    void StartBrain(string model)
    {
        if (IsRunning("Animus BRAIN")) { Log("Brain already running."); return; }
        if (model == null || model.Trim().Length == 0) model = LoadModel();
        model = model.Trim();
        EnsureOllama();
        string list = RunCapture("ollama", "list");
        if (list != null && list.IndexOf(model, StringComparison.OrdinalIgnoreCase) < 0)
        { Log(model + " isn't pulled yet — pulling it first…"); UseModel(model); }
        Log("Starting brain (" + model + ")…");
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
        else cbSchem.Text = "(none yet — add one)";
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
        Log("Stopping bot + brain…");
        string[] titles = { "Animus BOT", "Animus BRAIN" };
        int killed = 0;
        foreach (Process p in Process.GetProcesses())
        { try { if (Array.IndexOf(titles, p.MainWindowTitle) >= 0) { p.Kill(); killed++; } } catch { } }
        Log(killed > 0 ? ("Closed " + killed + " window(s).") : "Nothing was running.");
        SetStop("Stopped", Ghost);
        botUp = false;
        stateFails = 3;   // an explicit stop is known-dead: no grace window
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
