$ErrorActionPreference = 'Stop'
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$metadata = Join-Path $env:WINDIR 'System32\WinMetadata'
$compiler = Join-Path $framework 'csc.exe'
$dest = Join-Path (Split-Path -Parent $PSScriptRoot) 'components\agent-community\lib\win32'
$flags = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001')
$refs = @('System.dll', 'System.Core.dll', 'System.Xml.dll', 'System.Web.Extensions.dll',
    'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Runtime.WindowsRuntime.dll',
    'System.Runtime.InteropServices.WindowsRuntime.dll', 'System.Runtime.dll') |
    ForEach-Object { '/reference:' + (Join-Path $framework $_) }
$refs += @('Windows.UI.winmd', 'Windows.Foundation.winmd', 'Windows.Data.winmd') |
    ForEach-Object { '/reference:' + (Join-Path $metadata $_) }
& $compiler @flags "/out:$dest\TaskReminder.exe" @refs (Join-Path $PSScriptRoot 'TaskReminder.cs') (Join-Path $PSScriptRoot 'ShortcutIdentity.cs') (Join-Path $PSScriptRoot 'PinnedTaskWindow.cs')
if ($LASTEXITCODE -ne 0) { throw 'TaskReminder compilation failed.' }
& $compiler @flags "/out:$dest\DeliveryShell.exe" (Join-Path $PSScriptRoot 'DeliveryShell.cs') (Join-Path $PSScriptRoot 'ExplorerSelection.cs')
if ($LASTEXITCODE -ne 0) { throw 'DeliveryShell compilation failed.' }
Get-FileHash -LiteralPath "$dest\TaskReminder.exe", "$dest\DeliveryShell.exe" |
    Select-Object @{Name='File';Expression={Split-Path $_.Path -Leaf}},Hash
