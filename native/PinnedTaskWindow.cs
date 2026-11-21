using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal sealed class PinnedTaskWindow : Form {
    const int CardWidth = 332, OpenHeight = 126, ClosedHeight = 46;
    static readonly bool HighContrast = SystemInformation.HighContrast;
    static readonly Color Surface = HighContrast ? SystemColors.Window : Color.FromArgb(251, 253, 252);
    static readonly Color Ink = HighContrast ? SystemColors.WindowText : Color.FromArgb(26, 45, 42);
    static readonly Color Muted = HighContrast ? SystemColors.WindowText : Color.FromArgb(77, 98, 93);
    static readonly Color Accent = HighContrast ? SystemColors.Highlight : Color.FromArgb(19, 109, 94);
    static readonly Color Tint = HighContrast ? SystemColors.Window : Color.FromArgb(225, 242, 236);
    static readonly Color Edge = HighContrast ? SystemColors.WindowText : Color.FromArgb(202, 215, 209);
    readonly Font smallFont, titleFont, actionFont;
    readonly Label brand, title, status;
    readonly CardButton fold, close, open;
    readonly ToolTip hints = new ToolTip();
    int dpi = 96;
    bool compact;
    string room = "群任务", detail = "正在读取任务状态";

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attribute, ref int value, int size);

    internal static void EnableDisplayScaling() {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
    }

    internal PinnedTaskWindow(Action openMessage) {
        Text = "同机工作室 · 群任务";
        AccessibleName = Text;
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        KeyPreview = true;
        DoubleBuffered = true;
        BackColor = Surface;
        var family = SystemFonts.MessageBoxFont.FontFamily;
        smallFont = new Font(family, 10f);
        titleFont = new Font(family, 13f, FontStyle.Bold);
        actionFont = new Font(family, 10f, FontStyle.Bold);
        brand = Caption(smallFont, Muted);
        title = Caption(titleFont, Ink);
        status = Caption(smallFont, Muted);
        open = new CardButton("查看原消息", actionFont, false);
        fold = new CardButton("收起", smallFont, true);
        close = new CardButton("关闭", smallFont, true);
        open.TabIndex = 0; fold.TabIndex = 1; close.TabIndex = 2;
        open.Click += delegate { openMessage(); };
        fold.Click += delegate { SetCompact(!compact); };
        close.Click += delegate { Close(); };
        hints.SetToolTip(close, "关闭置顶小窗");
        hints.SetToolTip(open, "在同机工作室查看这条消息");
        Controls.AddRange(new Control[] { brand, title, status, open, fold, close });
        foreach (var caption in new[] { brand, title, status })
            caption.MouseDown += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) DragCard(); };
        MouseDown += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) DragCard(); };
        KeyDown += delegate(object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Escape) { e.Handled = true; Close(); } };
        // Create the handle on the intended monitor so the initial layout uses that display's DPI.
        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(area.Right - CardWidth - 20, area.Top + 22);
        SetCompact(false);
    }

    static Label Caption(Font font, Color color) {
        return new Label { Font = font, ForeColor = color, BackColor = Surface,
            AutoEllipsis = true, UseMnemonic = false, TextAlign = ContentAlignment.MiddleLeft,
            AutoSize = false, TabStop = false, Margin = Padding.Empty };
    }
    void DragCard() {
        ReleaseCapture();
        SendMessage(Handle, 0x00A1, new IntPtr(2), IntPtr.Zero);
    }
    int Px(int n) { return (int)Math.Round(n * dpi / 96.0); }
    void Box(Control c, int x, int y, int w, int h) { c.SetBounds(Px(x), Px(y), Px(w), Px(h)); }
    void LayoutCard() {
        SuspendLayout();
        ClientSize = new Size(Px(CardWidth), Px(compact ? ClosedHeight : OpenHeight));
        Box(brand, 47, 8, 205, 28);
        Box(title, compact ? 47 : 17, compact ? 6 : 45, compact ? 205 : CardWidth - 34, compact ? 34 : 29);
        Box(status, 26, 83, 178, 29);
        Box(open, 211, 84, 105, 28);
        Box(fold, 256, 7, 31, 30);
        Box(close, 291, 7, 28, 30);
        ResumeLayout(false);
        Invalidate(true);
    }
    void SetCompact(bool value) {
        compact = value;
        fold.Text = compact ? "展开" : "收起";
        fold.AccessibleName = fold.Text;
        hints.SetToolTip(fold, fold.Text);
        brand.Visible = status.Visible = open.Visible = !compact;
        title.Font = compact ? actionFont : titleFont;
        LayoutCard();
        UpdateText(room, detail);
        if (Visible && IsHandleCreated) {
            var area = Screen.FromHandle(Handle).WorkingArea;
            Top = Math.Max(area.Top, Math.Min(Top, area.Bottom - Height));
        }
    }
    internal void UpdateText(string group, string text) {
        room = String.IsNullOrWhiteSpace(group) ? "群任务" : group;
        detail = String.IsNullOrWhiteSpace(text) ? "正在读取任务状态" : text;
        if (title.Text != room) title.Text = room;
        if (status.Text != detail) status.Text = detail;
        brand.Text = "同机工作室";
        string tip = compact ? room + Environment.NewLine + detail : room;
        if (hints.GetToolTip(title) != tip) hints.SetToolTip(title, tip);
        if (hints.GetToolTip(status) != detail) hints.SetToolTip(status, detail);
    }
    protected override void OnLoad(EventArgs e) {
        try { uint value = GetDpiForWindow(Handle); if (value > 0) dpi = (int)value; }
        catch (EntryPointNotFoundException) { using (var g = CreateGraphics()) dpi = (int)g.DpiX; }
        LayoutCard();
        var area = Screen.FromHandle(Handle).WorkingArea;
        Location = new Point(Math.Max(area.Left, area.Right - Width - Px(20)), area.Top + Px(22));
        int rounded = 2;
        DwmSetWindowAttribute(Handle, 33, ref rounded, sizeof(int));
        base.OnLoad(e);
    }
    protected override void WndProc(ref Message m) {
        const int DpiChanged = 0x02E0;
        if (m.Msg == DpiChanged && title != null) {
            base.WndProc(ref m);
            int value = m.WParam.ToInt32() & 0xffff;
            if (value > 0) dpi = value;
            LayoutCard();
            return;
        }
        base.WndProc(ref m);
    }
    protected override CreateParams CreateParams {
        get { var cp = base.CreateParams; cp.ClassStyle |= 0x20000; return cp; }
    }
    static GraphicsPath Round(RectangleF rect, float radius) {
        float d = radius * 2;
        var p = new GraphicsPath();
        p.AddArc(rect.Left, rect.Top, d, d, 180, 90);
        p.AddArc(rect.Right - d, rect.Top, d, d, 270, 90);
        p.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
        p.AddArc(rect.Left, rect.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.ScaleTransform(dpi / 96f, dpi / 96f);
        using (var boundary = Round(new RectangleF(.5f, .5f, CardWidth - 1, (compact ? ClosedHeight : OpenHeight) - 1), 9))
        using (var pen = new Pen(Edge)) g.DrawPath(pen, boundary);
        using (var shape = Round(new RectangleF(16, 12, 22, 22), 6))
        using (var brush = new SolidBrush(Accent)) g.FillPath(brush, shape);
        using (var mark = new Pen(HighContrast ? SystemColors.HighlightText : Color.White, 1.6f)) {
            mark.StartCap = mark.EndCap = LineCap.Round;
            g.DrawLine(mark, 21.5f, 20, 32, 20);
            g.DrawLine(mark, 21.5f, 24.5f, 28.5f, 24.5f);
        }
        if (!compact) {
            using (var rule = new Pen(Edge)) g.DrawLine(rule, 17, 78, CardWidth - 17, 78);
            using (var dot = new SolidBrush(Accent)) g.FillEllipse(dot, 17, 96, 5.5f, 5.5f);
        }
    }
    sealed class CardButton : Button {
        readonly bool icon;
        bool hover, down;
        public CardButton(string label, Font font, bool iconOnly) {
            icon = iconOnly; Text = AccessibleName = label; Font = font;
            AccessibleRole = AccessibleRole.PushButton;
            UseVisualStyleBackColor = false; FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0; Cursor = Cursors.Hand; BackColor = Surface;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        }
        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hover = true; Invalidate(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hover = down = false; Invalidate(); }
        protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); down = true; Invalidate(); }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); down = false; Invalidate(); }
        protected override void OnPaint(PaintEventArgs e) {
            var g = e.Graphics; g.Clear(Surface); g.SmoothingMode = SmoothingMode.AntiAlias;
            float k = Height / (icon ? 30f : 28f);
            Color fill = down ? Accent : hover || !icon ? Tint : Surface;
            Color fg = down ? (HighContrast ? SystemColors.HighlightText : Color.White) : icon ? Muted : (HighContrast ? SystemColors.WindowText : Accent);
            var r = new RectangleF(1, 1, Width - 2, Height - 2);
            using (var shape = Round(r, 6 * k))
            using (var brush = new SolidBrush(fill)) {
                g.FillPath(brush, shape);
                if (HighContrast || (Focused && ShowFocusCues)) using (var focusPen = new Pen(fg, 1.3f * k)) g.DrawPath(focusPen, shape);
            }
            float x = icon ? Width / 2f : Width - 15 * k, y = Height / 2f;
            using (var p = new Pen(fg, 1.55f * k)) {
                p.StartCap = p.EndCap = LineCap.Round;
                if (Text == "关闭") {
                    g.DrawLine(p, x-3.5f*k, y-3.5f*k, x+3.5f*k, y+3.5f*k);
                    g.DrawLine(p, x+3.5f*k, y-3.5f*k, x-3.5f*k, y+3.5f*k);
                } else if (icon) {
                    float h = (Text == "收起" ? -2f : 2f) * k;
                    g.DrawLines(p, new[] { new PointF(x-4*k,y-h), new PointF(x,y+h), new PointF(x+4*k,y-h) });
                } else {
                    var textBox = new Rectangle(0, 0, Width - (int)(19*k), Height);
                    TextRenderer.DrawText(g, Text, Font, textBox, fg, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
                    g.DrawLine(p, x-3*k,y+3*k,x+3*k,y-3*k);
                    g.DrawLines(p, new[] { new PointF(x-2*k,y-3*k),new PointF(x+3*k,y-3*k),new PointF(x+3*k,y+2*k) });
                }
            }
        }
    }
    protected override void Dispose(bool disposing) {
        if (disposing) hints.Dispose();
        base.Dispose(disposing);
        if (disposing) { smallFont.Dispose(); titleFont.Dispose(); actionFont.Dispose(); }
    }
}
