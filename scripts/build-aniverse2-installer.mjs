import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export function buildInstallerSplash(root) {
  if (process.platform !== 'win32') return;
  const dotnet = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  const out = path.join(root, 'dist/aniverse2-installer');
  const assets = path.join(root, 'assets/aniverse2');
  mkdirSync(out, { recursive: true });
  execFileSync(path.join(dotnet, 'csc.exe'), [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    '/out:' + path.join(out, 'AniVerse2SetupSplash.exe'),
    '/win32icon:' + path.join(assets, 'aniverse2.ico'),
    '/resource:' + path.join(assets, 'mark.png') + ',aniverse2-mark.png',
    '/resource:' + path.join(assets, 'installer', 'intro-fallback.gif') + ',aniverse2-intro-fallback.gif',
    ...['PresentationCore', 'PresentationFramework', 'WindowsBase'].map(name =>
      '/reference:' + path.join(dotnet, 'WPF', name + '.dll')),
    '/reference:' + path.join(dotnet, 'System.Xaml.dll'),
    path.join(root, 'native/aniverse2/windows/SetupSplash.cs'),
  ], { stdio: 'inherit' });
}