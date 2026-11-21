using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

internal static class SetupSplash
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 1 || !File.Exists(args[0])) return;
        var resources = Assembly.GetExecutingAssembly();
        var window = new Window {
            Title = "AniVerse2 setup splash", Width = 408, Height = 446,
            WindowStyle = WindowStyle.None, ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            Background = new SolidColorBrush(Color.FromRgb(15, 24, 40)),
            UseLayoutRounding = true
        };
        using (var logo = resources.GetManifestResourceStream("aniverse2-mark.png"))
        {
            var icon = new BitmapImage();
            icon.BeginInit();
            icon.CacheOption = BitmapCacheOption.OnLoad;
            icon.StreamSource = logo;
            icon.EndInit();
            window.Icon = icon;
        }

        GifBitmapDecoder fallbackClip;
        using (var stream = resources.GetManifestResourceStream("aniverse2-intro-fallback.gif"))
            fallbackClip = new GifBitmapDecoder(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);

        var fallback = new Image { Source = fallbackClip.Frames[0], Stretch = Stretch.Uniform };
        var video = new MediaElement {
            Source = new Uri(Path.GetFullPath(args[0])),
            LoadedBehavior = MediaState.Manual, UnloadedBehavior = MediaState.Close,
            IsMuted = true, Stretch = Stretch.Uniform, Focusable = false
        };
        var visuals = new Grid();
        visuals.Children.Add(video);
        visuals.Children.Add(fallback);

        var footer = new DockPanel { Margin = new Thickness(10, 3, 10, 5) };
        var skip = new Button {
            Content = "Skip intro", MinWidth = 90, Padding = new Thickness(8, 3, 8, 3), IsCancel = true
        };
        DockPanel.SetDock(skip, Dock.Right);
        footer.Children.Add(skip);
        footer.Children.Add(new TextBlock {
            Text = "AniVerse2 Setup", Foreground = Brushes.White, VerticalAlignment = VerticalAlignment.Center
        });
        var layout = new DockPanel();
        DockPanel.SetDock(footer, Dock.Bottom);
        layout.Children.Add(footer);
        layout.Children.Add(visuals);
        window.Content = layout;

        var elapsed = new Stopwatch();
        var animation = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.0 / 12) };
        var timeout = new DispatcherTimer { Interval = TimeSpan.FromSeconds(6) };
        bool videoReady = false;
        int shownFrame = 0;
        animation.Tick += delegate {
            if (elapsed.Elapsed.TotalSeconds >= 4.6) { window.Close(); return; }
            if (videoReady && video.Position.TotalMilliseconds >= 150)
            {
                fallback.Visibility = Visibility.Collapsed;
                return;
            }
            fallback.Visibility = Visibility.Visible;
            int frame = Math.Min((int)(elapsed.Elapsed.TotalSeconds * 12), fallbackClip.Frames.Count - 1);
            if (frame == shownFrame) return;
            fallback.Source = fallbackClip.Frames[frame];
            shownFrame = frame;
        };
        video.MediaOpened += delegate {
            if (!video.HasVideo || elapsed.Elapsed.TotalSeconds >= 4) return;
            video.Position = elapsed.Elapsed;
            videoReady = true;
        };
        video.MediaFailed += delegate { videoReady = false; };
        window.ContentRendered += delegate {
            if (elapsed.IsRunning) return;
            elapsed.Start();
            animation.Start();
            video.Play();
        };
        timeout.Tick += delegate { window.Close(); };
        window.Closed += delegate { animation.Stop(); timeout.Stop(); };
        skip.Click += delegate { window.Close(); };
        timeout.Start();
        new Application().Run(window);
    }
}
