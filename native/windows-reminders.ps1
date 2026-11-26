[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidateSet('Enable','Disable')][string]$Action,
    [Parameter(Mandatory)][string]$DataHome,
    [string]$DesktopExe
)
$ErrorActionPreference = 'Stop'
$encoding = [Text.UTF8Encoding]::new($false)
$data = (Resolve-Path -LiteralPath $DataHome).ProviderPath
$root = Join-Path $data 'agent-community\task-reminders'
$binding = Join-Path $root 'native-binding.json'
$pluginId = 'dsh-plugin-local-workstudio'
$exe = Join-Path (Split-Path -Parent $PSScriptRoot) 'components\agent-community\lib\win32\TaskReminder.exe'
$hash = [Security.Cryptography.SHA256]::Create()
try { $bytes = $hash.ComputeHash($encoding.GetBytes($data.ToLowerInvariant())) }
finally { $hash.Dispose() }
$instance = (-join ($bytes | ForEach-Object { $_.ToString('x2') })).Substring(0,16)
$appId = "com.localworkstudio.$instance"
$protocol = "dsh-workstudio-task-$instance"
$classes = 'HKCU:\Software\Classes'
$urlKey = Join-Path $classes $protocol
$appKey = Join-Path $classes "AppUserModelId\$appId"
$programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
if (!$programs) { throw 'The current user has no Start Menu Programs directory.' }
$shortcut = Join-Path $programs "Local Agent Studio ($instance).lnk"

foreach ($key in @($urlKey, $appKey)) {
    if ((Test-Path -LiteralPath $key) -and
        ((Get-Item -LiteralPath $key).GetValue('LocalWorkstudioOwner') -cne $pluginId)) {
        throw 'This Windows notification identity is already in use.'
    }
}
if (Test-Path -LiteralPath $binding) {
    $old = Get-Content -Raw -Encoding UTF8 -LiteralPath $binding | ConvertFrom-Json
    if ($old.appId -cne $appId -or $old.protocol -cne $protocol) {
        throw 'The data directory already contains a different Windows notification binding.'
    }
}
if (Test-Path -LiteralPath $shortcut) {
    $shell = New-Object -ComObject WScript.Shell
    if ($shell.CreateShortcut($shortcut).Description -cne $pluginId) {
        throw 'The Start Menu shortcut already belongs to a different application.'
    }
}

if ($Action -eq 'Disable') {
    if (!$PSCmdlet.ShouldProcess($appId, 'Remove this plugin instance Windows notification binding')) { return }
    if (Test-Path -LiteralPath $binding) { Remove-Item -LiteralPath $binding }
    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
    foreach ($key in @( "$urlKey\shell\open\command", "$urlKey\shell\open", "$urlKey\shell", $urlKey, $appKey )) {
        if (Test-Path -LiteralPath $key) {
            if ((Get-ChildItem -LiteralPath $key | Measure-Object).Count -ne 0) {
                throw "Additional registry subkeys exist at $key."
            }
            Remove-Item -LiteralPath $key
        }
    }
    return
}

if (!(Test-Path -LiteralPath (Join-Path $root 'records.json') -PathType Leaf)) {
    throw 'Open the installed plugin once in the intended DSH data directory.'
}
if (!$DesktopExe) { throw 'Supply the path to the DeepSeek Harness desktop executable.' }
$desktop = (Resolve-Path -LiteralPath $DesktopExe).ProviderPath
if (!(Test-Path -LiteralPath $desktop -PathType Leaf) -or
    [IO.Path]::GetExtension($desktop) -ine '.exe' -or !(Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw 'The desktop executable and the installed plugin helper are required.'
}
if (!$PSCmdlet.ShouldProcess($appId, 'Enable local Windows notifications and create a Start Menu shortcut')) { return }

foreach ($key in @($urlKey, $appKey)) {
    if (!(Test-Path -LiteralPath $key)) { $null = New-Item -Path $key -Force }
    $null = New-ItemProperty -LiteralPath $key -Name 'LocalWorkstudioOwner' -Value $pluginId -PropertyType String -Force
}
Set-Item -LiteralPath $urlKey -Value 'URL:Local Agent Studio task notification'
$null = New-ItemProperty -LiteralPath $urlKey -Name 'URL Protocol' -Value '' -PropertyType String -Force
foreach ($part in @('shell','shell\open','shell\open\command')) {
    $key = Join-Path $urlKey $part
    if (!(Test-Path -LiteralPath $key)) { $null = New-Item -Path $key }
}
$launch = '"{0}" --binding "{1}"' -f $exe, $binding
Set-Item -LiteralPath (Join-Path $urlKey 'shell\open\command') -Value ($launch + ' "%1"')
$null = New-ItemProperty -LiteralPath $appKey -Name 'DisplayName' -Value 'Local Agent Studio' -PropertyType String -Force
$null = New-ItemProperty -LiteralPath $appKey -Name 'IconUri' -Value $desktop -PropertyType String -Force

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = $exe
$link.Arguments = '--binding "{0}" --launch' -f $binding
$link.Description = $pluginId
$link.IconLocation = "$desktop,0"
$link.WorkingDirectory = Split-Path -Parent $desktop
$link.Save()
$stamp = Start-Process -FilePath $exe -ArgumentList ('--stamp-shortcut "{0}" {1}' -f $shortcut, $appId) -Wait -PassThru -WindowStyle Hidden
if ($stamp.ExitCode -ne 0) { throw 'The notification identity could not be written to the shortcut.' }

$value = [ordered]@{ root = $root; appId = $appId; protocol = $protocol; host = $desktop; launcher = $desktop }
$pending = Join-Path $root ('native-binding-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    [IO.File]::WriteAllText($pending, ($value | ConvertTo-Json), $encoding)
    if (Test-Path -LiteralPath $binding) { [IO.File]::Replace($pending, $binding, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($pending, $binding) }
} finally {
    if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending }
}
