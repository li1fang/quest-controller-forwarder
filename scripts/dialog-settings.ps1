# These helpers only write disable_dialogs. PIN handling uses SecureString;
# ADB receives them through a non-PTY stdin pipe, never its host command line.
function Get-QuestTestProperties([string]$Adb, [string]$Serial) {
    $output = & $Adb -s $Serial shell content call --uri content://com.oculus.rc --method GET_PROPERTY 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read headset test properties.' }
    return ConvertFrom-QuestTestProperties $output
}

function ConvertFrom-QuestTestProperties([string]$Output) {
    $properties = @{}
    foreach ($match in [regex]::Matches($Output, '(\w+)=(true|false)')) {
        $properties[$match.Groups[1].Value] = $match.Groups[2].Value -eq 'true'
    }
    if (!$properties.ContainsKey('disable_dialogs')) { throw 'Headset does not expose disable_dialogs.' }
    return $properties
}

function New-QuestDialogsCommand([bool]$Value, [string]$PlainPin) {
    if ($PlainPin -cnotmatch '^[0-9]{4}$') { throw 'Store PIN must contain exactly four digits.' }
    $boolean = $Value.ToString().ToLowerInvariant()
    return "content call --uri content://com.oculus.rc --method SET_PROPERTY --extra 'disable_dialogs:b:$boolean' --extra 'PIN:s:$PlainPin'"
}

function Read-QuestStorePin([string]$ButtonText = 'Run test', [string]$Purpose = 'Only disable_dialogs will be changed, then restored.', [string]$Footer = 'The PIN is not saved or sent to the chat.') {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Quest - Meta Store PIN'
    $form.ClientSize = New-Object System.Drawing.Size(440, 190)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost = $true
    $label = New-Object System.Windows.Forms.Label
    $label.Text = "Enter your 4-digit Meta Store PIN locally.`r`n$Purpose`r`n$Footer"
    $label.SetBounds(20, 16, 400, 62)
    $pinBox = New-Object System.Windows.Forms.TextBox
    $pinBox.UseSystemPasswordChar = $true
    $pinBox.MaxLength = 4
    $pinBox.SetBounds(20, 88, 180, 28)
    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = $ButtonText
    $ok.SetBounds(230, 138, 90, 30)
    $ok.Add_Click({
        if ($pinBox.Text -cmatch '^[0-9]{4}$') { $form.DialogResult = 'OK'; $form.Close() }
        else { [void][System.Windows.Forms.MessageBox]::Show('Enter exactly four digits.', 'Meta Store PIN') }
    })
    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.DialogResult = 'Cancel'
    $cancel.SetBounds(330, 138, 90, 30)
    $form.Controls.AddRange(@($label, $pinBox, $ok, $cancel))
    $form.AcceptButton = $ok
    $form.CancelButton = $cancel
    $form.Add_Shown({ [void]$pinBox.Focus() })
    try {
        if ($form.ShowDialog() -ne 'OK') { throw 'PIN entry cancelled; no setting was changed.' }
        $pin = New-Object System.Security.SecureString
        foreach ($character in $pinBox.Text.ToCharArray()) { $pin.AppendChar($character) }
        $pin.MakeReadOnly()
        $pinBox.Clear()
        return $pin
    } finally { $pinBox.Clear(); $form.Dispose() }
}

function Set-QuestDialogs([string]$Adb, [string]$Serial, [bool]$Value, [System.Security.SecureString]$Pin) {
    if ($Serial -cnotmatch '^[A-Za-z0-9._:-]+$') { throw 'Invalid USB serial.' }
    if (!$Pin) { throw 'A locally entered Store PIN is required.' }
    $pointer = [IntPtr]::Zero
    $process = New-Object System.Diagnostics.Process
    try {
        $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Pin)
        $plainPin = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($plainPin -cnotmatch '^[0-9]{4}$') { throw 'Store PIN must contain exactly four digits.' }
        $process.StartInfo.FileName = $Adb
        $process.StartInfo.Arguments = "-s $Serial shell -T sh"
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardInput = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        [void]$process.Start()
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.WriteLine((New-QuestDialogsCommand $Value $plainPin))
        $process.StandardInput.Close()
        $plainPin = $null
        if (!$process.WaitForExit(10000)) { $process.Kill(); throw 'Headset property write timed out; verify the saved original value.' }
        $output = $outputTask.GetAwaiter().GetResult()
        $null = $errorTask.GetAwaiter().GetResult()
        # Raw output is intentionally never logged: a device error could echo input.
        if ($process.ExitCode -ne 0 -or $output -notmatch '\bSuccess=true\b') {
            $failure = New-Object System.InvalidOperationException('Headset rejected disable_dialogs. Check the Store PIN and account eligibility locally.')
            if ($output -match '\bSuccess=false\b') { $failure.Data['QuestPropertyRejected'] = $true }
            throw $failure
        }
    } finally {
        $plainPin = $null
        if ($pointer -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $process.Dispose()
    }
}

function Assert-QuestOtherProperties($Before, $After) {
    foreach ($key in $Before.Keys) {
        if ($key -ne 'disable_dialogs' -and (!$After.ContainsKey($key) -or $Before[$key] -ne $After[$key])) {
            throw "Another test property changed externally: $key. It was not written by this script."
        }
    }
}

function Restore-QuestDialogs([string]$Adb, [string]$Serial, $Before, [System.Security.SecureString]$Pin) {
    $current = Get-QuestTestProperties $Adb $Serial
    if ($current.disable_dialogs -ne $Before.disable_dialogs) { Set-QuestDialogs $Adb $Serial $Before.disable_dialogs $Pin }
    $after = Get-QuestTestProperties $Adb $Serial
    if ($after.disable_dialogs -ne $Before.disable_dialogs) { throw 'disable_dialogs restoration was not verified.' }
    Assert-QuestOtherProperties $Before $after
    return $after
}
